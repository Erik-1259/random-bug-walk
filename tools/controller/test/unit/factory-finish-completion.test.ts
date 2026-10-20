// The completion rule for a recorded finish (contract sections 8.1, 8.5 and 11). Once a request's
// or a validation run's finish is recorded, the writes that follow it are completed by every entry
// point that can see that finish: a repeated start POST, the read path's lost-worker call while the
// worker's heartbeat is still fresh, and the lost-worker routine once the heartbeat is 180 s old.
// For a run they are the request's needs_reconciliation attention (a finish with no cost),
// validation_finished, budget_updated and, for a finish with a cost, the slot release; for a request,
// the budget close of a finish its launch or the lost-worker routine recorded, and the slot release
// unless its spend needs reconciliation. One row per writer, interruption point and entry point: the
// writer's call at the interruption point fails without taking effect and the writer ends there, as
// a process that exits does. Afterwards every keyed write appears exactly once.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StopCode, ValidationMatrix } from "@rbw/factory-contract";
import type { Spend } from "@rbw/spend";
import { outcomeOf } from "../../src/factory-ledger.ts";
import { startFactoryValidation, startFactoryWorker } from "../../src/factory-launch.ts";
import type { FactoryLaunchDeps, ValidationStartArgs } from "../../src/factory-launch.ts";
import { finalizeLostWorker } from "../../src/factory-lost.ts";
import type { LostDeps } from "../../src/factory-lost.ts";
import type { LaunchReport, MeteredCopyPlan } from "../../src/factory-meter.ts";
import { FACTORY_PROFILE } from "../../src/factory-profile.ts";
import type { FactoryBudgets, FactoryEventInput, FactoryLedger, FactoryRecords, FactoryRequestRecord } from "../../src/factory-ports.ts";
import { runFactoryValidation, runFactoryWorker } from "../../src/factory-worker.ts";
import type { RequestHooks, Validate, WorkerDeps } from "../../src/factory-worker.ts";
import { CASE_ID, CREDENTIALS, PROTOCOL, SyntheticApiError, WORKER_IMAGE, acceptRequest, factoryWorld, slotHolder, syntheticUuid } from "./factory-fakes.ts";
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
  return { ledger: w.ledger, records: w.records, identity: w.identity, events: w.events, sandbox: w.sandbox, rates: w.rates, now: w.clock.now, sleep: () => Promise.resolve(), log: (line) => w.logs.push(line) };
}

function workerDeps(): WorkerDeps {
  return { ledger: w.ledger, records: w.records, identity: w.identity, rates: w.rates, now: w.clock.now, log: (line) => w.logs.push(line), provider: "vercel-sandbox", heartbeat_ms: 3_600_000 };
}

/** The writer's call at the interruption point: it fails without taking effect. */
class Interrupted extends Error {
  override name = "Interrupted";
}

/** Which call of the writer is the one at the interruption point. */
interface Cut {
  event?: (event: FactoryEventInput) => boolean;
  close?: boolean;
  release?: boolean;
}

interface CutDeps {
  ledger: FactoryLedger;
  records: FactoryRecords;
  hit: () => boolean;
}

/**
 * The writer's ledger and records: the call at the interruption point, and every call after it,
 * fails without taking effect, as calls of a process that exited never arrive.
 */
function cutAt(cut: Cut): CutDeps {
  let hit = false;
  const spend = w.ledger.spend;
  const budgets = w.ledger.budgets;
  const records = w.records;
  const call = <T>(here: boolean, run: () => Promise<T>): Promise<T> => {
    if (hit || here) {
      hit = true;
      return Promise.reject(new Interrupted("synthetic: the writer ended here"));
    }
    return run();
  };
  const ledgerSpend: Spend = {
    ...spend,
    releaseSlot: (request) => call(cut.release === true, () => spend.releaseSlot(request)),
    slotStatus: (request) => call(false, () => spend.slotStatus(request)),
    transition: (request) => call(false, () => spend.transition(request)),
    settle: (request) => call(false, () => spend.settle(request)),
    operationStatus: (request) => call(false, () => spend.operationStatus(request)),
  };
  const ledgerBudgets: FactoryBudgets = {
    reserve: (key, role, request) => call(false, () => budgets.reserve(key, role, request)),
    close: (key, cause) => call(cut.close === true, () => budgets.close(key, cause)),
    status: (key) => call(false, () => budgets.status(key)),
  };
  const store: FactoryRecords = {
    request: (id) => call(false, () => records.request(id)),
    appendEvent: (id, event, at) => call(cut.event?.(event) === true, () => records.appendEvent(id, event, at)),
    events: (id) => call(false, () => records.events(id)),
    recordHeartbeat: (target, at) => call(false, () => records.recordHeartbeat(target, at)),
    lastHeartbeat: (target) => call(false, () => records.lastHeartbeat(target)),
    stopRequested: (id) => call(false, () => records.stopRequested(id)),
    recordValidation: (record) => call(false, () => records.recordValidation(record)),
    validation: (id) => call(false, () => records.validation(id)),
    appendValidationEvent: (id, event, at) => call(false, () => records.appendValidationEvent(id, event, at)),
    validationEvents: (id) => call(false, () => records.validationEvents(id)),
    rootOwner: (root) => call(false, () => records.rootOwner(root)),
  };
  return { ledger: { spend: ledgerSpend, budgets: ledgerBudgets }, records: store, hit: () => hit };
}

