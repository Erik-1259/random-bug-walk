import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertRecord, encodeCanonical, sha256Hex, type FailureReason, type PublicationRecord, type Release } from "@rbw/schema";
import type { ReleaseConfig } from "./config.ts";
import { InvalidInput } from "./errors.ts";
import { Budget, LimitExceeded } from "./limits.ts";
import { checkStateLocation, destinations, loadPolicy, parseInput, printLocations, printRecord, readInput, scannerFor, type PublishDeps } from "./publish.ts";
import { Repository, RepositoryUnavailable, type TreeEntry } from "./repository.ts";
import { combine } from "./scanner.ts";
import { StateDir } from "./state.ts";

export const RELEASE_FILE = "release.json";

/** Every regular file below a directory, as relative POSIX paths. Anything else makes the directory unusable. */
function listFiles(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const stats = lstatSync(join(dir, path));
    if (stats.isDirectory()) found.push(...listFiles(dir, path));
    else if (stats.isFile()) found.push(path);
    else throw new InvalidInput("release_files_mismatch");
  }
  return found;
}

/**
 * Reads a release directory: canonical `release.json` and exactly the files it lists, each with
 * its SHA-256. The bytes read here are the bytes scanned and published.
 */
function readRelease(dir: string): { release: Release; releaseSha256: string; entries: TreeEntry[] } {
  const releaseBytes = readInput(join(dir, RELEASE_FILE), "release_unreadable");
  const release = parseInput("Release", releaseBytes, "release_invalid");
  if (!Buffer.from(encodeCanonical(release)).equals(releaseBytes)) throw new InvalidInput("release_not_canonical");
  let present: string[];
  try {
    present = listFiles(dir);
  } catch (error) {
    if (error instanceof InvalidInput) throw error;
    throw new InvalidInput("release_unreadable");
  }
  const listed = release.files.map((file) => file.path);
  if (present.length !== listed.length + 1 || !present.includes(RELEASE_FILE) || listed.some((path) => !present.includes(path))) throw new InvalidInput("release_files_mismatch");
  const entries: TreeEntry[] = [{ path: RELEASE_FILE, bytes: releaseBytes }];
  for (const file of release.files) {
    const bytes = readInput(join(dir, ...file.path.split("/")), "release_unreadable");
    if (sha256Hex(bytes) !== file.sha256) throw new InvalidInput("release_files_mismatch");
    entries.push({ path: file.path, bytes });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { release, releaseSha256: sha256Hex(releaseBytes), entries };
}

interface Attempt {
  status: "published" | "blocked" | "failed";
  failureReason: FailureReason | null;
  commit: string | null;
}

/**
 * The release command: publishes `releases/<release_id>/` to the results repository in one
 * fast-forward commit, after the run it names is published there. Nothing goes to the public
 * store. The record is a PublicationRecord of the release's root, with the release ID as its
 * publication ID and the SHA-256 of `release.json` as its manifest hash.
 */
export async function releaseCommand(config: ReleaseConfig, deps: PublishDeps): Promise<number> {
  const { policy, sha256: policySha256 } = loadPolicy(config);
  const { release, releaseSha256, entries } = readRelease(config.releaseDir);
  if (release.project_policy_sha256 !== policySha256 || release.project_id !== policy.project_id) throw new InvalidInput("release_policy_mismatch");
  const target = destinations(config, config.releaseDir, policy, deps);
  checkStateLocation(config, config.releaseDir);
  const scanner = scannerFor(config, target, deps);
  const state = new StateDir(config.stateDir);
  const releaseId = release.release_id;
  const root = release.run.root_execution_id;

  const record = (attempt: Attempt): PublicationRecord =>
    assertRecord("PublicationRecord", {
      schema_version: 1,
      root_execution_id: root,
      project_policy_sha256: policySha256,
      publication_id: releaseId,
      manifest_sha256: releaseSha256,
      execution_id: root,
      status: attempt.status,
      repository_commit: attempt.commit,
      artifacts: [],
      omissions: [],
      failure_reason: attempt.failureReason,
    });
  const finish = (attempt: Attempt): number => {
    const result = record(attempt);
    state.saveReleaseRecord(releaseId, result);
    deps.logger.event("record", { release: releaseId, status: result.status, reason: result.failure_reason });
    return printRecord(deps, result);
  };
  const failed = (failureReason: FailureReason): number => finish({ status: "failed", failureReason, commit: null });

  const current = state.loadReleaseRecord(releaseId);
  if (current?.manifest_sha256 === releaseSha256 && (current.status === "published" || current.failure_reason === "limit_exceeded")) return printRecord(deps, current);
  state.ensure();

  // PUB-02: scan exactly the bytes that become public, and publish nothing unless both scans are clean.
  const prefix = `releases/${releaseId}/`;
  const message = `chore(releases): publish ${releaseId}`;
  const scan = combine([await scanner.scanTree(new Map(entries.map((entry) => [`${prefix}${entry.path}`, entry.bytes]))), await scanner.scanText("commit-message", new TextEncoder().encode(message))]);
  if (scan.outcome === "blocked") {
    printLocations(deps, scan.locations);
    return finish({ status: "blocked", failureReason: "scan_blocked", commit: null });
  }
  if (scan.outcome === "unavailable") return failed("scan_unavailable");

  const budget = new Budget(state.releaseLimits, releaseId, config.limits);
  const repository = new Repository({ ...target.repository, gitDir: state.repositoryDir }, deps.runner, deps.env, deps.logger, budget);
  const payload = entries.reduce((total, entry) => total + entry.bytes.length, 0);
  try {
    await repository.init();
    const head = await repository.fetchHead();
    // The release names a published run: its manifest must be on the branch with the hash the release pins.
    const manifest = head === null ? null : await repository.blobAt(head, `runs/${root}/manifest.json`);
    if (head === null || manifest === null || sha256Hex(manifest) !== release.run.manifest_sha256) return failed("repository_conflict");
    const existing = await repository.treeAt(head, `releases/${releaseId}`);
    if (existing !== null) {
      if (existing !== (await repository.runTree(entries))) return failed("repository_conflict");
      return finish({ status: "published", failureReason: null, commit: await repository.addedBy(head, `${prefix}${RELEASE_FILE}`) });
    }
    // The payload becomes public once, however many pushes it takes.
    const payloadTag = `repository:${releaseSha256}`;
    budget.checkAll({ pushAttempts: 1, newPublicBytes: budget.hasCounted(payloadTag) ? 0 : payload, transferBytes: payload });
    const commit = await repository.commit(head, prefix, entries, message);
    budget.spendOnce("newPublicBytes", payload, payloadTag);
    budget.spend("transferBytes", payload);
    if (!(await repository.push(commit))) return failed("repository_unavailable");
    return finish({ status: "published", failureReason: null, commit });
  } catch (error) {
    if (error instanceof LimitExceeded) return failed("limit_exceeded");
    if (error instanceof RepositoryUnavailable) return failed("repository_unavailable");
    throw error;
  }
}
