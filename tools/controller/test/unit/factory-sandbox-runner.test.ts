import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CopyPlan, CopyRoots } from "@rbw/factory-contract";
import { sha256Hex } from "@rbw/schema";
import { copyOperation } from "../../src/factory-ledger.ts";
import { CopyMeter } from "../../src/factory-meter.ts";
import type { MeterContext } from "../../src/factory-meter.ts";
import type { FactoryRequestRecord } from "../../src/factory-ports.ts";
import { NO_IMAGE_DIGEST, RUN_ONCE_DIR, RUN_ONCE_SCRIPT, SandboxCopyUncertain, createSandboxCopyRunner, pinnedImage, sandboxVcpus } from "../../src/factory-sandbox-runner.ts";
import type { SandboxRunnerDeps } from "../../src/factory-sandbox-runner.ts";
import { CANDIDATE_A, COPY_APP as APP, COPY_CHECK as CHECK, COPY_DIGEST as DIGEST, FakeCopySandbox, acceptRequest, copyPlan, copyRoots, factoryWorld, operationState } from "./factory-fakes.ts";
import type { FactoryWorld } from "./factory-fakes.ts";

let w: FactoryWorld;
let record: FactoryRequestRecord;
let sdk: FakeCopySandbox;
let roots: CopyRoots;
let work: string;

beforeEach(async () => {
  w = await factoryWorld();
  record = await acceptRequest(w);
  sdk = new FakeCopySandbox();
  ({ roots, work } = copyRoots());
});

afterEach(async () => {
  await w.close();
});

function plan(overrides: Partial<CopyPlan> = {}): CopyPlan {
  return copyPlan(overrides);
}

function meter(overrides: Partial<MeterContext> = {}): CopyMeter {
  return new CopyMeter({
    ledger: w.ledger,
    identity: w.identity,
    rates: w.rates,
    now: w.clock.now,
    root: record.root,
    kind: "request",
    task_revision: record.interpretation_sha256,
    budget_key: record.budget_key,
    provider: "vercel-sandbox",
    deadline: new Date(w.clock.ms + 3_600_000),
    margin_s: 120,
    mode: { kind: "own_operation", role: "request" },
    log: (line) => w.logs.push(line),
    ...overrides,
  });
}

function deps(overrides: Partial<SandboxRunnerDeps> = {}): SandboxRunnerDeps {
  return {
    sdk,
    meter: meter(),
    subject: CANDIDATE_A,
    workDir: work,
    resultsSha256: (dir) => Promise.resolve(sha256Hex(Buffer.from(readdirSync(dir).sort().join("\n")))),
    now: () => {
      w.clock.advance(1000);
      return w.clock.ms;
    },
    sleep: () => Promise.resolve(),
    attempt: "synthetic-attempt",
    log: (line) => w.logs.push(line),
    ...overrides,
  };
}

function opId(state: CopyPlan["state"] = "buggy"): string {
  return copyOperation({ identity: w.identity, rates: w.rates }, { kind: "request", root: record.root, task_revision: record.interpretation_sha256, subject: CANDIDATE_A, state, n: 1, host: "task-report", provider: "vercel-sandbox" }).operation_id;
}

/** Runs RUN_ONCE_SCRIPT with the system shell, as the sandbox does, and answers its exit code. */
function runOnce(dir: string, command: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", RUN_ONCE_SCRIPT, "rbw-copy", dir, ...command], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve(code);
    });
  });
}

