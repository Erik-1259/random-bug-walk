// Derived from packages/factory-contract/schema/bug-request-v1.schema.json; regenerate with pnpm --filter @rbw/factory-contract run generate.
// Types and value lists only, with no imports, so client components can import this file.

export const DEF_NAMES = [
  "SafeInteger",
  "NonNegativeInteger",
  "PositiveInteger",
  "MicroUsd",
  "SignedMicroUsd",
  "Uuid",
  "Sha256",
  "GitCommitId",
  "ImageDigest",
  "RelativePath",
  "AbsolutePath",
  "UtcTime",
  "ItemKey",
  "Identifier",
  "Description",
  "Version",
  "ContractVersion",
  "HostId",
  "BugTypeId",
  "ServiceState",
  "ServiceCode",
  "SupportStatus",
  "SourceKind",
  "DifficultyOptionId",
  "ItemDifficultyStatus",
  "DifficultyAssessmentStatus",
  "InterpreterId",
  "QualificationRouteId",
  "PackageKind",
  "PackageFormat",
  "ProblemCode",
  "ProblemSeverity",
  "RequestState",
  "RequestOutcome",
  "StopCode",
  "Delivery",
  "AttentionCode",
  "CandidateStage",
  "CandidateReason",
  "EventType",
  "CheckSet",
  "CopyState",
  "ExpectedOutcome",
  "ObservedOutcome",
  "CaseOrigin",
  "QualificationVerdict",
  "ValidationState",
  "ValidationResult",
  "ErrorCode",
  "BusyReason",
  "TestScenario",
  "TestOperationKind",
  "TestOperationState",
  "TestSlotKey",
  "TestProvider",
  "TestProviderAction",
  "CopyRecordStatus",
  "CopyRunOutcome",
  "Architecture",
  "RepairKind",
  "EmptyObject",
  "Capabilities",
  "ServiceStatus",
  "Host",
  "BugType",
  "Criterion",
  "Combination",
  "SourceSummary",
  "DifficultyOption",
  "Limits",
  "InterpreterCapability",
  "InterpreterIdentity",
  "QualificationRoute",
  "PackageFormats",
  "RequestInput",
  "RequestItemInput",
  "NormalizedRequestInput",
  "NormalizedRequestItemInput",
  "Interpretation",
  "InterpretedItem",
  "ItemDifficulty",
  "InterpretedCriterion",
  "EligibleSource",
  "TypeQuantity",
  "InterpretationHost",
  "InterpretationBudget",
  "HostAmount",
  "InterpretationLimits",
  "Problem",
  "StartRequest",
  "RequestStatus",
  "StopReason",
  "Attention",
  "RequestBudget",
  "RequestLimits",
  "Funnel",
  "ItemProgress",
  "TypeProgress",
  "Candidate",
  "CandidateReasonDetail",
  "Event",
  "EmptyDataEvent",
  "HostEvent",
  "CandidateSelectedEvent",
  "CheckFinishedEvent",
  "CriteriaPassedEvent",
  "CandidateEndedEvent",
  "PackageReadyEvent",
  "SourceExhaustedEvent",
  "BudgetUpdatedEvent",
  "AttentionEvent",
  "RequestFinishedEvent",
  "ValidationStartedEvent",
  "ValidationFinishedEvent",
  "HostEventData",
  "CandidateSelectedData",
  "CheckFinishedData",
  "CriteriaPassedData",
  "CandidateEndedData",
  "PackageReadyData",
  "SourceExhaustedData",
  "BudgetUpdatedData",
  "AttentionEventData",
  "RequestFinishedData",
  "ValidationStartedData",
  "ValidationFinishedData",
  "Case",
  "CriterionSummary",
  "CaseSummary",
  "CaseMatrix",
  "CaseOriginalSuite",
  "CaseVerification",
  "Cell",
  "Repetition",
  "CaseDifficulty",
  "CaseQualification",
  "Packages",
  "PackagePart",
  "Provenance",
  "ValidationRun",
  "ValidationMatrix",
  "CellSet",
  "PackageHashes",
  "HarnessIdentity",
  "ValidationStartRequest",
  "StopRequest",
  "ErrorResponse",
  "ErrorBody",
  "BusyErrorDetails",
  "InterpretationErrorDetails",
  "SessionRequest",
  "SessionStatus",
  "ExampleResponse",
  "TestEvidence",
  "TestOperation",
  "TestSlot",
  "TestProviderCall",
  "TestReconcileRequest",
  "TestResetRequest",
  "TestResetResponse",
  "BaselineIdentity",
  "OriginalSuiteIdentity",
  "CatalogEntry",
  "CatalogPresentation",
  "CriterionRef",
  "PlantedChange",
  "PlantTarget",
  "ReferenceRepair",
  "FileDigest",
  "VerificationIdentity",
  "KitEnvironment",
  "Protocol",
  "ProtocolStates",
  "ProtocolState",
  "FileSet",
  "BugCaseInputs",
  "BugCaseRuntime",
  "ValidatorInputs",
  "ExpectedMatrix",
  "ExpectedCells",
  "PatchText",
  "UnpackedPair",
  "CopyTrees",
  "DifficultyAssessment",
  "CopyPlan",
  "ImagePin",
  "CopyDestinations",
  "CopyLimits",
  "CopyRoots",
  "CollectedCopy",
  "CellObservation",
  "SuiteObservation",
  "CopyRecord",
  "QualificationRecord",
  "QualificationCells",
  "QualificationCellSet",
  "QualificationCell",
  "CriterionMatch",
  "ExportVerification",
] as const;
export type DefName = (typeof DEF_NAMES)[number];

/** An integer whose absolute value is at most 2^53 - 1. */
export type SafeInteger = number;

export type NonNegativeInteger = number;

export type PositiveInteger = number;

/** Money in integer micro-US-dollars (contract section 3), never negative. 1500000 is $1.50. */
export type MicroUsd = NonNegativeInteger;

/** Money in integer micro-US-dollars that is negative only on an overrun (contract section 8.5). */
export type SignedMicroUsd = SafeInteger;

/** Lowercase 8-4-4-4-12 hexadecimal, chosen by the client. */
export type Uuid = string;

/** Exactly 64 lowercase hexadecimal characters. */
export type Sha256 = string;

/** A full 40-character lowercase Git commit ID. */
export type GitCommitId = string;

/** An OCI image digest. */
export type ImageDigest = string;

/** A relative POSIX path: segments joined by '/', with no leading or trailing '/', no empty, '.' or '..' segment, and no backslash or control character. Any other character is allowed, so source paths such as 'src/app/(main)/[id]/page.tsx' and dotfiles such as '.gitignore' are valid. */
export type RelativePath = string;

/** An absolute POSIX path inside a copy: '/' and then segments joined by '/', with no trailing '/', no empty, '.' or '..' segment, and no backslash or control character. */
export type AbsolutePath = string;

/** UTC ISO 8601 time with milliseconds and Z (contract section 3). The format adds the calendar check (no 2026-02-30, no second 60). */
export type UtcTime = string;

/** Chosen by the client and unique within a request (uniqueness is not checked by the schema). */
export type ItemKey = string;

/** A non-empty identifier declared by the service, a host or a source, such as a baseline, source, entry, criterion, suite, check set, protocol or copy ID. */
export type Identifier = string;

/** A normalized request description: plain-language text with no leading or trailing white space, as String.prototype.trim leaves it, and never empty (contract section 6). */
export type Description = string;

/** A non-empty version label, such as "1". */
export type Version = string;

/** Carried by every response body. */
export const CONTRACT_VERSION_VALUES = ["bug-request/1"] as const;
export type ContractVersion = (typeof CONTRACT_VERSION_VALUES)[number];

export const HOST_ID_VALUES = ["umami", "task-report"] as const;
export type HostId = (typeof HOST_ID_VALUES)[number];

export const BUG_TYPE_ID_VALUES = ["concurrency", "date_time"] as const;
export type BugTypeId = (typeof BUG_TYPE_ID_VALUES)[number];

export const SERVICE_STATE_VALUES = ["available", "unavailable"] as const;
export type ServiceState = (typeof SERVICE_STATE_VALUES)[number];