/** Runs the writer to its interruption point: it ends there (rejecting, or answering when it catches the failed call). */
async function runWriter(cut: CutDeps, writer: () => Promise<unknown>): Promise<void> {
  try {
    await writer();
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
  }
  expect(cut.hit(), "the writer reached its interruption point").toBe(true);
}

/** Counts the slot releases of `root` that went through, by any writer or entry point. */
function countReleases(root: string): () => number {
  let releases = 0;
  const spend = w.ledger.spend;
  w.ledger.spend = {
    ...spend,
    releaseSlot: async (request) => {
      const released = await spend.releaseSlot(request);
      if (released.ok && request.root_execution_id === root) releases += 1;
      return released;
    },
  };
  return () => releases;
}

const ENTRIES = ["start", "read", "lost"] as const;
type Entry = (typeof ENTRIES)[number];

function plan(state: MeteredCopyPlan["state"]): MeteredCopyPlan {
  return { subject: CASE_ID, host: "task-report", state, limits: { timeout_s: 720, vcpus: 4, memory_mb: 8192 } };
}

function lives(ms: number, extra: Partial<LaunchReport<string>> = {}) {
  return async (name: string, hooks: { created(id: string): Promise<void> }): Promise<LaunchReport<string>> => {
    await hooks.created(name);
    w.clock.advance(ms);
    return { result: name, created: true, lifetime_ms: ms, stop_confirmed: true, status: "completed", ...extra };
  };
}

// Validation runs -------------------------------------------------------------------------------

/**
 * Who recorded the run's finish: its worker after a settled run (passed, with a cost) or after a copy
 * whose stop was never confirmed (error, no cost); its start, after a create refused before anything
 * existed (error at zero); or the lost-worker routine past 1,800 s, with the run's sandbox confirmed
 * stopped (error at the full worst case) or not (error, no cost).
 */
const VALIDATION_WRITERS = {
  worker_settled: { settled: true, result: "passed" },
  worker_uncertain: { settled: false, result: "error" },
  launch_refused: { settled: true, result: "error" },
  lost_settled: { settled: true, result: "error" },
  lost_uncertain: { settled: false, result: "error" },
} as const;
type ValidationWriter = keyof typeof VALIDATION_WRITERS;

/** Where the writer ended after the run's finished record: before the request's attention, validation_finished, budget_updated or the slot release. */
type ValidationPoint = "before_attention" | "before_finished" | "before_settled" | "before_release";

interface ValidationRow {
  writer: ValidationWriter;
  point: ValidationPoint;
  entry: Entry;
}

const VALIDATION_ROWS: ValidationRow[] = (Object.keys(VALIDATION_WRITERS) as ValidationWriter[]).flatMap((writer) => {
  // A finish with a cost raises no attention and releases the slot; one with no cost keeps it held.
  const points: ValidationPoint[] = VALIDATION_WRITERS[writer].settled ? ["before_finished", "before_settled", "before_release"] : ["before_attention", "before_finished", "before_settled"];
  return points.flatMap((point) => ENTRIES.map((entry) => ({ writer, point, entry })));
});

function validationCut(point: ValidationPoint, validationId: string): Cut {
  switch (point) {
    case "before_attention":
      return { event: (event) => event.event_key === `validation:${validationId}:attention` };
    case "before_finished":
      return { event: (event) => event.type === "validation_finished" };
    case "before_settled":
      return { event: (event) => event.event_key === `validation:${validationId}:settled` };
    case "before_release":
      return { release: true };
  }
}

