import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StopCode, ValidationMatrix } from "@rbw/factory-contract";
import { FACTORY_PROFILE } from "../../src/factory-profile.ts";
import { copyOperation, validationOperation, workerOperation } from "../../src/factory-ledger.ts";
import { startFactoryValidation, startFactoryWorker } from "../../src/factory-launch.ts";
import type { FactoryLaunchDeps } from "../../src/factory-launch.ts";
import { finalizeLostWorker } from "../../src/factory-lost.ts";
import type { LaunchReport, MeteredCopyPlan } from "../../src/factory-meter.ts";
import type { FactoryRequestRecord } from "../../src/factory-ports.ts";
import { runFactoryValidation, runFactoryWorker, startHeartbeat } from "../../src/factory-worker.ts";
import type { Orchestrate, RequestHooks, WorkerDeps } from "../../src/factory-worker.ts";
import { CANDIDATE_A, CASE_ID, CREDENTIALS, FakeRecords, SYNTHETIC_REQUEST_NAMESPACE, WORKER_IMAGE, acceptRequest, factoryWorld, operationState, slotHolder, syntheticUuid } from "./factory-fakes.ts";
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
  return copyOperation({ identity: w.identity, rates: w.rates }, { namespace: SYNTHETIC_REQUEST_NAMESPACE, root: record.root, task_revision: record.interpretation_sha256, subject: CANDIDATE_A, state, n: 1, host: "task-report", provider: "vercel-sandbox" }).operation_id;
}

