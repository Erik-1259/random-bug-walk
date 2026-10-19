// Synthetic fakes for the factory worker's tests: a PGlite spend ledger with every migration, the
// factory pool and slot key; an in-memory request-budget layer and factory record store with the
// behavior the ledger's budget functions and records are specified to have (replay by operation or
// event key, budget room over committed amounts, validation reserves after close, only the
// contract's late event types after request_finished); synthetic identity namespaces; a fake
// Sandbox SDK that records every call; and a settable clock.
import { PGlite } from "@electric-sql/pglite";
import { loadRateSheet } from "@rbw/envelope";
import type { Rates } from "@rbw/envelope";
import type { EventType, HostId, StopCode } from "@rbw/factory-contract";
import { createSpend, migrate } from "@rbw/spend";
import type { Reservation, ReserveRequest, Spend } from "@rbw/spend";
import { uuidV5 } from "../../src/factory-ledger.ts";
import type {
  AppendOutcome,
  BudgetResult,
  BudgetRole,
  BudgetTotals,
  FactoryBudgets,
  FactoryEventInput,
  FactoryIdentity,
  FactoryLedger,
  FactoryRecords,
  FactoryRequestRecord,
  FactoryValidationRecord,
  HeartbeatTarget,
  StoredFactoryEvent,
  ValidationEventInput,
  WorkerSandboxCreateParams,
  WorkerSandboxInstance,
  WorkerSandboxSdk,
  WorkerSandboxStatus,
} from "../../src/factory-ports.ts";
import { RATE_SHEET_PATH } from "../../src/rate-sheet.ts";

export const SYNTHETIC_REQUEST_NAMESPACE = "5a0e6c1e-0000-5000-8000-0000000000a1";
export const SYNTHETIC_VALIDATION_NAMESPACE = "5a0e6c1e-0000-5000-8000-0000000000b2";
export const WORKER_IMAGE = `synthetic-team/synthetic-project/rbw-factory-worker@sha256:${"ab".repeat(32)}`;
export const CREDENTIALS = { DATABASE_URL: "postgres://synthetic.invalid/db", VERCEL_TOKEN: "synthetic-token", VERCEL_TEAM_ID: "synthetic-team", VERCEL_PROJECT_ID: "synthetic-project" };
export const INTERPRETATION_SHA256 = "1".repeat(64);
export const CASE_ID = "c".repeat(64);
export const CANDIDATE_A = "a".repeat(64);
export const CANDIDATE_B = "b".repeat(64);

export function syntheticIdentity(): FactoryIdentity {
  return {
    request_namespace: SYNTHETIC_REQUEST_NAMESPACE,
    validation_namespace: SYNTHETIC_VALIDATION_NAMESPACE,
    project_id: uuidV5(SYNTHETIC_REQUEST_NAMESPACE, "synthetic-project"),
    requestRoot: (id) => uuidV5(SYNTHETIC_REQUEST_NAMESPACE, id),
    validationRoot: (id) => uuidV5(SYNTHETIC_VALIDATION_NAMESPACE, id),
  };
}

