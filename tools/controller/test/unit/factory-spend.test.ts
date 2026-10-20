// The ledger adapters on the real spend ledger (PGlite with every migration): the request budgets,
// the factory records, the factory core's identity and event modules, the profile as the core
// reads it, and the in-process start lock. With them the launch, worker and lost-worker paths run on
// real records: a repeated validation start answers the harness its first start accepted, and the
// keyed checks find the events they look for.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRateSheet } from "@rbw/envelope";
import type { Rates } from "@rbw/envelope";
import { attention, budgetKey, candidateWorstCase, copyExecutionId, factoryProjectId, requestFinished, requestRoot, validationRoot } from "@rbw/factory";
import type { CaseEvidence } from "@rbw/factory";
import { FakeHostAdapter, fixtureRegistry, syntheticEntry, syntheticProtocol } from "@rbw/factory/testing";
import type { CatalogEntry, HostAdapter, Protocol, QualificationRecord, RequestStatus, ValidationResult } from "@rbw/factory-contract";
import { canonicalDigest } from "@rbw/schema";
import { migrate } from "@rbw/spend";
import { startFactoryValidation, startFactoryWorker } from "../../src/factory-launch.ts";
import type { FactoryLaunchDeps, ValidationStartArgs } from "../../src/factory-launch.ts";
import { FACTORY_EVENTS, FACTORY_IDENTITY, FACTORY_PROJECT, ROUTE_ACTOR, WORKER_ACTOR, finishValidation, validationOperation, workerOperation } from "../../src/factory-ledger.ts";
import { completeReconciliation } from "../../src/factory-lost.ts";
import type { LostDeps } from "../../src/factory-lost.ts";
import { CopyMeter } from "../../src/factory-meter.ts";
import type { FactoryEventInput, FactoryRecords, FactoryRequestRecord } from "../../src/factory-ports.ts";
import { FACTORY_PROFILE, ProfileMismatch, factoryEnvelope, factoryProfileInput, validationWorstCase } from "../../src/factory-profile.ts";
import { factoryDatabaseOver } from "../../src/factory-spend.ts";
import type { FactoryDatabase } from "../../src/factory-spend.ts";
import { RATE_SHEET_PATH } from "../../src/rate-sheet.ts";
import { CASE_ID, CREDENTIALS, Clock, FakeWorkerSandbox, PROTOCOL, SyntheticApiError, WORKER_IMAGE, syntheticInterpretation } from "./factory-fakes.ts";

interface World {
  pglite: PGlite;
  db: FactoryDatabase;
  clock: Clock;
  rates: Rates;
  sandbox: FakeWorkerSandbox;
  logs: string[];
}

let w: World;

function ok(result: { ok: boolean; code?: string }): void {
  if (!result.ok) throw new Error(`synthetic: refused (${result.code ?? "no code"})`);
}

beforeEach(async () => {
  const clock = new Clock();
  const pglite = await PGlite.create();
  await migrate(pglite, { schema: "public" });
  const db = factoryDatabaseOver({ client: pglite, now: clock.now });
  ok(await db.spend.createPool({ pool_key: "factory", cap_microusd: 40_000_000, allocations: [], actor_role: "owner", reason: "synthetic factory pool" }));
  ok(await db.spend.createSlotKey({ slot_key: "factory", actor_role: "owner", reason: "synthetic factory slot" }));
  w = { pglite, db, clock, rates: await loadRateSheet(RATE_SHEET_PATH), sandbox: new FakeWorkerSandbox(), logs: [] };
});

afterEach(async () => {
  await w.pglite.close();
});

const NO_LINKS = { host_id: null, candidate_id: null, item_key: null, case_id: null };

function launchDeps(overrides: Partial<FactoryLaunchDeps> = {}): FactoryLaunchDeps {
  return { ledger: w.db.ledger, records: w.db.factoryRecords, identity: FACTORY_IDENTITY, sandbox: w.sandbox, rates: w.rates, now: w.clock.now, launch: { image: WORKER_IMAGE, env: CREDENTIALS }, log: (line) => w.logs.push(line), ...overrides };
}

function lostDeps(overrides: Partial<LostDeps> = {}): LostDeps {
  return { ledger: w.db.ledger, records: w.db.factoryRecords, identity: FACTORY_IDENTITY, events: FACTORY_EVENTS, sandbox: w.sandbox, rates: w.rates, now: w.clock.now, sleep: () => Promise.resolve(), log: (line) => w.logs.push(line), ...overrides };
}