export const SERVICE_CODE_VALUES = ["not_configured", "halted", "maintenance"] as const;
export type ServiceCode = (typeof SERVICE_CODE_VALUES)[number];

export const SUPPORT_STATUS_VALUES = ["supported", "unsupported"] as const;
export type SupportStatus = (typeof SUPPORT_STATUS_VALUES)[number];

export const SOURCE_KIND_VALUES = ["finite_recipe_catalog"] as const;
export type SourceKind = (typeof SOURCE_KIND_VALUES)[number];

export const DIFFICULTY_OPTION_ID_VALUES = ["source_inferable_allowed", "source_only_difficulty_required"] as const;
export type DifficultyOptionId = (typeof DIFFICULTY_OPTION_ID_VALUES)[number];

export const ITEM_DIFFICULTY_STATUS_VALUES = ["not_required", "unsupported"] as const;
export type ItemDifficultyStatus = (typeof ITEM_DIFFICULTY_STATUS_VALUES)[number];

export const DIFFICULTY_ASSESSMENT_STATUS_VALUES = ["not_assessed"] as const;
export type DifficultyAssessmentStatus = (typeof DIFFICULTY_ASSESSMENT_STATUS_VALUES)[number];

export const INTERPRETER_ID_VALUES = ["criteria-match"] as const;
export type InterpreterId = (typeof INTERPRETER_ID_VALUES)[number];

export const QUALIFICATION_ROUTE_ID_VALUES = ["behavioral-qualification"] as const;
export type QualificationRouteId = (typeof QUALIFICATION_ROUTE_ID_VALUES)[number];

export const PACKAGE_KIND_VALUES = ["bug_case", "validator"] as const;
export type PackageKind = (typeof PACKAGE_KIND_VALUES)[number];

export const PACKAGE_FORMAT_VALUES = ["rbw-bug-case/1", "rbw-validator/1"] as const;
export type PackageFormat = (typeof PACKAGE_FORMAT_VALUES)[number];

/** Contract section 6.2. */
export const PROBLEM_CODE_VALUES = ["unsupported_combination", "unrecognized_description", "no_matching_source", "unsupported_difficulty", "budget_below_minimum", "budget_below_item_minimum", "quantity_exceeds_source", "host_unused"] as const;
export type ProblemCode = (typeof PROBLEM_CODE_VALUES)[number];

export const PROBLEM_SEVERITY_VALUES = ["blocking", "warning"] as const;
export type ProblemSeverity = (typeof PROBLEM_SEVERITY_VALUES)[number];

export const REQUEST_STATE_VALUES = ["queued", "starting", "running", "stopping", "finished"] as const;
export type RequestState = (typeof REQUEST_STATE_VALUES)[number];

/** Contract section 8.1. */
export const REQUEST_OUTCOME_VALUES = ["fulfilled", "stopped_at_limit", "sources_exhausted", "cancelled", "operational_error"] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOME_VALUES)[number];

/** Contract section 8.1. */
export const STOP_CODE_VALUES = ["fulfilled", "budget_exhausted", "time_limit", "candidate_limit", "sources_exhausted", "cancelled_by_user", "worker_lost", "needs_reconciliation", "operational_error"] as const;
export type StopCode = (typeof STOP_CODE_VALUES)[number];

export const DELIVERY_VALUES = ["none", "partial", "complete"] as const;
export type Delivery = (typeof DELIVERY_VALUES)[number];

export const ATTENTION_CODE_VALUES = ["needs_reconciliation", "worker_unresponsive"] as const;
export type AttentionCode = (typeof ATTENTION_CODE_VALUES)[number];

export const CANDIDATE_STAGE_VALUES = ["selected", "preparing", "checking", "behavior_checks_passed", "requested_criteria_passed", "packaging", "qualified", "rejected", "invalid", "incomplete", "skipped"] as const;
export type CandidateStage = (typeof CANDIDATE_STAGE_VALUES)[number];

/** Contract section 8.3. */
export const CANDIDATE_REASON_VALUES = ["original_suite_failed_clean", "original_suite_caught_bug", "original_suite_failed_fixed", "checks_failed_clean", "checks_failed_fixed", "bug_not_detected", "wrong_failure", "export_mismatch", "setup_failed", "incomplete_run", "stopped", "duplicate_defect", "no_budget_for_candidate"] as const;
export type CandidateReason = (typeof CANDIDATE_REASON_VALUES)[number];

/** Contract section 8.4. */
export const EVENT_TYPE_VALUES = ["request_accepted", "worker_started", "host_preparing", "host_ready", "candidate_selected", "check_finished", "behavior_checks_passed", "requested_criteria_passed", "candidate_rejected", "candidate_invalid", "candidate_incomplete", "candidate_skipped", "package_ready", "case_delivered", "source_exhausted", "budget_updated", "stop_requested", "attention", "attention_cleared", "request_finished", "validation_started", "validation_finished"] as const;
export type EventType = (typeof EVENT_TYPE_VALUES)[number];

export const CHECK_SET_VALUES = ["original_suite", "verification"] as const;
export type CheckSet = (typeof CHECK_SET_VALUES)[number];

export const COPY_STATE_VALUES = ["clean", "buggy", "fixed"] as const;
export type CopyState = (typeof COPY_STATE_VALUES)[number];

export const EXPECTED_OUTCOME_VALUES = ["pass", "fail"] as const;
export type ExpectedOutcome = (typeof EXPECTED_OUTCOME_VALUES)[number];

export const OBSERVED_OUTCOME_VALUES = ["pass", "fail", "error", "incomplete"] as const;
export type ObservedOutcome = (typeof OBSERVED_OUTCOME_VALUES)[number];

export const CASE_ORIGIN_VALUES = ["live_request", "published_example"] as const;
export type CaseOrigin = (typeof CASE_ORIGIN_VALUES)[number];

export const QUALIFICATION_VERDICT_VALUES = ["accepted", "rejected", "invalid", "incomplete"] as const;
export type QualificationVerdict = (typeof QUALIFICATION_VERDICT_VALUES)[number];

export const VALIDATION_STATE_VALUES = ["queued", "running", "finished"] as const;
export type ValidationState = (typeof VALIDATION_STATE_VALUES)[number];

export const VALIDATION_RESULT_VALUES = ["passed", "failed", "error"] as const;
export type ValidationResult = (typeof VALIDATION_RESULT_VALUES)[number];

/** Contract section 12. */
export const ERROR_CODE_VALUES = ["invalid_request", "unauthorized", "passcode_incorrect", "not_found", "idempotency_conflict", "interpretation_stale", "busy", "budget_unavailable", "unsupported_request", "unavailable"] as const;
export type ErrorCode = (typeof ERROR_CODE_VALUES)[number];

export const BUSY_REASON_VALUES = ["active", "needs_reconciliation"] as const;
export type BusyReason = (typeof BUSY_REASON_VALUES)[number];

/** A test-mode scenario (contract section 15.1). */
export const TEST_SCENARIO_VALUES = ["two-host-fulfilled", "partial-budget", "sources-exhausted", "duplicate-defect", "zero-result", "wrong-failure", "cancel-midway", "worker-lost", "uncertain-provider", "validation-failed", "validation-error", "setup-failed"] as const;
export type TestScenario = (typeof TEST_SCENARIO_VALUES)[number];

export const TEST_OPERATION_KIND_VALUES = ["worker", "candidate_copy", "validation", "validation_copy"] as const;
export type TestOperationKind = (typeof TEST_OPERATION_KIND_VALUES)[number];

export const TEST_OPERATION_STATE_VALUES = ["prepared", "launching", "running", "terminal", "uncertain", "reconciled"] as const;
export type TestOperationState = (typeof TEST_OPERATION_STATE_VALUES)[number];

export const TEST_SLOT_KEY_VALUES = ["factory"] as const;
export type TestSlotKey = (typeof TEST_SLOT_KEY_VALUES)[number];

export const TEST_PROVIDER_VALUES = ["sandbox"] as const;
export type TestProvider = (typeof TEST_PROVIDER_VALUES)[number];

export const TEST_PROVIDER_ACTION_VALUES = ["create", "stop"] as const;
export type TestProviderAction = (typeof TEST_PROVIDER_ACTION_VALUES)[number];

