import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FACTORY_PROFILE } from "../../src/factory-profile.ts";
import { busyReason, copyOperation, fullSettlement, validationOperation, validationSettlement, workerOperation } from "../../src/factory-ledger.ts";
import { startFactoryValidation, startFactoryWorker } from "../../src/factory-launch.ts";
import type { FactoryLaunchDeps } from "../../src/factory-launch.ts";
import { completeReconciliation, finalizeLostWorker } from "../../src/factory-lost.ts";
import type { LostDeps } from "../../src/factory-lost.ts";
import { CopyMeter } from "../../src/factory-meter.ts";
import type { LaunchReport } from "../../src/factory-meter.ts";
import type { FactoryRequestRecord } from "../../src/factory-ports.ts";
import { CANDIDATE_A, CASE_ID, CREDENTIALS, FakeInstance, WORKER_IMAGE, acceptRequest, factoryWorld, operationState, slotHolder, syntheticUuid } from "./factory-fakes.ts";
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
  return { ledger: w.ledger, records: w.records, identity: w.identity, events: w.events, sandbox: w.sandbox, rates: w.rates, now: w.clock.now, log: (line) => w.logs.push(line) };
}

function workerId(record: FactoryRequestRecord): string {
  return workerOperation({ identity: w.identity, rates: w.rates }, record).operation_id;
}

