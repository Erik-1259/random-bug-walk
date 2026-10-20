import type { SqlClient } from "./client.ts";
import { REFUSAL_CODES } from "./types.ts";
import type {
  AcquireSlotRequest,
  BudgetClosed,
  BudgetCreated,
  BudgetOperations,
  BudgetReserveRequest,
  BudgetStatus,
  ChildRecorded,
  CloseBudgetRequest,
  CreateBudgetRequest,
  ConfirmChildRequest,
  CreatePoolRequest,
  CreateSlotKeyRequest,
  HaltStatus,
  ManualReconciliation,
  OperationStatus,
  PoolStatus,
  RaiseCapRequest,
  Reconciled,
  Recorded,
  RecordChildRequest,
  ReleaseSlotRequest,
  Reservation,
  ReserveRequest,
  Result,
  ResumeRequest,
  Settled,
  SlotHold,
  SlotStatus,
  TransferRequest,
  Transitioned,
  TransitionRequest,
  UsageSettlement,
} from "./types.ts";

export interface SpendOptions {
  client: SqlClient;
  /** Schema the migrations were applied to. Default `public`. */
  schema?: string;
  /** Source of event times. Default: system time. */
  clock?: () => Date;
}

export interface Spend {
  createPool(request: CreatePoolRequest): Promise<Result<Recorded>>;
  createSlotKey(request: CreateSlotKeyRequest): Promise<Result<Recorded>>;
  raiseCap(request: RaiseCapRequest): Promise<Result<Recorded>>;
  transfer(request: TransferRequest): Promise<Result<Recorded>>;
  resume(request: ResumeRequest): Promise<Result<Recorded>>;
  reserve(request: ReserveRequest): Promise<Result<Reservation>>;
  transition(request: TransitionRequest): Promise<Result<Transitioned>>;
  settle(settlement: UsageSettlement): Promise<Result<Settled>>;
  reconcile(reconciliation: ManualReconciliation): Promise<Result<Reconciled>>;
  acquireSlot(request: AcquireSlotRequest): Promise<Result<SlotHold>>;
  recordChild(request: RecordChildRequest): Promise<Result<ChildRecorded>>;
  confirmChild(request: ConfirmChildRequest): Promise<Result<ChildRecorded>>;
  releaseSlot(request: ReleaseSlotRequest): Promise<Result<Recorded>>;
  haltStatus(): Promise<Result<HaltStatus>>;
  poolStatus(request: { pool_key: string }): Promise<Result<PoolStatus>>;
  operationStatus(request: { operation_id: string }): Promise<Result<OperationStatus>>;
  slotStatus(request: { slot_key: string }): Promise<Result<SlotStatus>>;
  /** Creates a request budget; an identical request replays, a different one is `idempotency_conflict`. */
  createBudget(request: CreateBudgetRequest): Promise<Result<BudgetCreated>>;
  /** Check-and-reserve against a request budget, then against its pool (`reserve`). */
  budgetReserve(request: BudgetReserveRequest): Promise<Result<Reservation>>;
  /** Closes a budget to `request` reservations; repeating the same cause replays. */
  closeBudget(request: CloseBudgetRequest): Promise<Result<BudgetClosed>>;
  budgetStatus(request: { budget_key: string }): Promise<Result<BudgetStatus>>;
  budgetOperations(request: { budget_key: string }): Promise<Result<BudgetOperations>>;
}

/** Database function name to [request, success result]. Write operations also take the event time. */
interface WriteOperations {
  spend_create_pool: [CreatePoolRequest, Recorded];
  spend_create_slot_key: [CreateSlotKeyRequest, Recorded];
  spend_raise_cap: [RaiseCapRequest, Recorded];
  spend_transfer: [TransferRequest, Recorded];
  spend_resume: [ResumeRequest, Recorded];
  spend_reserve: [ReserveRequest, Reservation];
  spend_transition: [TransitionRequest, Transitioned];
  spend_settle: [UsageSettlement, Settled];
  spend_reconcile: [ManualReconciliation, Reconciled];
  spend_slot_acquire: [AcquireSlotRequest, SlotHold];
  spend_slot_record_child: [RecordChildRequest, ChildRecorded];
  spend_slot_confirm_child: [ConfirmChildRequest, ChildRecorded];
  spend_slot_release: [ReleaseSlotRequest, Recorded];
  spend_create_budget: [CreateBudgetRequest, BudgetCreated];
  spend_budget_reserve: [BudgetReserveRequest, Reservation];
  spend_budget_close: [CloseBudgetRequest, BudgetClosed];
}

interface ReadOperations {
  spend_halt_status: [Record<string, never>, HaltStatus];
  spend_pool_status: [{ pool_key: string }, PoolStatus];
  spend_operation_status: [{ operation_id: string }, OperationStatus];
  spend_slot_status: [{ slot_key: string }, SlotStatus];
  spend_budget_status: [{ budget_key: string }, BudgetStatus];
  spend_budget_operations: [{ budget_key: string }, BudgetOperations];
}

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const INTEGER_TEXT = /^-?[0-9]+$/;
const REFUSAL_CODE_SET: ReadonlySet<string> = new Set(REFUSAL_CODES);