export class Clock {
  ms: number;
  constructor(iso = "2026-10-20T19:00:00.000Z") {
    this.ms = Date.parse(iso);
  }
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Every fake call yields once, as a database or provider round trip would, so concurrent callers interleave. */
function roundTrip(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The envelope's priced total, as the ledger prices it: each line rounded up. */
function priced(request: ReserveRequest): bigint {
  return request.envelope.reduce((total, line) => {
    if (line.price === null) throw new Error("synthetic: unpriced line");
    return total + (BigInt(line.limit) * BigInt(line.price.microusd) + BigInt(line.price.per_units) - 1n) / BigInt(line.price.per_units);
  }, 0n);
}

interface Budget {
  cap: bigint;
  root: string;
  closed: StopCode | null;
  operations: string[];
}

/** Request budgets over the real spend ledger: room = cap - committed over every operation the budget admitted. */
export class FakeBudgets implements FactoryBudgets {
  readonly budgets = new Map<string, Budget>();
  readonly refusals: { budget_key: string; code: string; role: BudgetRole }[] = [];
  readonly closes: { budget_key: string; cause: StopCode }[] = [];
  private readonly spend: Spend;

  constructor(spend: Spend) {
    this.spend = spend;
  }

  create(budgetKey: string, root: string, cap: number): void {
    this.budgets.set(budgetKey, { cap: BigInt(cap), root, closed: null, operations: [] });
  }

  private async committed(budget: Budget): Promise<{ settled: bigint; open: bigint }> {
    let settled = 0n;
    let open = 0n;
    for (const id of budget.operations) {
      const status = await this.spend.operationStatus({ operation_id: id });
      if (!status.ok) throw new Error("synthetic: a budget operation is unknown");
      settled += status.settled_microusd;
      open += status.open_microusd;
    }
    return { settled, open };
  }

  async reserve(budgetKey: string, role: BudgetRole, request: ReserveRequest): Promise<BudgetResult<Reservation>> {
    const budget = this.budgets.get(budgetKey);
    if (budget === undefined) return { ok: false, code: "unknown_budget" };
    const existing = await this.spend.operationStatus({ operation_id: request.operation_id });
    if (existing.ok) return this.spend.reserve(request);
    const refuse = (code: string): BudgetResult<Reservation> => {
      this.refusals.push({ budget_key: budgetKey, code, role });
      return { ok: false, code };
    };
    if (role === "request" && request.root_execution_id !== budget.root) return refuse("invalid_request");
    if (role === "request" && budget.closed !== null) return refuse("budget_closed");
    const { settled, open } = await this.committed(budget);
    if (priced(request) > budget.cap - settled - open) return refuse("budget_exhausted");
    const reserved = await this.spend.reserve(request);
    if (reserved.ok && !reserved.replay) budget.operations.push(request.operation_id);
    return reserved;
  }

  async close(budgetKey: string, cause: StopCode): Promise<BudgetResult<{ replay: boolean }>> {
    await roundTrip();
    const budget = this.budgets.get(budgetKey);
    if (budget === undefined) return { ok: false, code: "unknown_budget" };
    if (budget.closed !== null) return budget.closed === cause ? { ok: true, replay: true } : { ok: false, code: "operation_conflict" };
    budget.closed = cause;
    this.closes.push({ budget_key: budgetKey, cause });
    return { ok: true, replay: false };
  }

  async status(budgetKey: string): Promise<BudgetResult<BudgetTotals>> {
    const budget = this.budgets.get(budgetKey);
    if (budget === undefined) return { ok: false, code: "unknown_budget" };
    const { settled, open } = await this.committed(budget);
    return { ok: true, budget_microusd: budget.cap, settled_microusd: settled, open_microusd: open, committed_microusd: settled + open, available_microusd: budget.cap - settled - open, closed: budget.closed !== null };
  }
}

const LATE_TYPES: ReadonlySet<EventType> = new Set(["budget_updated", "attention", "attention_cleared", "validation_started", "validation_finished"]);

/** The same content: every field of the input, in a fixed key order, without the stored seq and time. */
function sameContent(stored: (FactoryEventInput | ValidationEventInput) & { seq: number; at: string }, input: FactoryEventInput | ValidationEventInput): boolean {
  const content: Record<string, unknown> = { ...stored };
  delete content.seq;
  delete content.at;
  const order = (value: object): string => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y))));
  return order(content) === order(input);
}

export class FakeRecords implements FactoryRecords {
  readonly requests = new Map<string, FactoryRequestRecord>();
  readonly eventLog = new Map<string, StoredFactoryEvent[]>();
  readonly heartbeats: { target: HeartbeatTarget; at: string }[] = [];
  readonly stops = new Set<string>();
  readonly validations = new Map<string, FactoryValidationRecord>();
  readonly validationLog = new Map<string, (ValidationEventInput & { seq: number; at: string })[]>();
  /** Every refused append (an event type no longer allowed after request_finished). */
  readonly refusedAppends: FactoryEventInput[] = [];

  async request(requestId: string): Promise<FactoryRequestRecord | null> {
    await roundTrip();
    return this.requests.get(requestId) ?? null;
  }

  async appendEvent(requestId: string, event: FactoryEventInput, at: Date): Promise<AppendOutcome> {
    await roundTrip();
    const log = this.eventLog.get(requestId) ?? [];
    this.eventLog.set(requestId, log);
    const prior = log.find((stored) => stored.event_key === event.event_key);
    if (prior !== undefined) return sameContent(prior, event) ? { kind: "replay", seq: prior.seq } : { kind: "conflict" };
    if (log.some((stored) => stored.type === "request_finished") && !LATE_TYPES.has(event.type)) {
      this.refusedAppends.push(event);
      return { kind: "refused", reason: "request_finished" };
    }
    const stored: StoredFactoryEvent = { ...event, seq: log.length + 1, at: at.toISOString() };
    log.push(stored);
    return { kind: "appended", seq: stored.seq };
  }