export const COPY_RECORD_STATUS_VALUES = ["complete", "invalid", "incomplete"] as const;
export type CopyRecordStatus = (typeof COPY_RECORD_STATUS_VALUES)[number];

/** How a runner's copy ended: ran (the command ran), setup_failed (the copy could not be set up, for example a file whose sha256 does not match) or timed_out (the command passed its time limit). */
export const COPY_RUN_OUTCOME_VALUES = ["ran", "setup_failed", "timed_out"] as const;
export type CopyRunOutcome = (typeof COPY_RUN_OUTCOME_VALUES)[number];

export const ARCHITECTURE_VALUES = ["amd64", "arm64"] as const;
export type Architecture = (typeof ARCHITECTURE_VALUES)[number];

export const REPAIR_KIND_VALUES = ["revert", "independent"] as const;
export type RepairKind = (typeof REPAIR_KIND_VALUES)[number];

/** An object with no fields: {}. */
export type EmptyObject = Record<string, never>;

/** GET /api/factory/capabilities (contract section 4). */
export interface Capabilities {
  contract_version: ContractVersion;
  service: ServiceStatus;
  /** Every HostId appears exactly once: clients build the form from this list and never hard-code hosts (contract section 4). */
  hosts: Host[];
  /** Every BugTypeId appears exactly once: clients build the form from this list and never hard-code bug types (contract section 4). */
  bug_types: BugType[];
  /** Every (host, bug type) pair of HostId and BugTypeId appears exactly once (contract section 4.2). */
  combinations: Combination[];
  /** Every DifficultyOptionId appears exactly once: source_inferable_allowed is the available default and source_only_difficulty_required is listed as unavailable (contract section 4.4). */
  difficulty_options: DifficultyOption[];
  limits: Limits;
  interpreter: InterpreterCapability;
  qualification_route: QualificationRoute;
  package_formats: PackageFormats;
}

export interface ServiceStatus {
  state: ServiceState;
  code: ServiceCode | null;
  message: string | null;
}

export interface Host {
  host_id: HostId;
  label: string;
  description: string;
  /** The pinned application revision, such as umami@ec0ff503. */
  baseline_id: Identifier;
}

export interface BugType {
  bug_type_id: BugTypeId;
  label: string;
  description: string;
  criteria: Criterion[];
}

/** A versioned criterion of a bug type. Its example phrases are matched exactly (contract section 6.1), and its failure code is published per criterion version (section 6.3). */
export interface Criterion {
  criterion_id: Identifier;
  version: Version;
  label: string;
  description: string;
  /** Matched exactly, as word sequences (contract section 6.1). */
  example_phrases: string[];
  /** What the verification checks report on the buggy copy when a candidate demonstrates this criterion (contract section 6.3). */
  failure_code: Identifier;
}

/** Supported means a declared source with at least one entry exists and its verification checks are implemented (contract section 4.2). */
export interface Combination {
  host_id: HostId;
  bug_type_id: BugTypeId;
  status: SupportStatus;
  /** Why the pair is unsupported (the host's availability reason when no entry is available over the planned window); null when supported (contract section 4.2). */
  reason: string | null;
  /** The declared source; set when supported. */
  source: SourceSummary | null;
}

export interface SourceSummary {
  source_id: Identifier;
  kind: SourceKind;
  catalog_version: Version;
  /** The number of catalog entries available over the planned window [now, now + max_wall_clock_s], by the host's availability; at least 1 for a supported pair (contract section 4.2). */
  entries: NonNegativeInteger;
  /** The criteria that the entries available over the planned window target (contract section 4.2). */
  criteria_ids: Identifier[];
  description: string;
}

/** Source-inferable difficulty is the default and always available; source-only difficulty is unavailable, not the default, and gives a reason (contract section 4.4). */
export interface DifficultyOption {
  option_id: DifficultyOptionId;
  label: string;
  default: boolean;
  available: boolean;
  reason: string | null;
}

/** Service configuration; clients read limits here and never hard-code them (contract section 4.3). */
export interface Limits {
  max_items: NonNegativeInteger;
  max_quantity_per_item: NonNegativeInteger;
  max_total_quantity: NonNegativeInteger;
  /** Counted in Unicode code points after trimming (contract section 5). */
  max_description_chars: NonNegativeInteger;
  budget_presets_microusd: MicroUsd[];
  default_budget_microusd: MicroUsd;
  min_budget_microusd: MicroUsd;
  max_budget_microusd: MicroUsd;
  max_wall_clock_s: NonNegativeInteger;
  max_candidates: NonNegativeInteger;
}

export interface InterpreterCapability {
  interpreter_id: InterpreterId;
  version: Version;
  criteria_catalog_version: Version;
  /** Versioned with criteria_catalog_version (contract section 6.1). */
  filler_phrases: string[];
}

export interface InterpreterIdentity {
  interpreter_id: InterpreterId;
  version: Version;
  criteria_catalog_version: Version;
}

export interface QualificationRoute {
  route_id: QualificationRouteId;
  version: Version;
}

export interface PackageFormats {
  bug_case: "rbw-bug-case/1";
  validator: "rbw-validator/1";
}

/** The body of POST /api/factory/interpretations and the input of a start (contract section 5). Limits from Capabilities are checked by the service, not the schema. */
export interface RequestInput {
  /** One or two hosts, no repeats. */
  hosts: HostId[];
  /** At least one item; at most limits.max_items. */
  items: RequestItemInput[];
  /** Shared by every host and item; within the limits' budget range. */
  budget_microusd: MicroUsd;
}

/** One item of a RequestInput, as the client sends it. */
export interface RequestItemInput {
  item_key: ItemKey;
  bug_type_id: BugTypeId;
  /** At most limits.max_quantity_per_item. */
  quantity: PositiveInteger;
  /** Any text or null. The service trims it and maps an empty result to null (contract section 6); at most limits.max_description_chars Unicode code points after trimming. */
  description: string | null;
  difficulty: DifficultyOptionId;
}

/** The normalized form of a RequestInput: each description trimmed, and null when nothing is left (contract section 6). Interpretation.input carries it. */
export interface NormalizedRequestInput {
  /** One or two hosts, no repeats. */
  hosts: HostId[];
  /** At least one item; at most limits.max_items. */
  items: NormalizedRequestItemInput[];
  /** Shared by every host and item; within the limits' budget range. */
  budget_microusd: MicroUsd;
}

/** One item of a NormalizedRequestInput. */
export interface NormalizedRequestItemInput {
  item_key: ItemKey;
  bug_type_id: BugTypeId;
  /** At most limits.max_quantity_per_item. */
  quantity: PositiveInteger;
  /** Trimmed and non-empty, or null. */
  description: Description | null;
  difficulty: DifficultyOptionId;
}

/** The answer of POST /api/factory/interpretations (contract section 6). */
export interface Interpretation {
  contract_version: ContractVersion;
  /** Canonical hash of the normalized input, the interpreter, catalog, route and source versions, the factory profile and the availability result for the planned window, not the raw time (contract section 6.1). */
  interpretation_sha256: Sha256;
  interpreter: InterpreterIdentity;
  qualification_route: QualificationRoute;
  /** The normalized input actually interpreted (contract section 6). */
  input: NormalizedRequestInput;
  /** True only when no problem has severity blocking. */
  startable: boolean;
  /** Each input item interpreted, so at least one (contract section 6). */
  items: InterpretedItem[];
  /** At most one total per bug type. A requested type's total is the sum of its items' quantities, so it is listed and at least 1; a type no item requests has 0 if it is listed (contract section 5). */
  type_totals: TypeQuantity[];
  hosts: InterpretationHost[];
  budget: InterpretationBudget;
  limits: InterpretationLimits;
  /** Request-level problems, so none has an item. */
  problems: Problem[];
}