export function assertSchemaName(schema: string): void {
  if (!SCHEMA_PATTERN.test(schema)) {
    throw new Error("schema must be a lowercase SQL identifier (letters, digits and underscores)");
  }
}

// JSON cannot carry a bigint; send it as a string so the database refuses it like any
// non-number amount instead of the encoder throwing.
function encode(request: unknown): string {
  return JSON.stringify(request, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}

// Amounts and quantities arrive as decimal strings and become exact bigints.
function revive(key: string, value: unknown): unknown {
  if ((key.endsWith("_microusd") || key.endsWith("_quantity")) && typeof value === "string") {
    if (!INTEGER_TEXT.test(value)) {
      throw new Error(`database returned a non-integer ${key}`);
    }
    return BigInt(value);
  }
  return value;
}

/**
 * Where amounts are revived. `nested`: at every depth (the spend results). `top-level`: only the
 * result's own fields, so stored documents inside it (event data, an interpretation) come back
 * exactly as they were stored.
 */
export type AmountRevival = "nested" | "top-level";

function decode(rows: Record<string, unknown>[], amounts: AmountRevival): unknown {
  const text = rows[0]?.result;
  if (typeof text !== "string") {
    throw new Error("database operation returned no result");
  }
  const parsed: unknown = JSON.parse(text, amounts === "nested" ? revive : undefined);
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed) || typeof parsed.ok !== "boolean") {
    throw new Error("database operation returned a malformed result");
  }
  if (!parsed.ok && !("code" in parsed && typeof parsed.code === "string" && REFUSAL_CODE_SET.has(parsed.code))) {
    throw new Error("database operation returned an unknown refusal code");
  }
  if (amounts === "top-level") {
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, revive(key, value)]));
  }
  return parsed;
}

/** Database function name to [request, success result]. */
export type OperationMap<T> = Record<keyof T, [unknown, unknown]>;

export interface DatabaseCalls<W extends OperationMap<W>, R extends OperationMap<R>> {
  /** Runs a writing function, with the clock's time as the event time. */
  write: <K extends keyof W & string>(fn: K, request: W[K][0]) => Promise<Result<W[K][1]>>;
  read: <K extends keyof R & string>(fn: K, request: R[K][0]) => Promise<Result<R[K][1]>>;
}

/**
 * One statement per call to a database function of this package in `options.schema`. The result
 * is decoded (amounts become bigints, as `amounts` says) and its refusal code checked. Its shape is
 * the named SQL function's own, so callers type it by the function name.
 */
export function databaseCalls<W extends OperationMap<W>, R extends OperationMap<R>>(
  options: SpendOptions,
  amounts: AmountRevival = "nested",
): DatabaseCalls<W, R> {
  const { client } = options;
  const schema = options.schema ?? "public";
  assertSchemaName(schema);
  const clock = options.clock ?? (() => new Date());
  return {
    write: async (fn, request) => {
      const { rows } = await client.query(`SELECT ${schema}.${fn}($1::jsonb, $2::text)::text AS result`, [
        encode(request),
        clock().toISOString(),
      ]);
      // The shape is produced by this package's own SQL function for the named operation.
      return decode(rows, amounts) as Result<W[typeof fn][1]>;
    },
    read: async (fn, request) => {
      const { rows } = await client.query(`SELECT ${schema}.${fn}($1::jsonb)::text AS result`, [encode(request)]);
      return decode(rows, amounts) as Result<R[typeof fn][1]>;
    },
  };
}

/**
 * Typed wrapper over the spend database operations. Every call is one statement; the
 * database does all validation and decides every outcome. Refusals are returned, never thrown;
 * infrastructure errors are thrown and never reported as success or refusal. Nothing retries.
 */
export function createSpend(options: SpendOptions): Spend {
  const { write, read } = databaseCalls<WriteOperations, ReadOperations>(options);

  return {
    createPool: (request) => write("spend_create_pool", request),
    createSlotKey: (request) => write("spend_create_slot_key", request),
    raiseCap: (request) => write("spend_raise_cap", request),
    transfer: (request) => write("spend_transfer", request),
    resume: (request) => write("spend_resume", request),
    reserve: (request) => write("spend_reserve", request),
    transition: (request) => write("spend_transition", request),
    settle: (settlement) => write("spend_settle", settlement),
    reconcile: (reconciliation) => write("spend_reconcile", reconciliation),
    acquireSlot: (request) => write("spend_slot_acquire", request),
    recordChild: (request) => write("spend_slot_record_child", request),
    confirmChild: (request) => write("spend_slot_confirm_child", request),
    releaseSlot: (request) => write("spend_slot_release", request),
    haltStatus: () => read("spend_halt_status", {}),
    poolStatus: (request) => read("spend_pool_status", request),
    operationStatus: (request) => read("spend_operation_status", request),
    slotStatus: (request) => read("spend_slot_status", request),
    createBudget: (request) => write("spend_create_budget", request),
    budgetReserve: (request) => write("spend_budget_reserve", request),
    closeBudget: (request) => write("spend_budget_close", request),
    budgetStatus: (request) => read("spend_budget_status", request),
    budgetOperations: (request) => read("spend_budget_operations", request),
  };
}