  async events(requestId: string): Promise<StoredFactoryEvent[]> {
    await roundTrip();
    return [...(this.eventLog.get(requestId) ?? [])];
  }

  async recordHeartbeat(target: HeartbeatTarget, at: Date): Promise<void> {
    await roundTrip();
    this.heartbeats.push({ target, at: at.toISOString() });
  }

  async lastHeartbeat(target: HeartbeatTarget): Promise<Date | null> {
    await roundTrip();
    const key = JSON.stringify(target);
    const last = this.heartbeats.filter((beat) => JSON.stringify(beat.target) === key).at(-1);
    return last === undefined ? null : new Date(last.at);
  }

  async stopRequested(requestId: string): Promise<boolean> {
    await roundTrip();
    return this.stops.has(requestId);
  }

  async recordValidation(record: FactoryValidationRecord): Promise<"created" | "replay" | "conflict"> {
    await roundTrip();
    const prior = this.validations.get(record.validation_id);
    if (prior !== undefined) return JSON.stringify(prior) === JSON.stringify(record) ? "replay" : "conflict";
    this.validations.set(record.validation_id, record);
    return "created";
  }

  async validation(validationId: string): Promise<FactoryValidationRecord | null> {
    await roundTrip();
    return this.validations.get(validationId) ?? null;
  }

  async appendValidationEvent(validationId: string, event: ValidationEventInput, at: Date): Promise<AppendOutcome> {
    await roundTrip();
    const log = this.validationLog.get(validationId) ?? [];
    this.validationLog.set(validationId, log);
    const prior = log.find((stored) => stored.event_key === event.event_key);
    if (prior !== undefined) return sameContent(prior, event) ? { kind: "replay", seq: prior.seq } : { kind: "conflict" };
    const stored = { ...event, seq: log.length + 1, at: at.toISOString() };
    log.push(stored);
    return { kind: "appended", seq: stored.seq };
  }

  async validationEvents(validationId: string): Promise<(ValidationEventInput & { seq: number; at: string })[]> {
    await roundTrip();
    return [...(this.validationLog.get(validationId) ?? [])];
  }

  types(requestId: string): string[] {
    return (this.eventLog.get(requestId) ?? []).map((event) => event.type);
  }
}

export class FakeInstance implements WorkerSandboxInstance {
  readonly name: string;
  status: WorkerSandboxStatus = "running";
  readonly sdk: FakeWorkerSandbox;
  constructor(name: string, sdk: FakeWorkerSandbox) {
    this.name = name;
    this.sdk = sdk;
  }
  async runCommand(params: { cmd: string; args: string[]; cwd: string; detached: true }): Promise<unknown> {
    await roundTrip();
    this.sdk.calls.push({ action: "run", name: this.name, detail: params });
    if (this.sdk.failRun) throw new Error("synthetic: the command could not be started");
    return { cmdId: "synthetic" };
  }
  async stop(): Promise<unknown> {
    await roundTrip();
    this.sdk.calls.push({ action: "stop", name: this.name, detail: null });
    if (this.sdk.failStop) throw new Error("synthetic: the stop failed");
    if (this.sdk.stopTakesEffect) this.status = "stopped";
    return undefined;
  }
}

export class SyntheticApiError extends Error {
  readonly response: { status: number };
  constructor(status: number) {
    super(`synthetic API error ${String(status)}`);
    this.name = "APIError";
    this.response = { status };
  }
}

export class FakeWorkerSandbox implements WorkerSandboxSdk {
  readonly calls: { action: "create" | "get" | "run" | "stop"; name: string; detail: unknown }[] = [];
  readonly sandboxes = new Map<string, FakeInstance>();
  /** When set, create throws this; with `createdAnyway` the sandbox exists afterwards. */
  createError: Error | null = null;
  createdAnyway = false;
  failRun = false;
  failStop = false;
  stopTakesEffect = true;
  /** Held creates wait for this before answering. */
  gate: Promise<void> | null = null;

