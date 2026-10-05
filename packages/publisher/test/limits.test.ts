import { rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LIMITS, type Limits } from "../src/config.ts";
import { Budget, LimitExceeded } from "../src/limits.ts";
import { StateDir } from "../src/state.ts";
import { describe, expect, it } from "vitest";
import { runProcess, type ProcessRunner } from "../src/process.ts";
import {
  commitCount,
  createWorld,
  events,
  expectNotPublished,
  git,
  headCommit,
  printed,
  publish,
  readPublished,
  stage,
  statusObject,
  storeObjects,
  tempDir,
  write,
  writeRootRun,
  type World,
} from "./support.ts";

// A large object well above the threshold, so its size dominates the byte limits.
const BIG_SIZE = 20_000;
const BIG = Buffer.alloc(BIG_SIZE, "a");

function bigWorld(): World {
  const world = createWorld();
  stage(world.staging, { big: BIG });
  return world;
}

/** Bytes of the repository payload (the manifest and the small files) of the staged run. */
async function repositoryPayload(): Promise<number> {
  const world = bigWorld();
  const record = printed(await publish(world, writeRootRun(world)));
  expect(record.status).toBe("published");
  return record.artifacts.filter((artifact) => artifact.public_uri === null).reduce((total, artifact) => total + artifact.size_bytes, 0);
}

function seedRemote(world: World): void {
  const work = tempDir("rbw-seed-");
  git(work, ["init", "-q", "-b", "main"]);
  write(join(work, "README.md"), "seed\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "chore: seed"]);
  git(work, ["push", "-q", world.remote, "main"]);
}

const rejected = { code: 1, spawnFailed: false, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.from("rejected") };
const isPush = (args: readonly string[]): boolean => args.includes("push");

describe("byte accounting", () => {
  it("charges no transfer for the existence check of a missing object", async () => {
    // Before uploading, the object is missing: only the upload and the read-back transfer bytes.
    const world = bigWorld();
    const result = await publish(world, writeRootRun(world), ["--limit-transfer-bytes", String(3 * BIG_SIZE - 1)]);
    expect(printed(result).status).toBe("published");
    expect(storeObjects(world.store)).toHaveLength(1);
  });

  it("refuses before uploading when the expected transfer cannot fit", async () => {
    const payload = await repositoryPayload();
    const world = bigWorld();
    const result = await publish(world, writeRootRun(world), ["--limit-transfer-bytes", String(2 * BIG_SIZE + Math.floor(payload / 2))]);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "limit_exceeded" });
    expect(storeObjects(world.store)).toEqual([]);
    expect(events(result, "store_put")).toEqual([]);
    expect(commitCount(world.remote)).toBe(0);
  });

  it("refuses before uploading when the new public bytes cannot fit", async () => {
    const payload = await repositoryPayload();
    const world = bigWorld();
    const result = await publish(world, writeRootRun(world), ["--limit-new-public-bytes", String(BIG_SIZE + Math.floor(payload / 2))]);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "limit_exceeded" });
    expect(storeObjects(world.store)).toEqual([]);
    expect(commitCount(world.remote)).toBe(0);
  });

  it("counts the repository payload as new public bytes once across retries", async () => {
    const payload = await repositoryPayload();
    const world = bigWorld();
    const rootRun = writeRootRun(world);
    const limit = ["--limit-new-public-bytes", String(BIG_SIZE + payload + Math.floor(payload / 2))];
    let pushes = 0;
    const rejectFirst: ProcessRunner = async (call) => {
      if (call.command === "git" && isPush(call.args) && pushes++ === 0) return rejected;
      return runProcess(call);
    };
    const first = await publish(world, rootRun, limit, { runner: rejectFirst });
    expect(printed(first)).toMatchObject({ status: "failed", failure_reason: "repository_unavailable" });
    const second = await publish(world, rootRun, limit, { runner: rejectFirst });
    expect(printed(second).status).toBe("published");
    expect(commitCount(world.remote)).toBe(1);
  });
});