export interface InterpretedItem {
  item_key: ItemKey;
  bug_type_id: BugTypeId;
  quantity: PositiveInteger;
  /** The normalized description, kept verbatim (contract section 6.1). */
  description: Description | null;
  difficulty: ItemDifficulty;
  /** Empty when the item has no description (contract section 6.1). */
  criteria: InterpretedCriterion[];
  /** Each maximal run of words that no criterion or filler phrase covers, from its first word to its last, so an entry starts and ends with a letter or digit; empty when the item has no description. Any entry makes the item unsupported with unrecognized_description, and that problem needs an entry (contract section 6.1). */
  unmatched_text: string[];
  /** Sources on the selected hosts, at most one per host, and at least one when the item is supported. An item has none exactly when it carries unsupported_combination or no_matching_source (contract section 6.2). */
  eligible_sources: EligibleSource[];
  /** Unsupported exactly when the item has a blocking problem; an item that requires source-only difficulty or has unmatched text is unsupported. */
  status: SupportStatus;
  /** The item's own problems, so each names an item; request-level problems belong to Interpretation.problems. */
  problems: Problem[];
}

/** An item that requires source-only difficulty is unsupported, never downgraded (contract section 4.4). */
export interface ItemDifficulty {
  requested: DifficultyOptionId;
  status: ItemDifficultyStatus;
}

export interface InterpretedCriterion {
  criterion_id: Identifier;
  version: Version;
  label: string;
  matched_text: string | null;
}

export interface EligibleSource {
  host_id: HostId;
  source_id: Identifier;
  /** The number of the source's catalog entries available over the planned window that satisfy the item's criteria (contract sections 4.2 and 6). */
  entries: PositiveInteger;
}

export interface TypeQuantity {
  bug_type_id: BugTypeId;
  quantity: NonNegativeInteger;
}

export interface InterpretationHost {
  host_id: HostId;
  used: boolean;
  reason: string | null;
}

export interface InterpretationBudget {
  budget_microusd: MicroUsd;
  worker_worst_case_microusd: MicroUsd;
  /** At most one entry per host. */
  worst_case_per_candidate_microusd: HostAmount[];
  /** At most one entry per host. A startable interpretation, the kind a request freezes, has one for each host that a supported item draws from, since a validation run reserves the worst case of its case's host from the frozen interpretation (contract section 11). */
  worst_case_per_validation_microusd: HostAmount[];
  estimate_note: string;
}

export interface HostAmount {
  host_id: HostId;
  microusd: MicroUsd;
}

export interface InterpretationLimits {
  max_wall_clock_s: NonNegativeInteger;
  max_candidates: NonNegativeInteger;
}

export interface Problem {
  code: ProblemCode;
  /** Fixed by the code (contract section 6.2). */
  severity: ProblemSeverity;
  message: string;
  /** Null for the request-level budget_below_minimum; set for every item-level code (contract section 6.2). */
  item_key: ItemKey | null;
}

/** The body of POST /api/factory/requests (contract section 7). */
export interface StartRequest {
  request_id: Uuid;
  /** As the client sends it; the canonical body holds its normalized form (contract section 7). */
  input: RequestInput;
  interpretation_sha256: Sha256;
}

/** GET /api/factory/requests/{request_id} (contract section 8). */
export interface RequestStatus {
  contract_version: ContractVersion;
  request_id: Uuid;
  created_at: UtcTime;
  updated_at: UtcTime;
  state: RequestState;
  /** Set only in state finished. */
  outcome: RequestOutcome | null;
  /** Set only in state finished; its code belongs to the outcome. */
  stop_reason: StopReason | null;
  /** Derived from the counts: complete when nothing is missing, none when no case was delivered; a fulfilled outcome always has complete. */
  delivery: Delivery;
  attention: Attention | null;
  /** Frozen at start; always startable. */
  interpretation: Interpretation;
  budget: RequestBudget;
  limits: RequestLimits;
  funnel: Funnel;
  /** Each request item, so at least one. */
  items: ItemProgress[];
  /** At most one total per bug type. A requested type is listed with requested at least 1; a type no item requests has requested 0 if it is listed (contract section 5). */
  type_totals: TypeProgress[];
  candidates: Candidate[];
  /** Qualified cases of this request only; empty exactly when delivery is none. */
  cases: Case[];
  /** Up to 200 events with seq greater than the after parameter. Event 1 is request_accepted. A request_finished event, at most one, names the outcome and stop code and appears only in state finished; a stop_requested event, at most one, only in states stopping and finished; validation events only in state finished. */
  events: Event[];
  /** The seq of the last event returned, or the after parameter when none is; at least 1, since event 1 always exists. */
  next_after: PositiveInteger;
  last_heartbeat_at: UtcTime | null;
  poll_after_ms: NonNegativeInteger;
}

export interface StopReason {
  code: StopCode;
  message: string;
}

export interface Attention {
  code: AttentionCode;
  message: string;
}

/** Contract section 8.5. Beyond the sign of remaining_microusd, the arithmetic between the fields is not checked by the schema. */
export interface RequestBudget {
  budget_microusd: MicroUsd;
  reserved_microusd: MicroUsd;
  spent_microusd: MicroUsd;
  /** reserved_microusd + spent_microusd. */
  committed_microusd: MicroUsd;
  /** budget_microusd - committed_microusd; negative only on an overrun. */
  remaining_microusd: SignedMicroUsd;
  /** True when committed_microusd exceeds budget_microusd. */
  overrun: boolean;
}

export interface RequestLimits {
  max_wall_clock_s: NonNegativeInteger;
  deadline_at: UtcTime;
  max_candidates: NonNegativeInteger;
  candidates_started: NonNegativeInteger;
}

/** Distinct candidates in this request (contract section 8.2). */
export interface Funnel {
  candidates_explored: NonNegativeInteger;
  behavior_checks_passed: NonNegativeInteger;
  requested_criteria_passed: NonNegativeInteger;
  packages_ready: NonNegativeInteger;
}

export interface ItemProgress {
  item_key: ItemKey;
  bug_type_id: BugTypeId;
  /** The normalized description of the item. */
  description: Description | null;
  /** The item's quantity, so at least 1. */
  requested: PositiveInteger;
  delivered: NonNegativeInteger;
  missing: NonNegativeInteger;
  /** The delivered cases that fill the item, each listed once; empty exactly when delivered is 0. */
  case_ids: Sha256[];
}

export interface TypeProgress {
  bug_type_id: BugTypeId;
  requested: NonNegativeInteger;
  delivered: NonNegativeInteger;
  missing: NonNegativeInteger;
}

export interface Candidate {
  /** Canonical hash of source_id, catalog_version and entry_id; unique within a request. */
  candidate_id: Sha256;
  /** The planted change (contract section 10.4). */
  defect_id: Sha256;
  host_id: HostId;
  bug_type_id: BugTypeId;
  source_id: Identifier;
  entry_id: Identifier;
  stage: CandidateStage;
  /** Set exactly for the stages rejected, invalid, incomplete and skipped, with a reason of that stage (contract section 8.3). */
  reason: CandidateReasonDetail | null;
  /** Set at requested_criteria_passed, when the candidate is assigned to an item; null for a candidate whose cells did not match in export verification (the original-suite and check reasons and bug_not_detected), one that fits no item (wrong_failure) and one skipped before it runs (duplicate_defect, no_budget_for_candidate). */
  item_key: ItemKey | null;
  /** Set exactly in stage qualified: only a qualified candidate becomes a case (contract sections 10 and 10.5). */
  case_id: Sha256 | null;
  started_at: UtcTime | null;
  finished_at: UtcTime | null;
}

export interface CandidateReasonDetail {
  code: CandidateReason;
  message: string;
}

/** One event of a request, discriminated by type (contract section 8.4). Events are append-only. */
export type Event = EmptyDataEvent | HostEvent | CandidateSelectedEvent | CheckFinishedEvent | CriteriaPassedEvent | CandidateEndedEvent | PackageReadyEvent | SourceExhaustedEvent | BudgetUpdatedEvent | AttentionEvent | RequestFinishedEvent | ValidationStartedEvent | ValidationFinishedEvent;

/** An event whose data is {}. */
export interface EmptyDataEvent {
  /** Numbered from 1 with no gaps. */
  seq: PositiveInteger;
  at: UtcTime;
  type: "request_accepted" | "worker_started" | "behavior_checks_passed" | "case_delivered" | "stop_requested";
  host_id: HostId | null;
  candidate_id: Sha256 | null;
  item_key: ItemKey | null;
  case_id: Sha256 | null;
  message: string;
  data: EmptyObject;
}