describe("a validation run's recorded finish is completed by every entry point that sees it", () => {
  it("has a row for every writer, every interruption point after its finished record and every entry point", () => {
    expect(VALIDATION_ROWS).toHaveLength(5 * 3 * 3);
  });

  it.each(VALIDATION_ROWS)("$writer, $point, then $entry", async (row) => {
    // The request ran and finished: its slot is released and its budget closed.
    const request = await acceptRequest(w);
    expect((await w.spend.releaseSlot({ slot_key: "factory", root_execution_id: request.root, actor_role: "factory-worker", evidence: null, reason: null })).ok).toBe(true);
    await w.budgets.close(request.budget_key, "fulfilled");
    await w.records.appendEvent(request.request_id, { event_key: "finish", type: "request_finished", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Request finished: fulfilled.", data: { outcome: "fulfilled", stop_code: "fulfilled" } }, w.clock.now());

    const validationId = syntheticUuid("7600");
    const root = w.identity.validationRoot(validationId);
    const args: ValidationStartArgs = { request_id: request.request_id, case_id: CASE_ID, validation_id: validationId, host_id: "task-report", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" }, protocol: PROTOCOL };
    const releases = countReleases(root);
    const cut = cutAt(validationCut(row.point, validationId));
    const { settled, result } = VALIDATION_WRITERS[row.writer];

    if (row.writer === "launch_refused") {
      w.sandbox.createError = new SyntheticApiError(400);
      await runWriter(cut, () => startFactoryValidation({ ...launchDeps(), ledger: cut.ledger, records: cut.records }, args));
      w.sandbox.createError = null;
    } else {
      expect((await startFactoryValidation(launchDeps(), args)).kind).toBe("accepted");
      if (row.writer === "worker_settled" || row.writer === "worker_uncertain") {
        const validate: Validate = async (hooks) => {
          if (row.writer === "worker_settled") {
            await hooks.meter.run(plan("clean"), lives(60_000));
            return { result: "passed", matrix: MATRIX, message: "All six cells matched their expected outcomes." };
          }
          await hooks.meter.run(plan("clean"), lives(10_000, { stop_confirmed: false }));
          return { result: "error", matrix: null, message: "A copy could not be confirmed stopped." };
        };
        await runWriter(cut, () => runFactoryValidation({ ...workerDeps(), ledger: cut.ledger, records: cut.records }, { validation_id: validationId, validate }));
      } else {
        // No worker ran; the read path calls the routine once the run passed 1,800 s.
        if (row.writer === "lost_uncertain") w.sandbox.stopTakesEffect = false;
        w.clock.advance(FACTORY_PROFILE.validation.max_run_s * 1000 + 1000);
        await runWriter(cut, () => finalizeLostWorker({ ...lostDeps(), ledger: cut.ledger, records: cut.records }, { validation_id: validationId }));
      }
    }

    if (row.entry === "start") {
      const again = await startFactoryValidation(launchDeps(), args);
      if (again.kind !== "accepted") throw new Error(`synthetic: the repeated start answered ${again.kind}`);
      expect([again.run.state, again.run.result]).toEqual(["finished", result]);
      expect(again.run.cost_microusd === null).toBe(!settled);
    } else {
      if (row.entry === "lost") w.clock.advance(181_000);
      await finalizeLostWorker(lostDeps(), { validation_id: validationId });
    }

    // One finished record, and the request's history says what it says, each event once and in order.
    const finished = (w.records.validationLog.get(validationId) ?? []).filter((event) => event.type === "finished");
    expect(finished.map((event) => [event.data.result, event.data.cost_microusd === null])).toEqual([[result, !settled]]);
    const events = w.records.eventLog.get(request.request_id) ?? [];
    const keys = events.map((event) => event.event_key);
    const count = (key: string): number => keys.filter((item) => item === key).length;
    const key = (step: string): string => `validation:${validationId}:${step}`;
    expect([count(key("started")), count(key("reserved")), count(key("attention")), count(key("finished")), count(key("settled"))]).toEqual([1, 1, settled ? 0 : 1, 1, 1]);
    expect(events.find((event) => event.event_key === key("finished"))?.data).toEqual({ validation_id: validationId, result });
    if (!settled) expect(keys.indexOf(key("attention"))).toBeLessThan(keys.indexOf(key("finished")));
    expect(keys.indexOf(key("finished"))).toBeLessThan(keys.indexOf(key("settled")));
    expect(new Set(keys).size).toBe(keys.length);

    // A settled run's slot is released once; a run whose spend needs reconciliation keeps it held.
    expect(await slotHolder(w)).toBe(settled ? null : root);
    expect(releases()).toBe(settled ? 1 : 0);
  });
});

describe("a validation worker whose finish another entry point completed first", () => {
  it("reports the run's slot released when a repeated start released it before the worker's own release", async () => {
    const request = await acceptRequest(w);
    expect((await w.spend.releaseSlot({ slot_key: "factory", root_execution_id: request.root, actor_role: "factory-worker", evidence: null, reason: null })).ok).toBe(true);
    const validationId = syntheticUuid("7610");
    const root = w.identity.validationRoot(validationId);
    const args: ValidationStartArgs = { request_id: request.request_id, case_id: CASE_ID, validation_id: validationId, host_id: "task-report", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" }, protocol: PROTOCOL };
    expect((await startFactoryValidation(launchDeps(), args)).kind).toBe("accepted");
    const releases = countReleases(root);
    const spend = w.ledger.spend;
    let completedFirst = false;
    const workerSpend: Spend = {
      ...spend,
      releaseSlot: async (release) => {
        // The client sends the validation ID again after the worker recorded the finish and before it released.
        if (!completedFirst) {
          completedFirst = true;
          expect((await startFactoryValidation(launchDeps(), args)).kind).toBe("accepted");
        }
        return spend.releaseSlot(release);
      },
    };
    const validate: Validate = async (hooks) => {
      await hooks.meter.run(plan("clean"), lives(60_000));
      return { result: "passed", matrix: MATRIX, message: "All six cells matched their expected outcomes." };
    };
    expect(await runFactoryValidation({ ...workerDeps(), ledger: { spend: workerSpend, budgets: w.ledger.budgets } }, { validation_id: validationId, validate })).toEqual({ kind: "finished", result: "passed", slot_released: true });
    expect(await slotHolder(w)).toBeNull();
    expect(releases()).toBe(1);
    expect(w.logs.some((line) => line.includes("the slot was already released"))).toBe(true);
    const keys = (w.records.eventLog.get(request.request_id) ?? []).map((event) => event.event_key);
    expect(keys.filter((key) => key.startsWith(`validation:${validationId}:`))).toEqual([`validation:${validationId}:started`, `validation:${validationId}:reserved`, `validation:${validationId}:finished`, `validation:${validationId}:settled`]);
  });
});

// Requests -------------------------------------------------------------------------------------

/**
 * Who recorded the request's finish: its start, after a create refused before anything existed
 * (operational_error: the budget close and the slot release follow); its worker, after the core's
 * loop settled the worker, closed the budget and finished (the slot release follows); or the
 * lost-worker routine (worker_lost: the budget close follows, and the slot stays held).
 */
type RequestWriter = "launch_refused" | "worker" | "lost";
/** Where the writer ended after the request's finish: before the budget close or the slot release. */
type RequestPoint = "before_close" | "before_release";

const REQUEST_WRITERS: Record<RequestWriter, { stop: StopCode; released: boolean; points: RequestPoint[] }> = {
  launch_refused: { stop: "operational_error", released: true, points: ["before_close", "before_release"] },
  worker: { stop: "fulfilled", released: true, points: ["before_release"] },
  lost: { stop: "worker_lost", released: false, points: ["before_close"] },
};

interface RequestRow {
  writer: RequestWriter;
  point: RequestPoint;
  entry: Entry;
}

const REQUEST_ROWS: RequestRow[] = (Object.keys(REQUEST_WRITERS) as RequestWriter[]).flatMap((writer) => REQUEST_WRITERS[writer].points.flatMap((point) => ENTRIES.map((entry) => ({ writer, point, entry }))));

const NO_LINKS = { host_id: null, candidate_id: null, item_key: null, case_id: null };

/** How the factory core's loop finishes a request: settleWorker, then its budget_updated, then request_finished. */
async function finishAsCore(hooks: RequestHooks, stop: StopCode): Promise<void> {
  await hooks.settleWorker(stop);
  await hooks.append({ event_key: "run:worker-settled", type: "budget_updated", ...NO_LINKS, message: "Settled the worker.", data: { reserved_microusd: 0, spent_microusd: 0, remaining_microusd: 0 } });
  await hooks.append({ event_key: "run:finished", type: "request_finished", ...NO_LINKS, message: "Request finished.", data: { outcome: outcomeOf(stop), stop_code: stop } });
}

describe("a request's recorded finish is completed by every entry point that sees it", () => {
  it("has a row for every writer, every interruption point after its finish and every entry point", () => {
    expect(REQUEST_ROWS).toHaveLength(4 * 3);
  });

  it.each(REQUEST_ROWS)("$writer, $point, then $entry", async (row) => {
    const record: FactoryRequestRecord = await acceptRequest(w);
    const releases = countReleases(record.root);
    const cut = cutAt(row.point === "before_close" ? { close: true } : { release: true });
    const { stop, released } = REQUEST_WRITERS[row.writer];

    if (row.writer === "launch_refused") {
      w.sandbox.createError = new SyntheticApiError(400);
      await runWriter(cut, () => startFactoryWorker({ ...launchDeps(), ledger: cut.ledger, records: cut.records }, record.request_id));
      w.sandbox.createError = null;
    } else {
      expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("launched");
      if (row.writer === "worker") {
        const deadline = new Date(w.clock.ms + FACTORY_PROFILE.worker.timeout_s * 1000);
        await runWriter(cut, () => runFactoryWorker({ ...workerDeps(), ledger: cut.ledger, records: cut.records }, { request_id: record.request_id, deadline, orchestrate: (hooks) => finishAsCore(hooks, "fulfilled") }));
      } else {
        w.clock.advance(181_000);
        await runWriter(cut, () => finalizeLostWorker({ ...lostDeps(), ledger: cut.ledger, records: cut.records }, { request_id: record.request_id }));
      }
    }

    if (row.entry === "start") {
      expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("replay");
    } else {
      if (row.entry === "lost") w.clock.advance(181_000);
      await finalizeLostWorker(lostDeps(), { request_id: record.request_id });
    }

    // One finish, one budget close with its stop code, each event once.
    const events = w.records.eventLog.get(record.request_id) ?? [];
    expect(events.filter((event) => event.type === "request_finished").map((event) => event.data.stop_code)).toEqual([stop]);
    expect(w.budgets.closes.map((close) => close.cause)).toEqual([stop]);
    const keys = events.map((event) => event.event_key);
    expect(new Set(keys).size).toBe(keys.length);
    // Only the lost-worker finish raises attention (its own, before the finish).
    expect(events.filter((event) => event.type === "attention").map((event) => event.event_key)).toEqual(row.writer === "lost" ? ["lost:attention"] : []);

    // The slot is released once, unless the request's spend needs reconciliation.
    expect(await slotHolder(w)).toBe(released ? null : record.root);
    expect(releases()).toBe(released ? 1 : 0);
  });
});

describe("a recorded finish that cannot be read", () => {
  it("writes nothing from a run's finish without a cost, logs it and still answers the run's start", async () => {
    const request = await acceptRequest(w);
    expect((await w.spend.releaseSlot({ slot_key: "factory", root_execution_id: request.root, actor_role: "factory-worker", evidence: null, reason: null })).ok).toBe(true);
    const validationId = syntheticUuid("7620");
    const args: ValidationStartArgs = { request_id: request.request_id, case_id: CASE_ID, validation_id: validationId, host_id: "task-report", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" }, protocol: PROTOCOL };
    expect((await startFactoryValidation(launchDeps(), args)).kind).toBe("accepted");
    await w.records.appendValidationEvent(validationId, { event_key: "finished", type: "finished", data: { result: "passed" } }, w.clock.now());
    expect((await startFactoryValidation(launchDeps(), args)).kind).toBe("accepted");
    expect(await finalizeLostWorker(lostDeps(), { validation_id: validationId })).toEqual({ kind: "finished" });
    expect((w.records.eventLog.get(request.request_id) ?? []).filter((event) => event.type === "validation_finished")).toEqual([]);
    expect(w.logs.some((line) => line.includes("the recorded finish cannot be read"))).toBe(true);
  });

  it("closes and releases nothing from a request's finish without a stop code, and the lost-worker routine still notes a silent worker's hold", async () => {
    const record = await acceptRequest(w);
    expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("launched");
    await w.records.appendEvent(record.request_id, { event_key: "run:finished", type: "request_finished", ...NO_LINKS, message: "Request finished.", data: {} }, w.clock.now());
    expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("replay");
    w.clock.advance(181_000);
    expect(await finalizeLostWorker(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "finalized", slot_held: true });
    expect(w.budgets.closes).toEqual([]);
    expect(await slotHolder(w)).toBe(record.root);
    expect(w.logs.some((line) => line.includes("no stop code that can be read"))).toBe(true);
  });
});
