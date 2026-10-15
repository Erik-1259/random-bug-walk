import { statSync, type Stats } from "node:fs";
import { sha256Hex, type FailureReason } from "@rbw/schema";
import type { ReadmeConfig } from "./config.ts";
import { InvalidInput } from "./errors.ts";
import { Budget, LimitExceeded } from "./limits.ts";
import { checkStateLocation, destinations, loadPolicy, printLocations, printRecord, readInput, scannerFor, type PublishDeps } from "./publish.ts";
import { Repository, RepositoryUnavailable } from "./repository.ts";
import { combine } from "./scanner.ts";
import { StateDir } from "./state.ts";

/** The one path this command writes. It is fixed here and never taken from input. */
export const README_PATH = "README.md";
export const README_MAX_BYTES = 64 * 1024;
export const README_MESSAGE = "chore(readme): publish";

/** The outcome of one readme attempt, printed to stdout and stored as `readme/record.json`. */
export interface ReadmeRecord {
  schema_version: 1;
  path: typeof README_PATH;
  sha256: string;
  size_bytes: number;
  project_policy_sha256: string;
  branch: string;
  /** Where the commit goes: the `--local-remote` path in local mode, the SSH URL in real mode. */
  repository: string;
  status: "published" | "blocked" | "failed";
  repository_commit: string | null;
  failure_reason: FailureReason | null;
}

/** Reads the file to publish: a regular, non-empty UTF-8 file of at most README_MAX_BYTES. */
function readReadme(file: string): Buffer {
  let stats: Stats;
  try {
    stats = statSync(file);
  } catch {
    throw new InvalidInput("readme_unreadable");
  }
  if (!stats.isFile()) throw new InvalidInput("readme_unreadable");
  // A file over the cap is refused before it is read; the length is checked again after the read.
  if (stats.size > README_MAX_BYTES) throw new InvalidInput("readme_too_large");
  const bytes = readInput(file, "readme_unreadable");
  if (bytes.length === 0) throw new InvalidInput("readme_empty");
  if (bytes.length > README_MAX_BYTES) throw new InvalidInput("readme_too_large");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidInput("readme_not_utf8");
  }
  return bytes;
}

/**
 * The readme command: publishes one file as `README.md` at the root of the results repository,
 * in one fast-forward commit on the fetched head that adds or replaces only that path. Nothing
 * goes to the public store. Limits are counted per README version (the SHA-256 of its bytes).
 */
export async function readmeCommand(config: ReadmeConfig, deps: PublishDeps): Promise<number> {
  const { policy, sha256: policySha256 } = loadPolicy(config);
  // The deploy-key and state-location checks look only at the path, so the file is read after them.
  const target = destinations(config, config.readmeFile, policy, deps);
  checkStateLocation(config, config.readmeFile);
  const bytes = readReadme(config.readmeFile);
  const scanner = scannerFor(config, target, deps);
  const state = new StateDir(config.stateDir);
  const sha256 = sha256Hex(bytes);

  const finish = (status: ReadmeRecord["status"], failureReason: FailureReason | null, commit: string | null): number => {
    const record: ReadmeRecord = {
      schema_version: 1,
      path: README_PATH,
      sha256,
      size_bytes: bytes.length,
      project_policy_sha256: policySha256,
      branch: config.branch,
      repository: target.repository.pushUrl,
      status,
      repository_commit: commit,
      failure_reason: failureReason,
    };
    state.saveReadmeRecord(record);
    deps.logger.event("record", { readme: sha256, status, reason: failureReason });
    return printRecord(deps, record);
  };
  const failed = (failureReason: FailureReason): number => finish("failed", failureReason, null);

  // While the latest record names these bytes, this policy, this branch and this repository, published and limit_exceeded are final.
  const current = state.loadReadmeRecord() as Partial<ReadmeRecord> | null;
  if (
    current?.sha256 === sha256 &&
    current.project_policy_sha256 === policySha256 &&
    current.branch === config.branch &&
    current.repository === target.repository.pushUrl &&
    (current.status === "published" || current.failure_reason === "limit_exceeded")
  ) {
    return printRecord(deps, current as ReadmeRecord);
  }
  state.ensure();

  // PUB-02: scan exactly the bytes that become public, and publish nothing unless both scans are clean.
  const scan = combine([await scanner.scanTree(new Map([[README_PATH, bytes]])), await scanner.scanText("commit-message", new TextEncoder().encode(README_MESSAGE))]);
  if (scan.outcome === "blocked") {
    printLocations(deps, scan.locations);
    return finish("blocked", "scan_blocked", null);
  }
  if (scan.outcome === "unavailable") return failed("scan_unavailable");

  const budget = new Budget(state.readmeLimits, sha256, config.limits);
  const repository = new Repository({ ...target.repository, gitDir: state.repositoryDir }, deps.runner, deps.env, deps.logger, budget);
  try {
    await repository.init();
    const head = await repository.fetchHead();
    // The README describes records already on the branch, so this command never creates the branch.
    if (head === null) return failed("repository_conflict");
    const mode = await repository.modeAt(head, README_PATH);
    if (mode !== null && mode !== "100644") return failed("repository_conflict");
    if (mode !== null && (await repository.blobAt(head, README_PATH))?.equals(bytes) === true) return finish("published", null, await repository.changedBy(head, README_PATH));
    // The bytes become public once, however many pushes it takes.
    const payloadTag = `repository:${sha256}`;
    budget.checkAll({ pushAttempts: 1, newPublicBytes: budget.hasCounted(payloadTag) ? 0 : bytes.length, transferBytes: bytes.length });
    const commit = await repository.commit(head, "", [{ path: README_PATH, bytes }], README_MESSAGE);
    budget.spendOnce("newPublicBytes", bytes.length, payloadTag);
    budget.spend("transferBytes", bytes.length);
    if (!(await repository.push(commit))) return failed("repository_unavailable");
    return finish("published", null, commit);
  } catch (error) {
    if (error instanceof LimitExceeded) return failed("limit_exceeded");
    if (error instanceof RepositoryUnavailable) return failed("repository_unavailable");
    throw error;
  }
}