/** What the web service does before it starts a worker: takes the slot under the request root and accepts the request (budget, record, request_accepted). */
async function accept(cap = 1_500_000): Promise<FactoryRequestRecord> {
  const requestId = randomUUID();
  const root = FACTORY_IDENTITY.requestRoot(requestId);
  ok(await w.db.spend.acquireSlot({ slot_key: "factory", root_execution_id: root, actor_role: ROUTE_ACTOR }));
  const interpretationSha = canonicalDigest({ synthetic_interpretation: requestId }).sha256;
  ok(
    await w.db.records.acceptRequest({
      budget: { budget_key: budgetKey(requestId), root_execution_id: root, pool_key: "factory", cap_microusd: cap, pool_required_microusd: FACTORY_PROFILE.prices.worker_worst_case_microusd, actor_role: ROUTE_ACTOR },
      request: {
        request_id: requestId,
        request_sha256: canonicalDigest({ synthetic_start: requestId }).sha256,
        interpretation: syntheticInterpretation(interpretationSha),
        interpretation_sha256: interpretationSha,
        budget_key: budgetKey(requestId),
        root_execution_id: root,
        factory_profile_sha256: FACTORY_PROFILE.profile_sha256,
      },
      accepted_message: "Request accepted.",
    }),
  );
  const record = await w.db.factoryRecords.request(requestId);
  if (record === null) throw new Error("synthetic: the accepted request is not recorded");
  return record;
}

/** A request that ran and finished fulfilled: its slot released, its budget closed and request_finished appended. */
async function finishedRequest(): Promise<FactoryRequestRecord> {
  const record = await accept();
  ok(await w.db.spend.releaseSlot({ slot_key: "factory", root_execution_id: record.root, actor_role: WORKER_ACTOR, evidence: null, reason: null }));
  ok(await w.db.ledger.budgets.close(record.budget_key, "fulfilled"));
  expect((await w.db.factoryRecords.appendEvent(record.request_id, FACTORY_EVENTS.finished("fulfilled", w.clock.now()), w.clock.now())).kind).toBe("appended");
  return record;
}

function validationArgs(requestId: string, version: string, validationId: string = randomUUID()): ValidationStartArgs {
  return { request_id: requestId, case_id: CASE_ID, validation_id: validationId, host_id: "task-report", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version }, protocol: PROTOCOL };
}

async function slotHolder(): Promise<string | null> {
  const slot = await w.db.spend.slotStatus({ slot_key: "factory" });
  if (!slot.ok) throw new Error("synthetic: the slot status was refused");
  return slot.holder;
}

/** A records port that passes every call through and, for appendEvent, lets the test act first. */
function recordsWith(appendEvent: FactoryRecords["appendEvent"]): FactoryRecords {
  return { ...w.db.factoryRecords, appendEvent };
}

const FIXTURES = new URL("../../../../docs/product/fixtures/bug-request-v1/", import.meta.url);
const RECORD_FIXTURE = new URL("../../../../packages/factory-contract/test/fixtures/qualification-record-accepted.json", import.meta.url);

/** A delivered case's evidence, from the contract's fulfilled status fixture and its accepted qualification record. */
function caseEvidence(): CaseEvidence {
  const status = JSON.parse(readFileSync(new URL("status-fulfilled.json", FIXTURES), "utf8")) as RequestStatus;
  const record = JSON.parse(readFileSync(RECORD_FIXTURE, "utf8")) as QualificationRecord;
  const delivered = status.cases[0];
  if (delivered === undefined) throw new Error("synthetic: the fixture has no case");
  return { schema_version: 1, case: { ...delivered, validation: null }, record: { ...record, case_id: delivered.case_id } };
}

