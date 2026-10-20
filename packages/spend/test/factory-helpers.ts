import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Event, Interpretation } from "@rbw/factory-contract";
import { createFactoryRecords } from "../src/factory.ts";
import type { AppendEvent, EventInput, FactoryRecords, RecordRequest, RecordValidation } from "../src/factory.ts";
import type { CreateBudgetRequest, EnvelopeLine, ReserveRequest } from "../src/types.ts";
import { expectOk, hex, line, loose, reserveRequest, uuid, type Harness } from "./helpers.ts";

// The factory pool and slot key are created by owner actions after migrating, never by a migration.
export const FACTORY_POOL = "factory";
export const FACTORY_SLOT = "factory";
export const FACTORY_CAP = 40_000_000;

/** Creates the factory pool (cap 40,000,000, no allocations) and the factory slot key. */
export async function factorySetup(h: Harness, cap = FACTORY_CAP): Promise<void> {
  expectOk(
    await h.spend.createPool({
      pool_key: FACTORY_POOL,
      cap_microusd: cap,
      allocations: [],
      actor_role: "owner",
      reason: "synthetic factory pool",
    }),
  );
  expectOk(await h.spend.createSlotKey({ slot_key: FACTORY_SLOT, actor_role: "owner", reason: "synthetic factory slot" }));
}

export function records(h: Harness): FactoryRecords {
  return createFactoryRecords({ client: h.client, schema: h.schema, clock: h.clock.now });
}

/** The root execution of request `n`'s budget. */
export function requestRoot(n: number): string {
  return uuid(5000 + n);
}

/** A validation run's root execution. */
export function validationRoot(n: number): string {
  return uuid(7000 + n);
}

export function requestId(n: number): string {
  return uuid(6000 + n);
}

export function budgetKey(n: number): string {
  return hex(5000 + n);
}

export function budgetRequest(n: number, overrides: Partial<CreateBudgetRequest> = {}): CreateBudgetRequest {
  return {
    budget_key: budgetKey(n),
    root_execution_id: requestRoot(n),
    pool_key: FACTORY_POOL,
    cap_microusd: 1_000_000,
    pool_required_microusd: 0,
    actor_role: "web",
    ...overrides,
  };
}

export function exactly(microusd: number): EnvelopeLine[] {
  return [line({ limit: microusd, price: { microusd: 1, per_units: 1 } })];
}

/** Operation `n` under `root` on the factory pool, whose worst case is exactly `microusd`. */
export function factoryOperation(
  n: number,
  root: string,
  microusd: number,
  overrides: Partial<ReserveRequest> = {},
): ReserveRequest {
  return reserveRequest(n, {
    pool_key: FACTORY_POOL,
    root_execution_id: root,
    execution_id: root,
    envelope: exactly(microusd),
    ...overrides,
  });
}

const FIXTURES = new URL("../../../docs/product/fixtures/bug-request-v1/", import.meta.url);

/** A contract fixture, parsed. The fixtures are synthetic and validated by the contract package's tests. */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
}

/** The supported interpretation fixture with its hash replaced. */
export function interpretation(sha256: string): Interpretation {
  const value = fixture("interpretation-supported.json") as Interpretation;
  return { ...value, interpretation_sha256: sha256 };
}

export function recordRequest(n: number, overrides: Partial<RecordRequest> = {}): RecordRequest {
  return {
    request_id: requestId(n),
    request_sha256: hex(8000 + n),
    interpretation: interpretation(hex(8100 + n)),
    interpretation_sha256: hex(8100 + n),
    budget_key: budgetKey(n),
    root_execution_id: requestRoot(n),
    factory_profile_sha256: hex(8200),
    ...overrides,
  };
}

/** Creates budget `n`, records request `n` and appends `request_accepted` (seq 1). */
export async function acceptRequest(h: Harness, n: number, cap = 1_000_000): Promise<string> {
  expectOk(
    await records(h).acceptRequest({
      budget: budgetRequest(n, { cap_microusd: cap }),
      request: recordRequest(n),
      accepted_message: "Request accepted.",
    }),
  );
  return requestId(n);
}

