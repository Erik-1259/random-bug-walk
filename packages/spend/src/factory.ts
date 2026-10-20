import type { Event, HarnessIdentity, HostId, Interpretation, PackageHashes } from "@rbw/factory-contract";
import type { SqlClient } from "./client.ts";
import { databaseCalls } from "./spend.ts";
import type { CreateBudgetRequest, Result } from "./types.ts";

// Durable records of factory requests (migrations 0006 and 0007): the request and its frozen
// interpretation, its numbered events, the worker's heartbeats, a stop request, per-case evidence,
// and validation runs with the details of their start and their own numbered events. Every write
// is idempotent: the same key with the same content replays (`replay: true`) and writes nothing;
// the same key with other content is refused with `idempotency_conflict`. Times are UTC ISO 8601
// strings with milliseconds and `Z`.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A request event as appended: the contract's `Event` without `seq` and `at`, which the database assigns. */
export type EventInput = DistributiveOmit<Event, "seq" | "at">;

export interface RecordRequest {
  request_id: string;
  /** Canonical SHA-256 of the start request body (request_id, normalized input, interpretation_sha256). */
  request_sha256: string;
  /** The frozen interpretation; its `interpretation_sha256` must equal the field below. */
  interpretation: Interpretation;
  interpretation_sha256: string;
  budget_key: string;
  /** The request root; it must be the budget's root execution. */
  root_execution_id: string;
  factory_profile_sha256: string;
}

export interface RequestRecorded {
  replay: boolean;
  request_id: string;
  created_at: string;
}

export interface AcceptRequest {
  budget: CreateBudgetRequest;
  request: RecordRequest;
  /** The message of the `request_accepted` event (event key `request_accepted`, sequence 1). */
  accepted_message: string;
}

export interface RequestAccepted {
  /** True only when the budget, the request and the event all existed with the same content. */
  replay: boolean;
  request_id: string;
  budget_key: string;
  created_at: string;
  seq: number;
}

export type AppendEvent = EventInput & {
  request_id: string;
  /** Deterministic per request; the same key with the same content replays. */
  event_key: string;
};

export interface EventAppended {
  replay: boolean;
  seq: number;
  at: string;
}

export interface StoredRequest {
  request_id: string;
  request_sha256: string;
  interpretation: Interpretation;
  interpretation_sha256: string;
  budget_key: string;
  root_execution_id: string;
  factory_profile_sha256: string;
  created_at: string;
}

export interface StoredStop {
  actor_role: string;
  recorded_at: string;
}

export interface EvidenceSummary {
  case_id: string;
  sha256: string;
  recorded_at: string;
}

export interface StoredValidation {
  validation_id: string;
  request_id: string;
  case_id: string;
  root_execution_id: string;
  recorded_at: string;
  last_heartbeat_at: string | null;
  host_id: HostId;
  /** The first recorded acceptance; a replayed record keeps it. */
  accepted_at: string;
  package_sha256: PackageHashes;
  harness: HarnessIdentity;
  copies: number;
}

export interface RequestRecord {
  request: StoredRequest;
  /** Events with `seq > after`, in order, at most `limit`. */
  events: Event[];
  /** The last returned event's seq, or `after` when none is returned. */
  next_after: number;
  /** The request's latest event seq (0 before any event). */
  last_seq: number;
  last_event_at: string | null;
  /** The latest request heartbeat (validation heartbeats are reported per validation). */
  last_heartbeat_at: string | null;
  stop: StoredStop | null;
  evidence: EvidenceSummary[];
  validations: StoredValidation[];
}

export interface HeartbeatRecorded {
  recorded_at: string;
}

export interface RecordStop {
  request_id: string;
  actor_role: string;
}

export interface StopRecorded {
  replay: boolean;
  recorded_at: string;
}

export interface RecordEvidence {
  request_id: string;
  case_id: string;
  /** SHA-256 of `evidence_json`'s UTF-8 bytes; the database checks it. */
  sha256: string;
  /** The evidence document as exact text: a JSON object. It is stored and returned byte for byte. */
  evidence_json: string;
}

export interface EvidenceRecorded {
  replay: boolean;
  recorded_at: string;
}

export interface StoredEvidence {
  request_id: string;
  case_id: string;
  sha256: string;
  evidence_json: string;
  recorded_at: string;
}

export interface RecordValidation {
  validation_id: string;
  request_id: string;
  case_id: string;
  /** The validation root; never a budget's root. */
  root_execution_id: string;
  /** The case's host. */
  host_id: HostId;
  /**
   * When the start was accepted (UTC, ending in `Z`). Not part of the replay comparison: a start
   * retried after its reservation replays and keeps the first value.
   */
  accepted_at: string;
  /** The hashes of the case's delivered packages. */
  package_sha256: PackageHashes;
  /** The harness the start accepted; `name` is always `rbw-validate`. */
  harness: HarnessIdentity;
  /** The total copies of the validator package's protocol, at least 3. */
  copies: number;
}

export interface ValidationRecorded {
  replay: boolean;
  recorded_at: string;
}

export interface AppendValidationEvent {
  validation_id: string;
  event_key: string;
  /** Lowercase letters, digits and underscores, starting with a letter. */
  type: string;
  data: Record<string, unknown>;
}

export interface ValidationEvent {
  seq: number;
  at: string;
  /** The key the event was appended under. */
  event_key: string;
  type: string;
  data: Record<string, unknown>;
}

export interface ValidationRecord {
  validation: StoredValidation;
  events: ValidationEvent[];
  next_after: number;
  last_seq: number;
}