describe("validation run details on the real ledger", () => {
  it("answers a repeated start with the harness its first start accepted, also once the service moved to a newer harness", async () => {
    const request = await finishedRequest();
    const first = validationArgs(request.request_id, "1.0.0");
    const started = await startFactoryValidation(launchDeps(), first);
    expect(started.kind === "accepted" && started.run.harness).toEqual({ name: "rbw-validate", version: "1.0.0" });

    w.clock.advance(5000);
    const again = await startFactoryValidation(launchDeps(), { ...first, harness: { name: "rbw-validate", version: "1.0.1" } });
    expect(again.kind === "accepted" && again.run.harness).toEqual({ name: "rbw-validate", version: "1.0.0" });
    expect(await w.db.factoryRecords.validation(first.validation_id)).toEqual({
      validation_id: first.validation_id,
      request_id: request.request_id,
      case_id: CASE_ID,
      host_id: "task-report",
      root: validationRoot(first.validation_id),
      accepted_at: "2026-10-20T19:00:00.000Z",
      package_sha256: first.package_sha256,
      harness: { name: "rbw-validate", version: "1.0.0" },
      copies: 3,
    });
    expect(w.sandbox.count("create")).toBe(1);
  });
});

describe("keyed event reads", () => {
  it("completes a reconciliation interrupted after its release on the next call, which answers released", async () => {
    const record = await accept();
    await w.db.factoryRecords.appendEvent(record.request_id, FACTORY_EVENTS.attention("needs_reconciliation", w.clock.now()), w.clock.now());
    const interrupted = recordsWith((id, event, at) => (event.type === "attention_cleared" ? Promise.reject(new Error("synthetic: the write failed")) : w.db.factoryRecords.appendEvent(id, event, at)));
    await expect(completeReconciliation(lostDeps({ records: interrupted }), { request_id: record.request_id })).rejects.toThrow("synthetic: the write failed");
    expect(await slotHolder()).toBeNull();

    expect(await completeReconciliation(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "released" });
    const keys = (await w.db.factoryRecords.events(record.request_id)).map((event) => event.event_key);
    expect(keys.slice(-2)).toEqual([`reconciled:${record.root}:budget`, `reconciled:${record.root}:attention_cleared`]);
    expect(await completeReconciliation(lostDeps(), { request_id: record.request_id })).toEqual({ kind: "not_held" });
  });

  it("does not append a repeated validation finish's events again, so its budget_updated is appended once", async () => {
    const request = await finishedRequest();
    const args = validationArgs(request.request_id, "1.0.0");
    expect((await startFactoryValidation(launchDeps(), args)).kind).toBe("accepted");
    const run = await w.db.factoryRecords.validation(args.validation_id);
    if (run === null) throw new Error("synthetic: the run is not recorded");
    const appends: FactoryEventInput[] = [];
    const counted = recordsWith((id, event, at) => {
      appends.push(event);
      return w.db.factoryRecords.appendEvent(id, event, at);
    });
    const deps = { ledger: w.db.ledger, records: counted, now: w.clock.now, log: (line: string) => w.logs.push(line) };
    const finish = { result: "error" as ValidationResult, matrix: null, message: "synthetic: the run ended", cost_microusd: 0 };

    expect((await finishValidation(deps, request, run, finish)).ours).toBe(true);
    w.clock.advance(60_000);
    // The lost-worker routine's overlapping finish: the worker's stands, and nothing follows it twice.
    expect((await finishValidation(deps, request, run, finish)).ours).toBe(false);
    const settled = `validation:${args.validation_id}:settled`;
    expect(appends.filter((event) => event.event_key === settled)).toHaveLength(1);
    expect(appends.filter((event) => event.type === "validation_finished")).toHaveLength(1);
    expect((await w.db.factoryRecords.events(request.request_id)).filter((event) => event.event_key === settled)).toHaveLength(1);
  });

  it("reads every event of a request with its key, across pages of 1,000", async () => {
    const record = await accept();
    for (let n = 1; n <= 1000; n += 1) {
      const appended = await w.db.factoryRecords.appendEvent(record.request_id, { event_key: `synthetic:${String(n)}`, type: "budget_updated", ...NO_LINKS, message: "Budget updated.", data: { reserved_microusd: 0, spent_microusd: 0, remaining_microusd: n } }, w.clock.now());
      expect(appended.kind).toBe("appended");
    }
    const events = await w.db.factoryRecords.events(record.request_id);
    expect(events).toHaveLength(1001);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 1001 }, (_, index) => index + 1));
    expect(events[0]?.event_key).toBe("request_accepted");
    expect(events.at(-1)).toMatchObject({ event_key: "synthetic:1000", type: "budget_updated", data: { remaining_microusd: 1000 } });
  });
});

