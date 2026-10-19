import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FACTORY_PROFILE } from "../../src/factory-profile.ts";
import { copyOperation, validationOperation, workerOperation } from "../../src/factory-ledger.ts";
import { startFactoryValidation, startFactoryWorker } from "../../src/factory-launch.ts";
import type { FactoryLaunchDeps } from "../../src/factory-launch.ts";
import { completeReconciliation, finalizeLostWorker, noteWorkerUnresponsive } from "../../src/factory-lost.ts";
import type { LostDeps } from "../../src/factory-lost.ts";
import { CopyMeter } from "../../src/factory-meter.ts";
import type { LaunchReport } from "../../src/factory-meter.ts";
import type { FactoryRequestRecord } from "../../src/factory-ports.ts";
import { CANDIDATE_A, CASE_ID, CREDENTIALS, FakeInstance, SYNTHETIC_REQUEST_NAMESPACE, WORKER_IMAGE, acceptRequest, factoryWorld, operationState, slotHolder, syntheticUuid } from "./factory-fakes.ts";
import type { FactoryWorld } from "./factory-fakes.ts";

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
  return { ledger: w.ledger, records: w.records, identity: w.identity, sandbox: w.sandbox, rates: w.rates, now: w.clock.now, log: (line) => w.logs.push(line) };
}

function workerId(record: FactoryRequestRecord): string {
  return workerOperation({ identity: w.identity, rates: w.rates }, record, WORKER_IMAGE).operation_id;
}

function copyId(record: FactoryRequestRecord): string {
  return copyOperation({ identity: w.identity, rates: w.rates }, { namespace: SYNTHETIC_REQUEST_NAMESPACE, root: record.root, task_revision: record.interpretation_sha256, subject: CANDIDATE_A, state: "clean", n: 1, host: "task-report", provider: "vercel-sandbox" }).operation_id;
}

