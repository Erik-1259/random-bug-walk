// What the factory worker and its launch functions call in other parts of the factory, as narrow
// injected ports, so this code depends on behavior and not on module names: the request budgets
// and factory records of the spend ledger, the identity roots of the factory core, and the
// Vercel Sandbox SDK with the credentials bound. The integration pass maps each port to the real
// function once it is on the same base. Type-only, so web-safe.
import type { EventType, HostId, PackageHashes, StopCode } from "@rbw/factory-contract";
import type { Reservation, ReserveRequest, Spend } from "@rbw/spend";

// Request budgets ---------------------------------------------------------------------------

/** `request` reserves for the request's own work; `validation` for a validation run, also after the budget closed. */
export type BudgetRole = "request" | "validation";

/** A budget refusal. Besides the spend ledger's codes, the budget functions answer budget_exhausted and budget_closed. */
export interface BudgetRefusal {
  ok: false;
  code: string;
  detail?: string;
}

export type BudgetResult<T> = ({ ok: true } & T) | BudgetRefusal;

export interface BudgetTotals {
  budget_microusd: bigint;
  settled_microusd: bigint;
  /** Open reservations: reserved and not yet settled or reconciled. */
  open_microusd: bigint;
  committed_microusd: bigint;
  /** budget_microusd - committed_microusd; negative only after an overrun. */
  available_microusd: bigint;
  closed: boolean;
}

/** The spend ledger's request-budget functions (budget reserve, close and status). */
export interface FactoryBudgets {
  reserve(budgetKey: string, role: BudgetRole, request: ReserveRequest): Promise<BudgetResult<Reservation>>;
  /** Idempotent: closing again with the same cause replays. */
  close(budgetKey: string, cause: StopCode): Promise<BudgetResult<{ replay: boolean }>>;
  status(budgetKey: string): Promise<BudgetResult<BudgetTotals>>;
}

/** The spend ledger as the factory uses it: the existing operations, settlement and slot functions, and the budgets. */
export interface FactoryLedger {
  spend: Spend;
  budgets: FactoryBudgets;
}

// Factory records ---------------------------------------------------------------------------

/** One request event to append. The event key makes the append idempotent: the same key and content replays. */
export interface FactoryEventInput {
  event_key: string;
  type: EventType;
  host_id: HostId | null;
  candidate_id: string | null;
  item_key: string | null;
  case_id: string | null;
  message: string;
  data: Record<string, unknown>;
}

export interface StoredFactoryEvent extends FactoryEventInput {
  seq: number;
  at: string;
}

/** `refused`: the store refused the append (for example an event type no longer allowed after request_finished). */
export type AppendOutcome = { kind: "appended" | "replay"; seq: number } | { kind: "conflict" } | { kind: "refused"; reason: string };

export interface FactoryRequestRecord {
  request_id: string;
  /** The request root: every ledger operation of the request uses it. */
  root: string;
  budget_key: string;
  interpretation_sha256: string;
  profile_sha256: string;
  created_at: string;
}

export interface FactoryValidationRecord {
  validation_id: string;
  request_id: string;
  case_id: string;
  host_id: HostId;
  /** The validation root: the run's slot hold and operations use it. */
  root: string;
  accepted_at: string;
  package_sha256: PackageHashes;
}

export type HeartbeatTarget = { request_id: string } | { validation_id: string };

/** One validation event to append, keyed like request events. */
export interface ValidationEventInput {
  event_key: string;
  type: "running" | "copy" | "finished";
  data: Record<string, unknown>;
}

export interface FactoryRecords {
  request(requestId: string): Promise<FactoryRequestRecord | null>;
  appendEvent(requestId: string, event: FactoryEventInput, at: Date): Promise<AppendOutcome>;
  events(requestId: string): Promise<StoredFactoryEvent[]>;
  recordHeartbeat(target: HeartbeatTarget, at: Date): Promise<void>;
  lastHeartbeat(target: HeartbeatTarget): Promise<Date | null>;
  stopRequested(requestId: string): Promise<boolean>;
  recordValidation(record: FactoryValidationRecord): Promise<"created" | "replay" | "conflict">;
  validation(validationId: string): Promise<FactoryValidationRecord | null>;
  appendValidationEvent(validationId: string, event: ValidationEventInput, at: Date): Promise<AppendOutcome>;
  validationEvents(validationId: string): Promise<(ValidationEventInput & { seq: number; at: string })[]>;
}

// Identity ----------------------------------------------------------------------------------

/** The factory core's identity module: the roots, their namespaces and the project ID. */
export interface FactoryIdentity {
  request_namespace: string;
  validation_namespace: string;
  project_id: string;
  requestRoot(requestId: string): string;
  validationRoot(validationId: string): string;
}

// Vercel Sandbox ----------------------------------------------------------------------------

/** A worker sandbox: network allowed (it reaches the database and the Sandbox API), credentials as create-time environment values. */
export interface WorkerSandboxCreateParams {
  image: string;
  name: string;
  persistent: false;
  networkPolicy: "allow-all";
  resources: { vcpus: number };
  /** Milliseconds. */
  timeout: number;
  env: Record<string, string>;
}

export type WorkerSandboxStatus = "pending" | "running" | "stopping" | "stopped" | "failed" | "aborted" | "snapshotting";

export interface WorkerSandboxInstance {
  readonly name: string;
  readonly status: WorkerSandboxStatus;
  runCommand(params: { cmd: string; args: string[]; cwd: string; detached: true }): Promise<unknown>;
  stop(): Promise<unknown>;
}

/** `Sandbox.create` and `Sandbox.get` with the credentials bound. */
export interface WorkerSandboxSdk {
  create(params: WorkerSandboxCreateParams): Promise<WorkerSandboxInstance>;
  /** Null when no sandbox has this name. */
  get(name: string): Promise<WorkerSandboxInstance | null>;
}
