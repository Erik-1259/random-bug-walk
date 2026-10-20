// Integration proof (synthetic, free): a full local request and a validation run, from the start
// the web service makes to the released slot. The worker sandbox is replaced by a local launcher
// that runs the factory-worker command in this process on the docker backend; the factory core's
// request loop, the harness and the host adapter are synthetic stand-ins with two candidates (one
// per host) whose copies "run" for a fixed time, metered directly: no copy runner runs here (the
// docker runner's metering is held until the harness lands; the sandbox runner runs under the
// worker in factory-worker.test.ts). The ledger is PGlite with every spend migration;
// the request budgets and factory records are the in-memory fakes. Nothing here is real host,
// harness or Sandbox evidence.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CopyState, HostId, StopCode } from "@rbw/factory-contract";
import { FACTORY_PROFILE } from "../../src/factory-profile.ts";
import { outcomeOf } from "../../src/factory-ledger.ts";
import { factoryWorkerCommand } from "../../src/factory-cli.ts";
import { startFactoryValidation, startFactoryWorker } from "../../src/factory-launch.ts";
import type { FactoryLaunchDeps } from "../../src/factory-launch.ts";
import type { WorkerSandboxCreateParams, WorkerSandboxInstance, WorkerSandboxSdk } from "../../src/factory-ports.ts";
import { MISSING_MODULES } from "../../src/factory-wiring.ts";
import type { FactoryWiring } from "../../src/factory-wiring.ts";
import type { Orchestrate, Validate } from "../../src/factory-worker.ts";
import { UsageError } from "../../src/run-options.ts";
import { CANDIDATE_A, CANDIDATE_B, CASE_ID, CREDENTIALS, PROTOCOL, WORKER_IMAGE, acceptRequest, factoryWorld, slotHolder, syntheticUuid } from "./factory-fakes.ts";
import type { FactoryWorld } from "./factory-fakes.ts";

let w: FactoryWorld;
let out: string[];

beforeEach(async () => {
  w = await factoryWorld();
  out = [];
});

afterEach(async () => {
  await w.close();
});

const STATES: readonly CopyState[] = ["clean", "buggy", "fixed"];
const LIMITS = { timeout_s: 720, vcpus: 4, memory_mb: 8192 };

/**
 * The synthetic request loop: per candidate, select and reserve its copies (one per state), run them
 * in order with a checkpoint before each, settle the candidate, deliver; then finish as the factory
 * core does: settleWorker, budget_updated, request_finished.
 */
const syntheticLoop: Orchestrate = async (hooks) => {
  const candidates: { id: string; host: HostId }[] = [
    { id: CANDIDATE_A, host: "task-report" },
    { id: CANDIDATE_B, host: "umami" },
  ];
  const event = (key: string, type: "candidate_selected" | "check_finished" | "case_delivered", candidate: { id: string; host: HostId }, data: Record<string, unknown>) =>
    hooks.append({ event_key: key, type, host_id: candidate.host, candidate_id: candidate.id, item_key: null, case_id: null, message: `synthetic ${type}`, data });
  const stop = await (async (): Promise<StopCode> => {
    for (const candidate of candidates) {
      if ((await hooks.checkpoint()) !== "continue") return "cancelled_by_user";
      await event(`cand:${candidate.id}:selected`, "candidate_selected", candidate, { source_id: `synthetic-${candidate.host}`, entry_id: `synthetic-${candidate.host}-01` });
      if ((await hooks.meter.reserveCandidate({ candidate_id: candidate.id, host_id: candidate.host, protocol: PROTOCOL })).kind !== "reserved") return "budget_exhausted";
      for (const state of STATES) {
        const outcome = await hooks.meter.run({ subject: candidate.id, host: candidate.host, state, limits: LIMITS }, async (name, launch) => {
          await launch.created(name);
          hooks.now();
          return { result: "pass", created: true, lifetime_ms: 95_000, stop_confirmed: true, status: "completed" as const };
        });
        if (outcome.kind !== "ran") return outcome.kind === "uncertain" ? "needs_reconciliation" : "operational_error";
        await event(`cand:${candidate.id}:check:${state}`, "check_finished", candidate, { check_set: "verification", copy: state, outcome: "pass", runs_valid: 1, runs_total: 1 });
      }
      await hooks.meter.settleCandidate({ candidate_id: candidate.id });
      await event(`cand:${candidate.id}:end`, "case_delivered", candidate, {});
    }
    return "fulfilled";
  })();
  const none = { host_id: null, candidate_id: null, item_key: null, case_id: null };
  await hooks.settleWorker(stop);
  await hooks.append({ event_key: "run:worker-settled", type: "budget_updated", ...none, message: "synthetic budget_updated", data: { reserved_microusd: 0, spent_microusd: 0, remaining_microusd: 0 } });
  await hooks.append({ event_key: "run:finished", type: "request_finished", ...none, message: "synthetic request_finished", data: { outcome: outcomeOf(stop), stop_code: stop } });
};