describe("the factory records port", () => {
  it("reads a request with its root, budget key, interpretation and profile hash, and null for an unknown one", async () => {
    const record = await accept();
    expect(record.root).toBe(requestRoot(record.request_id));
    expect(record.budget_key).toBe(budgetKey(record.request_id));
    expect(record.profile_sha256).toBe(FACTORY_PROFILE.profile_sha256);
    expect(record.interpretation).toEqual(syntheticInterpretation(record.interpretation_sha256));
    expect(record.created_at).toBe("2026-10-20T19:00:00.000Z");
    expect(await w.db.factoryRecords.request(randomUUID())).toBeNull();
  });

  it("appends an event at the given time and maps each answer: appended, replay, conflict, and refused after the finish", async () => {
    const record = await accept();
    const records = w.db.factoryRecords;
    const event: FactoryEventInput = { event_key: "synthetic:budget", type: "budget_updated", ...NO_LINKS, message: "Budget updated.", data: { reserved_microusd: 0, spent_microusd: 0, remaining_microusd: 1_500_000 } };
    const at = new Date("2026-10-20T19:05:00.000Z");
    expect(await records.appendEvent(record.request_id, event, at)).toEqual({ kind: "appended", seq: 2 });
    expect(await records.appendEvent(record.request_id, event, new Date("2026-10-20T19:06:00.000Z"))).toEqual({ kind: "replay", seq: 2 });
    expect(await records.appendEvent(record.request_id, { ...event, message: "Budget updated again." }, at)).toEqual({ kind: "conflict" });
    expect(await records.appendEvent(record.request_id, FACTORY_EVENTS.finished("fulfilled", at), at)).toEqual({ kind: "appended", seq: 3 });
    expect(await records.appendEvent(record.request_id, { event_key: "worker_started", type: "worker_started", ...NO_LINKS, message: "The worker started.", data: {} }, at)).toEqual({ kind: "refused", reason: "event_not_allowed" });
    expect(await records.appendEvent(record.request_id, { ...event, event_key: "synthetic:late" }, at)).toEqual({ kind: "appended", seq: 4 });
    expect((await records.events(record.request_id)).find((stored) => stored.seq === 2)?.at).toBe(at.toISOString());
    await expect(records.appendEvent(randomUUID(), event, at)).rejects.toThrow("unknown_request");
    expect(await records.events(randomUUID())).toEqual([]);
  });

  it("records heartbeats at the given time for a request and for a validation run, and reads the latest of each", async () => {
    const request = await finishedRequest();
    const args = validationArgs(request.request_id, "1");
    expect((await startFactoryValidation(launchDeps(), args)).kind).toBe("accepted");
    const records = w.db.factoryRecords;
    expect(await records.lastHeartbeat({ request_id: request.request_id })).toBeNull();
    expect(await records.lastHeartbeat({ validation_id: args.validation_id })).toBeNull();
    await records.recordHeartbeat({ request_id: request.request_id }, new Date("2026-10-20T19:01:00.000Z"));
    await records.recordHeartbeat({ validation_id: args.validation_id }, new Date("2026-10-20T19:02:00.000Z"));
    await records.recordHeartbeat({ validation_id: args.validation_id }, new Date("2026-10-20T19:03:00.000Z"));
    expect(await records.lastHeartbeat({ request_id: request.request_id })).toEqual(new Date("2026-10-20T19:01:00.000Z"));
    expect(await records.lastHeartbeat({ validation_id: args.validation_id })).toEqual(new Date("2026-10-20T19:03:00.000Z"));
    await expect(records.recordHeartbeat({ validation_id: randomUUID() }, w.clock.now())).rejects.toThrow("unknown_validation");
  });

  it("answers whether a stop was requested", async () => {
    const record = await accept();
    expect(await w.db.factoryRecords.stopRequested(record.request_id)).toBe(false);
    ok(await w.db.records.recordStop({ request_id: record.request_id, actor_role: ROUTE_ACTOR }));
    expect(await w.db.factoryRecords.stopRequested(record.request_id)).toBe(true);
  });

  it("records a validation run once: created, replayed with a later acceptance (the first kept), and a conflict for other details", async () => {
    const request = await accept();
    const validationId = randomUUID();
    const run = { validation_id: validationId, request_id: request.request_id, case_id: CASE_ID, host_id: "task-report" as const, root: validationRoot(validationId), accepted_at: "2026-10-20T19:00:00.000Z", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate" as const, version: "1" }, copies: 3 };
    const records = w.db.factoryRecords;
    expect(await records.recordValidation(run)).toBe("created");
    expect(await records.recordValidation({ ...run, accepted_at: "2026-10-20T19:00:09.000Z" })).toBe("replay");
    expect(await records.recordValidation({ ...run, harness: { name: "rbw-validate", version: "2" } })).toBe("conflict");
    expect(await records.recordValidation({ ...run, copies: 4 })).toBe("conflict");
    expect(await records.validation(validationId)).toEqual(run);
    expect(await records.validation(randomUUID())).toBeNull();
    await expect(records.recordValidation({ ...run, validation_id: randomUUID(), request_id: randomUUID(), root: validationRoot(randomUUID()) })).rejects.toThrow("unknown_request");
  });

  it("appends validation events at the given time with the same answers and reads them back with their keys", async () => {
    const request = await accept();
    const validationId = randomUUID();
    expect(await w.db.factoryRecords.recordValidation({ validation_id: validationId, request_id: request.request_id, case_id: CASE_ID, host_id: "umami", root: validationRoot(validationId), accepted_at: "2026-10-20T19:00:00.000Z", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" }, copies: 3 })).toBe("created");
    const records = w.db.factoryRecords;
    const at = new Date("2026-10-20T19:04:00.000Z");
    expect(await records.appendValidationEvent(validationId, { event_key: "running", type: "running", data: { started_at: at.toISOString() } }, at)).toEqual({ kind: "appended", seq: 1 });
    expect(await records.appendValidationEvent(validationId, { event_key: "running", type: "running", data: { started_at: at.toISOString() } }, w.clock.now())).toEqual({ kind: "replay", seq: 1 });
    expect(await records.appendValidationEvent(validationId, { event_key: "running", type: "running", data: {} }, at)).toEqual({ kind: "conflict" });
    expect(await records.appendValidationEvent(validationId, { event_key: "copy:clean-1", type: "copy", data: { n: 1 } }, at)).toEqual({ kind: "appended", seq: 2 });
    expect(await records.validationEvents(validationId)).toEqual([
      { seq: 1, at: at.toISOString(), event_key: "running", type: "running", data: { started_at: at.toISOString() } },
      { seq: 2, at: at.toISOString(), event_key: "copy:clean-1", type: "copy", data: { n: 1 } },
    ]);
    expect(await records.validationEvents(randomUUID())).toEqual([]);
    await expect(records.appendValidationEvent(randomUUID(), { event_key: "running", type: "running", data: {} }, at)).rejects.toThrow("unknown_validation");
  });

  it("records a case's evidence once as canonical text and reads it back, and null when there is none", async () => {
    const request = await accept();
    const evidence = caseEvidence();
    const digest = canonicalDigest(evidence);
    const records = w.db.factoryRecords;
    expect(await records.readEvidence(request.request_id, CASE_ID)).toBeNull();
    expect(await records.recordEvidence({ request_id: request.request_id, case_id: CASE_ID, evidence, sha256: digest.sha256 })).toBe("recorded");
    expect(await records.recordEvidence({ request_id: request.request_id, case_id: CASE_ID, evidence, sha256: digest.sha256 })).toBe("replay");
    expect(await records.readEvidence(request.request_id, CASE_ID)).toEqual(evidence);
    const stored = await w.db.records.readEvidence({ request_id: request.request_id, case_id: CASE_ID });
    expect(stored.ok && stored.evidence_json).toBe(Buffer.from(digest.bytes).toString("utf8"));
    const other = { ...evidence, record: { ...evidence.record, case_id: "f".repeat(64) } };
    await expect(records.recordEvidence({ request_id: request.request_id, case_id: CASE_ID, evidence: other, sha256: canonicalDigest(other).sha256 })).rejects.toThrow("idempotency_conflict");
    await expect(records.recordEvidence({ request_id: request.request_id, case_id: "f".repeat(64), evidence, sha256: "0".repeat(64) })).rejects.toThrow("invalid_request");
    expect(await records.readEvidence(randomUUID(), CASE_ID)).toBeNull();
  });

  it("names the request or the validation run of a root, null for a root of neither, and rejects a malformed root", async () => {
    const request = await accept();
    const validationId = randomUUID();
    expect(await w.db.factoryRecords.recordValidation({ validation_id: validationId, request_id: request.request_id, case_id: CASE_ID, host_id: "task-report", root: validationRoot(validationId), accepted_at: "2026-10-20T19:00:00.000Z", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" }, copies: 3 })).toBe("created");
    const records = w.db.factoryRecords;
    expect(await records.rootOwner(request.root)).toEqual({ request_id: request.request_id, validation_id: null });
    expect(await records.rootOwner(validationRoot(validationId))).toEqual({ request_id: request.request_id, validation_id: validationId });
    expect(await records.rootOwner(randomUUID())).toBeNull();
    await expect(records.rootOwner("not-a-root")).rejects.toThrow("invalid_request");
  });
});

describe("the request budgets port", () => {
  it("reserves on the request budget and reports its totals, then its closure", async () => {
    const record = await accept();
    const op = workerOperation({ identity: FACTORY_IDENTITY, rates: w.rates }, record);
    const reserved = await w.db.ledger.budgets.reserve(record.budget_key, "request", op.request);
    expect(reserved.ok && reserved.state).toBe("prepared");
    const worker = BigInt(FACTORY_PROFILE.prices.worker_worst_case_microusd);
    expect(await w.db.ledger.budgets.status(record.budget_key)).toEqual({ ok: true, budget_microusd: 1_500_000n, settled_microusd: 0n, open_microusd: worker, committed_microusd: worker, available_microusd: 1_500_000n - worker, closed: null });
    ok(await w.db.ledger.budgets.close(record.budget_key, "fulfilled"));
    const closed = await w.db.ledger.budgets.status(record.budget_key);
    expect(closed.ok && closed.closed).toEqual({ cause: "fulfilled" });
    const refused = await w.db.ledger.budgets.reserve(record.budget_key, "request", workerOperation({ identity: FACTORY_IDENTITY, rates: w.rates }, { ...record, interpretation_sha256: "9".repeat(64) }).request);
    expect(!refused.ok && refused.code).toBe("budget_closed");
  });

  it("closes once, replays the same cause, and answers another cause as operation_conflict", async () => {
    const record = await accept();
    const { budgets } = w.db.ledger;
    expect(await budgets.close(record.budget_key, "fulfilled")).toEqual({ ok: true, replay: false });
    expect(await budgets.close(record.budget_key, "fulfilled")).toEqual({ ok: true, replay: true });
    const conflict = await budgets.close(record.budget_key, "worker_lost");
    expect(!conflict.ok && conflict.code).toBe("operation_conflict");
    const unknown = await budgets.close(budgetKey(randomUUID()), "fulfilled");
    expect(!unknown.ok && unknown.code).toBe("unknown_budget");
    const status = await budgets.status(budgetKey(randomUUID()));
    expect(!status.ok && status.code).toBe("unknown_budget");
  });
});

describe("the factory core's identity and event modules", () => {
  it("derives every ID with the core's identity module under the factory project name", () => {
    const requestId = randomUUID();
    expect(FACTORY_PROJECT).toBe("rbw-factory");
    expect(FACTORY_IDENTITY.project_id).toBe(factoryProjectId("rbw-factory"));
    expect(FACTORY_IDENTITY.requestRoot(requestId)).toBe(requestRoot(requestId));
    expect(FACTORY_IDENTITY.validationRoot(requestId)).toBe(validationRoot(requestId));
    const copy = { kind: "request" as const, root: requestRoot(requestId), subject_id: "a".repeat(64), state: "buggy" as const, n: 2 };
    expect(FACTORY_IDENTITY.copyExecutionId(copy)).toBe(copyExecutionId(copy));
    expect(FACTORY_IDENTITY.isUuid(requestId)).toBe(true);
    expect(FACTORY_IDENTITY.isUuid(requestId.toUpperCase())).toBe(false);
  });

  it("builds the loop's finish and attention under the core's keys, without a time", () => {
    const now = w.clock.now();
    const finished = FACTORY_EVENTS.finished("budget_exhausted", now);
    expect(finished).toMatchObject({ event_key: "run:finished", type: "request_finished", ...NO_LINKS, data: { outcome: "stopped_at_limit", stop_code: "budget_exhausted" } });
    expect({ ...finished, at: now.toISOString() }).toEqual(requestFinished("budget_exhausted", now.toISOString()));
    const raised = FACTORY_EVENTS.attention("needs_reconciliation", now);
    expect(raised).toMatchObject({ event_key: "run:attention:needs_reconciliation", type: "attention", data: { code: "needs_reconciliation" } });
    expect({ ...raised, at: now.toISOString() }).toEqual(attention("needs_reconciliation", now.toISOString()));
    expect("at" in finished || "at" in raised).toBe(false);
  });

  it("builds the core's lost-worker finish from the stored events, and the store takes it", async () => {
    const record = await accept();
    const records = w.db.factoryRecords;
    const candidate = { event_key: "cand:a:selected", type: "candidate_selected" as const, host_id: "task-report" as const, candidate_id: "a".repeat(64), item_key: null, case_id: null, message: "Candidate selected.", data: { source_id: "synthetic-task-report-concurrency", entry_id: "synthetic-task-report-concurrency-01" } };
    expect((await records.appendEvent(record.request_id, candidate, w.clock.now())).kind).toBe("appended");
    const lost = FACTORY_EVENTS.lostWorker({ events: await records.events(record.request_id), now: w.clock.now() });
    expect(lost.map((event) => [event.event_key, event.type])).toEqual([
      ["lost:candidate-end", "candidate_incomplete"],
      ["lost:attention", "attention"],
      ["lost:finished", "request_finished"],
    ]);
    for (const event of lost) expect((await records.appendEvent(record.request_id, event, w.clock.now())).kind).toBe("appended");
    expect(FACTORY_EVENTS.lostWorker({ events: await records.events(record.request_id), now: w.clock.now() })).toEqual([]);
  });

  it("finishes a start whose worker never ran with the core's finish, after the core's attention when its spend is uncertain", async () => {
    const refused = await accept(200_000);
    expect(await startFactoryWorker(launchDeps(), refused.request_id)).toEqual({ kind: "refused", code: "budget_exhausted" });
    const finish = (await w.db.factoryRecords.events(refused.request_id)).at(-1);
    expect(finish).toMatchObject({ event_key: "run:finished", message: "Request finished: operational error.", data: { outcome: "operational_error", stop_code: "operational_error" } });

    const uncertain = await accept();
    w.sandbox.createError = new SyntheticApiError(500);
    expect((await startFactoryWorker(launchDeps(), uncertain.request_id)).kind).toBe("uncertain");
    const tail = (await w.db.factoryRecords.events(uncertain.request_id)).slice(-2);
    expect(tail.map((event) => event.event_key)).toEqual(["run:attention:needs_reconciliation", "run:finished"]);
    expect(tail[0]?.message).toBe(FACTORY_EVENTS.attention("needs_reconciliation", w.clock.now()).message);
    expect(tail[1]?.data).toEqual({ outcome: "operational_error", stop_code: "needs_reconciliation" });
  });
});

/** A host adapter whose entries declare different protocols: entry `n` has `n` copies of each state. */
class VaryingAdapter extends FakeHostAdapter {
  override protocol(entry?: CatalogEntry): Protocol {
    const base = syntheticProtocol(3);
    const n = Number(entry?.entry_id.slice(-2) ?? "1");
    return { ...base, per_state: { clean: { ...base.per_state.clean, copies: n }, buggy: { ...base.per_state.buggy, copies: n }, fixed: { ...base.per_state.fixed, copies: n } } };
  }
}

describe("factoryProfileInput", () => {
  it("states the profile's hash, limits and worker worst case", () => {
    const input = factoryProfileInput({ rates: w.rates, registry: fixtureRegistry() });
    expect(input.profile_sha256).toBe(FACTORY_PROFILE.profile_sha256);
    expect(input.limits).toEqual(FACTORY_PROFILE.limits);
    expect(input.worker_worst_case_microusd).toBe(FACTORY_PROFILE.prices.worker_worst_case_microusd);
    expect(input.copy_envelope_microusd).toEqual(FACTORY_PROFILE.prices.copy_worst_case_microusd);
  });

  it("prices each host's copy as the copy meter reserves it, so a candidate the core prices is reserved without a difference", async () => {
    const input = factoryProfileInput({ rates: w.rates, registry: fixtureRegistry() });
    const record = await accept(3_000_000);
    const meter = new CopyMeter({
      ledger: w.db.ledger,
      identity: FACTORY_IDENTITY,
      rates: w.rates,
      now: w.clock.now,
      root: record.root,
      kind: "request",
      task_revision: record.interpretation_sha256,
      budget_key: record.budget_key,
      provider: "vercel-sandbox",
      deadline: new Date(w.clock.now().getTime() + 3_600_000),
      margin_s: FACTORY_PROFILE.copy_launch_margin_s,
      mode: { kind: "own_operation", role: "request" },
      log: (line) => w.logs.push(line),
    });
    const registry: readonly HostAdapter[] = fixtureRegistry();
    for (const [index, adapter] of registry.entries()) {
      const entry = adapter.catalog()[0];
      if (entry === undefined) throw new Error("synthetic: the fixture adapter has no entry");
      const worst = candidateWorstCase(adapter, entry, input);
      const protocol = adapter.protocol(entry);
      const copies = protocol.per_state.clean.copies + protocol.per_state.buggy.copies + protocol.per_state.fixed.copies;
      expect(worst).toBe(copies * Number(factoryEnvelope(w.rates, { kind: "copy", host: adapter.host_id }).reserved_microusd));
      const candidateId = String(index + 1).repeat(64);
      expect(await meter.reserveCandidate({ candidate_id: candidateId, host_id: adapter.host_id, protocol, worst_case_microusd: worst })).toEqual({ kind: "reserved", reserved_microusd: worst });
    }
    expect(meter.uncertain).toBe(false);
  });

  it("prices a host's validation run for the most copies its catalog's protocols declare, as a start reserves it, and none for a host with no entry", () => {
    const entries = [1, 2].map((n) => syntheticEntry({ host_id: "task-report", bug_type_id: "concurrency", n, criteria: ["concurrency.lost-acknowledged-change"] }));
    const adapter = new VaryingAdapter({ host_id: "task-report", entries, entryOf: () => entries[0] });
    const input = factoryProfileInput({ rates: w.rates, registry: [adapter] });
    expect(input.validation_worst_case_microusd).toEqual({ "task-report": validationWorstCase(w.rates, "task-report", 6) });
    const op = validationOperation({ identity: FACTORY_IDENTITY, rates: w.rates }, { root: validationRoot(randomUUID()), case_id: CASE_ID, host_id: "task-report", copies: 6 });
    expect(BigInt(input.validation_worst_case_microusd["task-report"] ?? 0)).toBe(op.envelope.reserved_microusd);
    expect(validationWorstCase(w.rates, "task-report", 6)).toBeGreaterThan(validationWorstCase(w.rates, "task-report", 3));
  });

  it("refuses a rate sheet that is not the profile's", () => {
    expect(() => factoryProfileInput({ rates: { ...w.rates, rate_sheet_sha256: "0".repeat(64) }, registry: fixtureRegistry() })).toThrow(ProfileMismatch);
  });
});

describe("the in-process start lock", () => {
  it("runs starts of one ID one at a time, while starts of another ID or the other scope run at once", async () => {
    const order: string[] = [];
    const gate = Promise.withResolvers<undefined>();
    const first = w.db.withStartLock("request", "synthetic-a", async () => {
      order.push("a1:start");
      await gate.promise;
      order.push("a1:end");
      return 1;
    });
    const second = w.db.withStartLock("request", "synthetic-a", () => {
      order.push("a2:start");
      return Promise.resolve(2);
    });
    const other = w.db.withStartLock("request", "synthetic-b", () => {
      order.push("b:start");
      return Promise.resolve(3);
    });
    const scope = w.db.withStartLock("validation", "synthetic-a", () => {
      order.push("va:start");
      return Promise.resolve(4);
    });
    expect(await Promise.all([other, scope])).toEqual([3, 4]);
    expect(order).toContain("a1:start");
    expect(order).not.toContain("a2:start");
    gate.resolve(undefined);
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order.slice(-2)).toEqual(["a1:end", "a2:start"]);
  });

  it("releases the lock when a start rejects", async () => {
    await expect(w.db.withStartLock("validation", "synthetic-a", () => Promise.reject(new Error("synthetic: the start failed")))).rejects.toThrow("synthetic: the start failed");
    expect(await w.db.withStartLock("validation", "synthetic-a", () => Promise.resolve("next"))).toBe("next");
  });
});
