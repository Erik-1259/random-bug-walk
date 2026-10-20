import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CollectedCopy, StopCode, ValidationMatrix } from "@rbw/factory-contract";
import { validateContract } from "@rbw/factory-contract/validate";
import { sha256Hex } from "@rbw/schema";
import { FACTORY_PROFILE } from "../../src/factory-profile.ts";
import { busyReason, copyOperation, outcomeOf, validationOperation, workerOperation } from "../../src/factory-ledger.ts";
import { startFactoryValidation, startFactoryWorker } from "../../src/factory-launch.ts";
import type { FactoryLaunchDeps } from "../../src/factory-launch.ts";
import { finalizeLostWorker } from "../../src/factory-lost.ts";
import type { LostDeps } from "../../src/factory-lost.ts";
import type { LaunchReport, MeteredCopyPlan } from "../../src/factory-meter.ts";
import type { FactoryEventInput, FactoryRequestRecord } from "../../src/factory-ports.ts";
import { createSandboxCopyRunner } from "../../src/factory-sandbox-runner.ts";
import { runFactoryValidation, runFactoryWorker, startHeartbeat } from "../../src/factory-worker.ts";
import type { Orchestrate, RequestHooks, WorkerDeps } from "../../src/factory-worker.ts";
import { CANDIDATE_A, CASE_ID, CREDENTIALS, FakeCopySandbox, FakeRecords, PROTOCOL, VALIDATION_3_MICROUSD, WORKER_IMAGE, acceptRequest, copyPlan, copyRoots, factoryWorld, operationState, protocolOf, slotHolder, syntheticUuid } from "./factory-fakes.ts";
import type { FactoryWorld } from "./factory-fakes.ts";

const MATRIX = (JSON.parse(readFileSync(new URL("../../../../docs/product/fixtures/bug-request-v1/validation-passed.json", import.meta.url), "utf8")) as { matrix: ValidationMatrix }).matrix;

let w: FactoryWorld;

beforeEach(async () => {
  w = await factoryWorld();
});

afterEach(async () => {
  await w.close();
});

function launchDeps(): FactoryLaunchDeps {
  return { ledger: w.ledger, records: w.records, identity: w.identity, sandbox: w.sandbox, rates: w.rates, now: w.clock.now, launch: { image: WORKER_IMAGE, env: CREDENTIALS }, log: (line) => w.logs.push(line) };
}

function lostDeps(): LostDeps {
  return { ledger: w.ledger, records: w.records, identity: w.identity, events: w.events, sandbox: w.sandbox, rates: w.rates, now: w.clock.now, log: () => undefined };
}

function workerDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return { ledger: w.ledger, records: w.records, identity: w.identity, rates: w.rates, now: w.clock.now, log: (line) => w.logs.push(line), provider: "vercel-sandbox", ...overrides };
}

async function launched(budget = 1_500_000): Promise<FactoryRequestRecord> {
  const record = await acceptRequest(w, { budget });
  expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("launched");
  return record;
}

function deadline(): Date {
  return new Date(w.clock.ms + FACTORY_PROFILE.worker.timeout_s * 1000);
}

function plan(subject: string, state: MeteredCopyPlan["state"]): MeteredCopyPlan {
  return { subject, host: "task-report", state, limits: { timeout_s: 720, vcpus: 4, memory_mb: 8192 } };
}

function lives(ms: number, extra: Partial<LaunchReport<string>> = {}) {
  return async (name: string, hooks: { created(id: string): Promise<void> }): Promise<LaunchReport<string>> => {
    await hooks.created(name);
    w.clock.advance(ms);
    return { result: name, created: true, lifetime_ms: ms, stop_confirmed: true, status: "completed", ...extra };
  };
}

function copyId(record: FactoryRequestRecord, state: MeteredCopyPlan["state"]): string {
  return copyOperation({ identity: w.identity, rates: w.rates }, { kind: "request", root: record.root, task_revision: record.interpretation_sha256, subject: CANDIDATE_A, state, n: 1, host: "task-report", provider: "vercel-sandbox" }).operation_id;
}

const NO_LINKS = { host_id: null, candidate_id: null, item_key: null, case_id: null };

/** The core's attention event, under its key. */
const CORE_ATTENTION: FactoryEventInput = { event_key: "run:attention:needs_reconciliation", type: "attention", ...NO_LINKS, message: "Spend needs reconciliation.", data: { code: "needs_reconciliation" } };

