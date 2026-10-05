// Request and result shapes for the spend database operations. Field names match the
// JSON that the SQL functions accept and return, so a caller in another language sends
// and receives the same documents.

/** Units an envelope line may meter. The database holds the authoritative list (table `units`). */
export const UNITS = [
  "input_token",
  "output_token",
  "call",
  "creation",
  "step",
  "operation",
  "credit",
  "vcpu_second",
  "memory_gb_second",
  "byte",
  "allowance",
] as const;
export type Unit = (typeof UNITS)[number];

/** How a line's limit is enforced. The database holds the authoritative list (table `enforcement_methods`). */
export const ENFORCED_BY = [
  "request_parameter",
  "client_counter",
  "provider_timeout",
  "provider_quota",
  "fixed_allowance",
] as const;
export type EnforcedBy = (typeof ENFORCED_BY)[number];

export const OPERATION_STATES = [
  "prepared",
  "launching",
  "running",
  "terminal",
  "reconciled",
  "uncertain",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const REFUSAL_CODES = [
  "invalid_request",
  "unknown_pool",
  "unknown_allocation",
  "unknown_operation",
  "unknown_price",
  "unenforceable_limit",
  "insufficient_funds",
  "pool_halted",
  "operation_conflict",
  "previous_attempt_unresolved",
  "invalid_transition",
  "already_settled",
  "slot_held",
  "slot_not_held",
  "slot_release_blocked",
  "unknown_slot",
  "transfer_refused",
  "cap_change_refused",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type TerminalStatus = "completed" | "failed" | "cancelled";
export type UsageState = "known" | "partly_unknown" | "unknown";
export type ReconciliationDecision =
  | "found_running"
  | "confirm_no_launch"
  | "accept_complete"
  | "confirm_stopped_incomplete";

export interface Evidence {
  key: string;
  sha256: string;
}

/** A child resource that blocks a slot release, with the slot key it is confirmed under. */
export interface ChildResourceRef {
  slot_key: string;
  provider: string;
  resource_id: string;
}

/** A typed business refusal. Only the fields relevant to the code are present. */
export interface Refusal {
  ok: false;
  code: RefusalCode;
  detail?: string;
  current_state?: OperationState;
  requested_microusd?: bigint;
  pool_available_microusd?: bigint;
  allocation_available_microusd?: bigint | null;
  holder?: string;
  blocking_child_resources?: ChildResourceRef[];
  blocking_operation_ids?: string[];
}

export type Result<T> = ({ ok: true } & T) | Refusal;

// Manual actions

export interface AllocationInput {
  allocation_key: string;
  limit_microusd: number;
}

export interface CreatePoolRequest {
  pool_key: string;
  cap_microusd: number;
  allocations: AllocationInput[];
  actor_role: string;
  reason: string;
}

export interface CreateSlotKeyRequest {
  slot_key: string;
  actor_role: string;
  reason: string;
}

export interface RaiseCapRequest {
  pool_key: string;
  new_cap_microusd: number;
  actor_role: string;
  reason: string;
}

export interface TransferRequest {
  pool_key: string;
  from_allocation_key: string;
  to_allocation_key: string;
  amount_microusd: number;
  actor_role: string;
  reason: string;
}

export interface ResumeRequest {
  actor_role: string;
  evidence: Evidence[];
  reason: string;
}

export interface Recorded {
  seq: number;
}

// Reservation

export interface Price {
  microusd: number;
  per_units: number;
}

export interface EnvelopeLine {
  service: string;
  unit: Unit;
  limit: number;
  enforced_by: EnforcedBy;
  price: Price | null;
}

export interface ReserveRequest {
  operation_id: string;
  payload_hash: string;
  attempt_ordinal: number;
  previous_operation_id: string | null;
  project_id: string;
  project_policy_sha256: string;
  batch_id: string | null;
  task_revision: string;
  root_execution_id: string;
  execution_id: string;
  parent_execution_id: string | null;
  kind: string;
  call_name: string;
  provider: string;
  provider_replay_key: string | null;
  pool_key: string;
  allocation_key: string | null;
  runtime_profile_sha256: string;
  rate_sheet_sha256: string;
  envelope: EnvelopeLine[];
}

export interface Reservation {
  replay: boolean;
  operation_id: string;
  state: OperationState;
  reserved_microusd: bigint;
  pool_available_microusd: bigint;
  allocation_available_microusd: bigint | null;
}

// State transitions

export interface TransitionRequest {
  operation_id: string;
  from_state: OperationState;
  to_state: OperationState;
  actor_role: string;
  /** Required for `prepared → launching`. */
  slot_key?: string;
  /** Required for `launching → running`. */
  provider_resource_id?: string;
  /** Required for `→ terminal`. */
  terminal_status?: TerminalStatus;
  /** Required for `→ uncertain`. */
  uncertainty?: "lost_response" | "unknown_status";
}

export interface Transitioned {
  operation_id: string;
  state: OperationState;
  seq: number;
}

// Settlement

export interface UsageSettlementLine {
  service: string;
  unit: Unit;
  actual_quantity: number | null;
  actual_microusd: number | null;
  retained_microusd: number;
}

export interface UsageSettlement {
  schema_version: 1;
  operation_id: string;
  runtime_profile_sha256: string;
  rate_sheet_sha256: string;
  reserved_microusd: number;
  service_lines: UsageSettlementLine[];
  usage_state: UsageState;
  terminal_evidence_key: string | null;
  terminal_evidence_sha256: string | null;
}

export interface Settled {
  replay: boolean;
  operation_id: string;
  state: OperationState;
  settled_microusd: bigint;
  retained_microusd: bigint;
  released_microusd: bigint;
  over_envelope: boolean;
}

// Manual reconciliation

export interface ManualReconciliation {
  schema_version: 1;
  operation_id: string;
  previous_state: OperationState;
  evidence: Evidence[];
  provider_resource_ids: string[];
  recorded_at: string;
  actor_role: string;
  decision: ReconciliationDecision;
  retained_microusd: number;
  released_microusd: number;
  reason: string;
}

export interface Reconciled {
  operation_id: string;
  state: OperationState;
  retained_microusd: bigint;
  released_microusd: bigint;
  over_envelope: boolean;
}

// Serial execution slot

export interface AcquireSlotRequest {
  slot_key: string;
  root_execution_id: string;
  actor_role: string;
}

export interface SlotHold {
  replay: boolean;
  slot_key: string;
  holder: string;
}

export interface RecordChildRequest {
  slot_key: string;
  root_execution_id: string;
  provider: string;
  resource_id: string;
  operation_id: string | null;
  execution_id: string | null;
  kind: string;
  actor_role: string;
}

export interface ConfirmChildRequest {
  slot_key: string;
  root_execution_id: string;
  provider: string;
  resource_id: string;
  terminal_status: TerminalStatus;
  evidence: Evidence;
  actor_role: string;
}

export interface ChildRecorded {
  replay: boolean;
  seq: number;
}

export interface ReleaseSlotRequest {
  slot_key: string;
  root_execution_id: string;
  actor_role: string;
  /** Required (one or more) when an `owner` or `operator` releases. */
  evidence: Evidence[] | null;
  /** Required when an `owner` or `operator` releases. */
  reason: string | null;
}

// Read-only status

export interface HaltObservation {
  seq: number;
  operation_id: string;
  pool_key: string;
  source: "settlement" | "reconciliation";
  service: string | null;
  unit: string | null;
  observed_microusd: bigint | null;
  bound_microusd: bigint | null;
  observed_quantity: bigint | null;
  bound_quantity: bigint | null;
}

export interface HaltStatus {
  halted: boolean;
  observations: HaltObservation[];
}

export interface AllocationStatus {
  allocation_key: string;
  limit_microusd: bigint;
  settled_microusd: bigint;
  open_microusd: bigint;
  committed_microusd: bigint;
  available_microusd: bigint;
}

export interface PoolStatus {
  pool_key: string;
  cap_microusd: bigint;
  settled_microusd: bigint;
  open_microusd: bigint;
  committed_microusd: bigint;
  available_microusd: bigint;
  allocations: AllocationStatus[];
}

export interface OperationStatus {
  operation_id: string;
  state: OperationState;
  pool_key: string;
  allocation_key: string | null;
  reserved_microusd: bigint;
  settled_microusd: bigint;
  open_microusd: bigint;
  released_microusd: bigint;
}

export interface SlotChild {
  provider: string;
  resource_id: string;
  operation_id: string | null;
  execution_id: string | null;
  kind: string;
  confirmed: boolean;
  terminal_status: TerminalStatus | null;
}

export interface SlotStatus {
  slot_key: string;
  holder: string | null;
  children: SlotChild[];
  release_blockers: {
    child_resources: ChildResourceRef[];
    operation_ids: string[];
  };
}
