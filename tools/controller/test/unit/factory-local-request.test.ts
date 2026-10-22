// Integration proof (synthetic, free): a full local request and a validation run, from the start
// the web service makes to the released slot, on the real wiring. The worker sandbox is replaced by
// a local launcher that runs the factory-worker command in this process on the docker backend; the
// factory core's request loop, the harness and the package tooling are the real ones, over the
// synthetic host exported under the factory's identity functions, and the copies run as local Node
// processes through the docker backend's meter glue. The ledger is PGlite with every spend
// migration, with the real request budgets and factory records. Nothing here is real host, container
// or Sandbox evidence. The command's own checks run with a synthetic loop and the in-memory fakes.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syntheticProtocol } from "@rbw/case-package/synthetic";
import { HARNESS_IDENTITY } from "@rbw/case-validate";
import type { CopyState, HostId, StopCode } from "@rbw/factory-contract";
import { LedgerError } from "../../src/database-ledger.ts";
import { FACTORY_IDENTITY, outcomeOf } from "../../src/factory-ledger.ts";
import { factoryWorkerCommand } from "../../src/factory-cli.ts";
import { startFactoryValidation, startFactoryWorker } from "../../src/factory-launch.ts";
import type { FactoryLaunchDeps } from "../../src/factory-launch.ts";
import type { WorkerSandboxCreateParams, WorkerSandboxInstance, WorkerSandboxSdk } from "../../src/factory-ports.ts";
import type { FactoryWiring } from "../../src/factory-wiring.ts";
import type { Orchestrate, Validate } from "../../src/factory-worker.ts";
import { UsageError } from "../../src/run-options.ts";
import { CANDIDATE_A, CANDIDATE_B, CREDENTIALS, PROTOCOL, WORKER_IMAGE, acceptRequest, factoryWorld, slotHolder, syntheticUuid } from "./factory-fakes.ts";
import type { FactoryWorld } from "./factory-fakes.ts";
import { acceptSyntheticRequest, localProcessRunner, scratch, syntheticHost, syntheticWiring, wiringWorld } from "./factory-wiring-fakes.ts";
import type { LocalProcessRunner, SyntheticHost, WiringWorld } from "./factory-wiring-fakes.ts";

/** A worker sandbox replaced by this process: the detached command runs the factory-worker command on the docker backend. */
class LocalLauncher implements WorkerSandboxSdk {
  readonly runs: Promise<number>[] = [];
  readonly names: string[] = [];
  private readonly command: (args: string[], env: Record<string, string>) => Promise<number>;

  constructor(command: (args: string[], env: Record<string, string>) => Promise<number>) {
    this.command = command;
  }

  create(params: WorkerSandboxCreateParams): Promise<WorkerSandboxInstance> {
    this.names.push(params.name);
    const env = { ...params.env };
    const runs = this.runs;
    const command = this.command;
    return Promise.resolve({
      name: params.name,
      status: "running",
      runCommand: (sent) => {
        // The worker command under its run-once guard: sh -c <guard> rbw-worker <dir> node <cli> factory-worker ...
        expect([sent.cmd, sent.args[2]]).toEqual(["sh", "rbw-worker"]);
        const [, verb, ...rest] = sent.args.slice(5);
        expect(verb).toBe("factory-worker");
        runs.push(command([...rest, "--backend", "docker"], env));
        return Promise.resolve({ detached: true });
      },
      stop: () => Promise.resolve(undefined),
    });
  }

  get(): Promise<WorkerSandboxInstance | null> {
    return Promise.resolve(null);
  }
}

