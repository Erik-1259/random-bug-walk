import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPolicy } from "@rbw/schema";
import { runProcess, type ProcessRunner } from "../src/process.ts";
import {
  BIG_FILE,
  CHILD_ID,
  PROJECT_ID,
  ROOT_ID,
  bigFileBytes,
  commitCount,
  createWorld,
  defaultOmissions,
  events,
  expectNotPublished,
  git,
  headCommit,
  listFiles,
  printed,
  publish,
  sha256,
  stage,
  statusObject,
  storeObjects,
  tempDir,
  write,
  writeRootRun,
  type World,
} from "./support.ts";

describe("non-terminal roots", () => {
  for (const status of ["prepared", "running", "needs_reconciliation"] as const) {
    it(`writes only the status object for ${status} and exits 3`, async () => {
      const world = createWorld();
      mkdirSync(world.staging);
      write(join(world.staging, "report.md"), "unreadable\n");
      chmodSync(world.staging, 0o000);
      const result = await publish(world, writeRootRun(world, { status }));
      chmodSync(world.staging, 0o700);
      expect(result.code).toBe(3);
      const printedStatus = JSON.parse(result.stdout) as Record<string, unknown>;
      const stored = statusObject(world);
      expect(stored).toEqual(printedStatus);
      expect(Object.keys(stored ?? {}).sort()).toEqual(
        [
          "child_execution_count",
          "declared_stage_count",
          "kind",
          "outcome",
          "project_policy_sha256",
          "publication_status",
          "root_execution_id",
          "schema_version",
          "status",
        ].sort(),
      );
      expect(stored).toMatchObject({ status, outcome: null, publication_status: null, declared_stage_count: 3, child_execution_count: 1 });
      expect(listFiles(world.store)).toEqual([`status/${ROOT_ID}.json`]);
      expect(readFileSync(join(world.store, "status", `${ROOT_ID}.json`), "utf8")).not.toContain(CHILD_ID);
      expect(commitCount(world.remote)).toBe(0);
      // The only state is the root's persisted limits; there is no candidate.
      expect(listFiles(world.state)).toEqual([join("roots", ROOT_ID, "limits.json")]);
    });
  }

  it("writes nothing when the status scan is blocked or unavailable", async () => {
    const world = createWorld();
    const unavailable = await publish(world, writeRootRun(world, { status: "running" }), ["--patterns", join(world.dir, "absent.txt")]);
    expect(unavailable.code).toBe(2);
    expect(listFiles(world.store)).toEqual([]);
    write(world.patterns, `${ROOT_ID}\n`);
    const blocked = await publish(world, writeRootRun(world, { status: "running" }));
    expect(blocked.code).toBe(1);
    expect(listFiles(world.store)).toEqual([]);
    expect(existsSync(world.state)).toBe(false);
  });
});

function seedConflict(world: World): string {
  const work = tempDir("rbw-conflict-");
  git(work, ["init", "-q", "-b", "main"]);
  write(join(work, "runs", ROOT_ID, "manifest.json"), "{}");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "chore: synthetic conflicting run"]);
  git(work, ["push", "-q", world.remote, "main"]);
  return git(world.remote, ["rev-parse", "main"]);
}

describe("conflicts", () => {
  it("records repository_conflict when a different tree exists at runs/<root>/", async () => {
    const world = createWorld();
    const head = seedConflict(world);
    stage(world.staging);
    const result = await publish(world, writeRootRun(world));
    expect(result.code).toBe(2);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "repository_conflict" });
    expect(headCommit(world.remote)).toBe(head);
    expect(storeObjects(world.store)).toEqual([]);
    expectNotPublished(result, world);
  });

  it("records store_mismatch when a store key holds other bytes", async () => {
    const world = createWorld();
    stage(world.staging);
    const key = sha256(bigFileBytes());
    write(join(world.store, "sha256", key), "different bytes\n");
    const result = await publish(world, writeRootRun(world));
    expect(result.code).toBe(2);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "store_mismatch" });
    expect(readFileSync(join(world.store, "sha256", key), "utf8")).toBe("different bytes\n");
    expect(storeObjects(world.store)).toEqual([key]);
    expect(commitCount(world.remote)).toBe(0);
    expectNotPublished(result, world);
  });

  it("records store_mismatch when an object of a run already on the remote is wrong", async () => {
    const world = createWorld();
    stage(world.staging);
    const rootRun = writeRootRun(world);
    expect((await publish(world, rootRun)).code).toBe(0);
    const key = sha256(bigFileBytes());
    writeFileSync(join(world.store, "sha256", key), "tampered\n");
    const fresh = await publish(world, rootRun, ["--state", join(world.dir, "private", "fresh-state")]);
    expect(fresh.code).toBe(2);
    expect(printed(fresh)).toMatchObject({ status: "failed", failure_reason: "store_mismatch" });
    expect(BIG_FILE).toContain("big.bin");
  });
});