function copyId(record: FactoryRequestRecord): string {
  return copyOperation({ identity: w.identity, rates: w.rates }, { kind: "request", root: record.root, task_revision: record.interpretation_sha256, subject: CANDIDATE_A, state: "clean", n: 1, host: "task-report", provider: "vercel-sandbox" }).operation_id;
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
    kind: "request",
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

/** What an operator does before completing a reconciliation: reconciles every operation that keeps the slot held. */
async function reconcileHeld(): Promise<void> {
  const slot = await w.spend.slotStatus({ slot_key: "factory" });
  if (!slot.ok) throw new Error("synthetic: slot status refused");
  for (const id of slot.release_blockers.operation_ids) {
    const status = await w.spend.operationStatus({ operation_id: id });
    if (!status.ok) throw new Error("synthetic: unknown operation");
    const resources = slot.children.filter((child) => child.operation_id === id).map((child) => child.resource_id);
    const never = status.state === "prepared";
    const reconciled = await w.spend.reconcile({
      schema_version: 1,
      operation_id: id,
      previous_state: status.state,
      evidence: [{ key: `synthetic/reconcile/${id}`, sha256: "f".repeat(64) }],
      provider_resource_ids: never ? [] : resources,
      recorded_at: w.clock.now().toISOString(),
      actor_role: "operator",
      decision: never ? "confirm_no_launch" : "confirm_stopped_incomplete",
      retained_microusd: never ? 0 : Number(status.open_microusd),
      released_microusd: never ? Number(status.open_microusd) : 0,
      reason: "synthetic reconciliation",
    });
    expect(reconciled.ok).toBe(true);
  }
}

const FINISHED = { event_key: "run:finished", type: "request_finished" as const, host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Request finished: fulfilled.", data: { outcome: "fulfilled", stop_code: "fulfilled" } };

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
    // The factory core's lost-worker events, under its keys; the worker_unresponsive attention is the status side's, not this routine's.
    const events = await w.records.events(record.request_id);
    expect(events.slice(-3).map((event) => [event.event_key, event.type, event.candidate_id, event.data])).toEqual([
      ["lost:candidate-end", "candidate_incomplete", CANDIDATE_A, { reason: "incomplete_run" }],
      ["lost:attention", "attention", null, { code: "needs_reconciliation" }],
      ["lost:finished", "request_finished", null, { outcome: "operational_error", stop_code: "worker_lost" }],
    ]);
    expect(events.filter((event) => event.type === "attention")).toHaveLength(1);
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
    expect(events.filter((event) => event.type === "attention")).toHaveLength(1);
    expect(w.budgets.closes).toHaveLength(1);
    expect(await operationState(w, workerId(record))).toBe("uncertain");
    expect(await operationState(w, copyId(record))).toBe("uncertain");
    const again = await finalizeLostWorker(lostDeps(), { request_id: record.request_id });
    expect(again.kind).toBe("finalized");
    expect(await w.records.events(record.request_id)).toEqual(events);
  });

  it("leaves a request that finished on its own and released the slot alone", async () => {
    const record = await acceptRequest(w);
    await w.records.appendEvent(record.request_id, FINISHED, w.clock.now());
    await w.spend.releaseSlot({ slot_key: "factory", root_execution_id: record.root, actor_role: "factory-worker", evidence: null, reason: null });
    w.clock.advance(1_000_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finished" });
    expect(w.budgets.closes).toEqual([]);
    expect(w.records.types(record.request_id)).toEqual(["request_accepted", "request_finished"]);
  });

  it("makes a finished request whose worker stopped before settling visible: its open operations uncertain, attention once, the slot held", async () => {
    const record = await acceptRequest(w);
    expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("launched");
    await w.records.recordHeartbeat({ request_id: record.request_id }, w.clock.now());
    // The loop appended request_finished; then the worker died before it settled itself or released the slot.
    await w.records.appendEvent(record.request_id, FINISHED, w.clock.now());
    w.clock.advance(100_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finished" });
    expect(await operationState(w, workerId(record))).toBe("running");
    w.clock.advance(81_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finalized", slot_held: true });
    expect(await operationState(w, workerId(record))).toBe("uncertain");
    expect(await slotHolder(w)).toBe(record.root);
    expect(await busyReason({ spend: w.spend, records: w.records }, "factory")).toBe("needs_reconciliation");
    const attention = (await w.records.events(record.request_id)).filter((event) => event.type === "attention");
    expect(attention.map((event) => [event.event_key, event.data])).toEqual([["run:attention:needs_reconciliation", { code: "needs_reconciliation" }]]);
    // The outcome stands, and a repeated call changes nothing.
    const events = await w.records.events(record.request_id);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finished" });
    expect(await w.records.events(record.request_id)).toEqual(events);
    expect(w.budgets.closes).toEqual([]);
  });

  it("releases the slot of a finished request whose worker settled but stopped before releasing it", async () => {
    const record = await acceptRequest(w);
    expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("launched");
    const op = workerOperation({ identity: w.identity, rates: w.rates }, record);
    await w.spend.transition({ operation_id: op.operation_id, from_state: "running", to_state: "terminal", actor_role: "factory-worker", terminal_status: "completed" });
    expect((await w.spend.settle(fullSettlement(op.envelope, op.operation_id))).ok).toBe(true);
    await w.records.appendEvent(record.request_id, FINISHED, w.clock.now());
    w.clock.advance(181_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finalized", slot_held: false });
    expect(await slotHolder(w)).toBeNull();
    expect(w.records.types(record.request_id).filter((type) => type === "attention")).toEqual([]);
  });

  it("keeps the slot of a finished request whose spend was left for reconciliation held, though nothing is open, and answers busy needs_reconciliation", async () => {
    const record = await acceptRequest(w);
    expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("launched");
    const op = workerOperation({ identity: w.identity, rates: w.rates }, record);
    await w.spend.transition({ operation_id: op.operation_id, from_state: "running", to_state: "terminal", actor_role: "factory-worker", terminal_status: "completed" });
    // The loop raised needs_reconciliation (for example after a failed settlement), then finished; the worker kept the slot.
    await w.records.appendEvent(record.request_id, w.events.attention("needs_reconciliation", w.clock.now()), w.clock.now());
    await w.records.appendEvent(record.request_id, FINISHED, w.clock.now());
    w.clock.advance(181_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finished" });
    expect(await slotHolder(w)).toBe(record.root);
    expect(await busyReason({ spend: w.spend, records: w.records }, "factory")).toBe("needs_reconciliation");
  });

  it("answers busy needs_reconciliation for a request finished worker_lost whose slot is held with nothing open, until reconciliation releases it", async () => {
    const record = await acceptRequest(w);
    // The worker reservation's outcome is unknown: the call failed after the request was recorded.
    w.ledger.budgets = { reserve: () => Promise.reject(new Error("synthetic: the connection dropped")), close: (key, cause) => w.budgets.close(key, cause), status: (key) => w.budgets.status(key) };
    await expect(startFactoryWorker(launchDeps(), record.request_id)).rejects.toThrow(/connection dropped/);
    w.ledger.budgets = w.budgets;
    w.clock.advance(181_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finalized", slot_held: true });
    const validation = { request_id: record.request_id, case_id: CASE_ID, validation_id: syntheticUuid("7210"), host_id: "task-report" as const, package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate" as const, version: "1" } };
    expect(await startFactoryValidation(launchDeps(), validation)).toEqual({ kind: "busy", reason: "needs_reconciliation" });
    expect(await completeReconciliation(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "released" });
    expect(await slotHolder(w)).toBeNull();
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

  it("releases the held slot only after an operator reconciled every uncertain operation", async () => {
    const record = await runningRequest();
    w.clock.advance(181_000);
    await finalizeLostWorker(lostDeps(), { request_id: record.request_id });
    const blocked = await completeReconciliation(lostDeps(), { request_id: record.request_id });
    expect(blocked.kind).toBe("blocked");
    expect(blocked.kind === "blocked" && [...blocked.operation_ids].sort()).toEqual([workerId(record), copyId(record)].sort());
    await reconcileHeld();
    expect(await completeReconciliation(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "released" });
    expect(await slotHolder(w)).toBeNull();
    const tail = (await w.records.events(record.request_id)).slice(-2);
    expect(tail.map((event) => [event.type, event.type === "attention_cleared" ? event.data : null])).toEqual([
      ["budget_updated", null],
      ["attention_cleared", { code: "needs_reconciliation" }],
    ]);
    expect(await completeReconciliation(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "not_held" });
  });

  it("finishes a completion whose release went through but whose attention clearing failed when it is called again", async () => {
    const record = await runningRequest();
    w.clock.advance(181_000);
    await finalizeLostWorker(lostDeps(), { request_id: record.request_id });
    await reconcileHeld();
    const append = w.records.appendEvent.bind(w.records);
    let failing = true;
    w.records.appendEvent = (id, event, at) => (failing && event.type === "attention_cleared" ? Promise.reject(new Error("synthetic: the connection dropped")) : append(id, event, at));
    await expect(completeReconciliation(lostDeps(), { request_id: record.request_id })).rejects.toThrow(/connection dropped/);
    expect(await slotHolder(w)).toBeNull();
    failing = false;
    expect(await completeReconciliation(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "released" });
    const events = await w.records.events(record.request_id);
    expect(events.filter((event) => event.type === "attention_cleared").map((event) => event.data)).toEqual([{ code: "needs_reconciliation" }]);
    expect(events.filter((event) => event.type === "budget_updated" && event.event_key.startsWith("reconciled:"))).toHaveLength(1);
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
    const operationId = validationOperation({ identity: w.identity, rates: w.rates }, { root, case_id: CASE_ID, host_id: "task-report" }).operation_id;
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

  it("releases the slot of a finished run whose worker settled but stopped before releasing it", async () => {
    const { validationId, operationId } = await runningValidation();
    const root = w.identity.validationRoot(validationId);
    const op = validationOperation({ identity: w.identity, rates: w.rates }, { root, case_id: CASE_ID, host_id: "task-report" });
    await w.spend.transition({ operation_id: operationId, from_state: "running", to_state: "terminal", actor_role: "factory-worker", terminal_status: "completed" });
    expect((await w.spend.settle(fullSettlement(op.envelope, operationId))).ok).toBe(true);
    await w.records.appendValidationEvent(validationId, { event_key: "finished", type: "finished", data: { result: "passed" } }, w.clock.now());
    w.clock.advance(100_000);
    expect(await finalizeLostWorker(lostDeps(), { validation_id: validationId })).toEqual({ kind: "finished" });
    w.clock.advance(81_000);
    expect(await finalizeLostWorker(lostDeps(), { validation_id: validationId })).toEqual({ kind: "finalized", slot_held: false });
    expect(await slotHolder(w)).toBeNull();
  });

  it("gives one finish, no attention and a released slot under overlapping calls for one lost run", async () => {
    const { record, validationId, operationId } = await runningValidation();
    w.clock.advance(181_000);
    const results = await Promise.all([1, 2, 3].map(() => finalizeLostWorker(lostDeps(), { validation_id: validationId })));
    expect(results.some((result) => result.kind === "finalized")).toBe(true);
    expect(results.every((result) => (result.kind === "finalized" && !result.slot_held) || result.kind === "finished")).toBe(true);
    expect(await slotHolder(w)).toBeNull();
    expect(w.records.types(record.request_id).filter((type) => type === "attention")).toEqual([]);
    const worst = FACTORY_PROFILE.prices.validation_worst_case_microusd["task-report"];
    expect((await w.records.validationEvents(validationId)).filter((event) => event.type === "finished").map((event) => event.data.cost_microusd)).toEqual([worst]);
    const status = await w.spend.operationStatus({ operation_id: operationId });
    expect(status.ok && [status.state, status.settled_microusd]).toEqual(["reconciled", BigInt(worst)]);
    expect(await finalizeLostWorker(lostDeps(), { validation_id: validationId })).toEqual({ kind: "finished" });
  });

  it("confirms a lost run's copy in flight stopped, then settles at the full worst case and releases the slot", async () => {
    const { validationId, operationId } = await runningValidation();
    const root = w.identity.validationRoot(validationId);
    const record = await w.records.validation(validationId);
    const meter = new CopyMeter({
      ledger: w.ledger,
      identity: w.identity,
      rates: w.rates,
      now: w.clock.now,
      root,
      kind: "validation",
      task_revision: CASE_ID,
      budget_key: (await w.records.request(record?.request_id ?? ""))?.budget_key ?? "",
      provider: "vercel-sandbox",
      deadline: new Date(w.clock.ms + 1_800_000),
      margin_s: 30,
      mode: { kind: "child_of", operation_id: operationId },
      log: (line) => w.logs.push(line),
    });
    let copy = "";
    void meter.run({ subject: CASE_ID, host: "task-report", state: "clean", limits: { timeout_s: 720, vcpus: 4, memory_mb: 8192 } }, async (name, hooks) => {
      w.sandbox.sandboxes.set(name, new FakeInstance(name, w.sandbox));
      await hooks.created(name);
      copy = name;
      return new Promise<LaunchReport<string>>(() => undefined);
    });
    for (let i = 0; i < 100 && copy === ""; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const before = await w.spend.slotStatus({ slot_key: "factory" });
    expect(before.ok && before.release_blockers.child_resources.map((child) => child.resource_id)).toContain(copy);
    w.clock.advance(181_000);
    expect(await finalizeLostWorker(lostDeps(), { validation_id: validationId })).toEqual({ kind: "finalized", slot_held: false });
    // The copy was stopped and confirmed: the ledger releases the slot only once every child is confirmed.
    expect(w.sandbox.calls.some((call) => call.action === "stop" && call.name === copy)).toBe(true);
    const status = await w.spend.operationStatus({ operation_id: operationId });
    expect(status.ok && [status.state, status.settled_microusd]).toEqual(["reconciled", BigInt(FACTORY_PROFILE.prices.validation_worst_case_microusd["task-report"])]);
    expect(await slotHolder(w)).toBeNull();
  });

  it("finishes a run past 1,800 s whose worker settled but had not finished it with the settled cost, releasing the slot and raising nothing", async () => {
    const { record, validationId, operationId } = await runningValidation();
    const root = w.identity.validationRoot(validationId);
    const op = validationOperation({ identity: w.identity, rates: w.rates }, { root, case_id: CASE_ID, host_id: "task-report" });
    // The worker ended its run and settled it as measured, and had not yet finished it or released the slot.
    await w.spend.transition({ operation_id: operationId, from_state: "running", to_state: "terminal", actor_role: "factory-worker", terminal_status: "completed" });
    const settled = await w.spend.settle(validationSettlement(op.envelope, operationId, "task-report", [{ launched: true, lifetime_ms: 90_000 }]));
    if (!settled.ok) throw new Error("synthetic: the settlement was refused");
    w.clock.advance(1_800_001);
    await w.records.recordHeartbeat({ validation_id: validationId }, w.clock.now());
    expect(await finalizeLostWorker(lostDeps(), { validation_id: validationId })).toEqual({ kind: "finalized", slot_held: false });
    const finished = (await w.records.validationEvents(validationId)).find((event) => event.type === "finished");
    expect(finished?.data).toMatchObject({ result: "error", cost_microusd: Number(settled.settled_microusd) });
    expect(w.records.types(record.request_id).filter((type) => type === "attention")).toEqual([]);
    expect(await slotHolder(w)).toBeNull();
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