  async create(params: WorkerSandboxCreateParams): Promise<WorkerSandboxInstance> {
    this.calls.push({ action: "create", name: params.name, detail: params });
    if (this.gate !== null) await this.gate;
    if (this.createError !== null) {
      if (this.createdAnyway) this.sandboxes.set(params.name, new FakeInstance(params.name, this));
      throw this.createError;
    }
    const instance = new FakeInstance(params.name, this);
    this.sandboxes.set(params.name, instance);
    return instance;
  }

  async get(name: string): Promise<WorkerSandboxInstance | null> {
    await roundTrip();
    this.calls.push({ action: "get", name, detail: null });
    return this.sandboxes.get(name) ?? null;
  }

  count(action: "create" | "get" | "run" | "stop"): number {
    return this.calls.filter((call) => call.action === action).length;
  }
}

export interface FactoryWorld {
  db: PGlite;
  spend: Spend;
  budgets: FakeBudgets;
  ledger: FactoryLedger;
  records: FakeRecords;
  identity: FactoryIdentity;
  sandbox: FakeWorkerSandbox;
  clock: Clock;
  rates: Rates;
  logs: string[];
  close: () => Promise<void>;
}

/** A fresh world: the ledger with the factory pool ($40) and slot key, no request yet. */
export async function factoryWorld(): Promise<FactoryWorld> {
  const clock = new Clock();
  const db = await PGlite.create();
  await migrate(db, { schema: "public" });
  const spend = createSpend({ client: db, schema: "public", clock: clock.now });
  const pool = await spend.createPool({ pool_key: "factory", cap_microusd: 40_000_000, allocations: [], actor_role: "owner", reason: "synthetic factory pool" });
  if (!pool.ok) throw new Error(`synthetic: the factory pool was refused (${pool.code})`);
  const slot = await spend.createSlotKey({ slot_key: "factory", actor_role: "owner", reason: "synthetic factory slot" });
  if (!slot.ok) throw new Error(`synthetic: the factory slot key was refused (${slot.code})`);
  const budgets = new FakeBudgets(spend);
  return {
    db,
    spend,
    budgets,
    ledger: { spend, budgets },
    records: new FakeRecords(),
    identity: syntheticIdentity(),
    sandbox: new FakeWorkerSandbox(),
    clock,
    rates: await loadRateSheet(RATE_SHEET_PATH),
    logs: [],
    close: () => db.close(),
  };
}

let counter = 0;
/** A fresh synthetic UUID per call. */
export function syntheticUuid(prefix = "9000"): string {
  counter += 1;
  return `00000000-0000-4000-${prefix}-${counter.toString(16).padStart(12, "0")}`;
}

/**
 * What the web service does before it calls startFactoryWorker (contract section 7, steps 6 and 7):
 * takes the slot under the request root, creates the budget, records the request and appends
 * request_accepted.
 */
export async function acceptRequest(w: FactoryWorld, options: { budget?: number; requestId?: string } = {}): Promise<FactoryRequestRecord> {
  const requestId = options.requestId ?? syntheticUuid();
  const root = w.identity.requestRoot(requestId);
  const slot = await w.spend.acquireSlot({ slot_key: "factory", root_execution_id: root, actor_role: "factory-route" });
  if (!slot.ok) throw new Error(`synthetic: the slot was refused (${slot.code})`);
  const record: FactoryRequestRecord = { request_id: requestId, root, budget_key: `request-${requestId}`, interpretation_sha256: INTERPRETATION_SHA256, profile_sha256: "0".repeat(64), created_at: w.clock.now().toISOString() };
  w.budgets.create(record.budget_key, root, options.budget ?? 1_500_000);
  w.records.requests.set(requestId, record);
  await w.records.appendEvent(requestId, { event_key: "request_accepted", type: "request_accepted", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Request accepted.", data: {} }, w.clock.now());
  return record;
}

export async function slotHolder(w: FactoryWorld): Promise<string | null> {
  const slot = await w.spend.slotStatus({ slot_key: "factory" });
  if (!slot.ok) throw new Error("synthetic: slot status refused");
  return slot.holder;
}

export async function operationState(w: FactoryWorld, operationId: string): Promise<string | null> {
  const status = await w.spend.operationStatus({ operation_id: operationId });
  return status.ok ? status.state : null;
}

export function host(value: HostId): HostId {
  return value;
}