describe("a full local request on the real wiring (synthetic integration proof)", () => {
  let w: WiringWorld;
  let host: SyntheticHost;
  let out: string[];

  beforeEach(async () => {
    w = await wiringWorld();
    host = await syntheticHost();
    out = [];
  });

  afterEach(async () => {
    await w.pglite.close();
  });

  function launcher(runner: LocalProcessRunner): LocalLauncher {
    return new LocalLauncher((args, env) =>
      factoryWorkerCommand(args, { env: { ...env, RBW_FACTORY_PACKAGES_DIR: host.packagesDir }, out: (line) => out.push(line), log: (line) => w.logs.push(line), now: w.clock.now, load: () => Promise.resolve({ ok: true, wiring: syntheticWiring(w, host, runner) }) }),
    );
  }

  function launchDeps(sandbox: WorkerSandboxSdk): FactoryLaunchDeps {
    return { ledger: w.db.ledger, records: w.db.factoryRecords, identity: FACTORY_IDENTITY, sandbox, rates: w.rates, now: w.clock.now, launch: { image: WORKER_IMAGE, env: CREDENTIALS }, log: (line) => w.logs.push(line) };
  }

  it("starts, verifies and delivers the case, settles, closes and releases; then a validation run of the case passes and is charged to the closed budget", async () => {
    const runner = localProcessRunner(await scratch("copies"));
    const local = launcher(runner);
    const record = await acceptSyntheticRequest(w, host.registry);
    expect((await startFactoryWorker(launchDeps(local), record.request_id)).kind).toBe("launched");
    expect(local.runs).toHaveLength(1);
    expect(await local.runs[0]).toBe(0);
    expect(out).toEqual([`request=${record.request_id} stop_code=fulfilled slot_released=true`]);

    const types = (await w.db.factoryRecords.events(record.request_id)).map((event) => event.type);
    expect(types[0]).toBe("request_accepted");
    expect(types.filter((type) => type === "case_delivered")).toHaveLength(1);
    expect(types.filter((type) => type === "check_finished")).toHaveLength(6);
    expect(types.at(-1)).toBe("request_finished");
    expect(runner.plans).toHaveLength(3);
    expect(await w.db.spend.slotStatus({ slot_key: "factory" })).toMatchObject({ ok: true, holder: null });
    const budget = await w.db.ledger.budgets.status(record.budget_key);
    expect(budget.ok && budget.open_microusd).toBe(0n);
    expect(budget.ok && budget.closed).toEqual({ cause: "fulfilled" });

    const evidence = await w.db.factoryRecords.readEvidence(record.request_id, host.prepared.case_id);
    if (evidence === null) throw new Error("synthetic: no evidence was recorded");
    const validationId = randomUUID();
    const started = await startFactoryValidation(launchDeps(local), {
      request_id: record.request_id,
      case_id: host.prepared.case_id,
      validation_id: validationId,
      host_id: "task-report",
      package_sha256: { bug_case: evidence.case.packages.bug_case.sha256, validator: evidence.case.packages.validator.sha256 },
      harness: HARNESS_IDENTITY,
      protocol: syntheticProtocol(),
    });
    expect(started.kind).toBe("accepted");
    expect(local.runs).toHaveLength(2);
    expect(await local.runs[1]).toBe(0);
    expect(out[1]).toBe(`validation=${validationId} result=passed slot_released=true`);
    expect(runner.plans).toHaveLength(6);
    expect(await w.db.spend.slotStatus({ slot_key: "factory" })).toMatchObject({ ok: true, holder: null });
    const after = await w.db.ledger.budgets.status(record.budget_key);
    expect(after.ok && after.open_microusd).toBe(0n);
    expect((await w.db.factoryRecords.events(record.request_id)).map((event) => event.type).slice(-4)).toEqual(["validation_started", "budget_updated", "validation_finished", "budget_updated"]);
  });
});