/** Validation run 9100 of request 1 on case 51, with its own root and every detail of its start. */
export function validationRecord(overrides: Partial<RecordValidation> = {}): RecordValidation {
  return {
    validation_id: uuid(9100),
    request_id: requestId(1),
    case_id: hex(51),
    root_execution_id: validationRoot(1),
    host_id: "task-report",
    accepted_at: "2026-10-04T00:00:00.000Z",
    package_sha256: { bug_case: hex(9501), validator: hex(9502) },
    harness: { name: "rbw-validate", version: "1" },
    copies: 9,
    ...overrides,
  };
}

/** IDs written by `populateFactoryTables`. */
export const POPULATED = {
  /** Accepted, charged, closed, stopped, with evidence and a validation run. */
  request: requestId(900),
  budget: budgetKey(900),
  root: requestRoot(900),
  caseId: hex(9901),
  validation: uuid(9900),
  validationRoot: validationRoot(900),
  /** A budget with no request, no closure and no operations. */
  openBudget: budgetKey(901),
  openRoot: requestRoot(901),
  /** An operation under the open budget's root, reserved on the factory pool outside any budget. */
  looseOperation: factoryOperation(901, requestRoot(901), 1).operation_id,
  /** Accepted and nothing else. */
  quietRequest: requestId(902),
} as const;

/**
 * Writes at least one row to every factory table (migration 0006), so row-level guards have
 * something to reject. Uses operation numbers from 900 up; creates the factory pool and slot key.
 * With `before0007`, the validation run is recorded as migration 0006 took it: IDs and root only.
 */
export async function populateFactoryTables(h: Harness, options: { before0007?: boolean } = {}): Promise<void> {
  const f = records(h);
  await factorySetup(h);
  await acceptRequest(h, 900);
  expectOk(
    await h.spend.budgetReserve({ budget_key: POPULATED.budget, role: "request", reservation: factoryOperation(900, POPULATED.root, 1) }),
  );
  expectOk(await h.spend.closeBudget({ budget_key: POPULATED.budget, cause: "fulfilled", actor_role: "worker" }));
  const refused = await h.spend.budgetReserve({
    budget_key: POPULATED.budget,
    role: "request",
    reservation: factoryOperation(903, POPULATED.root, 1),
  });
  if (refused.ok || refused.code !== "budget_closed") {
    throw new Error("expected budget_closed");
  }
  expectOk(await h.spend.createBudget(budgetRequest(901)));
  expectOk(await h.spend.reserve(factoryOperation(901, POPULATED.openRoot, 1)));
  await acceptRequest(h, 902);
  expectOk(await f.recordHeartbeat({ request_id: POPULATED.request, validation_id: null }));
  expectOk(await f.recordStop({ request_id: POPULATED.request, actor_role: "web" }));
  const evidence = '{"synthetic":true}';
  expectOk(
    await f.recordEvidence({
      request_id: POPULATED.request,
      case_id: POPULATED.caseId,
      sha256: createHash("sha256").update(evidence).digest("hex"),
      evidence_json: evidence,
    }),
  );
  const run = validationRecord({
    validation_id: POPULATED.validation,
    request_id: POPULATED.request,
    case_id: POPULATED.caseId,
    root_execution_id: POPULATED.validationRoot,
  });
  const { validation_id, request_id, case_id, root_execution_id } = run;
  expectOk(
    await f.recordValidation(options.before0007 === true ? loose({ validation_id, request_id, case_id, root_execution_id }) : run),
  );
  expectOk(await f.appendValidationEvent({ validation_id: POPULATED.validation, event_key: "started", type: "running", data: {} }));
}

/** The running fixture's events, as a writer appends them: without seq and at. */
export function runningEvents(): Event[] {
  const status = fixture("status-running.json") as { events: Event[] };
  return status.events;
}

export function withoutSeqAndAt(event: Event): EventInput {
  // Each field is copied from one event, so the type and data still belong together.
  return {
    type: event.type,
    host_id: event.host_id,
    candidate_id: event.candidate_id,
    item_key: event.item_key,
    case_id: event.case_id,
    message: event.message,
    data: event.data,
  } as EventInput;
}

export function event(requestIdValue: string, key: string, input: Partial<EventInput> = {}): AppendEvent {
  const base: EventInput = {
    type: "worker_started",
    host_id: null,
    candidate_id: null,
    item_key: null,
    case_id: null,
    message: "The worker started.",
    data: {},
  };
  return { ...base, ...input, request_id: requestIdValue, event_key: key } as AppendEvent;
}
