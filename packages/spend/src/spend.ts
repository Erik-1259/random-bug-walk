import type { SqlClient } from "./client.ts";
import { REFUSAL_CODES } from "./types.ts";
import type {
  AcquireSlotRequest,
  ChildRecorded,
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
}

interface ReadOperations {
  spend_halt_status: [Record<string, never>, HaltStatus];
  spend_pool_status: [{ pool_key: string }, PoolStatus];
  spend_operation_status: [{ operation_id: string }, OperationStatus];
  spend_slot_status: [{ slot_key: string }, SlotStatus];
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

function decode(rows: Record<string, unknown>[]): unknown {
  const text = rows[0]?.result;
  if (typeof text !== "string") {
    throw new Error("database operation returned no result");
  }
  const parsed: unknown = JSON.parse(text, revive);
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed) || typeof parsed.ok !== "boolean") {
    throw new Error("database operation returned a malformed result");
  }
  if (!parsed.ok && !("code" in parsed && typeof parsed.code === "string" && REFUSAL_CODE_SET.has(parsed.code))) {
    throw new Error("database operation returned an unknown refusal code");
  }
  return parsed;
}

/**
 * Typed wrapper over the spend database operations. Every call is one statement; the
 * database does all validation and decides every outcome. Refusals are returned, never thrown;
 * infrastructure errors are thrown and never reported as success or refusal. Nothing retries.
 */
export function createSpend(options: SpendOptions): Spend {
  const { client } = options;
  const schema = options.schema ?? "public";
  assertSchemaName(schema);
  const clock = options.clock ?? (() => new Date());

  async function write<K extends keyof WriteOperations>(
    fn: K,
    request: WriteOperations[K][0],
  ): Promise<Result<WriteOperations[K][1]>> {
    const { rows } = await client.query(`SELECT ${schema}.${fn}($1::jsonb, $2::text)::text AS result`, [
      encode(request),
      clock().toISOString(),
    ]);
    // The shape is produced by this package's own SQL function for the named operation.
    return decode(rows) as Result<WriteOperations[K][1]>;
  }

  async function read<K extends keyof ReadOperations>(
    fn: K,
    request: ReadOperations[K][0],
  ): Promise<Result<ReadOperations[K][1]>> {
    const { rows } = await client.query(`SELECT ${schema}.${fn}($1::jsonb)::text AS result`, [encode(request)]);
    return decode(rows) as Result<ReadOperations[K][1]>;
  }

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
  };
}