export interface HostEvent {
  /** Numbered from 1 with no gaps. */
  seq: PositiveInteger;
  at: UtcTime;
  type: "host_preparing" | "host_ready";
  host_id: HostId | null;
  candidate_id: Sha256 | null;
  item_key: ItemKey | null;
  case_id: Sha256 | null;
  message: string;
  data: HostEventData;
}

export interface CandidateSelectedEvent {
  /** Numbered from 1 with no gaps. */
  seq: PositiveInteger;
  at: UtcTime;
  type: "candidate_selected";
  host_id: HostId | null;
  candidate_id: Sha256 | null;
  item_key: ItemKey | null;
  case_id: Sha256 | null;
  message: string;
  data: CandidateSelectedData;
}

export interface CheckFinishedEvent {
  /** Numbered from 1 with no gaps. */
  seq: PositiveInteger;
  at: UtcTime;
  type: "check_finished";
  host_id: HostId | null;
  candidate_id: Sha256 | null;
  item_key: ItemKey | null;
  case_id: Sha256 | null;
  message: string;
  data: CheckFinishedData;
}

export interface CriteriaPassedEvent {
  /** Numbered from 1 with no gaps. */
  seq: PositiveInteger;
  at: UtcTime;
  type: "requested_criteria_passed";
  host_id: HostId | null;
  candidate_id: Sha256 | null;
  item_key: ItemKey | null;
  case_id: Sha256 | null;
  message: string;
  data: CriteriaPassedData;
}

/** The reason belongs to the stage the type names (contract section 8.3). */
export interface CandidateEndedEvent {
  /** Numbered from 1 with no gaps. */
  seq: PositiveInteger;
  at: UtcTime;
  type: "candidate_rejected" | "candidate_invalid" | "candidate_incomplete" | "candidate_skipped";
  host_id: HostId | null;
  candidate_id: Sha256 | null;
  item_key: ItemKey | null;
  case_id: Sha256 | null;
  message: string;
  data: CandidateEndedData;
}

export interface PackageReadyEvent {
  /** Numbered from 1 with no gaps. */
  seq: PositiveInteger;
  at: UtcTime;
  type: "package_ready";
  host_id: HostId | null;
  candidate_id: Sha256 | null;
  item_key: ItemKey | null;
  case_id: Sha256 | null;
  message: string;
  data: PackageReadyData;
}

export interface SourceExhaustedEvent {
  /** Numbered from 1 with no gaps. */
  seq: PositiveInteger;
  at: UtcTime;
  type: "source_exhausted";
  host_id: HostId | null;
  candidate_id: Sha256 | null;
  item_key: ItemKey | null;
  case_id: Sha256 | null;
  message: string;
  data: SourceExhaustedData;
}

export interface BudgetUpdatedEvent {
  /** Numbered from 1 with no gaps. */
  seq: PositiveInteger;
  at: UtcTime;
  type: "budget_updated";
  host_id: HostId | null;
  candidate_id: Sha256 | null;
  item_key: ItemKey | null;
  case_id: Sha256 | null;
  message: string;
  data: BudgetUpdatedData;
}

export interface AttentionEvent {
  /** Numbered from 1 with no gaps. */
  seq: PositiveInteger;
  at: UtcTime;
  type: "attention" | "attention_cleared";
  host_id: HostId | null;
  candidate_id: Sha256 | null;
  item_key: ItemKey | null;
  case_id: Sha256 | null;
  message: string;
  data: AttentionEventData;
}

export interface RequestFinishedEvent {
  /** Numbered from 1 with no gaps. */
  seq: PositiveInteger;
  at: UtcTime;
  type: "request_finished";
  host_id: HostId | null;
  candidate_id: Sha256 | null;
  item_key: ItemKey | null;
  case_id: Sha256 | null;
  message: string;
  data: RequestFinishedData;
}

export interface ValidationStartedEvent {
  /** Numbered from 1 with no gaps. */
  seq: PositiveInteger;
  at: UtcTime;
  type: "validation_started";
  host_id: HostId | null;
  candidate_id: Sha256 | null;
  item_key: ItemKey | null;
  case_id: Sha256 | null;
  message: string;
  data: ValidationStartedData;
}

export interface ValidationFinishedEvent {
  /** Numbered from 1 with no gaps. */
  seq: PositiveInteger;
  at: UtcTime;
  type: "validation_finished";
  host_id: HostId | null;
  candidate_id: Sha256 | null;
  item_key: ItemKey | null;
  case_id: Sha256 | null;
  message: string;
  data: ValidationFinishedData;
}

export interface HostEventData {
  baseline_id: Identifier;
}

export interface CandidateSelectedData {
  source_id: Identifier;
  entry_id: Identifier;
}

export interface CheckFinishedData {
  check_set: CheckSet;
  copy: CopyState;
  outcome: ObservedOutcome;
  runs_valid: NonNegativeInteger;
  runs_total: NonNegativeInteger;
}

export interface CriteriaPassedData {
  /** The criteria the candidate demonstrated, which become its case's criteria_met: at least one, each once (contract sections 6.3 and 8.4). */
  criterion_ids: Identifier[];
}

export interface CandidateEndedData {
  reason: CandidateReason;
}

export interface PackageReadyData {
  bug_case_sha256: Sha256;
  validator_sha256: Sha256;
}

export interface SourceExhaustedData {
  bug_type_id: BugTypeId;
  source_id: Identifier;
}

export interface BudgetUpdatedData {
  reserved_microusd: MicroUsd;
  spent_microusd: MicroUsd;
  remaining_microusd: SignedMicroUsd;
}

export interface AttentionEventData {
  code: AttentionCode;
}

export interface RequestFinishedData {
  outcome: RequestOutcome;
  /** Belongs to the outcome (contract section 8.1). */
  stop_code: StopCode;
}

export interface ValidationStartedData {
  validation_id: Uuid;
}

export interface ValidationFinishedData {
  validation_id: Uuid;
  result: ValidationResult;
}

/** A qualified case (contract section 10). It never carries answer-bearing material (section 10.1). */
export interface Case {
  case_id: Sha256;
  defect_id: Sha256;
  /** Short plain-language name of the observed failure. */
  title: string;
  host_id: HostId;
  host_label: string;
  baseline_id: Identifier;
  bug_type_id: BugTypeId;
  /** The request item it fills; null for the completed example. */
  item_key: ItemKey | null;
  /** Criteria the case demonstrated in export verification; at least one (contract section 6.3). */
  criteria_met: CriterionSummary[];
  summary: CaseSummary;
  matrix: CaseMatrix;
  repetition: Repetition;
  difficulty: CaseDifficulty;
  qualification: CaseQualification;
  packages: Packages;
  /** The latest user-started validation run, if any. A run takes the slot that the request holds until it finishes, so a case has none before its request is finished. */
  validation: ValidationRun | null;
  provenance: Provenance;
}

export interface CriterionSummary {
  criterion_id: Identifier;
  version: Version;
  label: string;
}

export interface CaseSummary {
  observed_failure: string;
  how_checked: string;
}

/** The six cells of a qualified case: every cell matched its expectation. */
export interface CaseMatrix {
  original_suite: CaseOriginalSuite;
  verification: CaseVerification;
}

/** The unchanged original suite passes on all three copies. */
export interface CaseOriginalSuite {
  suite_id: Identifier;
  suite_sha256: Sha256;
  test_count: NonNegativeInteger;
  clean: Cell;
  buggy: Cell;
  fixed: Cell;
}

/** The verification checks pass on the clean and fixed copies and detect the failure on the buggy copy. */
export interface CaseVerification {
  check_set_id: Identifier;
  clean: Cell;
  buggy: Cell;
  fixed: Cell;
}

export interface Cell {
  expected: ExpectedOutcome;
  /** error when the copy could not be prepared or run; incomplete when too few runs were valid. */
  observed: ObservedOutcome;
  runs_valid: NonNegativeInteger;
  runs_total: NonNegativeInteger;
  /** True exactly when observed equals expected. */
  matches_expectation: boolean;
}

export interface Repetition {
  protocol_id: Identifier;
  version: Version;
  summary: string;
}