describe("frozen candidate integrity", () => {
  function candidateDir(world: World, publicationId: string): string {
    return join(world.state, "roots", ROOT_ID, "candidates", publicationId);
  }

  it("records candidate_corrupt when the frozen file list no longer matches the manifest", async () => {
    const world = createWorld();
    stage(world.staging);
    const rootRun = writeRootRun(world);
    const first = printed(await publish(world, rootRun, ["--patterns", join(world.dir, "absent.txt")]));
    expect(first.failure_reason).toBe("scan_unavailable");
    const filesPath = join(candidateDir(world, first.publication_id), "files.json");
    const files = JSON.parse(readFileSync(filesPath, "utf8")) as { sha256: string; size_bytes: number }[];
    const [a, b] = files;
    if (a === undefined || b === undefined) throw new Error("expected two frozen files");
    // Each entry still names an intact blob with its true size, but not the bytes the manifest lists.
    [a.sha256, b.sha256, a.size_bytes, b.size_bytes] = [b.sha256, a.sha256, b.size_bytes, a.size_bytes];
    writeFileSync(filesPath, JSON.stringify(files));
    const result = await publish(world, rootRun);
    expect(result.code).toBe(2);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "candidate_corrupt", publication_id: first.publication_id });
    expect(commitCount(world.remote)).toBe(0);
    expect(storeObjects(world.store)).toEqual([]);
    // The status object is rewritten with the record's status on this path too.
    expect(statusObject(world)?.publication_status).toBe("failed");
  });

  it("records candidate_corrupt under the same publication ID when the frozen manifest is replaced", async () => {
    const world = createWorld();
    stage(world.staging);
    const rootRun = writeRootRun(world);
    const first = printed(await publish(world, rootRun, ["--patterns", join(world.dir, "absent.txt")]));
    const manifestPath = join(candidateDir(world, first.publication_id), "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { declared_stages: string[] };
    manifest.declared_stages = ["synthetic_stage"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = await publish(world, rootRun);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "candidate_corrupt", publication_id: first.publication_id });
    expect(commitCount(world.remote)).toBe(0);
  });

  it("records candidate_corrupt when a frozen blob changes", async () => {
    const world = createWorld();
    stage(world.staging);
    const rootRun = writeRootRun(world);
    const first = printed(await publish(world, rootRun, ["--patterns", join(world.dir, "absent.txt")]));
    const blob = first.artifacts.find((artifact) => artifact.path === "inputs/task.md");
    writeFileSync(join(candidateDir(world, first.publication_id), "blobs", blob?.sha256 ?? "missing"), "tampered\n");
    const result = await publish(world, rootRun);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "candidate_corrupt" });
    expect(commitCount(world.remote)).toBe(0);
  });
});