/** A request event as stored: the contract's `Event` with the key it was appended under. */
export type KeyedEvent = Event & { event_key: string };

export interface RequestEvents {
  /** Events with `seq > after`, in order, at most `limit`. */
  events: KeyedEvent[];
  /** The last returned event's seq, or `after` when none is returned. */
  next_after: number;
  /** The request's latest event seq (0 before any event). */
  last_seq: number;
}

export interface RootOwner {
  root_execution_id: string;
  request_id: string;
  /** Set when the root is a validation run's. */
  validation_id: string | null;
}

export interface FactoryRecords {
  /**
   * Creates the budget, records the request and appends `request_accepted` in one transaction:
   * on any refusal nothing is written. Repeating it with the same content replays.
   */
  acceptRequest(request: AcceptRequest): Promise<Result<RequestAccepted>>;
  recordRequest(request: RecordRequest): Promise<Result<RequestRecorded>>;
  /** The request, its events after `after` (at most `limit`, 1 to 1000), heartbeat, stop, evidence and validations. */
  readRequest(request: { request_id: string; after: number; limit: number }): Promise<Result<RequestRecord>>;
  /**
   * The request's events after `after` (at most `limit`, 1 to 1000), each with its `event_key`, for
   * writers that check which keyed events exist. `readRequest` keeps the contract's `Event` shape.
   */
  readRequestEvents(request: { request_id: string; after: number; limit: number }): Promise<Result<RequestEvents>>;
  /** Appends one event with the next seq; concurrent writers get consecutive numbers. */
  appendEvent(event: AppendEvent): Promise<Result<EventAppended>>;
  /** A worker heartbeat for the request (`validation_id` null) or one of its validation runs. Never an event. */
  recordHeartbeat(request: { request_id: string; validation_id: string | null }): Promise<Result<HeartbeatRecorded>>;
  recordStop(request: RecordStop): Promise<Result<StopRecorded>>;
  recordEvidence(request: RecordEvidence): Promise<Result<EvidenceRecorded>>;
  readEvidence(request: { request_id: string; case_id: string }): Promise<Result<StoredEvidence>>;
  /**
   * Records a validation run with the details of its start. Record it only after its reservation
   * succeeded: a refused run records nothing. A repeat replays when every field but `accepted_at`
   * is the same.
   */
  recordValidation(request: RecordValidation): Promise<Result<ValidationRecorded>>;
  /** A validation run by ID, whatever its request and case, with its events after `after`. */
  readValidation(request: { validation_id: string; after: number; limit: number }): Promise<Result<ValidationRecord>>;
  appendValidationEvent(event: AppendValidationEvent): Promise<Result<EventAppended>>;
  /** The request, or the validation run and its request, whose root this is (for example the factory slot's holder). */
  readRoot(request: { root_execution_id: string }): Promise<Result<RootOwner>>;
}

/** The same options as `createSpend`: the database client, the schema and the clock that supplies record times. */
export interface FactoryRecordsOptions {
  client: SqlClient;
  /** Schema the migrations were applied to. Default `public`. */
  schema?: string;
  /** Source of record times. Default: system time. */
  clock?: () => Date;
}

interface WriteOperations {
  factory_accept_request: [AcceptRequest, RequestAccepted];
  factory_record_request: [RecordRequest, RequestRecorded];
  factory_append_event: [AppendEvent, EventAppended];
  factory_record_heartbeat: [{ request_id: string; validation_id: string | null }, HeartbeatRecorded];
  factory_record_stop: [RecordStop, StopRecorded];
  factory_record_evidence: [RecordEvidence, EvidenceRecorded];
  factory_record_validation: [RecordValidation, ValidationRecorded];
  factory_append_validation_event: [AppendValidationEvent, EventAppended];
}

interface ReadOperations {
  factory_request_read: [{ request_id: string; after: number; limit: number }, RequestRecord];
  factory_request_events_read: [{ request_id: string; after: number; limit: number }, RequestEvents];
  factory_evidence_read: [{ request_id: string; case_id: string }, StoredEvidence];
  factory_validation_read: [{ validation_id: string; after: number; limit: number }, ValidationRecord];
  factory_root_read: [{ root_execution_id: string }, RootOwner];
}

/**
 * Typed wrapper over the factory record functions. Like `createSpend`, every call is one
 * statement, the database decides every outcome, refusals are returned and infrastructure errors
 * are thrown. Nothing retries.
 */
export function createFactoryRecords(options: FactoryRecordsOptions): FactoryRecords {
  // Stored documents (event data, interpretations) come back as stored; only a result's own
  // amounts, such as a refusal's, become bigints.
  const { write, read } = databaseCalls<WriteOperations, ReadOperations>(options, "top-level");

  return {
    acceptRequest: (request) => write("factory_accept_request", request),
    recordRequest: (request) => write("factory_record_request", request),
    readRequest: (request) => read("factory_request_read", request),
    readRequestEvents: (request) => read("factory_request_events_read", request),
    appendEvent: (event) => write("factory_append_event", event),
    recordHeartbeat: (request) => write("factory_record_heartbeat", request),
    recordStop: (request) => write("factory_record_stop", request),
    recordEvidence: (request) => write("factory_record_evidence", request),
    readEvidence: (request) => read("factory_evidence_read", request),
    recordValidation: (request) => write("factory_record_validation", request),
    readValidation: (request) => read("factory_validation_read", request),
    appendValidationEvent: (event) => write("factory_append_validation_event", event),
    readRoot: (request) => read("factory_root_read", request),
  };
}