describe("the factory-worker command", () => {
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
   * A synthetic request loop: per candidate, select and reserve its copies (one per state), run them
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

  const syntheticHarness: Validate = () => Promise.resolve({ result: "passed", matrix: null, message: "synthetic: all cells matched" });

  function wiring(): FactoryWiring {
    return {
      identity: w.identity,
      openDatabase: () => Promise.resolve({ ledger: w.ledger, factoryRecords: w.records, close: () => Promise.resolve() }),
      orchestrate: () => syntheticLoop,
      validate: () => syntheticHarness,
    };
  }

  function launchDeps(sandbox: WorkerSandboxSdk): FactoryLaunchDeps {
    return { ledger: w.ledger, records: w.records, identity: w.identity, sandbox, rates: w.rates, now: w.clock.now, launch: { image: WORKER_IMAGE, env: CREDENTIALS }, log: (line) => w.logs.push(line) };
  }

  const io = () => ({ env: { DATABASE_URL: "postgres://synthetic.invalid/db" }, out: (line: string) => out.push(line), log: (line: string) => w.logs.push(line), now: w.clock.now, load: () => Promise.resolve({ ok: true as const, wiring: wiring() }) });

  it("refuses bad arguments before opening anything", async () => {
    const id = syntheticUuid();
    for (const args of [[], ["--request-id", id, "--validation-id", id], ["--request-id", "NOT-A-UUID", "--deadline-at", "2026-10-20T20:00:00Z"], ["--request-id", id], ["--validation-id", id, "--deadline-at", "2026-10-20T20:00:00Z"], ["--request-id", id, "--deadline-at", "2026-10-20T20:00:00Z", "--backend", "vm"]]) {
      await expect(factoryWorkerCommand(args, io())).rejects.toThrow(UsageError);
    }
    await expect(factoryWorkerCommand(["--request-id", id, "--deadline-at", "2026-10-20T20:00:00Z"], { ...io(), env: {} })).rejects.toThrow(/DATABASE_URL/);
    await expect(factoryWorkerCommand(["--request-id", id, "--deadline-at", "2026-10-20T20:00:00Z"], { ...io(), env: { DATABASE_URL: "postgres://synthetic.invalid/db" }, load: undefined, sandbox: undefined })).rejects.toThrow(/VERCEL_TOKEN/);
  });

  it("loads the real wiring when none is given, and opens the database DATABASE_URL names", async () => {
    // This build is wired: the command gets past the wiring to the database, which does not resolve here.
    await expect(factoryWorkerCommand(["--request-id", syntheticUuid(), "--deadline-at", "2026-10-20T20:00:00Z", "--backend", "docker"], { ...io(), load: undefined })).rejects.toThrow(LedgerError);
  });

  it("stops its own worker sandbox last on the sandbox backend, after the request finished", async () => {
    const record = await acceptRequest(w, { budget: 3_000_000 });
    // The fake worker SDK records the launch without running anything; the command runs here instead.
    expect((await startFactoryWorker(launchDeps(w.sandbox), record.request_id)).kind).toBe("launched");
    const name = `rbw-fw-${record.root}`;
    // The synthetic credentials build the copies' SDK, which the synthetic loop never calls.
    const code = await factoryWorkerCommand(["--request-id", record.request_id, "--deadline-at", new Date(w.clock.ms + 3_600_000).toISOString()], { ...io(), env: { ...CREDENTIALS }, sandbox: w.sandbox });
    expect(code).toBe(0);
    expect(out.at(-1)).toBe(`request=${record.request_id} stop_code=fulfilled slot_released=true`);
    const calls = w.sandbox.calls.map((call) => `${call.action}:${call.name}`);
    expect(calls.at(-1)).toBe(`stop:${name}`);
    expect(w.sandbox.sandboxes.get(name)?.status).toBe("stopped");
    expect(await slotHolder(w)).toBeNull();
  });

  it("gives the copies the registry namespace of RBW_FACTORY_WORKER_IMAGE on the sandbox backend, and none, with a log line, without it", async () => {
    const seen: (string | null)[] = [];
    const capture = (): FactoryWiring => ({
      ...wiring(),
      orchestrate: (_backend, ctx) => {
        seen.push(ctx.copyRegistry);
        return syntheticLoop;
      },
    });
    for (const env of [{ ...CREDENTIALS, RBW_FACTORY_WORKER_IMAGE: WORKER_IMAGE }, { ...CREDENTIALS }]) {
      const record = await acceptRequest(w, { budget: 3_000_000 });
      expect((await startFactoryWorker(launchDeps(w.sandbox), record.request_id)).kind).toBe("launched");
      const code = await factoryWorkerCommand(["--request-id", record.request_id, "--deadline-at", new Date(w.clock.ms + 3_600_000).toISOString()], { ...io(), env, sandbox: w.sandbox, load: () => Promise.resolve({ ok: true as const, wiring: capture() }) });
      expect(code).toBe(0);
    }
    expect(seen).toEqual(["synthetic-team/synthetic-project", null]);
    expect(w.logs.filter((line) => line.includes("RBW_FACTORY_WORKER_IMAGE is not set or names no registry namespace"))).toHaveLength(1);
  });

  it("refuses a request that is not recorded as an input error", async () => {
    await expect(factoryWorkerCommand(["--request-id", syntheticUuid(), "--deadline-at", "2026-10-20T20:00:00Z", "--backend", "docker"], io())).rejects.toThrow(UsageError);
  });
});