/** A request whose worker started, heartbeat once, selected candidate A and has its first copy in flight. */
async function runningRequest(): Promise<FactoryRequestRecord> {
  const record = await acceptRequest(w, { budget: 1_000_000 });
  expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("launched");
  await w.records.recordHeartbeat({ request_id: record.request_id }, w.clock.now());
  const append = (event_key: string, type: "worker_started" | "candidate_selected", candidate: string | null, data: Record<string, unknown>, message: string) =>
    w.records.appendEvent(record.request_id, { event_key, type, host_id: candidate === null ? null : "task-report", candidate_id: candidate, item_key: null, case_id: null, message, data }, w.clock.now());
  await append("worker_started", "worker_started", null, {}, "The worker started.");
  await append(`cand:${CANDIDATE_A}:selected`, "candidate_selected", CANDIDATE_A, { source_id: "synthetic-task-report-concurrency", entry_id: "synthetic-task-report-concurrency-01" }, "Selected catalog entry synthetic-task-report-concurrency-01.");
  const meter = new CopyMeter({
    ledger: w.ledger,
    identity: w.identity,
    rates: w.rates,
    now: w.clock.now,
    root: record.root,
    namespace: SYNTHETIC_REQUEST_NAMESPACE,
    task_revision: record.interpretation_sha256,
    budget_key: record.budget_key,
    provider: "vercel-sandbox",
    deadline: new Date(w.clock.ms + 3_600_000),
    margin_s: 120,
    mode: { kind: "own_operation", role: "request" },
    log: (line) => w.logs.push(line),
  });
  void meter.run({ subject: CANDIDATE_A, host: "task-report", state: "clean", limits: { timeout_s: 720, vcpus: 4, memory_mb: 8192 } }, async (name, hooks) => {
    w.sandbox.sandboxes.set(name, new FakeInstance(name, w.sandbox));
    await hooks.created(name);
    return new Promise<LaunchReport<string>>(() => undefined);
  });
  for (let i = 0; i < 100 && (await operationState(w, copyId(record))) !== "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await operationState(w, copyId(record))).toBe("running");
  return record;
}

describe("finalizeLostWorker for a request", () => {
  it("does nothing while the heartbeat is younger than 180 s", async () => {
    const record = await runningRequest();
    const before = await w.records.events(record.request_id);
    w.clock.advance(179_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "alive" });
    expect(await w.records.events(record.request_id)).toEqual(before);
    expect(await operationState(w, workerId(record))).toBe("running");
  });

  it("moves the worker and the in-flight copy to uncertain, ends the candidate incomplete, finishes worker_lost and keeps the slot held", async () => {
    const record = await runningRequest();
    w.clock.advance(181_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finalized", slot_held: true });
    expect(await operationState(w, workerId(record))).toBe("uncertain");
    expect(await operationState(w, copyId(record))).toBe("uncertain");
    const events = await w.records.events(record.request_id);
    expect(events.slice(-4).map((event) => [event.type, event.candidate_id, event.data])).toEqual([
      ["attention", null, { code: "worker_unresponsive" }],
      ["candidate_incomplete", CANDIDATE_A, { reason: "incomplete_run" }],
      ["attention", null, { code: "needs_reconciliation" }],
      ["request_finished", null, { outcome: "operational_error", stop_code: "worker_lost" }],
    ]);
    expect(w.budgets.closes).toEqual([{ budget_key: record.budget_key, cause: "worker_lost" }]);
    expect(await slotHolder(w)).toBe(record.root);
    // Nothing was settled: the reservations stay held for reconciliation.
    const budget = await w.ledger.budgets.status(record.budget_key);
    expect(budget.ok && [budget.settled_microusd, budget.open_microusd]).toEqual([0n, BigInt(FACTORY_PROFILE.prices.worker_worst_case_microusd + FACTORY_PROFILE.prices.copy_worst_case_microusd["task-report"])]);
    // Both sandboxes were asked to stop.
    const stopped = w.sandbox.calls.filter((call) => call.action === "stop").map((call) => call.name);
    expect(stopped).toContain(`rbw-fw-${record.root}`);
    expect(stopped.some((name) => name.startsWith("rbw-fc-"))).toBe(true);
  });

  it("gives one set of events and one budget close under concurrent calls, and is idempotent afterwards", async () => {
    const record = await runningRequest();
    w.clock.advance(200_000);
    const results = await Promise.all([1, 2, 3].map(() => finalizeLostWorker(lostDeps(), { request_id: record.request_id })));
    expect(results.every((result) => result.kind === "finalized")).toBe(true);
    const events = await w.records.events(record.request_id);
    expect(events.filter((event) => event.type === "request_finished")).toHaveLength(1);
    expect(events.filter((event) => event.type === "candidate_incomplete")).toHaveLength(1);
    expect(events.filter((event) => event.type === "attention")).toHaveLength(2);
    expect(w.budgets.closes).toHaveLength(1);
    expect(await operationState(w, workerId(record))).toBe("uncertain");
    expect(await operationState(w, copyId(record))).toBe("uncertain");
    const again = await finalizeLostWorker(lostDeps(), { request_id: record.request_id });
    expect(again.kind).toBe("finalized");
    expect(await w.records.events(record.request_id)).toEqual(events);
  });

  it("leaves a request that finished on its own alone", async () => {
    const record = await acceptRequest(w);
    await w.records.appendEvent(record.request_id, { event_key: "finish", type: "request_finished", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Request finished: fulfilled.", data: { outcome: "fulfilled", stop_code: "fulfilled" } }, w.clock.now());
    w.clock.advance(1_000_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finished" });
    expect(w.budgets.closes).toEqual([]);
  });

  it("finishes a worker that never sent a heartbeat once 180 s passed since the request was created", async () => {
    const record = await acceptRequest(w);
    await startFactoryWorker(launchDeps(), record.request_id);
    w.clock.advance(150_000);
    expect((await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).kind).toBe("alive");
    w.clock.advance(31_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finalized", slot_held: true });
    expect(w.records.types(record.request_id).filter((type) => type === "candidate_incomplete")).toEqual([]);
  });

  it("notes worker_unresponsive once after 60 s without a heartbeat", async () => {
    const record = await runningRequest();
    w.clock.advance(59_000);
    expect(await noteWorkerUnresponsive(lostDeps(), record.request_id)).toBe(false);
    w.clock.advance(2_000);
    expect(await noteWorkerUnresponsive(lostDeps(), record.request_id)).toBe(true);
    expect(await noteWorkerUnresponsive(lostDeps(), record.request_id)).toBe(true);
    expect((await w.records.events(record.request_id)).filter((event) => event.type === "attention")).toHaveLength(1);
  });

  it("releases the held slot only after an operator reconciled every uncertain operation", async () => {
    const record = await runningRequest();
    w.clock.advance(181_000);
    await finalizeLostWorker(lostDeps(), { request_id: record.request_id });
    const blocked = await completeReconciliation(lostDeps(), { request_id: record.request_id });
    expect(blocked.kind).toBe("blocked");
    expect(blocked.kind === "blocked" && [...blocked.operation_ids].sort()).toEqual([workerId(record), copyId(record)].sort());
    for (const id of [workerId(record), copyId(record)]) {
      const status = await w.spend.operationStatus({ operation_id: id });
      if (!status.ok) throw new Error("synthetic: unknown operation");
      const slot = await w.spend.slotStatus({ slot_key: "factory" });
      const resources = slot.ok ? slot.children.filter((child) => child.operation_id === id).map((child) => child.resource_id) : [];
      const reconciled = await w.spend.reconcile({
        schema_version: 1,
        operation_id: id,
        previous_state: "uncertain",
        evidence: [{ key: `synthetic/reconcile/${id}`, sha256: "f".repeat(64) }],
        provider_resource_ids: resources,
        recorded_at: w.clock.now().toISOString(),
        actor_role: "operator",
        decision: "confirm_stopped_incomplete",
        retained_microusd: Number(status.open_microusd),
        released_microusd: 0,
        reason: "synthetic reconciliation",
      });
      expect(reconciled.ok).toBe(true);
    }
    expect(await completeReconciliation(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "released" });
    expect(await slotHolder(w)).toBeNull();
    const tail = (await w.records.events(record.request_id)).slice(-2);
    expect(tail.map((event) => [event.type, event.type === "attention_cleared" ? event.data : null])).toEqual([
      ["budget_updated", null],
      ["attention_cleared", { code: "needs_reconciliation" }],
    ]);
    expect(await completeReconciliation(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "not_held" });
  });
});

describe("finalizeLostWorker for a validation run", () => {
  async function runningValidation(): Promise<{ record: FactoryRequestRecord; validationId: string; operationId: string }> {
    const record = await acceptRequest(w);
    await w.spend.releaseSlot({ slot_key: "factory", root_execution_id: record.root, actor_role: "factory-worker", evidence: null, reason: null });
    await w.budgets.close(record.budget_key, "fulfilled");
    const validationId = syntheticUuid("7200");
    const started = await startFactoryValidation(launchDeps(), { request_id: record.request_id, case_id: CASE_ID, validation_id: validationId, host_id: "task-report", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" } });
    expect(started.kind).toBe("accepted");
    await w.records.recordHeartbeat({ validation_id: validationId }, w.clock.now());
    const root = w.identity.validationRoot(validationId);
    const operationId = validationOperation({ identity: w.identity, rates: w.rates }, { root, case_id: CASE_ID, host_id: "task-report" }, WORKER_IMAGE).operation_id;
    return { record, validationId, operationId };
  }

  it("settles at the full worst case and releases the slot when its sandbox is confirmed stopped", async () => {
    const { record, validationId, operationId } = await runningValidation();
    w.clock.advance(181_000);
    expect(await finalizeLostWorker(lostDeps(), { validation_id: validationId })).toEqual({ kind: "finalized", slot_held: false });
    const status = await w.spend.operationStatus({ operation_id: operationId });
    expect(status.ok && [status.state, status.settled_microusd]).toEqual(["reconciled", BigInt(FACTORY_PROFILE.prices.validation_worst_case_microusd["task-report"])]);
    expect(await slotHolder(w)).toBeNull();
    const finished = (await w.records.validationEvents(validationId)).find((event) => event.type === "finished");
    expect(finished?.data).toMatchObject({ result: "error", cost_microusd: FACTORY_PROFILE.prices.validation_worst_case_microusd["task-report"] });
    expect(w.records.types(record.request_id).slice(-2)).toEqual(["validation_finished", "budget_updated"]);
  });

  it("keeps the reservation and the slot held when its sandbox cannot be confirmed stopped", async () => {
    const { record, validationId, operationId } = await runningValidation();
    w.sandbox.stopTakesEffect = false;
    w.clock.advance(181_000);
    expect(await finalizeLostWorker(lostDeps(), { validation_id: validationId })).toEqual({ kind: "finalized", slot_held: true });
    expect(await operationState(w, operationId)).toBe("uncertain");
    expect(await slotHolder(w)).toBe(w.identity.validationRoot(validationId));
    const finished = (await w.records.validationEvents(validationId)).find((event) => event.type === "finished");
    expect(finished?.data).toMatchObject({ result: "error", cost_microusd: null });
    expect((await w.records.events(record.request_id)).filter((event) => event.type === "attention").map((event) => event.data)).toEqual([{ code: "needs_reconciliation" }]);
  });

  it("finishes a run still going after 1,800 s even with fresh heartbeats", async () => {
    const { validationId } = await runningValidation();
    w.clock.advance(1_000_000);
    await w.records.recordHeartbeat({ validation_id: validationId }, w.clock.now());
    expect((await finalizeLostWorker(lostDeps(), { validation_id: validationId })).kind).toBe("alive");
    w.clock.advance(800_001);
    await w.records.recordHeartbeat({ validation_id: validationId }, w.clock.now());
    expect((await finalizeLostWorker(lostDeps(), { validation_id: validationId })).kind).toBe("finalized");
  });
});