describe("limits", () => {
  const rejectAll = (calls: string[][]): ProcessRunner => async (call) => {
    if (call.command === "git" && call.args.includes("push")) {
      calls.push([...call.args]);
      return { code: 1, spawnFailed: false, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.from("rejected") };
    }
    return runProcess(call);
  };

  it("refuses a fourth push attempt and then stops", async () => {
    const world = createWorld();
    stage(world.staging);
    const rootRun = writeRootRun(world);
    const pushes: string[][] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await publish(world, rootRun, [], { runner: rejectAll(pushes) });
      expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "repository_unavailable" });
    }
    expect(pushes).toHaveLength(3);
    const fourth = await publish(world, rootRun, [], { runner: rejectAll(pushes) });
    expect(printed(fourth)).toMatchObject({ status: "failed", failure_reason: "limit_exceeded" });
    expect(pushes).toHaveLength(3);
    // The fourth call only inspects the remote; it reads and uploads nothing.
    expect(events(fourth, "fetch")).toHaveLength(1);
    expect(events(fourth, "store_read")).toEqual([]);
    // No command raises or resets a limit: a larger configured limit does not help.
    const raised = await publish(world, rootRun, ["--limit-push-attempts", "10"]);
    expect(printed(raised)).toMatchObject({ status: "failed", failure_reason: "limit_exceeded" });
    expect(events(raised, "fetch")).toEqual([]);
    expect(commitCount(world.remote)).toBe(0);
    expectNotPublished(raised, world);
  });

  it("stops at the repository metadata request limit", async () => {
    const world = createWorld();
    const work = tempDir("rbw-seed-");
    git(work, ["init", "-q", "-b", "main"]);
    write(join(work, "README.md"), "seed\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "chore: seed"]);
    git(work, ["push", "-q", world.remote, "main"]);
    stage(world.staging);
    const rootRun = writeRootRun(world);
    const first = await publish(world, rootRun, ["--limit-metadata-requests", "1"], { runner: rejectAll([]) });
    expect(printed(first)).toMatchObject({ status: "failed", failure_reason: "repository_unavailable" });
    expect(events(first, "fetch")).toHaveLength(1);
    const result = await publish(world, rootRun, ["--limit-metadata-requests", "1"]);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "limit_exceeded" });
    expect(events(result, "fetch")).toEqual([]);
    expect(commitCount(world.remote)).toBe(1);
  });

  it("stops at the new public bytes limit before uploading", async () => {
    const world = createWorld();
    stage(world.staging);
    const result = await publish(world, writeRootRun(world), ["--limit-new-public-bytes", "2048"]);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "limit_exceeded" });
    expect(storeObjects(world.store)).toEqual([]);
    expect(statusObject(world)?.publication_status).toBe("failed");
    expect(commitCount(world.remote)).toBe(0);
  });

  it("stops at the transfer limit", async () => {
    const world = createWorld();
    stage(world.staging);
    const result = await publish(world, writeRootRun(world), ["--limit-transfer-bytes", "1000"]);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "limit_exceeded" });
    expect(commitCount(world.remote)).toBe(0);
  });

  it("stops at the store operation limit", async () => {
    const world = createWorld();
    stage(world.staging);
    const result = await publish(world, writeRootRun(world), ["--limit-store-operations", "1"]);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "limit_exceeded" });
    expect(commitCount(world.remote)).toBe(0);
  });
});

