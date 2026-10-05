import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess, type ProcessRunner } from "../src/process.ts";
import {
  AGENT_LOG,
  BIG_FILE,
  CHILD_ID,
  HEADER_SECRET,
  COOKIE_SECRET,
  LISTED_VALUE,
  OTHER_ROOT_ID,
  ROOT_ID,
  RUN_LOG,
  RUN_LOG_BYTES,
  commitCount,
  createWorld,
  events,
  git,
  headCommit,
  printed,
  publish,
  readPublished,
  sha256,
  stage,
  statusObject,
  storeObjects,
  tempDir,
  write,
  writeRootRun,
} from "./support.ts";

function seedRemote(remote: string): string {
  const work = tempDir("rbw-seed-");
  git(work, ["init", "-q", "-b", "main"]);
  write(join(work, ".gitattributes"), "* text=auto eol=lf\n*.log text eol=lf\n");
  write(join(work, "README.md"), "Synthetic results repository.\n");
  write(join(work, "runs", "unrelated", "keep.txt"), "unrelated content\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "chore: seed synthetic remote"]);
  git(work, ["push", "-q", remote, "main"]);
  return git(remote, ["rev-parse", "main"]);
}

describe("terminal publish", () => {
  it("publishes a completed root to an empty remote with its first commit", async () => {
    const world = createWorld();
    stage(world.staging);
    const result = await publish(world, writeRootRun(world));
    expect(result.stderr).not.toContain("internal error");
    expect(result.code).toBe(0);
    const record = printed(result);
    expect(record.status).toBe("published");
    expect(record.failure_reason).toBeNull();

    const published = readPublished(world);
    expect(record.repository_commit).toBe(published.commit);
    expect(commitCount(world.remote)).toBe(1);
    expect(git(world.remote, ["rev-list", "--parents", "-n", "1", published.commit])).toBe(published.commit);
    expect(record.manifest_sha256).toBe(sha256(published.manifestBytes));

    // Commit identity, dates, message and the absence of trailers and signatures.
    const raw = git(world.remote, ["cat-file", "commit", published.commit]);
    expect(raw).toMatch(/^author Random Bug Walk <> \d+ \+0000$/m);
    expect(raw).toMatch(/^committer Random Bug Walk <> \d+ \+0000$/m);
    expect(raw).not.toMatch(/^gpgsig/m);
    expect(raw.split("\n\n").slice(1).join("\n\n")).toBe(`chore(runs): publish ${ROOT_ID}`);
    expect(git(world.remote, ["ls-tree", "-r", "--name-only", published.commit]).split("\n").every((path) => path.startsWith(`runs/${ROOT_ID}/`))).toBe(true);

    // One large object in the store, referenced by URI, and absent from the repository.
    expect(storeObjects(world.store)).toHaveLength(1);
    const big = published.manifest.entries.find((entry) => entry.path === BIG_FILE);
    expect(big?.public_uri).not.toBeNull();
    expect(published.files.has(BIG_FILE)).toBe(false);

    // CRLF and trailing spaces survive byte for byte.
    expect(published.files.get(RUN_LOG)?.equals(RUN_LOG_BYTES)).toBe(true);

    // The record lists every published byte stream, sorted by path, and the omissions in manifest order.
    const expectedArtifacts = [
      ...published.manifest.entries
        .filter((entry) => entry.outcome === "published" || entry.outcome === "truncated")
        .map((entry) => ({ path: entry.path, sha256: entry.sha256, size_bytes: entry.size_bytes, public_uri: entry.public_uri })),
      { path: "manifest.json", sha256: sha256(published.manifestBytes), size_bytes: published.manifestBytes.length, public_uri: null },
    ].sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(record.artifacts).toEqual(expectedArtifacts);
    expect(record.omissions).toEqual([
      { category: "not_produced", reason: "stage_failed" },
      { category: "withheld_private", reason: "private_material" },
    ]);
    expect(statusObject(world)?.publication_status).toBe("published");
  });

  it("publishes an incomplete root on top of an existing branch without touching other paths", async () => {
    const world = createWorld();
    const seeded = seedRemote(world.remote);
    stage(world.staging, { report: false });
    const result = await publish(world, writeRootRun(world, { outcome: "incomplete" }));
    expect(result.code).toBe(0);
    const published = readPublished(world);
    expect(git(world.remote, ["rev-parse", `${published.commit}^`])).toBe(seeded);
    expect(git(world.remote, ["diff", "--name-only", seeded, published.commit]).split("\n").every((path) => path.startsWith(`runs/${ROOT_ID}/`))).toBe(true);
    expect(git(world.remote, ["show", `${published.commit}:runs/unrelated/keep.txt`])).toBe("unrelated content");
    expect(published.manifest.outcome).toBe("incomplete");
    // .gitattributes on the remote asks for conversion; the blobs still hold the exact bytes.
    expect(published.files.get(RUN_LOG)?.equals(RUN_LOG_BYTES)).toBe(true);
    const report = published.manifest.entries.find((entry) => entry.path === "report.md");
    expect(report).toMatchObject({ outcome: "not_produced", reason: "report_missing", sha256: null, size_bytes: null, media_type: null, public_uri: null, redactions: [] });
  });

  it("builds the manifest from the staged run, with redactions as category and count only", async () => {
    const world = createWorld();
    stage(world.staging);
    expect((await publish(world, writeRootRun(world))).code).toBe(0);
    const { manifest, files, manifestBytes } = readPublished(world);
    expect(manifest.executions).toEqual([
      { execution_id: ROOT_ID, parent_execution_id: null },
      { execution_id: CHILD_ID, parent_execution_id: ROOT_ID },
    ]);
    const paths = manifest.entries.map((entry) => entry.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual([
      `generated/${CHILD_ID}/planted-01/fix.patch`,
      "inputs/task.md",
      AGENT_LOG,
      RUN_LOG,
      "report.md",
      `results/${CHILD_ID}/planted-01/big.bin`,
      `results/${CHILD_ID}/planted-01/score.json`,
      "withheld/1",
    ]);
    const agent = manifest.entries.find((entry) => entry.path === AGENT_LOG);
    expect(agent).toMatchObject({ execution_id: CHILD_ID, trial_id: "planted-01", outcome: "published", reason: null });
    expect(agent?.redactions).toEqual([
      { category: "auth_header", count: 2 },
      { category: "credential", count: 2 },
    ]);
    expect(manifest.entries.find((entry) => entry.path === "withheld/1")).toMatchObject({
      execution_id: CHILD_ID,
      trial_id: "planted-01",
      outcome: "withheld_private",
      reason: "private_material",
    });
    expect(manifest.entries.find((entry) => entry.path === "inputs/task.md")).toMatchObject({ execution_id: ROOT_ID, trial_id: null, redactions: [] });
    expect(paths).not.toContain("omissions.json");
    expect(files.has("omissions.json")).toBe(false);
    // The manifest is stored as its canonical bytes and holds no removed value.
    expect(manifestBytes.toString("utf8")).toBe(JSON.stringify(sortKeys(manifest)));
    for (const secret of [LISTED_VALUE, HEADER_SECRET, COOKIE_SECRET]) {
      expect(manifestBytes.toString("utf8")).not.toContain(secret);
      expect(manifestBytes.toString("utf8")).not.toContain(sha256(secret));
    }
  });
});

describe("idempotency", () => {
  it("returns the same record on a second publish with no new commit or upload", async () => {
    const world = createWorld();
    stage(world.staging);
    const rootRun = writeRootRun(world);
    const first = await publish(world, rootRun);
    expect(first.code).toBe(0);
    const objects = storeObjects(world.store);
    const head = headCommit(world.remote);
    const second = await publish(world, rootRun);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(headCommit(world.remote)).toBe(head);
    expect(storeObjects(world.store)).toEqual(objects);
    expect(events(second, "store_put")).toEqual([]);
    expect(events(second, "push")).toEqual([]);
    expect(events(second, "fetch")).toEqual([]);
  });

  it("retries after a rejected push without re-uploading and keeps the same IDs", async () => {
    const world = createWorld();
    stage(world.staging);
    const rootRun = writeRootRun(world);
    let rejected = 0;
    const rejectOnce: ProcessRunner = async (call) => {
      if (call.command === "git" && call.args.includes("push") && rejected === 0) {
        rejected += 1;
        return { code: 1, spawnFailed: false, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.from("rejected") };
      }
      return runProcess(call);
    };
    const first = await publish(world, rootRun, [], { runner: rejectOnce });
    expect(first.code).toBe(2);
    const failed = printed(first);
    expect(failed).toMatchObject({ status: "failed", failure_reason: "repository_unavailable", repository_commit: null });
    expect(storeObjects(world.store)).toHaveLength(1);
    expect(commitCount(world.remote)).toBe(0);
    expect(statusObject(world)?.publication_status).toBe("failed");

    const second = await publish(world, rootRun);
    expect(second.code).toBe(0);
    const record = printed(second);
    expect(record.status).toBe("published");
    expect(record.publication_id).toBe(failed.publication_id);
    expect(record.manifest_sha256).toBe(failed.manifest_sha256);
    expect(events(second, "store_put")).toEqual([]);
    expect(commitCount(world.remote)).toBe(1);
    readPublished(world);
  });

  it("recovers from a crash between the push and the record without a second commit or upload", async () => {
    const world = createWorld();
    stage(world.staging);
    const rootRun = writeRootRun(world);
    const crashAfterPush: ProcessRunner = async (call) => {
      const result = await runProcess(call);
      if (call.command === "git" && call.args.includes("push") && result.code === 0) throw new Error("synthetic crash");
      return result;
    };
    const crashed = await publish(world, rootRun, [], { runner: crashAfterPush });
    expect(crashed.code).toBe(2);
    expect(crashed.stdout).toBe("");
    expect(commitCount(world.remote)).toBe(1);
    const head = headCommit(world.remote);
    const objects = storeObjects(world.store);

    const retry = await publish(world, rootRun);
    expect(retry.code).toBe(0);
    const record = printed(retry);
    expect(record.repository_commit).toBe(head);
    expect(headCommit(world.remote)).toBe(head);
    expect(storeObjects(world.store)).toEqual(objects);
    expect(events(retry, "store_put")).toEqual([]);
    expect(events(retry, "push")).toEqual([]);
    expect(events(retry, "store_read").length).toBeGreaterThanOrEqual(1);

    // A fresh state directory with unchanged staging and values freezes the same candidate.
    const fresh = await publish(world, rootRun, ["--state", join(world.dir, "private", "fresh-state")]);
    expect(fresh.code).toBe(0);
    const freshRecord = printed(fresh);
    expect(freshRecord.publication_id).toBe(record.publication_id);
    expect(freshRecord.manifest_sha256).toBe(record.manifest_sha256);
    expect(freshRecord.repository_commit).toBe(head);
    expect(headCommit(world.remote)).toBe(head);
    expect(events(fresh, "store_put")).toEqual([]);
  });

  it("publishes the frozen bytes after staging changes or disappears", async () => {
    const world = createWorld();
    stage(world.staging);
    const rootRun = writeRootRun(world);
    const unavailable = await publish(world, rootRun, ["--patterns", join(world.dir, "private", "missing-patterns.txt")]);
    expect(printed(unavailable)).toMatchObject({ status: "failed", failure_reason: "scan_unavailable" });
    const frozen = printed(unavailable);

    writeFileSync(join(world.staging, "inputs", "task.md"), "changed after freezing\n");
    const changed = await publish(world, rootRun, ["--patterns", join(world.dir, "private", "missing-patterns.txt")]);
    expect(printed(changed).manifest_sha256).toBe(frozen.manifest_sha256);

    rmSync(world.staging, { recursive: true, force: true });
    const result = await publish(world, rootRun);
    expect(result.code).toBe(0);
    expect(printed(result).manifest_sha256).toBe(frozen.manifest_sha256);
    expect(readPublished(world).files.get("inputs/task.md")?.toString("utf8")).toBe("Synthetic task description.\n");
  });

  it("keeps two roots apart in one state directory and one remote", async () => {
    const world = createWorld();
    stage(world.staging);
    expect((await publish(world, writeRootRun(world))).code).toBe(0);
    const otherStaging = join(world.dir, "staging-other");
    stage(otherStaging);
    const other = await publish(world, writeRootRun(world, { root: OTHER_ROOT_ID, name: "other" }), ["--staging", otherStaging]);
    expect(other.code).toBe(0);
    expect(commitCount(world.remote)).toBe(2);
    readPublished(world, ROOT_ID);
    readPublished(world, OTHER_ROOT_ID);
    // Both runs share the large object's bytes, so the store keeps one object.
    expect(storeObjects(world.store)).toHaveLength(1);
    expect(readFileSync(join(world.store, "status", `${OTHER_ROOT_ID}.json`), "utf8")).toContain('"publication_status":"published"');
  });
});

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