/** How the factory core's loop finishes a request: settleWorker, then its budget_updated, then request_finished. */
async function finishAsCore(hooks: RequestHooks, stop: StopCode): Promise<void> {
  await hooks.settleWorker(stop);
  await hooks.append({ event_key: "run:worker-settled", type: "budget_updated", ...NO_LINKS, message: "Settled the worker.", data: { reserved_microusd: 0, spent_microusd: 0, remaining_microusd: 0 } });
  await hooks.append({ event_key: "run:finished", type: "request_finished", ...NO_LINKS, message: "Request finished.", data: { outcome: outcomeOf(stop), stop_code: stop } });
}

/**
 * A synthetic stand-in for the factory core's request loop: one candidate, reserved at its selection
 * (one copy per state), its copies in order with a checkpoint before each, and its unused copies
 * cancelled when it ends; it finishes the request itself.
 */
function synthetic(states: MeteredCopyPlan["state"][], done: StopCode, launch = lives(60_000)): Orchestrate {
  return async (hooks: RequestHooks) => {
    const reserved = await hooks.meter.reserveCandidate({ candidate_id: CANDIDATE_A, host_id: "task-report", protocol: PROTOCOL });
    if (reserved.kind === "refused") {
      await finishAsCore(hooks, "budget_exhausted");
      return;
    }
    let stop = done;
    for (const state of states) {
      const checkpoint = await hooks.checkpoint();
      if (checkpoint === "fenced") return;
      if (checkpoint === "stop") {
        stop = "cancelled_by_user";
        break;
      }
      const outcome = await hooks.meter.run(plan(CANDIDATE_A, state), launch);
      if (outcome.kind === "uncertain") {
        // As the core does: an uncertain copy ends the candidate without settling it; its reservations stay held.
        await hooks.append(CORE_ATTENTION);
        await finishAsCore(hooks, "needs_reconciliation");
        return;
      }
    }
    await hooks.meter.settleCandidate({ candidate_id: CANDIDATE_A });
    await finishAsCore(hooks, stop);
  };
}

describe("startHeartbeat", () => {
  it("writes a heartbeat at once and then on every interval until stopped", async () => {
    const target = { request_id: syntheticUuid() };
    const beat = startHeartbeat(w.records, target, w.clock.now, 20, (line) => w.logs.push(line));
    await new Promise((resolve) => setTimeout(resolve, 75));
    await beat.stop();
    const count = w.records.heartbeats.length;
    expect(count).toBeGreaterThanOrEqual(3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.records.heartbeats.length).toBe(count);
  });

  it("logs a failed heartbeat write and keeps going", async () => {
    let calls = 0;
    const records = new FakeRecords();
    records.recordHeartbeat = () => (calls++ === 0 ? Promise.reject(new Error("synthetic: database busy")) : Promise.resolve());
    const beat = startHeartbeat(records, { request_id: syntheticUuid() }, w.clock.now, 20, (line) => w.logs.push(line));
    await new Promise((resolve) => setTimeout(resolve, 60));
    await beat.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(w.logs.some((line) => line.includes("heartbeat"))).toBe(true);
  });
});