describe("invalid input", () => {
  function expectInvalid(result: { code: number; stdout: string }, world: World): void {
    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(existsSync(world.state)).toBe(false);
    expect(listFiles(world.store)).toEqual([]);
    expect(commitCount(world.remote)).toBe(0);
  }

  it("refuses an evaluation policy", async () => {
    const world = createWorld();
    stage(world.staging);
    const evaluation = buildPolicy({ projectId: PROJECT_ID, outputRepository: null, publicArtifactBaseUri: null, policyVersion: 1 });
    writeFileSync(world.policyFile, evaluation.bytes);
    world.policySha256 = evaluation.sha256;
    expectInvalid(await publish(world, writeRootRun(world)), world);
  });

  it("refuses policy bytes that are not canonical", async () => {
    const world = createWorld();
    stage(world.staging);
    const text = readFileSync(world.policyFile, "utf8");
    writeFileSync(world.policyFile, `${text}\n`);
    expectInvalid(await publish(world, writeRootRun(world)), world);
  });

  it("refuses a root run with another policy hash or project", async () => {
    const world = createWorld();
    stage(world.staging);
    const rootRun = writeRootRun(world);
    const parsed = JSON.parse(readFileSync(rootRun, "utf8")) as Record<string, unknown>;
    writeFileSync(rootRun, JSON.stringify({ ...parsed, project_policy_sha256: "e".repeat(64) }));
    expectInvalid(await publish(world, rootRun), world);
    writeFileSync(rootRun, JSON.stringify({ ...parsed, project_id: "00000000-0000-4000-8000-000000000002" }));
    expectInvalid(await publish(world, rootRun), world);
  });

  it("refuses a state directory inside staging", async () => {
    const world = createWorld();
    stage(world.staging);
    const result = await publish(world, writeRootRun(world), ["--state", join(world.staging, "state")]);
    expect(result.code).toBe(4);
    expect(existsSync(join(world.staging, "state"))).toBe(false);
  });

  const stagingCases: [string, (world: World) => void][] = [
    ["a symlink", (world) => { symlinkSync("/etc/hostname", join(world.staging, "inputs", "link.txt")); }],
    ["a dot segment", (world) => write(join(world.staging, "inputs", ".hidden"), "x")],
    ["a case collision", (world) => write(join(world.staging, "inputs", "TASK.md"), "x")],
    ["an extra top-level entry", (world) => write(join(world.staging, "extra.txt"), "x")],
    ["a manifest.json at the top level", (world) => write(join(world.staging, "manifest.json"), "{}")],
    ["an unknown child ID", (world) => write(join(world.staging, "logs", "00000000-0000-4000-8000-000000000999", "x.log"), "x")],
    ["a bad segment character", (world) => write(join(world.staging, "inputs", "a b.txt"), "x")],
    ["an unknown execution deeper in a path", (world) => write(join(world.staging, "results", "sub", "00000000-0000-4000-8000-000000000999", "x.txt"), "x")],
    ["an execution ID used as a trial directory", (world) => write(join(world.staging, "results", CHILD_ID, "00000000-0000-4000-8000-000000000999", "x.txt"), "x")],
    ["a malformed omissions file", (world) => write(join(world.staging, "omissions.json"), '{"schema_version":1,"entries":[]}')],
    ["non-canonical-parseable omissions", (world) => write(join(world.staging, "omissions.json"), '{"schema_version":1,"schema_version":1,"entries":[],"redactions":[]}')],
    [
      "a redaction declared for a path that is not staged",
      (world) => {
        const omissions = defaultOmissions() as { redactions: unknown[] };
        omissions.redactions.push({ path: "logs/absent.log", category: "credential", count: 1 });
        write(join(world.staging, "omissions.json"), JSON.stringify(omissions));
      },
    ],
    [
      "a truncated declaration for a path that is not staged",
      (world) => {
        const omissions = defaultOmissions() as { entries: unknown[] };
        omissions.entries.push({ outcome: "truncated", path: "logs/absent.log", execution_id: ROOT_ID, trial_id: null, reason: "size_limit" });
        write(join(world.staging, "omissions.json"), JSON.stringify(omissions));
      },
    ],
    [
      "a not_produced declaration for a staged path",
      (world) => {
        const omissions = defaultOmissions() as { entries: unknown[] };
        omissions.entries.push({ outcome: "not_produced", path: "inputs/task.md", execution_id: ROOT_ID, trial_id: null, reason: "stage_failed" });
        write(join(world.staging, "omissions.json"), JSON.stringify(omissions));
      },
    ],
    [
      "a declaration whose execution does not match its path",
      (world) => {
        const omissions = defaultOmissions() as { entries: unknown[] };
        omissions.entries.push({ outcome: "not_produced", path: "logs/missing.log", execution_id: CHILD_ID, trial_id: null, reason: "stage_failed" });
        write(join(world.staging, "omissions.json"), JSON.stringify(omissions));
      },
    ],
  ];

  for (const [label, arrange] of stagingCases) {
    it(`refuses staging with ${label}`, async () => {
      const world = createWorld();
      stage(world.staging);
      arrange(world);
      expectInvalid(await publish(world, writeRootRun(world)), world);
    });
  }

  it("refuses a dot-dot segment in a declared path", async () => {
    const world = createWorld();
    const omissions = defaultOmissions() as { entries: unknown[] };
    omissions.entries.push({ outcome: "not_produced", path: "logs/../x.log", execution_id: ROOT_ID, trial_id: null, reason: "stage_failed" });
    stage(world.staging, { omissions });
    expectInvalid(await publish(world, writeRootRun(world)), world);
  });

  it("refuses real-mode destinations that differ from the policy", async () => {
    const world = createWorld();
    stage(world.staging);
    const result = await publish(world, writeRootRun(world), [
      "--real",
      "--repository-url",
      "https://example.invalid/synthetic-owner/other",
      "--artifact-base-uri",
      "https://example.invalid/synthetic-store/test-prefix/",
    ]);
    expectInvalid(result, world);
  });
});

describe("local remote hooks", () => {
  it("refuses a local remote with an executable hook, which receive-pack would run", async () => {
    const world = createWorld();
    stage(world.staging);
    const marker = join(world.dir, "hook-ran");
    const hook = write(join(world.remote, "hooks", "pre-receive"), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    const result = await publish(world, writeRootRun(world));
    expect(result.code).toBe(4);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(world.state)).toBe(false);
    expect(commitCount(world.remote)).toBe(0);
  });

  it("refuses a local remote whose configuration sets core.hooksPath", async () => {
    const world = createWorld();
    stage(world.staging);
    git(world.remote, ["config", "core.hooksPath", join(world.dir, "elsewhere")]);
    const result = await publish(world, writeRootRun(world));
    expect(result.code).toBe(4);
    expect(commitCount(world.remote)).toBe(0);
  });

  it("accepts a local remote that holds only sample hooks", async () => {
    const world = createWorld();
    stage(world.staging);
    write(join(world.remote, "hooks", "pre-receive.sample"), "#!/bin/sh\nexit 1\n");
    expect((await publish(world, writeRootRun(world))).code).toBe(0);
  });
});