const syntheticHarness: Validate = async (hooks) => {
  for (const state of STATES) {
    await hooks.meter.run({ subject: hooks.validation.case_id, host: hooks.validation.host_id, state, limits: LIMITS }, async (name, launch) => {
      await launch.created(name);
      return { result: "pass", created: true, lifetime_ms: 100_000, stop_confirmed: true, status: "completed" as const };
    });
  }
  return { result: "passed", matrix: null, message: "synthetic: all cells matched" };
};

function wiring(): FactoryWiring {
  return {
    identity: w.identity,
    openLedger: () => Promise.resolve({ ledger: w.ledger, records: w.records, close: () => Promise.resolve() }),
    orchestrate: () => syntheticLoop,
    validate: () => syntheticHarness,
  };
}

/** A worker sandbox replaced by this process: the detached command runs the factory-worker command on the docker backend. */
class LocalLauncher implements WorkerSandboxSdk {
  readonly runs: Promise<number>[] = [];
  readonly names: string[] = [];
  create(params: WorkerSandboxCreateParams): Promise<WorkerSandboxInstance> {
    this.names.push(params.name);
    const env = { ...params.env };
    const runs = this.runs;
    return Promise.resolve({
      name: params.name,
      status: "running",
      runCommand: (command) => {
        // The worker command under its run-once guard: sh -c <guard> rbw-worker <dir> node <cli> factory-worker ...
        expect([command.cmd, command.args[2]]).toEqual(["sh", "rbw-worker"]);
        const [, verb, ...rest] = command.args.slice(5);
        expect(verb).toBe("factory-worker");
        runs.push(factoryWorkerCommand([...rest, "--backend", "docker"], { env, out: (line) => out.push(line), log: (line) => w.logs.push(line), now: w.clock.now, load: () => Promise.resolve({ ok: true, wiring: wiring() }) }));
        return Promise.resolve({ detached: true });
      },
      stop: () => Promise.resolve(undefined),
    });
  }
  get(): Promise<WorkerSandboxInstance | null> {
    return Promise.resolve(null);
  }
}

function launchDeps(sandbox: WorkerSandboxSdk): FactoryLaunchDeps {
  return { ledger: w.ledger, records: w.records, identity: w.identity, sandbox, rates: w.rates, now: w.clock.now, launch: { image: WORKER_IMAGE, env: CREDENTIALS }, log: (line) => w.logs.push(line) };
}