/** A synthetic stand-in for the factory core's request loop: one candidate, copies in order, a checkpoint before each. */
function synthetic(states: MeteredCopyPlan["state"][], done: StopCode, launch = lives(60_000)): Orchestrate {
  return async (hooks: RequestHooks) => {
    for (const state of states) {
      const checkpoint = await hooks.checkpoint();
      if (checkpoint === "fenced") return { stop_code: "operational_error", finished: false };
      if (checkpoint === "stop") return { stop_code: "cancelled_by_user", finished: false };
      const outcome = await hooks.meter.run(plan(CANDIDATE_A, state), launch);
      if (outcome.kind === "refused" && outcome.reason === "budget") return { stop_code: "budget_exhausted", finished: false };
      if (outcome.kind === "uncertain") return { stop_code: "needs_reconciliation", finished: false };
    }
    return { stop_code: done, finished: false };
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
  it("heartbeats, appends worker_started, runs the request loop, then finishes, settles itself in full, closes the budget and releases the slot", async () => {
    const record = await launched();
    const outcome = await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate: synthetic(["clean", "buggy"], "fulfilled") });
    expect(outcome).toEqual({ kind: "finished", stop_code: "fulfilled", slot_released: true });
    expect(w.records.heartbeats.filter((beat) => "request_id" in beat.target).length).toBeGreaterThanOrEqual(1);
    const types = w.records.types(record.request_id);
    expect(types[2]).toBe("worker_started");
    expect(types.slice(-2)).toEqual(["request_finished", "budget_updated"]);
    const worker = await w.spend.operationStatus({ operation_id: workerOperation({ identity: w.identity, rates: w.rates }, record).operation_id });
    expect(worker.ok && [worker.state, worker.settled_microusd]).toEqual(["reconciled", BigInt(FACTORY_PROFILE.prices.worker_worst_case_microusd)]);
    expect(await operationState(w, copyId(record, "clean"))).toBe("reconciled");
    expect(await operationState(w, copyId(record, "buggy"))).toBe("reconciled");
    expect(w.budgets.closes).toEqual([{ budget_key: record.budget_key, cause: "fulfilled" }]);
    expect(await slotHolder(w)).toBeNull();
    // Each copy's reservation and settlement appended budget_updated.
    expect(types.filter((type) => type === "budget_updated").length).toBe(1 + 2 * 2 + 1);
  });

  it("checks for a stop between copies: no copy starts after the stop is recorded", async () => {
    const record = await launched();
    const launch = async (name: string, hooks: { created(id: string): Promise<void> }) => {
      const report = await lives(30_000)(name, hooks);
      w.records.stops.add(record.request_id);
      return report;
    };
    const outcome = await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate: synthetic(["clean", "buggy", "fixed"], "fulfilled", launch) });
    expect(outcome).toMatchObject({ kind: "finished", stop_code: "cancelled_by_user" });
    expect(await operationState(w, copyId(record, "clean"))).toBe("reconciled");
    expect(await operationState(w, copyId(record, "buggy"))).toBeNull();
    const finished = (await w.records.events(record.request_id)).find((event) => event.type === "request_finished");
    expect(finished?.data).toEqual({ outcome: "cancelled", stop_code: "cancelled_by_user" });
  });

  it("ends budget_exhausted when the budget can no longer cover the next copy, launching nothing more", async () => {
    // The worker and one copy fit; after the first copy settles, the next copy's worst case does not.
    const record = await launched(500_000);
    const outcome = await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate: synthetic(["clean", "buggy"], "fulfilled") });
    expect(outcome).toEqual({ kind: "finished", stop_code: "budget_exhausted", slot_released: true });
    expect(await operationState(w, copyId(record, "buggy"))).toBeNull();
    expect(w.budgets.closes).toEqual([{ budget_key: record.budget_key, cause: "budget_exhausted" }]);
    const status = await w.ledger.budgets.status(record.budget_key);
    expect(status.ok && status.open_microusd).toBe(0n);
  });

  it("finishes needs_reconciliation when a copy is uncertain, settles itself and keeps the slot held", async () => {
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
    expect(tail.map((event) => event.data)).toEqual([{ code: "needs_reconciliation" }, { outcome: "operational_error", stop_code: "needs_reconciliation" }]);
  });

  it("never reports a clean stop code while a copy is uncertain", async () => {
    const record = await launched();
    const orchestrate: Orchestrate = async (hooks) => {
      await hooks.meter.run(plan(CANDIDATE_A, "clean"), async (name, h) => {
        await h.created(name);
        throw new Error("synthetic: lost response");
      });
      return { stop_code: "sources_exhausted", finished: false };
    };
    expect(await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate })).toMatchObject({ stop_code: "needs_reconciliation" });
  });

  it("stops at the next checkpoint without appending or settling anything once the request was finished as lost", async () => {
    const record = await launched();
    let afterLost: string[] = [];
    const orchestrate: Orchestrate = async (hooks) => {
      await hooks.meter.run(plan(CANDIDATE_A, "clean"), lives(10_000));
      // The status route declares the worker lost (no heartbeat for 180 s on the request's clock).
      w.clock.advance(400_000);
      expect((await finalizeLostWorker({ ledger: w.ledger, records: w.records, identity: w.identity, sandbox: w.sandbox, rates: w.rates, now: w.clock.now, log: () => undefined }, { request_id: record.request_id })).kind).toBe("finalized");
      afterLost = w.records.types(record.request_id);
      expect(await hooks.checkpoint()).toBe("fenced");
      const late = await hooks.append({ event_key: "late", type: "check_finished", host_id: "task-report", candidate_id: CANDIDATE_A, item_key: null, case_id: null, message: "late", data: {} });
      expect(late.kind).toBe("refused");
      expect(await hooks.meter.run(plan(CANDIDATE_A, "buggy"), lives(10_000))).toMatchObject({ kind: "refused", reason: "stopped" });
      return { stop_code: "operational_error", finished: false };
    };
    expect(await runFactoryWorker(workerDeps({ heartbeat_ms: 3_600_000 }), { request_id: record.request_id, deadline: deadline(), orchestrate })).toEqual({ kind: "fenced" });
    expect(w.records.types(record.request_id)).toEqual(afterLost);
    expect(w.records.refusedAppends).toEqual([]);
    expect(await operationState(w, workerOperation({ identity: w.identity, rates: w.rates }, record).operation_id)).toBe("uncertain");
    expect(await slotHolder(w)).toBe(record.root);
  });

  it("finishes operational_error when the request loop throws", async () => {
    const record = await launched();
    const outcome = await runFactoryWorker(workerDeps(), {
      request_id: record.request_id,
      deadline: deadline(),
      orchestrate: () => Promise.reject(new Error("synthetic: the loop failed")),
    });
    expect(outcome).toEqual({ kind: "finished", stop_code: "operational_error", slot_released: true });
    expect(w.logs.some((line) => line.includes("synthetic: the loop failed"))).toBe(true);
  });

  it("still sets needs_reconciliation when the loop finished the request itself while a copy was uncertain", async () => {
    const record = await launched();
    const orchestrate: Orchestrate = async (hooks) => {
      await hooks.meter.run(plan(CANDIDATE_A, "clean"), lives(5000, { stop_confirmed: false }));
      await hooks.append({ event_key: "finish", type: "request_finished", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Request finished: sources exhausted.", data: { outcome: "sources_exhausted", stop_code: "sources_exhausted" } });
      return { stop_code: "sources_exhausted", finished: true };
    };
    expect(await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate })).toMatchObject({ slot_released: false });
    const attention = (await w.records.events(record.request_id)).filter((event) => event.type === "attention");
    expect(attention.map((event) => event.data)).toEqual([{ code: "needs_reconciliation" }]);
    expect(await slotHolder(w)).toBe(record.root);
  });

  it("does not append request_finished again when the request loop already did", async () => {
    const record = await launched();
    const orchestrate: Orchestrate = async (hooks) => {
      await hooks.append({ event_key: "finish", type: "request_finished", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Request finished: sources exhausted.", data: { outcome: "sources_exhausted", stop_code: "sources_exhausted" } });
      return { stop_code: "sources_exhausted", finished: true };
    };
    expect(await runFactoryWorker(workerDeps(), { request_id: record.request_id, deadline: deadline(), orchestrate })).toMatchObject({ stop_code: "sources_exhausted", slot_released: true });
    expect(w.records.types(record.request_id).filter((type) => type === "request_finished")).toHaveLength(1);
    expect(w.budgets.closes).toEqual([{ budget_key: record.budget_key, cause: "sources_exhausted" }]);
  });
});

describe("runFactoryValidation", () => {
  async function acceptedValidation(): Promise<{ record: FactoryRequestRecord; validationId: string; operationId: string }> {
    const record = await acceptRequest(w);
    await w.spend.releaseSlot({ slot_key: "factory", root_execution_id: record.root, actor_role: "factory-worker", evidence: null, reason: null });
    await w.budgets.close(record.budget_key, "fulfilled");
    const validationId = syntheticUuid("7300");
    const started = await startFactoryValidation(launchDeps(), { request_id: record.request_id, case_id: CASE_ID, validation_id: validationId, host_id: "task-report", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" } });
    expect(started.kind).toBe("accepted");
    const root = w.identity.validationRoot(validationId);
    return { record, validationId, operationId: validationOperation({ identity: w.identity, rates: w.rates }, { root, case_id: CASE_ID, host_id: "task-report" }).operation_id };
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
});