export interface CaseDifficulty {
  status: DifficultyAssessmentStatus;
  note: string;
}

export interface CaseQualification {
  route_id: QualificationRouteId;
  version: Version;
  verdict: "accepted";
  record_sha256: Sha256;
  qualified_at: UtcTime;
}

/** Both parts of a case are ready and have a download path: a case appears only once it is qualified, after its parts are verified and stored (contract sections 10 and 10.2). */
export interface Packages {
  package_version: PositiveInteger;
  /** Canonical hash of the two parts' SHA-256 values and the case ID. */
  pair_sha256: Sha256;
  bug_case: PackagePart;
  validator: PackagePart;
}

export interface PackagePart {
  kind: PackageKind;
  /** rbw-bug-case/1 for the bug case, rbw-validator/1 for the validator package. */
  format: PackageFormat;
  filename: string;
  media_type: "application/gzip";
  size_bytes: NonNegativeInteger;
  sha256: Sha256;
  ready: boolean;
  /** Offer a download only when ready is true and this is not null. */
  download_path: string | null;
}

export interface Provenance {
  origin: CaseOrigin;
  /** The live request: set for live_request, null for published_example. */
  request_id: Uuid | null;
  source_id: Identifier;
  entry_id: Identifier;
}

/** POST and GET of a case's validation runs (contract section 11). */
export interface ValidationRun {
  contract_version: ContractVersion;
  validation_id: Uuid;
  case_id: Sha256;
  state: ValidationState;
  /** Set only in state finished. */
  result: ValidationResult | null;
  /** Null until the run finishes, and when the harness could run no cell. */
  matrix: ValidationMatrix | null;
  package_sha256: PackageHashes;
  harness: HarnessIdentity;
  message: string | null;
  started_at: UtcTime | null;
  /** Set exactly in state finished. */
  finished_at: UtcTime | null;
  /** The run's cost recorded when it completed: null before state finished, set for passed and failed, and possibly null after an error whose spend is uncertain, since reconciliation updates the request's budget, not the run. Null is not 0 (contract section 11). */
  cost_microusd: MicroUsd | null;
  poll_after_ms: NonNegativeInteger;
}

export interface ValidationMatrix {
  original_suite: CellSet;
  verification: CellSet;
}

export interface CellSet {
  clean: Cell;
  buggy: Cell;
  fixed: Cell;
}

export interface PackageHashes {
  bug_case: Sha256;
  validator: Sha256;
}

export interface HarnessIdentity {
  name: "rbw-validate";
  version: Version;
}

/** The body of POST /api/factory/requests/{request_id}/cases/{case_id}/validations. */
export interface ValidationStartRequest {
  validation_id: Uuid;
}

/** The body of POST /api/factory/requests/{request_id}/stop: {}. */
export type StopRequest = EmptyObject;

/** The body of every refused call (contract section 12). Clients branch on error.code, never on the message. */
export interface ErrorResponse {
  contract_version: ContractVersion;
  error: ErrorBody;
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /** BusyErrorDetails for busy, InterpretationErrorDetails for interpretation_stale and unsupported_request, otherwise null. */
  details: BusyErrorDetails | InterpretationErrorDetails | null;
}

export interface BusyErrorDetails {
  /** active is retryable; needs_reconciliation is not. */
  reason: BusyReason;
}

export interface InterpretationErrorDetails {
  /** The current interpretation. */
  interpretation: Interpretation;
}

/** The body of POST /api/factory/session. */
export interface SessionRequest {
  passcode: string;
}

/** The answer of GET /api/factory/session. */
export interface SessionStatus {
  contract_version: ContractVersion;
  signed_in: boolean;
}

/** GET /api/factory/example. The case carries published_example provenance. */
export interface ExampleResponse {
  contract_version: ContractVersion;
  label: string;
  note: string;
  case: Case;
}

/** GET /api/factory/test/evidence?request_id= in test mode: read-only evidence of one request (contract section 15.1). */
export interface TestEvidence {
  contract_version: ContractVersion;
  request_id: Uuid;
  /** The request's root execution in the spend ledger. The worker's operation and every candidate copy run under it, and it stays the same across reads. */
  root_execution_id: Uuid;
  operations: TestOperation[];
  slot: TestSlot;
  provider_calls: TestProviderCall[];
}

/** One spend ledger operation of the request. */
export interface TestOperation {
  /** The spend ledger's operation ID: 64 lowercase hexadecimal characters. */
  operation_id: Sha256;
  kind: TestOperationKind;
  call_name: Identifier;
  /** The execution this operation pays for. For the worker it is the request's root execution; for a candidate or validation copy, the copy's execution; for a validation run, the run's root execution. */
  execution_id: Uuid;
  /** The host of the copy or validation run; null for the worker. */
  host_id: HostId | null;
  /** A settled operation is terminal with settled_microusd set. */
  state: TestOperationState;
  /** The operation's original reservation in every state. It is held until the operation is settled or reconciled, so the request's reserved_microusd sums only the operations still holding theirs (contract section 15.1). */
  reserved_microusd: MicroUsd;
  /** Set only in state terminal, once settled, and in state reconciled, which always records it. */
  settled_microusd: MicroUsd | null;
  attempt_ordinal: PositiveInteger;
}

/** The factory slot and what holds it, if anything. */
export interface TestSlot {
  slot_key: TestSlotKey;
  /** The request whose start or validation run holds the slot. */
  holder_request_id: Uuid | null;
  /** Set while a validation run holds the slot. */
  holder_validation_id: Uuid | null;
}

/** One call made to the fake provider. */
export interface TestProviderCall {
  call_name: Identifier;
  /** The execution whose job this call created or stopped. It equals the execution_id of the operation with the same call_name. */
  execution_id: Uuid;
  provider: TestProvider;
  action: TestProviderAction;
  at: UtcTime;
}

/** The body of POST /api/factory/test/reconcile; the answer is the RequestStatus after reconciliation (contract section 15.1). */
export interface TestReconcileRequest {
  request_id: Uuid;
}

/** The body of POST /api/factory/test/reset (contract section 15.1). */
export interface TestResetRequest {
  scenario: TestScenario;
}

/** The answer of POST /api/factory/test/reset. */
export interface TestResetResponse {
  contract_version: ContractVersion;
  scenario: TestScenario;
}

/** Internal: a host's pinned baseline. */
export interface BaselineIdentity {
  host_id: HostId;
  baseline_id: Identifier;
  app_commit: GitCommitId;
  original_suite: OriginalSuiteIdentity;
}

export interface OriginalSuiteIdentity {
  suite_id: Identifier;
  sha256: Sha256;
  test_count: NonNegativeInteger;
  test_ids_sha256: Sha256;
}

/** Internal: one recipe of a finite catalog. It holds answer-bearing material and is never sent to a client or a debugging agent; only presentation text reaches a Case. */
export interface CatalogEntry {
  entry_id: Identifier;
  source_id: Identifier;
  catalog_version: Version;
  host_id: HostId;
  bug_type_id: BugTypeId;
  /** The criteria the entry targets. Each criterion's failure code comes from the criteria catalog, never from the entry (contract section 6.3). */
  criteria: CriterionRef[];
  plant: PlantedChange;
  reference_repair: ReferenceRepair;
  /** The permitted plain-language description, without fix hints. */
  incident: FileDigest;
  presentation: CatalogPresentation;
  verification: VerificationIdentity;
  environment: KitEnvironment;
  difficulty: DifficultyAssessment;
}

/** Internal: the client-safe text of a Case (contract section 10.1), scanned before use; no answer material. */
export interface CatalogPresentation {
  title: string;
  observed_failure: string;
  how_checked: string;
  repetition_summary: string;
}

export interface CriterionRef {
  criterion_id: Identifier;
  version: Version;
}

export interface PlantedChange {
  patch: string;
  patch_sha256: Sha256;
  targets: PlantTarget[];
}

export interface PlantTarget {
  path: RelativePath;
  before_sha256: Sha256;
  after_sha256: Sha256;
}

export interface ReferenceRepair {
  patch: string;
  patch_sha256: Sha256;
  result_sha256: FileDigest[];
  kind: RepairKind;
}

export interface FileDigest {
  path: RelativePath;
  sha256: Sha256;
}