describe("runFactoryWorker", () => {
  it("heartbeats, appends worker_started, runs the loop, which settles the worker through settleWorker and finishes; then releases the slot, appending nothing else", async () => {
    const record = await launched();
    const outcome = await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate: synthetic(["clean", "buggy"], "fulfilled") });
    expect(outcome).toEqual({ kind: "finished", stop_code: "fulfilled", slot_released: true });
    expect(w.records.heartbeats.filter((beat) => "request_id" in beat.target).length).toBeGreaterThanOrEqual(1);
    // The start's budget_updated and worker_started are this code's; the loop appends every other event.
    const events = await w.records.events(record.request_id);
    expect(events.map((event) => event.event_key)).toEqual(["request_accepted", "worker:reserved", "worker_started", "run:worker-settled", "run:finished"]);
    const worker = await w.spend.operationStatus({ operation_id: workerOperation({ identity: w.identity, rates: w.rates }, record).operation_id });
    expect(worker.ok && [worker.state, worker.settled_microusd]).toEqual(["reconciled", BigInt(FACTORY_PROFILE.prices.worker_worst_case_microusd)]);
    expect(await operationState(w, copyId(record, "clean"))).toBe("reconciled");
    expect(await operationState(w, copyId(record, "buggy"))).toBe("reconciled");
    // The copy the loop never ran was reserved at the candidate's selection and cancelled at zero when it ended.
    const fixed = await w.spend.operationStatus({ operation_id: copyId(record, "fixed") });
    expect(fixed.ok && [fixed.state, fixed.settled_microusd]).toEqual(["reconciled", 0n]);
    expect(w.budgets.closes).toEqual([{ budget_key: record.budget_key, cause: "fulfilled" }]);
    expect(await slotHolder(w)).toBeNull();
  });

  it("settles the worker once and closes the budget once when settleWorker is called again", async () => {
    const record = await launched();
    const orchestrate: Orchestrate = async (hooks) => {
      await hooks.settleWorker("sources_exhausted");
      await finishAsCore(hooks, "sources_exhausted");
    };
    expect(await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate })).toEqual({ kind: "finished", stop_code: "sources_exhausted", slot_released: true });
    expect(w.budgets.closes).toEqual([{ budget_key: record.budget_key, cause: "sources_exhausted" }]);
    const status = await w.ledger.budgets.status(record.budget_key);
    expect(status.ok && status.settled_microusd).toBe(BigInt(FACTORY_PROFILE.prices.worker_worst_case_microusd));
  });

  it("checks for a stop between copies: no copy starts after the stop is recorded", async () => {
    const record = await launched();
    const launch = async (name: string, hooks: { created(id: string): Promise<void> }) => {
      const report = await lives(30_000)(name, hooks);
      w.records.stops.add(record.request_id);
      return report;
    };
    const outcome = await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate: synthetic(["clean", "buggy", "fixed"], "fulfilled", launch) });
    expect(outcome).toMatchObject({ kind: "finished", stop_code: "cancelled_by_user", slot_released: true });
    expect(await operationState(w, copyId(record, "clean"))).toBe("reconciled");
    // Reserved at selection, never launched: cancelled at zero when the candidate ended.
    for (const state of ["buggy", "fixed"] as const) {
      const status = await w.spend.operationStatus({ operation_id: copyId(record, state) });
      expect(status.ok && [status.state, status.settled_microusd]).toEqual(["reconciled", 0n]);
    }
    expect(w.sandbox.calls.filter((call) => call.action === "create")).toHaveLength(1);
    const finished = (await w.records.events(record.request_id)).find((event) => event.type === "request_finished");
    expect(finished?.data).toEqual({ outcome: "cancelled", stop_code: "cancelled_by_user" });
  });

  it("lets the loop end budget_exhausted when the budget cannot cover the candidate's whole worst case, launching nothing", async () => {
    // The worker and one copy fit, the candidate's three copies do not: its reservation is refused whole.
    const record = await launched(500_000);
    const outcome = await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate: synthetic(["clean", "buggy"], "fulfilled") });
    expect(outcome).toEqual({ kind: "finished", stop_code: "budget_exhausted", slot_released: true });
    expect(await operationState(w, copyId(record, "buggy"))).toBeNull();
    expect(w.sandbox.calls.filter((call) => call.action === "create")).toHaveLength(1);
    expect(w.budgets.closes).toEqual([{ budget_key: record.budget_key, cause: "budget_exhausted" }]);
    const status = await w.ledger.budgets.status(record.budget_key);
    expect(status.ok && status.open_microusd).toBe(0n);
  });

  it("keeps the slot held when a copy is uncertain, adding no attention of its own to the loop's", async () => {
    const record = await launched();
    const rejecting = async (name: string, hooks: { created(id: string): Promise<void> }): Promise<LaunchReport<string>> => {
      await hooks.created(name);
      throw new Error("synthetic: lost response");
    };
    const outcome = await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate: synthetic(["clean"], "fulfilled", rejecting) });
    expect(outcome).toEqual({ kind: "finished", stop_code: "needs_reconciliation", slot_released: false });
    expect(await operationState(w, copyId(record, "clean"))).toBe("uncertain");
    expect(await slotHolder(w)).toBe(record.root);
    const tail = (await w.records.events(record.request_id)).filter((event) => event.type === "attention" || event.type === "request_finished");
    expect(tail.map((event) => event.event_key)).toEqual(["run:attention:needs_reconciliation", "run:finished"]);
  });

  it("stops at the next checkpoint without appending or settling anything once the request was finished as lost", async () => {
    const record = await launched();
    let afterLost: string[] = [];
    const orchestrate: Orchestrate = async (hooks) => {
      await hooks.meter.reserveCandidate({ candidate_id: CANDIDATE_A, host_id: "task-report", protocol: PROTOCOL });
      await hooks.meter.run(plan(CANDIDATE_A, "clean"), lives(10_000));
      // The status route declares the worker lost (no heartbeat for 180 s on the request's clock).
      w.clock.advance(400_000);
      expect((await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).kind).toBe("finalized");
      afterLost = w.records.types(record.request_id);
      expect(await hooks.checkpoint()).toBe("fenced");
      const late = await hooks.append({ event_key: "late", type: "check_finished", host_id: "task-report", candidate_id: CANDIDATE_A, item_key: null, case_id: null, message: "late", data: {} });
      expect(late.kind).toBe("refused");
      expect(await hooks.meter.run(plan(CANDIDATE_A, "buggy"), lives(10_000))).toMatchObject({ kind: "refused", reason: "stopped" });
      await expect(hooks.meter.settleCandidate({ candidate_id: CANDIDATE_A })).rejects.toThrow(/finished elsewhere/);
      await expect(hooks.settleWorker("operational_error")).rejects.toThrow(/finished elsewhere/);
    };
    expect(await runFactoryWorker(workerDeps({ heartbeat_ms: 3_600_000 }), { request_id: record.request_id, deadline: deadline(), orchestrate })).toEqual({ kind: "fenced" });
    expect(w.records.types(record.request_id)).toEqual(afterLost);
    expect(w.records.refusedAppends).toEqual([]);
    expect(await operationState(w, workerOperation({ identity: w.identity, rates: w.rates }, record).operation_id)).toBe("uncertain");
    expect(await slotHolder(w)).toBe(record.root);
  });

  it("leaves a request whose loop failed unfinished, settling and releasing nothing, for the lost-worker finish, which ends the candidate in flight", async () => {
    const record = await launched();
    const outcome = await runFactoryWorker(workerDeps({ heartbeat_ms: 3_600_000 }), {
      request_id: record.request_id,
      deadline: deadline(),
      orchestrate: async (hooks) => {
        await hooks.append({ event_key: `cand:${CANDIDATE_A}:selected`, type: "candidate_selected", host_id: "task-report", candidate_id: CANDIDATE_A, item_key: null, case_id: null, message: "Selected catalog entry synthetic-task-report-01.", data: { source_id: "synthetic-task-report", entry_id: "synthetic-task-report-01" } });
        throw new Error("synthetic: the loop failed");
      },
    });
    expect(outcome).toEqual({ kind: "unfinished" });
    expect(w.logs.some((line) => line.includes("synthetic: the loop failed"))).toBe(true);
    expect(w.records.types(record.request_id)).toEqual(["request_accepted", "budget_updated", "worker_started", "candidate_selected"]);
    const workerId = workerOperation({ identity: w.identity, rates: w.rates }, record).operation_id;
    expect(await operationState(w, workerId)).toBe("running");
    expect(w.budgets.closes).toEqual([]);
    expect(await slotHolder(w)).toBe(record.root);
    // Contract 8.1: a worker that exited before finishing is lost; no candidate stays in progress in a finished request.
    w.clock.advance(181_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finalized", slot_held: true });
    const tail = (await w.records.events(record.request_id)).slice(-3);
    expect(tail.map((event) => [event.type, event.candidate_id, event.data])).toEqual([
      ["candidate_incomplete", CANDIDATE_A, { reason: "incomplete_run" }],
      ["attention", null, { code: "needs_reconciliation" }],
      ["request_finished", null, { outcome: "operational_error", stop_code: "worker_lost" }],
    ]);
  });

  it("leaves the slot to the lost-worker routine when its release fails after the finish; that routine releases it once the worker is silent", async () => {
    const record = await launched();
    const release = w.spend.releaseSlot.bind(w.spend);
    let failing = true;
    w.ledger.spend = { ...w.spend, releaseSlot: (request) => (failing ? Promise.reject(new Error("synthetic: the connection dropped")) : release(request)) };
    const outcome = await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate: synthetic(["clean"], "fulfilled") });
    expect(outcome).toEqual({ kind: "finished", stop_code: "fulfilled", slot_released: false });
    expect(w.logs.some((line) => line.includes("synthetic: the connection dropped"))).toBe(true);
    expect(await slotHolder(w)).toBe(record.root);
    failing = false;
    w.clock.advance(181_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finalized", slot_held: false });
    expect(await slotHolder(w)).toBeNull();
    expect(w.records.types(record.request_id).filter((type) => type === "attention")).toEqual([]);
  });

  it("keeps the slot held for reconciliation when the worker's settlement fails after its end, as the core's loop raises needs_reconciliation", async () => {
    const record = await launched();
    const workerId = workerOperation({ identity: w.identity, rates: w.rates }, record).operation_id;
    const settle = w.spend.settle.bind(w.spend);
    w.ledger.spend = { ...w.spend, settle: (request) => (request.operation_id === workerId ? Promise.reject(new Error("synthetic: the connection dropped")) : settle(request)) };
    const orchestrate: Orchestrate = async (hooks) => {
      // As the core's finish does: a settleWorker that rejects raises needs_reconciliation, and the outcome stands.
      try {
        await hooks.settleWorker("fulfilled");
      } catch {
        await hooks.append(CORE_ATTENTION);
      }
      await hooks.append({ event_key: "run:worker-settled", type: "budget_updated", ...NO_LINKS, message: "Budget updated for the worker.", data: { reserved_microusd: 0, spent_microusd: 0, remaining_microusd: 0 } });
      await hooks.append({ event_key: "run:finished", type: "request_finished", ...NO_LINKS, message: "Request finished.", data: { outcome: "fulfilled", stop_code: "fulfilled" } });
    };
    expect(await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate })).toEqual({ kind: "finished", stop_code: "fulfilled", slot_released: false });
    expect(await operationState(w, workerId)).toBe("terminal");
    expect(await slotHolder(w)).toBe(record.root);
    w.ledger.spend = w.spend;
    const validation = { request_id: record.request_id, case_id: CASE_ID, validation_id: syntheticUuid("7310"), host_id: "task-report" as const, package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate" as const, version: "1" }, protocol: PROTOCOL };
    expect(await startFactoryValidation(launchDeps(), validation)).toEqual({ kind: "busy", reason: "needs_reconciliation" });
    // The lost-worker routine leaves it held too: only reconciliation releases it.
    w.clock.advance(181_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finished" });
    expect(await slotHolder(w)).toBe(record.root);
  });

  it("leaves a request unfinished when the loop returns without finishing it", async () => {
    const record = await launched();
    const outcome = await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate: () => Promise.resolve() });
    expect(outcome).toEqual({ kind: "unfinished" });
    expect(w.records.types(record.request_id).filter((type) => type === "request_finished")).toEqual([]);
    expect(await slotHolder(w)).toBe(record.root);
  });

  it("runs the sandbox copy runner under the worker: a candidate stopped after its first copy has its other copies cancelled at zero, and the slot is released", async () => {
    const record = await launched();
    const sdk = new FakeCopySandbox();
    const { roots, work } = copyRoots();
    const collected: CollectedCopy[] = [];
    const orchestrate: Orchestrate = async (hooks) => {
      const runner = createSandboxCopyRunner({
        sdk,
        meter: hooks.meter,
        subject: CANDIDATE_A,
        workDir: work,
        resultsSha256: (dir) => Promise.resolve(sha256Hex(Buffer.from(readdirSync(dir).sort().join("\n")))),
        now: () => {
          w.clock.advance(30_000);
          return w.clock.ms;
        },
        sleep: () => Promise.resolve(),
        attempt: "synthetic-attempt",
        log: (line) => w.logs.push(line),
      });
      expect(await hooks.meter.reserveCandidate({ candidate_id: CANDIDATE_A, host_id: "task-report", protocol: PROTOCOL })).toEqual({ kind: "reserved", reserved_microusd: 3 * FACTORY_PROFILE.prices.copy_worst_case_microusd["task-report"] });
      collected.push(await runner.run(copyPlan({ state: "clean", copy_id: "synthetic-clean-01" }), roots));
      w.records.stops.add(record.request_id);
      collected.push(await runner.run(copyPlan({ state: "buggy", copy_id: "synthetic-buggy-01" }), roots));
      await hooks.meter.settleCandidate({ candidate_id: CANDIDATE_A });
      await finishAsCore(hooks, hooks.meter.lastRefusal?.reason === "stopped" ? "cancelled_by_user" : "fulfilled");
    };
    expect(await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate })).toEqual({ kind: "finished", stop_code: "cancelled_by_user", slot_released: true });
    expect(collected.map((copy) => copy.outcome)).toEqual(["ran", "timed_out"]);
    expect(sdk.creates).toHaveLength(1);
    expect(await operationState(w, copyId(record, "clean"))).toBe("reconciled");
    for (const state of ["buggy", "fixed"] as const) {
      const status = await w.spend.operationStatus({ operation_id: copyId(record, state) });
      expect(status.ok && [status.state, status.settled_microusd]).toEqual(["reconciled", 0n]);
    }
    const budget = await w.ledger.budgets.status(record.budget_key);
    expect(budget.ok && budget.open_microusd).toBe(0n);
    // The slot was released, which the ledger allows only once the copy's sandbox was confirmed stopped and nothing is open.
    expect(await slotHolder(w)).toBeNull();
  });
});