describe("the sandbox copy runner", () => {
  it("checks and places the files, runs the command once, brings the results back, confirms the stop and settles the copy", async () => {
    const collected = await createSandboxCopyRunner(deps()).run(plan(), roots);
    expect(collected).toMatchObject({ copy_id: "synthetic-copy-buggy-01", outcome: "ran", exit_code: 0, image_digest: DIGEST, architecture: "amd64" });
    expect(collected.results_dir).not.toBeNull();
    expect(readFileSync(join(collected.results_dir ?? "", "record.json"), "utf8")).toBe('{"synthetic":true}\n');
    expect(collected.results_sha256).toBe(sha256Hex(Buffer.from("record.json")));
    expect(Date.parse(collected.finished_at)).toBeGreaterThan(Date.parse(collected.started_at));

    expect(sdk.creates).toHaveLength(1);
    const create = sdk.creates[0];
    expect(create?.image).toBe(`registry.invalid/synthetic/task-report-kit@${DIGEST}`);
    expect(create?.networkPolicy).toBe("deny-all");
    expect(create?.resources.vcpus).toBe(4);
    expect(create?.timeout).toBe((600 + 60) * 1000);
    expect(create?.name).toMatch(/^rbw-fc-[0-9a-f-]{36}$/);
    const fs = sdk.files.get(create?.name ?? "");
    expect(fs?.get("/workspace/app/src/store.ts")?.toString()).toBe(APP);
    expect(fs?.get("/workspace/evaluator/checks/check.txt")?.toString()).toBe(CHECK);
    expect(sdk.commands.filter((command) => command.cmd === "sh")).toHaveLength(1);
    expect(sdk.stops).toEqual([create?.name]);

    const status = await w.spend.operationStatus({ operation_id: opId() });
    expect(status.ok && status.state).toBe("reconciled");
    expect(status.ok && status.settled_microusd > 0n).toBe(true);
  });

  it("returns setup_failed without reserving or creating anything when a file is missing or has another sha256", async () => {
    for (const bad of [plan({ files: [{ path: "src/store.ts", sha256: "0".repeat(64) }] }), plan({ files: [{ path: "src/missing.ts", sha256: "0".repeat(64) }] }), plan({ evaluator_files: [{ path: "checks/check.txt", sha256: "1".repeat(64) }] })]) {
      expect((await createSandboxCopyRunner(deps()).run(bad, roots)).outcome).toBe("setup_failed");
    }
    expect(sdk.creates).toHaveLength(0);
    expect(await operationState(w, opId())).toBeNull();
  });

  it("returns setup_failed for a plan whose image is not pinned by digest", async () => {
    const collected = await createSandboxCopyRunner(deps()).run(plan({ image: { reference: "registry.invalid/synthetic/task-report-kit:1", digest: null } }), roots);
    expect(collected).toMatchObject({ outcome: "setup_failed", image_digest: NO_IMAGE_DIGEST, results_dir: null, results_sha256: null });
    expect(sdk.creates).toHaveLength(0);
    expect(pinnedImage(plan({ image: { reference: `registry.invalid/a/b@sha256:${"1".repeat(64)}`, digest: DIGEST } }))).toBeNull();
    expect(pinnedImage(plan({ image: { reference: "registry.invalid:5000/a/b", digest: DIGEST } }))).toBe(`registry.invalid:5000/a/b@${DIGEST}`);
  });

  it("refuses a plan above its host's copy limits through the meter, creating nothing", async () => {
    const collected = await createSandboxCopyRunner(deps()).run(plan({ limits: { timeout_s: 900, vcpus: 2, memory_mb: 4096, network: "none" } }), roots);
    expect(collected.outcome).toBe("setup_failed");
    expect(sdk.creates).toHaveLength(0);
    expect(await operationState(w, opId())).toBeNull();
  });

  it("gives a plan whose memory needs more vCPUs the vCPUs for it, and settles the size it created", async () => {
    expect(sandboxVcpus(plan({ limits: { timeout_s: 600, vcpus: 2, memory_mb: 8192, network: "none" } }))).toBe(4);
    const runner = createSandboxCopyRunner(deps());
    await runner.run(plan({ state: "clean", limits: { timeout_s: 600, vcpus: 2, memory_mb: 4096, network: "none" } }), roots);
    await runner.run(plan({ state: "fixed" }), roots);
    expect(sdk.creates.map((create) => create.resources.vcpus)).toEqual([2, 4]);
    const settled = async (state: CopyPlan["state"]) => {
      const status = await w.spend.operationStatus({ operation_id: opId(state) });
      if (!status.ok) throw new Error("synthetic: unknown operation");
      return Number(status.settled_microusd) - 1;
    };
    // The same lifetime at half the size settles half the compute and memory (each line rounded up).
    expect(Math.abs(2 * (await settled("clean")) - (await settled("fixed")))).toBeLessThanOrEqual(2);
  });

  it("rejects as uncertain, and never retries, when the create fails", async () => {
    sdk.createError = new Error("synthetic: the answer was lost");
    const runner = createSandboxCopyRunner(deps());
    await expect(runner.run(plan(), roots)).rejects.toThrow(SandboxCopyUncertain);
    expect(sdk.creates).toHaveLength(1);
    expect(await operationState(w, opId())).toBe("uncertain");
  });

  it("stops a sandbox it created when the ledger cannot record it, and rejects as uncertain", async () => {
    const transition = w.spend.transition.bind(w.spend);
    w.ledger.spend = { ...w.spend, transition: (request) => (request.to_state === "running" ? Promise.resolve({ ok: false as const, code: "invalid_transition" as const }) : transition(request)) };
    await expect(createSandboxCopyRunner(deps()).run(plan(), roots)).rejects.toThrow(SandboxCopyUncertain);
    expect(sdk.creates).toHaveLength(1);
    expect(sdk.stops).toEqual([sdk.creates[0]?.name]);
    expect(await operationState(w, opId())).toBe("uncertain");
  });

  it("counts the command's timeout from the create, as the provider does", async () => {
    const asked: number[] = [];
    const never = new AbortController().signal;
    await createSandboxCopyRunner(
      deps({
        timer: (ms) => {
          asked.push(ms);
          return never;
        },
      }),
    ).run(plan(), roots);
    expect(asked).toHaveLength(1);
    // The fake clock moves 1 s per reading: the create, then the setup reading before the command.
    expect(asked[0]).toBeLessThan(600_000);
    expect(asked[0]).toBeGreaterThan(590_000);
  });

  it("rejects as uncertain when the stop cannot be confirmed, keeping the reservation held", async () => {
    sdk.stopTakesEffect = false;
    await expect(createSandboxCopyRunner(deps()).run(plan(), roots)).rejects.toThrow(SandboxCopyUncertain);
    const status = await w.spend.operationStatus({ operation_id: opId() });
    expect(status.ok && [status.state, status.open_microusd > 0n]).toEqual(["uncertain", true]);
  });

  it("reports timed_out when the command passes its timeout, and still stops and settles the copy", async () => {
    const aborted = AbortSignal.abort();
    const collected = await createSandboxCopyRunner(deps({ timer: () => aborted })).run(plan(), roots);
    expect(collected).toMatchObject({ outcome: "timed_out", exit_code: null, results_dir: null, results_sha256: null });
    expect(sdk.stops).toHaveLength(1);
    expect(await operationState(w, opId())).toBe("reconciled");
  });

  it("returns setup_failed when the platform reports another image digest", async () => {
    sdk.reportedImage = `registry.invalid/synthetic/task-report-kit@sha256:${"0".repeat(64)}`;
    const collected = await createSandboxCopyRunner(deps()).run(plan(), roots);
    expect(collected.outcome).toBe("setup_failed");
    expect(sdk.commands).toHaveLength(0);
    expect(sdk.stops).toHaveLength(1);
  });

  it("keeps the exit code of a failing command and brings back no results from an archive with a link", async () => {
    sdk.copy = () => 1;
    expect(await createSandboxCopyRunner(deps()).run(plan(), roots)).toMatchObject({ outcome: "ran", exit_code: 1 });
    sdk.extraEntries = [{ name: "./escape", type: "symlink" }];
    const collected = await createSandboxCopyRunner(deps()).run(plan({ state: "fixed" }), roots);
    expect(collected).toMatchObject({ outcome: "ran", results_dir: null, results_sha256: null });
  });
});