export interface VerificationIdentity {
  check_set_id: Identifier;
  version: Version;
  check_set_sha256: Sha256;
  expected_vectors_sha256: Sha256;
  protocol_id: Identifier;
  protocol_sha256: Sha256;
}

export interface KitEnvironment {
  /** The pinned amd64 kit image reference. */
  kit_image: Identifier;
  kit_image_digest: ImageDigest;
  environment_sha256: Sha256;
}

/** Internal: a declared repetition protocol, readable from the catalog alone. */
export interface Protocol {
  protocol_id: Identifier;
  version: Version;
  sha256: Sha256;
  per_state: ProtocolStates;
  /** Rule IDs that the host adapter's interpret() applies. */
  valid_trial_rules: Identifier[];
}

export interface ProtocolStates {
  clean: ProtocolState;
  buggy: ProtocolState;
  fixed: ProtocolState;
}

export interface ProtocolState {
  copies: PositiveInteger;
  rounds_per_copy: PositiveInteger;
  min_valid_runs: PositiveInteger;
}

/** Internal: a local directory and its listed files. */
export interface FileSet {
  /** A local directory. */
  root: Identifier;
  /** The listed files, relative to root. */
  files: FileDigest[];
}

/** Internal: what a host adapter gives the exporter for a bug case. */
export interface BugCaseInputs {
  host_id: HostId;
  entry_id: Identifier;
  baseline: BaselineIdentity;
  /** The buggy application source with the unchanged original tests, without version-control history. */
  source: FileSet;
  incident: FileSet;
  runtime: BugCaseRuntime;
}

export interface BugCaseRuntime {
  kit_image: Identifier;
  kit_image_digest: ImageDigest;
  setup: string[];
}

/** Internal: what a host adapter gives the exporter for a validator package. */
export interface ValidatorInputs {
  host_id: HostId;
  entry_id: Identifier;
  /** Verification checks, fixtures and expected vectors. */
  checks: FileSet;
  expected: ExpectedMatrix;
  /** Turns the exported buggy source into the clean copy. */
  clean_reconstruction: PatchText;
  reference_repair: ReferenceRepair;
  protocol: Protocol;
}

/** The expected outcome of every cell, as the qualification table of contract section 1 fixes them. */
export interface ExpectedMatrix {
  original_suite: ExpectedCells;
  verification: ExpectedCells;
}

export interface ExpectedCells {
  clean: ExpectedOutcome;
  buggy: ExpectedOutcome;
  fixed: ExpectedOutcome;
}

export interface PatchText {
  patch: string;
  patch_sha256: Sha256;
}

/** Internal: the two archives unpacked by the harness in fresh workspaces. */
export interface UnpackedPair {
  bug_case_sha256: Sha256;
  validator_sha256: Sha256;
  pair_sha256: Sha256;
  states: CopyTrees;
  evaluator: FileSet;
  protocol: Protocol;
}

export interface CopyTrees {
  /** Reconstructed from the exported buggy source. */
  clean: FileSet;
  /** As exported. */
  buggy: FileSet;
  /** The reference repair applied to the exported buggy source. */
  fixed: FileSet;
}

export interface DifficultyAssessment {
  status: DifficultyAssessmentStatus;
}

/** Internal: what a runner executes for one copy. */
export interface CopyPlan {
  copy_id: Identifier;
  host_id: HostId;
  state: CopyState;
  image: ImagePin;
  /** The app source tree, placed at destinations.app before start. */
  files: FileDigest[];
  /** Validator material, placed at destinations.evaluator, an evaluator-only location. */
  evaluator_files: FileDigest[];
  destinations: CopyDestinations;
  command: string[];
  limits: CopyLimits;
}

export interface ImagePin {
  reference: Identifier;
  /** Required for sandbox runs. */
  digest: ImageDigest | null;
}

/** Absolute paths inside the copy. */
export interface CopyDestinations {
  /** Where the runner places every file of files. */
  app: AbsolutePath;
  /** Where the runner places every file of evaluator_files; evaluator-only. */
  evaluator: AbsolutePath;
  /** Where the copy writes its results; the runner copies this directory back. */
  results: AbsolutePath;
}

export interface CopyLimits {
  timeout_s: PositiveInteger;
  vcpus: PositiveInteger;
  memory_mb: PositiveInteger;
  network: "none";
}

/** Internal: the local directories the harness built from an UnpackedPair, which a runner reads a copy's files from. */
export interface CopyRoots {
  /** A local directory holding the plan's files. */
  app_root: Identifier;
  /** A local directory holding the plan's evaluator files. */
  evaluator_root: Identifier;
}

/** Internal: what a runner brings back from one copy, which the host adapter's collect parses into a CopyRecord. */
export interface CollectedCopy {
  copy_id: Identifier;
  outcome: CopyRunOutcome;
  /** The command's exit code, or null when there is none. */
  exit_code: SafeInteger | null;
  /** A fresh local directory with the copy's results, or null. */
  results_dir: Identifier | null;
  image_digest: ImageDigest;
  architecture: Architecture;
  started_at: UtcTime;
  finished_at: UtcTime;
  /** The sha256 of a deterministic tar of results_dir, or null. */
  results_sha256: Sha256 | null;
}

/** Internal: never sent to a client. */
export interface CellObservation {
  observed: ObservedOutcome;
  runs_valid: NonNegativeInteger;
  runs_total: NonNegativeInteger;
  failure_codes: Identifier[];
  detail: string;
}

/** Internal: a CellObservation of the original suite with its test counts. */
export interface SuiteObservation {
  observed: ObservedOutcome;
  runs_valid: NonNegativeInteger;
  runs_total: NonNegativeInteger;
  failure_codes: Identifier[];
  detail: string;
  executed: NonNegativeInteger;
  /** The number of tests the suite should execute. */
  expected: NonNegativeInteger;
  failing_test_ids: string[];
  suite_sha256: Sha256;
}

/** Internal: what one copy's run recorded. */
export interface CopyRecord {
  copy_id: Identifier;
  state: CopyState;
  status: CopyRecordStatus;
  original_suite: SuiteObservation;
  verification: CellObservation;
  image_digest: ImageDigest;
  architecture: Architecture;
  started_at: UtcTime;
  finished_at: UtcTime;
  /** The collected copy's results_sha256, or null when the copy brought back no results. A complete record has one. */
  evidence_sha256: Sha256 | null;
}

/** Internal: the qualification route's record for one candidate. Whether the verdict follows from the cells and criteria is not checked by the schema. */
export interface QualificationRecord {
  route: QualificationRoute;
  case_id: Sha256;
  defect_id: Sha256;
  entry_id: Identifier;
  item_key: ItemKey | null;
  cells: QualificationCells;
  criteria: CriterionMatch[];
  export_verification: ExportVerification;
  verdict: QualificationVerdict;
  /** Null for accepted; otherwise a candidate reason of the verdict's stage. */
  reason_code: CandidateReason | null;
  copy_record_sha256s: Sha256[];
}

export interface QualificationCells {
  original_suite: QualificationCellSet;
  verification: QualificationCellSet;
}

export interface QualificationCellSet {
  clean: QualificationCell;
  buggy: QualificationCell;
  fixed: QualificationCell;
}

/** Internal: a CellObservation with its expectation. */
export interface QualificationCell {
  observed: ObservedOutcome;
  runs_valid: NonNegativeInteger;
  runs_total: NonNegativeInteger;
  failure_codes: Identifier[];
  detail: string;
  expected: ExpectedOutcome;
  /** True exactly when observed equals expected. */
  matches_expectation: boolean;
}

export interface CriterionMatch {
  criterion_id: Identifier;
  matched: boolean;
}

export interface ExportVerification {
  bug_case_sha256: Sha256;
  validator_sha256: Sha256;
  harness: HarnessIdentity;
}