describe("a full local request (synthetic integration proof)", () => {
  it("starts, runs two candidates' copies one at a time, delivers, settles, closes and releases; then a validation run is charged to the closed budget", async () => {
    const launcher = new LocalLauncher();
    const record = await acceptRequest(w, { budget: 3_000_000 });
    expect((await startFactoryWorker(launchDeps(launcher), record.request_id)).kind).toBe("launched");
    expect(launcher.runs).toHaveLength(1);
    expect(await launcher.runs[0]).toBe(0);
    expect(out).toEqual([`request=${record.request_id} stop_code=fulfilled slot_released=true`]);

    const types = w.records.types(record.request_id);
    expect(types[0]).toBe("request_accepted");
    expect(types.filter((type) => type === "case_delivered")).toHaveLength(2);
    expect(types.filter((type) => type === "check_finished")).toHaveLength(6);
    expect(types.slice(-2)).toEqual(["budget_updated", "request_finished"]);
    expect(await slotHolder(w)).toBeNull();
    const budget = await w.ledger.budgets.status(record.budget_key);
    if (!budget.ok) throw new Error("synthetic: budget status refused");
    // Six copies of 95 s at 4 vCPU and 8 GB (13,512 + 4,476 + 1 µUSD each) and the worker in full.
    expect(budget.open_microusd).toBe(0n);
    expect(budget.settled_microusd).toBe(BigInt(FACTORY_PROFILE.prices.worker_worst_case_microusd + 6 * 17_989));
    expect(w.budgets.closes).toEqual([{ budget_key: record.budget_key, cause: "fulfilled" }]);

    const validationId = syntheticUuid("7400");
    const started = await startFactoryValidation(launchDeps(launcher), { request_id: record.request_id, case_id: CASE_ID, validation_id: validationId, host_id: "umami", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" }, protocol: PROTOCOL });
    expect(started.kind).toBe("accepted");
    expect(launcher.runs).toHaveLength(2);
    expect(await launcher.runs[1]).toBe(0);
    expect(out[1]).toBe(`validation=${validationId} result=passed slot_released=true`);
    expect(await slotHolder(w)).toBeNull();
    const after = await w.ledger.budgets.status(record.budget_key);
    expect(after.ok && after.open_microusd).toBe(0n);
    expect(w.records.types(record.request_id).slice(-4)).toEqual(["validation_started", "budget_updated", "validation_finished", "budget_updated"]);
  });
});

describe("the factory-worker command", () => {
  const io = () => ({ env: { DATABASE_URL: "postgres://synthetic.invalid/db" }, out: (line: string) => out.push(line), log: (line: string) => w.logs.push(line), now: w.clock.now, load: () => Promise.resolve({ ok: true as const, wiring: wiring() }) });

  it("refuses bad arguments before opening anything", async () => {
    const id = syntheticUuid();
    for (const args of [[], ["--request-id", id, "--validation-id", id], ["--request-id", "NOT-A-UUID", "--deadline-at", "2026-10-20T20:00:00Z"], ["--request-id", id], ["--validation-id", id, "--deadline-at", "2026-10-20T20:00:00Z"], ["--request-id", id, "--deadline-at", "2026-10-20T20:00:00Z", "--backend", "vm"]]) {
      await expect(factoryWorkerCommand(args, io())).rejects.toThrow(UsageError);
    }
    await expect(factoryWorkerCommand(["--request-id", id, "--deadline-at", "2026-10-20T20:00:00Z"], { ...io(), env: {} })).rejects.toThrow(/DATABASE_URL/);
    await expect(factoryWorkerCommand(["--request-id", id, "--deadline-at", "2026-10-20T20:00:00Z"], { ...io(), env: { DATABASE_URL: "postgres://synthetic.invalid/db" }, load: undefined, sandbox: undefined })).rejects.toThrow(/VERCEL_TOKEN/);
  });

  it("says what is missing when this build has no wiring", async () => {
    const id = syntheticUuid();
    const run = factoryWorkerCommand(["--request-id", id, "--deadline-at", "2026-10-20T20:00:00Z", "--backend", "docker"], { ...io(), load: undefined });
    await expect(run).rejects.toThrow(UsageError);
    await expect(factoryWorkerCommand(["--request-id", id, "--deadline-at", "2026-10-20T20:00:00Z", "--backend", "docker"], { ...io(), load: undefined })).rejects.toThrow(MISSING_MODULES[0] ?? "");
  });

  it("stops its own worker sandbox last on the sandbox backend, after the request finished", async () => {
    const record = await acceptRequest(w, { budget: 3_000_000 });
    // The fake worker SDK records the launch without running anything; the command runs here instead.
    expect((await startFactoryWorker(launchDeps(w.sandbox), record.request_id)).kind).toBe("launched");
    const name = `rbw-fw-${record.root}`;
    const code = await factoryWorkerCommand(["--request-id", record.request_id, "--deadline-at", new Date(w.clock.ms + 3_600_000).toISOString()], { ...io(), sandbox: w.sandbox });
    expect(code).toBe(0);
    expect(out.at(-1)).toBe(`request=${record.request_id} stop_code=fulfilled slot_released=true`);
    const calls = w.sandbox.calls.map((call) => `${call.action}:${call.name}`);
    expect(calls.at(-1)).toBe(`stop:${name}`);
    expect(w.sandbox.sandboxes.get(name)?.status).toBe("stopped");
  });

  it("refuses a request that is not recorded as an input error", async () => {
    await expect(factoryWorkerCommand(["--request-id", syntheticUuid(), "--deadline-at", "2026-10-20T20:00:00Z", "--backend", "docker"], io())).rejects.toThrow(UsageError);
  });
});