describe("runFactoryValidation", () => {
  async function acceptedValidation(): Promise<{ record: FactoryRequestRecord; validationId: string; operationId: string }> {
    const record = await acceptRequest(w);
    await w.spend.releaseSlot({ slot_key: "factory", root_execution_id: record.root, actor_role: "factory-worker", evidence: null, reason: null });
    await w.budgets.close(record.budget_key, "fulfilled");
    const validationId = syntheticUuid("7300");
    const started = await startFactoryValidation(launchDeps(), { request_id: record.request_id, case_id: CASE_ID, validation_id: validationId, host_id: "task-report", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" }, protocol: PROTOCOL });
    expect(started.kind).toBe("accepted");
    const root = w.identity.validationRoot(validationId);
    return { record, validationId, operationId: validationOperation({ identity: w.identity, rates: w.rates }, { root, case_id: CASE_ID, host_id: "task-report", copies: 3 }).operation_id };
  }

  it("runs the copies inside the window, settles its worker in full and its copies as measured, finishes and releases the slot", async () => {
    const { record, validationId, operationId } = await acceptedValidation();
    const outcome = await runFactoryValidation(workerDeps(), {
      validation_id: validationId,
      validate: async (hooks) => {
        expect(hooks.deadline.getTime()).toBe(Date.parse(hooks.validation.accepted_at) + 1_800_000);
        // A copy must leave the run its finish margin: it starts only when 720 s + 60 s + 30 s fit before the window ends.
        const now = w.clock.ms;
        w.clock.ms = Date.parse(hooks.validation.accepted_at) + (1800 - 720 - 60 - 30) * 1000 + 1;
        expect(await hooks.meter.run({ ...plan(CASE_ID, "clean") }, lives(1000))).toMatchObject({ kind: "refused", reason: "no_time" });
        w.clock.ms = now;
        await hooks.meter.run({ ...plan(CASE_ID, "clean") }, lives(90_000));
        await hooks.meter.run({ ...plan(CASE_ID, "buggy") }, lives(80_000));
        return { result: "passed", matrix: MATRIX, message: "All six cells matched their expected outcomes." };
      },
    });
    expect(outcome).toEqual({ kind: "finished", result: "passed", slot_released: true });
    // Worker: 2 vCPU and 4 GB for 1,860 s; copies: 4 vCPU and 8 GB for 170 s; three creations.
    const status = await w.spend.operationStatus({ operation_id: operationId });
    expect(status.ok && [status.state, status.settled_microusd]).toEqual(["reconciled", 208_270n]);
    expect(await slotHolder(w)).toBeNull();
    const events = await w.records.validationEvents(validationId);
    expect(events.map((event) => event.type)).toEqual(["running", "finished"]);
    expect(events[1]?.data).toMatchObject({ result: "passed", cost_microusd: 208_270, matrix: MATRIX });
    expect(w.records.heartbeats.some((beat) => "validation_id" in beat.target)).toBe(true);
    const finished = (await w.records.events(record.request_id)).find((event) => event.type === "validation_finished");
    expect(finished?.data).toEqual({ validation_id: validationId, result: "passed" });
  });

  it("prices and caps a run by the copies the protocol inside its delivered validator package declares", async () => {
    const record = await acceptRequest(w);
    await w.spend.releaseSlot({ slot_key: "factory", root_execution_id: record.root, actor_role: "factory-worker", evidence: null, reason: null });
    await w.budgets.close(record.budget_key, "fulfilled");
    const validationId = syntheticUuid("7320");
    // Two copies of each state: six in all, where the earlier fixed totals priced three for an Umami case.
    const protocol = protocolOf({ clean: 2, buggy: 2, fixed: 2 });
    const started = await startFactoryValidation(launchDeps(), { request_id: record.request_id, case_id: CASE_ID, validation_id: validationId, host_id: "umami", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" }, protocol });
    expect(started.kind).toBe("accepted");
    const root = w.identity.validationRoot(validationId);
    const operationId = validationOperation({ identity: w.identity, rates: w.rates }, { root, case_id: CASE_ID, host_id: "umami", copies: 6 }).operation_id;
    const reserved = await w.spend.operationStatus({ operation_id: operationId });
    // Its worker for 1,860 s and six copies inside 1,800 s plus six allowances, seven creations.
    expect(reserved.ok && reserved.reserved_microusd).toBe(BigInt(439_467 + 145_574 + 5));
    expect((await w.records.validation(validationId))?.copies).toBe(6);
    const kinds: string[] = [];
    const outcome = await runFactoryValidation(workerDeps(), {
      validation_id: validationId,
      validate: async (hooks) => {
        for (const state of ["clean", "clean", "buggy", "buggy", "fixed", "fixed", "fixed"] as const) {
          kinds.push((await hooks.meter.run({ subject: CASE_ID, host: "umami", state, limits: { timeout_s: 120, vcpus: 4, memory_mb: 8192 } }, lives(10_000))).kind);
        }
        return { result: "error", matrix: null, message: "synthetic: a seventh copy was refused" };
      },
    });
    expect(kinds).toEqual(["ran", "ran", "ran", "ran", "ran", "ran", "refused"]);
    expect(outcome).toEqual({ kind: "finished", result: "error", slot_released: true });
    const settled = await w.spend.operationStatus({ operation_id: operationId });
    expect(settled.ok && settled.state).toBe("reconciled");
  });

  it("admits a copy that ends inside the run's 30 s finish margin though not inside the request's 120 s copy margin", async () => {
    const { validationId } = await acceptedValidation();
    const outcome = await runFactoryValidation(workerDeps(), {
      validation_id: validationId,
      validate: async (hooks) => {
        // 950 s in: 720 s + 60 s + 30 s end 40 s before the window does; 120 s instead of 30 s would pass it.
        w.clock.ms = Date.parse(hooks.validation.accepted_at) + 950_000;
        expect(await hooks.meter.run(plan(CASE_ID, "clean"), lives(1000))).toMatchObject({ kind: "ran" });
        return { result: "passed", matrix: MATRIX, message: null };
      },
    });
    expect(outcome).toEqual({ kind: "finished", result: "passed", slot_released: true });
  });

  it("finishes error, never passed, when the harness returns after the run's 1,800 s, still settling as measured and releasing the slot", async () => {
    const { record, validationId } = await acceptedValidation();
    const outcome = await runFactoryValidation(workerDeps(), {
      validation_id: validationId,
      validate: async (hooks) => {
        await hooks.meter.run(plan(CASE_ID, "clean"), lives(90_000));
        w.clock.ms = hooks.deadline.getTime() + 1;
        return { result: "passed", matrix: MATRIX, message: "All six cells matched their expected outcomes." };
      },
    });
    expect(outcome).toEqual({ kind: "finished", result: "error", slot_released: true });
    const finished = (await w.records.validationEvents(validationId)).find((event) => event.type === "finished")?.data;
    expect(finished).toMatchObject({ result: "error", matrix: null, message: "The validation run did not finish within 1,800 s." });
    expect(typeof finished?.cost_microusd).toBe("number");
    expect((await w.records.events(record.request_id)).find((event) => event.type === "validation_finished")?.data).toEqual({ validation_id: validationId, result: "error" });
  });

  it("finishes error with its reservation and the slot held when a copy's stop cannot be confirmed", async () => {
    const { record, validationId, operationId } = await acceptedValidation();
    const outcome = await runFactoryValidation(workerDeps(), {
      validation_id: validationId,
      validate: async (hooks) => {
        await hooks.meter.run(plan(CASE_ID, "clean"), lives(10_000, { stop_confirmed: false }));
        return { result: "error", matrix: null, message: "A copy could not be confirmed stopped." };
      },
    });
    expect(outcome).toEqual({ kind: "finished", result: "error", slot_released: false });
    expect(await operationState(w, operationId)).toBe("uncertain");
    expect(await slotHolder(w)).toBe(w.identity.validationRoot(validationId));
    expect((await w.records.validationEvents(validationId)).at(-1)?.data).toMatchObject({ result: "error", cost_microusd: null });
    expect((await w.records.events(record.request_id)).some((event) => event.type === "attention")).toBe(true);
  });

  it("finishes error, still settling and releasing, when the harness throws", async () => {
    const { validationId } = await acceptedValidation();
    const outcome = await runFactoryValidation(workerDeps(), { validation_id: validationId, validate: () => Promise.reject(new Error("synthetic: harness failed")) });
    expect(outcome).toEqual({ kind: "finished", result: "error", slot_released: true });
  });

  it("finishes error with no matrix when the run's settlement is refused after the harness passed, so the run stays a valid ValidationRun", async () => {
    const { validationId, operationId } = await acceptedValidation();
    const settle = w.spend.settle.bind(w.spend);
    w.ledger.spend = { ...w.spend, settle: (request) => (request.operation_id === operationId ? Promise.resolve({ ok: false as const, code: "already_settled" as const }) : settle(request)) };
    const outcome = await runFactoryValidation(workerDeps(), { validation_id: validationId, validate: () => Promise.resolve({ result: "passed", matrix: MATRIX, message: "All six cells matched their expected outcomes." }) });
    expect(outcome).toEqual({ kind: "finished", result: "error", slot_released: false });
    const events = await w.records.validationEvents(validationId);
    const started = events.find((event) => event.type === "running")?.data;
    const finished = events.find((event) => event.type === "finished")?.data;
    expect(finished).toMatchObject({ result: "error", matrix: null, cost_microusd: null });
    // The run as the service serves it from these records.
    const run = {
      contract_version: "bug-request/1",
      validation_id: validationId,
      case_id: CASE_ID,
      state: "finished",
      result: finished?.result,
      matrix: finished?.matrix,
      package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) },
      harness: { name: "rbw-validate", version: "1" },
      message: finished?.message,
      started_at: started?.started_at,
      finished_at: finished?.finished_at,
      cost_microusd: finished?.cost_microusd,
      poll_after_ms: 0,
    };
    expect(validateContract("ValidationRun", run)).toEqual([]);
  });

  it("finishes error with no cost and the slot held when the run's settlement call fails, and the lost-worker routine never settles it again", async () => {
    const { validationId, operationId } = await acceptedValidation();
    const settle = w.spend.settle.bind(w.spend);
    const settles: string[] = [];
    w.ledger.spend = {
      ...w.spend,
      settle: (request) => {
        settles.push(request.operation_id);
        return request.operation_id === operationId ? Promise.reject(new Error("synthetic: the connection dropped")) : settle(request);
      },
    };
    const outcome = await runFactoryValidation(workerDeps(), {
      validation_id: validationId,
      validate: async (hooks) => {
        await hooks.meter.run(plan(CASE_ID, "clean"), lives(90_000));
        return { result: "passed", matrix: MATRIX, message: "All six cells matched their expected outcomes." };
      },
    });
    expect(outcome).toEqual({ kind: "finished", result: "error", slot_released: false });
    expect((await w.records.validationEvents(validationId)).find((event) => event.type === "finished")?.data).toMatchObject({ result: "error", matrix: null, cost_microusd: null });
    const root = w.identity.validationRoot(validationId);
    w.clock.advance(181_000);
    expect(await finalizeLostWorker(lostDeps(), { validation_id: validationId })).toEqual({ kind: "finished" });
    expect(settles.filter((id) => id === operationId)).toHaveLength(1);
    expect(await operationState(w, operationId)).toBe("terminal");
    expect(await slotHolder(w)).toBe(root);
    expect(await busyReason({ spend: w.spend, records: w.records }, "factory")).toBe("needs_reconciliation");
  });

  it("stops after a lost-worker finish of its run: no settlement, event or release of its own, even with a copy left uncertain", async () => {
    const { record, validationId, operationId } = await acceptedValidation();
    let afterLost: string[] = [];
    let validationAfterLost = 0;
    const outcome = await runFactoryValidation(workerDeps({ heartbeat_ms: 3_600_000 }), {
      validation_id: validationId,
      validate: async (hooks) => {
        // The copy is in flight when the status route finds the run lost (no heartbeat for 180 s).
        await hooks.meter.run(plan(CASE_ID, "clean"), async (name, launch) => {
          await launch.created(name);
          w.clock.advance(181_000);
          expect(await finalizeLostWorker(lostDeps(), { validation_id: validationId })).toEqual({ kind: "finalized", slot_held: false });
          afterLost = w.records.types(record.request_id);
          validationAfterLost = (await w.records.validationEvents(validationId)).length;
          return { result: name, created: true, lifetime_ms: 181_000, stop_confirmed: false, status: "completed" };
        });
        expect(hooks.meter.uncertain).toBe(true);
        return { result: "error", matrix: null, message: "A copy could not be confirmed stopped." };
      },
    });
    expect(outcome).toEqual({ kind: "fenced" });
    expect(w.records.types(record.request_id)).toEqual(afterLost);
    expect((await w.records.validationEvents(validationId)).length).toBe(validationAfterLost);
    // Settled once, by the lost-worker finish, at the full worst case.
    const status = await w.spend.operationStatus({ operation_id: operationId });
    expect(status.ok && [status.state, status.settled_microusd]).toEqual(["reconciled", BigInt(VALIDATION_3_MICROUSD)]);
    expect(await slotHolder(w)).toBeNull();
  });
});