/** Maps each definition name to its type. */
export interface DefTypes {
  SafeInteger: SafeInteger;
  NonNegativeInteger: NonNegativeInteger;
  PositiveInteger: PositiveInteger;
  MicroUsd: MicroUsd;
  SignedMicroUsd: SignedMicroUsd;
  Uuid: Uuid;
  Sha256: Sha256;
  GitCommitId: GitCommitId;
  ImageDigest: ImageDigest;
  RelativePath: RelativePath;
  AbsolutePath: AbsolutePath;
  UtcTime: UtcTime;
  ItemKey: ItemKey;
  Identifier: Identifier;
  Description: Description;
  Version: Version;
  ContractVersion: ContractVersion;
  HostId: HostId;
  BugTypeId: BugTypeId;
  ServiceState: ServiceState;
  ServiceCode: ServiceCode;
  SupportStatus: SupportStatus;
  SourceKind: SourceKind;
  DifficultyOptionId: DifficultyOptionId;
  ItemDifficultyStatus: ItemDifficultyStatus;
  DifficultyAssessmentStatus: DifficultyAssessmentStatus;
  InterpreterId: InterpreterId;
  QualificationRouteId: QualificationRouteId;
  PackageKind: PackageKind;
  PackageFormat: PackageFormat;
  ProblemCode: ProblemCode;
  ProblemSeverity: ProblemSeverity;
  RequestState: RequestState;
  RequestOutcome: RequestOutcome;
  StopCode: StopCode;
  Delivery: Delivery;
  AttentionCode: AttentionCode;
  CandidateStage: CandidateStage;
  CandidateReason: CandidateReason;
  EventType: EventType;
  CheckSet: CheckSet;
  CopyState: CopyState;
  ExpectedOutcome: ExpectedOutcome;
  ObservedOutcome: ObservedOutcome;
  CaseOrigin: CaseOrigin;
  QualificationVerdict: QualificationVerdict;
  ValidationState: ValidationState;
  ValidationResult: ValidationResult;
  ErrorCode: ErrorCode;
  BusyReason: BusyReason;
  TestScenario: TestScenario;
  TestOperationKind: TestOperationKind;
  TestOperationState: TestOperationState;
  TestSlotKey: TestSlotKey;
  TestProvider: TestProvider;
  TestProviderAction: TestProviderAction;
  CopyRecordStatus: CopyRecordStatus;
  CopyRunOutcome: CopyRunOutcome;
  Architecture: Architecture;
  RepairKind: RepairKind;
  EmptyObject: EmptyObject;
  Capabilities: Capabilities;
  ServiceStatus: ServiceStatus;
  Host: Host;
  BugType: BugType;
  Criterion: Criterion;
  Combination: Combination;
  SourceSummary: SourceSummary;
  DifficultyOption: DifficultyOption;
  Limits: Limits;
  InterpreterCapability: InterpreterCapability;
  InterpreterIdentity: InterpreterIdentity;
  QualificationRoute: QualificationRoute;
  PackageFormats: PackageFormats;
  RequestInput: RequestInput;
  RequestItemInput: RequestItemInput;
  NormalizedRequestInput: NormalizedRequestInput;
  NormalizedRequestItemInput: NormalizedRequestItemInput;
  Interpretation: Interpretation;
  InterpretedItem: InterpretedItem;
  ItemDifficulty: ItemDifficulty;
  InterpretedCriterion: InterpretedCriterion;
  EligibleSource: EligibleSource;
  TypeQuantity: TypeQuantity;
  InterpretationHost: InterpretationHost;
  InterpretationBudget: InterpretationBudget;
  HostAmount: HostAmount;
  InterpretationLimits: InterpretationLimits;
  Problem: Problem;
  StartRequest: StartRequest;
  RequestStatus: RequestStatus;
  StopReason: StopReason;
  Attention: Attention;
  RequestBudget: RequestBudget;
  RequestLimits: RequestLimits;
  Funnel: Funnel;
  ItemProgress: ItemProgress;
  TypeProgress: TypeProgress;
  Candidate: Candidate;
  CandidateReasonDetail: CandidateReasonDetail;
  Event: Event;
  EmptyDataEvent: EmptyDataEvent;
  HostEvent: HostEvent;
  CandidateSelectedEvent: CandidateSelectedEvent;
  CheckFinishedEvent: CheckFinishedEvent;
  CriteriaPassedEvent: CriteriaPassedEvent;
  CandidateEndedEvent: CandidateEndedEvent;
  PackageReadyEvent: PackageReadyEvent;
  SourceExhaustedEvent: SourceExhaustedEvent;
  BudgetUpdatedEvent: BudgetUpdatedEvent;
  AttentionEvent: AttentionEvent;
  RequestFinishedEvent: RequestFinishedEvent;
  ValidationStartedEvent: ValidationStartedEvent;
  ValidationFinishedEvent: ValidationFinishedEvent;
  HostEventData: HostEventData;
  CandidateSelectedData: CandidateSelectedData;
  CheckFinishedData: CheckFinishedData;
  CriteriaPassedData: CriteriaPassedData;
  CandidateEndedData: CandidateEndedData;
  PackageReadyData: PackageReadyData;
  SourceExhaustedData: SourceExhaustedData;
  BudgetUpdatedData: BudgetUpdatedData;
  AttentionEventData: AttentionEventData;
  RequestFinishedData: RequestFinishedData;
  ValidationStartedData: ValidationStartedData;
  ValidationFinishedData: ValidationFinishedData;
  Case: Case;
  CriterionSummary: CriterionSummary;
  CaseSummary: CaseSummary;
  CaseMatrix: CaseMatrix;
  CaseOriginalSuite: CaseOriginalSuite;
  CaseVerification: CaseVerification;
  Cell: Cell;
  Repetition: Repetition;
  CaseDifficulty: CaseDifficulty;
  CaseQualification: CaseQualification;
  Packages: Packages;
  PackagePart: PackagePart;
  Provenance: Provenance;
  ValidationRun: ValidationRun;
  ValidationMatrix: ValidationMatrix;
  CellSet: CellSet;
  PackageHashes: PackageHashes;
  HarnessIdentity: HarnessIdentity;
  ValidationStartRequest: ValidationStartRequest;
  StopRequest: StopRequest;
  ErrorResponse: ErrorResponse;
  ErrorBody: ErrorBody;
  BusyErrorDetails: BusyErrorDetails;
  InterpretationErrorDetails: InterpretationErrorDetails;
  SessionRequest: SessionRequest;
  SessionStatus: SessionStatus;
  ExampleResponse: ExampleResponse;
  TestEvidence: TestEvidence;
  TestOperation: TestOperation;
  TestSlot: TestSlot;
  TestProviderCall: TestProviderCall;
  TestReconcileRequest: TestReconcileRequest;
  TestResetRequest: TestResetRequest;
  TestResetResponse: TestResetResponse;
  BaselineIdentity: BaselineIdentity;
  OriginalSuiteIdentity: OriginalSuiteIdentity;
  CatalogEntry: CatalogEntry;
  CatalogPresentation: CatalogPresentation;
  CriterionRef: CriterionRef;
  PlantedChange: PlantedChange;
  PlantTarget: PlantTarget;
  ReferenceRepair: ReferenceRepair;
  FileDigest: FileDigest;
  VerificationIdentity: VerificationIdentity;
  KitEnvironment: KitEnvironment;
  Protocol: Protocol;
  ProtocolStates: ProtocolStates;
  ProtocolState: ProtocolState;
  FileSet: FileSet;
  BugCaseInputs: BugCaseInputs;
  BugCaseRuntime: BugCaseRuntime;
  ValidatorInputs: ValidatorInputs;
  ExpectedMatrix: ExpectedMatrix;
  ExpectedCells: ExpectedCells;
  PatchText: PatchText;
  UnpackedPair: UnpackedPair;
  CopyTrees: CopyTrees;
  DifficultyAssessment: DifficultyAssessment;
  CopyPlan: CopyPlan;
  ImagePin: ImagePin;
  CopyDestinations: CopyDestinations;
  CopyLimits: CopyLimits;
  CopyRoots: CopyRoots;
  CollectedCopy: CollectedCopy;
  CellObservation: CellObservation;
  SuiteObservation: SuiteObservation;
  CopyRecord: CopyRecord;
  QualificationRecord: QualificationRecord;
  QualificationCells: QualificationCells;
  QualificationCellSet: QualificationCellSet;
  QualificationCell: QualificationCell;
  CriterionMatch: CriterionMatch;
  ExportVerification: ExportVerification;
}
