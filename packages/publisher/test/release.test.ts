import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeCanonical, parseRecord, sha256Hex } from "@rbw/schema";
import type { Release } from "@rbw/schema";
import { runCli } from "../src/cli.ts";
import { FORBIDDEN_TERM, PROJECT_ID, ROOT_ID, commitCount, createWorld, git, gitBytes, headCommit, printed, publish, stage, storeObjects, tempDir, write, writeRootRun } from "./support.ts";
import type { World } from "./support.ts";

const RELEASE_ID = "00000000-0000-4000-8000-000000000601";
const FIXTURE = new URL("../../schema/fixtures/records/release-valid.json", import.meta.url).pathname;

interface ReleaseFiles {
  issue?: string;
}

/** A release directory for the world's published root: release.json and the files it lists. */
function writeRelease(world: World, run: { manifest_sha256: string; publication_id: string; repository_commit: string }, files: ReleaseFiles = {}): string {
  const dir = tempDir("rbw-publisher-release-");
  const contents: Record<string, Uint8Array> = {
    "issue.json": encodeCanonical({ title: files.issue ?? "Synthetic issue title", environment: "Synthetic; the planted bug is synthetic." }),
    "issue-check.json": encodeCanonical({ status: "ready_for_review", codes: [] }),
    "recordings/card-1.recording.json": encodeCanonical({ format_version: 1, provenance: "synthetic", request: { body: { messages: ["synthetic prompt"] } } }),
    "recordings/issue-1.recording.json": encodeCanonical({ format_version: 1, provenance: "synthetic", response: { body: "synthetic response" } }),
  };
  for (const [path, bytes] of Object.entries(contents)) write(join(dir, path), bytes);
  const base = JSON.parse(readFileSync(FIXTURE, "utf8")) as Release;
  const release: Release = {
    ...base,
    release_id: RELEASE_ID,
    project_id: PROJECT_ID,
    project_policy_sha256: world.policySha256,
    run: { root_execution_id: ROOT_ID, ...run },
    files: Object.entries(contents)
      .map(([path, bytes]) => ({ path, sha256: sha256Hex(bytes) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  write(join(dir, "release.json"), encodeCanonical(release));
  return dir;
}

function release(world: World, releaseDir: string, state = world.state) {
  return runCli(
    ["release", "--policy", world.policyFile, "--release-dir", releaseDir, "--state", state, "--patterns", world.patterns, "--local-remote", world.remote, "--local-store", world.store, "--gitleaks", world.gitleaks],
    { env: { PATH: process.env.PATH ?? "", HOME: world.dir } },
  );
}

async function publishedWorld(): Promise<{ world: World; run: { manifest_sha256: string; publication_id: string; repository_commit: string } }> {
  const world = createWorld();
  stage(world.staging);
  const result = await publish(world, writeRootRun(world));
  expect(result.code).toBe(0);
  const record = printed(result);
  return { world, run: { manifest_sha256: record.manifest_sha256, publication_id: record.publication_id, repository_commit: record.repository_commit ?? "" } };
}

describe("release", () => {
  it("publishes releases/<release_id>/ with the exact bytes, in one fast-forward commit, and nothing to the store", async () => {
    const { world, run } = await publishedWorld();
    const before = storeObjects(world.store);
    const dir = writeRelease(world, run);
    const result = await release(world, dir);
    expect(result.stderr).not.toContain("internal error");
    expect(result.code).toBe(0);
    const record = printed(result);
    expect(record.status).toBe("published");
    expect(record.publication_id).toBe(RELEASE_ID);
    expect(record.manifest_sha256).toBe(sha256Hex(readFileSync(join(dir, "release.json"))));
    const commit = headCommit(world.remote) ?? "";
    expect(record.repository_commit).toBe(commit);
    expect(commitCount(world.remote)).toBe(2);
    expect(git(world.remote, ["rev-list", "--parents", "-n", "1", commit]).split(" ")).toHaveLength(2);
    const raw = git(world.remote, ["cat-file", "commit", commit]);
    expect(raw).toMatch(/^author Random Bug Walk <> \d+ \+0000$/m);
    expect(raw.split("\n\n").slice(1).join("\n\n")).toBe(`chore(releases): publish ${RELEASE_ID}`);
    const added = git(world.remote, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).split("\n");
    expect(added).toEqual(["issue-check.json", "issue.json", "recordings/card-1.recording.json", "recordings/issue-1.recording.json", "release.json"].map((path) => `releases/${RELEASE_ID}/${path}`));
    for (const path of ["release.json", "issue.json", "recordings/card-1.recording.json"]) {
      expect(gitBytes(world.remote, ["cat-file", "blob", `${commit}:releases/${RELEASE_ID}/${path}`])).toEqual(readFileSync(join(dir, path)));
    }
    expect(storeObjects(world.store)).toEqual(before);
    const stored = parseRecord("PublicationRecord", readFileSync(join(world.state, "releases", RELEASE_ID, "record.json")));
    expect(stored.status).toBe("published");
    expect(stored.root_execution_id).toBe(ROOT_ID);
  });

  it("is idempotent: a second call prints the same record and makes no commit", async () => {
    const { world, run } = await publishedWorld();
    const dir = writeRelease(world, run);
    const first = await release(world, dir);
    const second = await release(world, dir);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(commitCount(world.remote)).toBe(2);
    const fresh = await release(world, dir, join(tempDir(), "state"));
    expect(fresh.code).toBe(0);
    expect(printed(fresh).repository_commit).toBe(printed(first).repository_commit);
    expect(commitCount(world.remote)).toBe(2);
  });

  it("refuses repository_conflict when the run is not published", async () => {
    const world = createWorld();
    const result = await release(world, writeRelease(world, { manifest_sha256: "7".repeat(64), publication_id: "00000000-0000-4000-8000-000000000701", repository_commit: "b".repeat(40) }));
    expect(result.code).toBe(2);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "repository_conflict" });
    expect(commitCount(world.remote)).toBe(0);
  });

  it("refuses repository_conflict when the published run's manifest has another hash", async () => {
    const { world, run } = await publishedWorld();
    const result = await release(world, writeRelease(world, { ...run, manifest_sha256: "7".repeat(64) }));
    expect(result.code).toBe(2);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "repository_conflict" });
    expect(commitCount(world.remote)).toBe(1);
  });

  it("refuses repository_conflict when the release directory is published with other bytes", async () => {
    const { world, run } = await publishedWorld();
    expect((await release(world, writeRelease(world, run))).code).toBe(0);
    const other = await release(world, writeRelease(world, run, { issue: "Another synthetic issue title" }), join(tempDir(), "state"));
    expect(other.code).toBe(2);
    expect(printed(other)).toMatchObject({ status: "failed", failure_reason: "repository_conflict" });
    expect(commitCount(world.remote)).toBe(2);
  });

  it("blocks a release whose files hold a forbidden term, and publishes nothing", async () => {
    const { world, run } = await publishedWorld();
    const result = await release(world, writeRelease(world, run, { issue: `Synthetic ${FORBIDDEN_TERM} title` }));
    expect(result.code).toBe(1);
    expect(printed(result)).toMatchObject({ status: "blocked", failure_reason: "scan_blocked", artifacts: [] });
    expect(result.stderr).toMatch(new RegExp(`releases/${RELEASE_ID}/issue.json:1`));
    expect(result.stderr).not.toContain(FORBIDDEN_TERM);
    expect(commitCount(world.remote)).toBe(1);
  });

  it("refuses a release directory whose files differ from release.json, before contacting anything", async () => {
    const { world, run } = await publishedWorld();
    const dir = writeRelease(world, run);
    write(join(dir, "issue.json"), encodeCanonical({ title: "changed" }));
    const result = await release(world, dir);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("invalid input: release_files_mismatch");
    expect(commitCount(world.remote)).toBe(1);
  });
});