describe("the sandbox copy runner's run-once guard", () => {
  it("runs the plan's command under the run-once guard, from the app directory", async () => {
    await createSandboxCopyRunner(deps()).run(plan(), roots);
    const command = sdk.commands.find((params) => params.cmd === "sh");
    expect(command?.args).toEqual(["-c", RUN_ONCE_SCRIPT, "rbw-copy", RUN_ONCE_DIR, ...plan().command]);
    expect(command?.cwd).toBe("/workspace/app");
  });

  it("runs the command once when it is started twice: the second start waits and exits with the first one's status", { timeout: 20_000 }, async () => {
    const base = mkdtempSync(join(tmpdir(), "rbw-run-once-test-"));
    const count = join(base, "count");
    const command = ["sh", "-c", 'echo ran >> "$1"; sleep 1; exit 3', "synthetic-copy", count];
    const dir = join(base, "once");
    expect(await Promise.all([runOnce(dir, command), runOnce(dir, command)])).toEqual([3, 3]);
    expect(readFileSync(count, "utf8")).toBe("ran\n");
    expect(await runOnce(dir, command)).toBe(3);
    expect(readFileSync(count, "utf8")).toBe("ran\n");
  });
});

describe("the sandbox copy runner's refused copies", () => {
  it("reports a copy refused after a stop as timed_out, creating nothing", async () => {
    const collected = await createSandboxCopyRunner(deps({ meter: meter({ beforeLaunch: () => Promise.resolve(false) }) })).run(plan(), roots);
    expect(collected).toMatchObject({ outcome: "timed_out", results_dir: null, results_sha256: null });
    expect(sdk.creates).toHaveLength(0);
  });

  it("reports a copy that would not end before the deadline as timed_out, creating nothing", async () => {
    const collected = await createSandboxCopyRunner(deps({ meter: meter({ deadline: new Date(w.clock.ms + 60_000) }) })).run(plan(), roots);
    expect(collected.outcome).toBe("timed_out");
    expect(sdk.creates).toHaveLength(0);
  });

  it("reports a refused reservation as timed_out, never setup_failed, and the meter keeps the refusal", async () => {
    w.budgets.create("synthetic-small-budget", record.root, 100_000);
    const small = meter({ budget_key: "synthetic-small-budget" });
    const collected = await createSandboxCopyRunner(deps({ meter: small })).run(plan(), roots);
    expect(collected.outcome).toBe("timed_out");
    expect(small.lastRefusal?.reason).toBe("budget");
    expect(sdk.creates).toHaveLength(0);
  });

  it("reports a halted ledger as timed_out, never setup_failed, and the meter keeps the refusal", async () => {
    const halted = meter({
      ledger: {
        spend: w.spend,
        budgets: { reserve: () => Promise.resolve({ ok: false as const, code: "pool_halted" }), close: (key, cause) => w.budgets.close(key, cause), status: (key) => w.budgets.status(key) },
      },
    });
    const collected = await createSandboxCopyRunner(deps({ meter: halted })).run(plan(), roots);
    expect(collected.outcome).toBe("timed_out");
    expect(halted.lastRefusal?.reason).toBe("halted");
    expect(sdk.creates).toHaveLength(0);
  });

  it("rejects every later copy as uncertain once one copy was uncertain, creating nothing more", async () => {
    sdk.createError = new Error("synthetic: the answer was lost");
    const runner = createSandboxCopyRunner(deps());
    await expect(runner.run(plan(), roots)).rejects.toThrow(SandboxCopyUncertain);
    sdk.createError = null;
    await expect(runner.run(plan({ state: "fixed" }), roots)).rejects.toThrow(SandboxCopyUncertain);
    expect(sdk.creates).toHaveLength(1);
    expect(await operationState(w, opId("fixed"))).toBeNull();
  });

  it("says in its uncertain rejection whether the stop of a sandbox the ledger could not record was confirmed", async () => {
    const transition = w.spend.transition.bind(w.spend);
    w.ledger.spend = { ...w.spend, transition: (request) => (request.to_state === "running" ? Promise.resolve({ ok: false as const, code: "invalid_transition" as const }) : transition(request)) };
    await expect(createSandboxCopyRunner(deps()).run(plan(), roots)).rejects.toThrow(/stop confirmed/);
    sdk.stopTakesEffect = false;
    await expect(createSandboxCopyRunner(deps()).run(plan({ state: "fixed" }), roots)).rejects.toThrow(/stop not confirmed/);
  });
});