describe("recovery after the last allowed push", () => {
  it("records published when the third push reached the remote but was reported as failed", async () => {
    const world = createWorld();
    seedRemote(world);
    stage(world.staging);
    const rootRun = writeRootRun(world);
    let pushes = 0;
    // The first two pushes are rejected; the third updates the remote and then loses the connection.
    const flaky: ProcessRunner = async (call) => {
      if (call.command !== "git" || !isPush(call.args)) return runProcess(call);
      pushes += 1;
      if (pushes < 3) return rejected;
      await runProcess(call);
      return rejected;
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await publish(world, rootRun, [], { runner: flaky });
      expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "repository_unavailable" });
    }
    expect(commitCount(world.remote)).toBe(2);
    const landed = headCommit(world.remote);

    const recovered = await publish(world, rootRun, [], { runner: flaky });
    expect(recovered.code).toBe(0);
    expect(printed(recovered)).toMatchObject({ status: "published", repository_commit: landed });
    expect(pushes).toBe(3);
    expect(events(recovered, "push")).toEqual([]);
    expect(commitCount(world.remote)).toBe(2);
    expect(statusObject(world)?.publication_status).toBe("published");
    readPublished(world);
  });

  it("uses one repository metadata request per attempt", async () => {
    const world = createWorld();
    seedRemote(world);
    stage(world.staging);
    const result = await publish(world, writeRootRun(world), ["--limit-metadata-requests", "1"]);
    expect(printed(result).status).toBe("published");
    expect(events(result, "fetch")).toHaveLength(1);
  });

  it("still refuses a fourth push after inspecting the remote", async () => {
    const world = createWorld();
    stage(world.staging);
    const rootRun = writeRootRun(world);
    const pushes: string[][] = [];
    const rejectAll: ProcessRunner = async (call) => {
      if (call.command !== "git" || !isPush(call.args)) return runProcess(call);
      pushes.push([...call.args]);
      return rejected;
    };
    for (let attempt = 1; attempt <= 4; attempt += 1) await publish(world, rootRun, [], { runner: rejectAll });
    expect(pushes).toHaveLength(3);
    const after = await publish(world, rootRun, [], { runner: rejectAll });
    expect(printed(after)).toMatchObject({ status: "failed", failure_reason: "limit_exceeded" });
    expect(events(after, "fetch")).toEqual([]);
    expectNotPublished(after, world);
  });
});

describe("status-only calls", () => {
  it("count store operations against the root's persisted limit", async () => {
    const world = createWorld();
    const rootRun = writeRootRun(world, { status: "running" });
    const limit = ["--limit-store-operations", "2"];
    expect((await publish(world, rootRun, limit)).code).toBe(3);
    expect((await publish(world, rootRun, limit)).code).toBe(3);
    rmSync(join(world.store, "status"), { recursive: true });
    const third = await publish(world, rootRun, limit);
    expect(third.code).toBe(2);
    expect(third.stderr).toContain("status object not written: limit_exceeded");
    expect(statusObject(world)).toBeNull();
  });
});

describe("persisted root limits", () => {
  it("keeps a lowered limit for later runs that use the default configuration", () => {
    const state = new StateDir(tempDir("rbw-limits-"));
    const configured = (storeOperations: number): Limits => ({ ...DEFAULT_LIMITS, storeOperations });
    expect(new Budget(state, "synthetic-root", configured(200)).remaining("storeOperations")).toBe(200);
    expect(new Budget(state, "synthetic-root", configured(2)).remaining("storeOperations")).toBe(2);
    const third = new Budget(state, "synthetic-root", DEFAULT_LIMITS);
    expect(third.remaining("storeOperations")).toBe(2);
    third.spend("storeOperations", 2);
    expect(() => { third.spend("storeOperations", 1); }).toThrow(LimitExceeded);
  });
});
