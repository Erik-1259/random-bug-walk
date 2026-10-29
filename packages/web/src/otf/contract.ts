// On-the-fly (OTF) bug creation: the one contract every OTF module shares. It covers the customer's
// routes (the /factory UI against production), the builder's routes (the builder machine against
// production), the store port the server modules meet through, and the power port that starts and
// stops the builder machine. It is separate from @rbw/factory-contract on purpose: that contract's
// enums and event union are closed, and OTF does not revise them.
//
// This module holds types and constants only, plus small pure helpers (the signing string, the
// criterion-to-host lookup, the lane stage order and the host calendar), so the browser bundle can
// import it. Runtime validators live in schemas.ts and canonical hashing in canonical.ts.
// docs/otf/SPEC.md explains the behavior around these types.

export const OTF_CONTRACT_VERSION = "otf/0";

// ---- identities and enums

/** A UUID v4, chosen by production when the job is created. */
export type OtfJobId = string;

export const LANE_IDS = ["lane-1", "lane-2", "lane-3", "lane-4"] as const;
export type LaneId = (typeof LANE_IDS)[number];

/** The hosts OTF builds on. Each has a profile in OTF_HOST_DEFAULTS and its own criteria (CRITERION_HOST). */
export const OTF_HOST_IDS = ["task-report", "umami"] as const;
export type OtfHostId = (typeof OTF_HOST_IDS)[number];

export const OTF_HOST_LABELS: Readonly<Record<OtfHostId, string>> = Object.freeze({
  "task-report": "task-report service",
  umami: "Umami",
});

/** The criteria the contract knows. Availability lists the ones offered right now. */
export const OTF_CRITERION_IDS = [
  "concurrency.lost-acknowledged-change",
  "concurrency.stale-success-response",
  "date_time.time-zone-grouping",
] as const;
export type OtfCriterionId = (typeof OTF_CRITERION_IDS)[number];

/** The one host each criterion is built on. A create names both; production refuses a mismatch. */
export const CRITERION_HOST: Readonly<Record<OtfCriterionId, OtfHostId>> = Object.freeze({
  "concurrency.lost-acknowledged-change": "task-report",
  "concurrency.stale-success-response": "task-report",
  "date_time.time-zone-grouping": "umami",
});

/** The criteria of one host, in OTF_CRITERION_IDS order. */
export function criteriaOf(host: OtfHostId): OtfCriterionId[] {
  return OTF_CRITERION_IDS.filter((id) => CRITERION_HOST[id] === host);
}

/**
 * Topics a host's card may not touch, on top of the shared security checks. Umami OTF covers the
 * time-zone grouping class only: its sign-in, identity, permission and race areas are out of scope.
 * A card field that matches answers invalid_spec.
 */
export const HOST_SCOPE_EXCLUDED: Readonly<Partial<Record<OtfHostId, RegExp>>> = Object.freeze({
  umami: /\b(auth\w*|log ?in|sign[- ]?in|password|permission|session token|identity|identify|credential|role|race|concurren\w*)\b/i,
});

// ---- host profiles, global caps and the host calendar (defaults; W1 reads overrides from config)

export const QUALIFICATION_KINDS = ["tier_b", "admission"] as const;
export type QualificationKind = (typeof QUALIFICATION_KINDS)[number];

/** One host's build profile. W1 reads per-host overrides from config; these are the defaults. */
export interface OtfHostProfile {
  qualification: QualificationKind;
  lanes_per_job: number;
  max_rounds: 3;
  /**
   * 1: a lane whose qualification passes runs one confirmation round before it wins.
   * 0: the qualifying round wins. Admission already runs 5 planted and 5 fixed copies, with 20
   *    repetitions in the first of each (docs/admission-rules.md, ADM-02 and ADM-05).
   */
  confirm_rounds: 0 | 1;
  max_usd_lane: string;
  max_usd_job: string;
  /** Build jobs of this host running at once. */
  max_active: number;
  /** From claim to the job deadline. */
  deadline_ms: number;
  /** The builder starts a qualification or confirmation only with at least this long left before the deadline. */
  round_min_remaining_ms: number;
}

export const OTF_HOST_DEFAULTS: Readonly<Record<OtfHostId, Readonly<OtfHostProfile>>> = Object.freeze({
  "task-report": Object.freeze({
    qualification: "tier_b",
    lanes_per_job: 3,
    max_rounds: 3,
    confirm_rounds: 1,
    max_usd_lane: "3.00",
    max_usd_job: "8.00",
    max_active: 2,
    deadline_ms: 45 * 60_000,
    round_min_remaining_ms: 0,
  }),
  umami: Object.freeze({
    qualification: "admission",
    lanes_per_job: 2,
    max_rounds: 3,
    confirm_rounds: 0,
    max_usd_lane: "3.00",
    max_usd_job: "6.00",
    max_active: 1,
    deadline_ms: 60 * 60_000,
    round_min_remaining_ms: 11 * 60_000,
  }),
});

/** Caps shared by every host. */
export const OTF_DEFAULTS = {
  max_queued: 4,
  max_per_day: 30,
  vm_hours_per_day: 12,
} as const;

/** UTC days of the month on which a host's copies cannot qualify, inclusive. */
export const HOST_CALENDAR_BLOCKS: Readonly<Partial<Record<OtfHostId, Readonly<{ first_utc_day: number; last_utc_day: number }>>>> = Object.freeze({
  // On the 2nd to the 5th (UTC) two of Umami's own revenue tests fail on an unmodified copy
  // (packages/host-umami/src/availability.ts, CALENDAR_REASON).
  umami: Object.freeze({ first_utc_day: 2, last_utc_day: 5 }),
});
/** Slack added after the deadline when production checks a job's calendar window. */
export const CALENDAR_MARGIN_MS = 15 * 60_000;

/** True when no instant in [fromMs, untilMs] falls on a blocked UTC day of the host. */
export function hostCalendarOpen(host: OtfHostId, fromMs: number, untilMs: number): boolean {
  const block = HOST_CALENDAR_BLOCKS[host];
  if (block === undefined) return true;
  const DAY_MS = 86_400_000;
  for (let day = Math.floor(fromMs / DAY_MS) * DAY_MS; day <= untilMs; day += DAY_MS) {
    const date = new Date(day).getUTCDate();
    if (date >= block.first_utc_day && date <= block.last_utc_day) return false;
  }
  return true;
}

// ---- builder state, as the customer sees it

/**
 * The builder machine's state, from the cloud provider's instance state combined with the builder's
 * heartbeat. "running" means the heartbeat is fresh (BUILDER_FRESH_MS), not only that the instance
 * is up; an instance that is up without a fresh heartbeat reads "starting".
 */
export const BUILDER_STATES = ["running", "starting", "stopped", "stopping", "unknown"] as const;
export type BuilderState = (typeof BUILDER_STATES)[number];

// ---- (1) guided input -> spec card -> accept

export interface OtfBehaviorOption {
  criterion_id: OtfCriterionId;
  host_id: OtfHostId;
  /** The capabilities criteria label. */
  label: string;
  example_phrases: string[];
}

/**
 * The spec card: the bug designer's bug_spec answer without in_scope. The UI gets it from the
 * existing POST /api/factory/assist/bug-spec with
 * { shape: { title: <picker label>, summary: <sentence>, sources: [] }, host_id: <the behavior's host_id> }.
 */
export interface OtfSpecCard {
  title: string;
  where: string;
  change: string;
  why_tests_miss: string;
  /** 1..6 entries. */
  checks_to_add: string[];
  fix: string;
}

/** POST /api/factory/otf/jobs */
export interface OtfCreateJob {
  /** A UUID chosen by the client. A repeat create with the same key and the same body replays. */
  client_key: string;
  /** Must equal CRITERION_HOST[criterion_id]. */
  host_id: OtfHostId;
  criterion_id: OtfCriterionId;
  /** The customer's own words, SENTENCE_MIN_CHARS..SENTENCE_MAX_CHARS. */
  sentence: string;
  /** The card as accepted (edits allowed; production re-checks every field). */
  spec: OtfSpecCard;
  /** specSha256(spec) from canonical.ts; production recomputes it and refuses a mismatch. */
  spec_sha256: string;
  /** The catalog request the customer also started, when there is one. */
  catalog_request_id?: string;
}

/** 201 on a new job, 200 on an idempotent replay. */
export interface OtfCreateResponse {
  job_id: OtfJobId;
  status: OtfJobStatus;
}

/**
 * Why a create is refused. A stopped builder is never a refusal: production starts it and the job
 * waits in starting_builder.
 */
export const OTF_CREATE_REFUSALS = [
  "busy", // active + queued jobs >= max_active + max_queued
  "daily_cap", // jobs created this UTC day >= the daily cap
  "spend_cap", // reported model spend >= the OTF spend cap
  "refused_topic", // a security topic, or code, in the sentence or any spec field
  "invalid_spec", // the body fails its schema, the spec hash does not match, host and criterion do not pair, or the card is out of the host's scope
  "idempotency_conflict", // the client_key was used before with a different body
  "signed_out", // no judge session
  "host_unavailable", // the criterion's host is disabled, left out of a running builder's ready_hosts, or its calendar window would be touched
  "unavailable", // OTF disabled or unconfigured, an operator hold, the VM-hours day cap, or a server fault
] as const;
export type OtfCreateRefusal = (typeof OTF_CREATE_REFUSALS)[number];

/** Every error code an OTF route answers with (customer and builder routes). */
export const OTF_ERROR_CODES = [
  ...OTF_CREATE_REFUSALS,
  "invalid_request", // a malformed body or query on any route but create
  "not_found",
  "not_delivered", // validation or download on a job that did not deliver
  "job_finished", // a builder post to a finished job; the builder stops its lanes
  "event_conflict", // a builder_seq repeated with different bytes, or a gap in builder_seq
  "unauthorized", // builder auth failed (bad, missing or stale signature)
] as const;
export type OtfErrorCode = (typeof OTF_ERROR_CODES)[number];

export const OTF_ERROR_STATUS: Record<OtfErrorCode, number> = {
  busy: 409,
  daily_cap: 409,
  spend_cap: 409,
  refused_topic: 422,
  invalid_spec: 422,
  idempotency_conflict: 409,
  signed_out: 401,
  host_unavailable: 409,
  unavailable: 503,
  invalid_request: 400,
  not_found: 404,
  not_delivered: 409,
  job_finished: 409,
  event_conflict: 409,
  unauthorized: 401,
};

export interface OtfErrorBody {
  contract_version: typeof OTF_CONTRACT_VERSION;
  error: { code: OtfErrorCode; message: string; retryable: boolean };
}

// ---- (4) lanes: events and the projected status

export const LANE_STAGES = [
  "queued",
  "setting_up", // sidecars, npm ci, database reset
  "writing", // agent session running (sub-progress in LaneFiles)
  "prechecking",
  "qualifying", // the six-cell round
  "revising", // feedback sent, next agent round
  "confirming", // this lane qualified; the confirmation round is running
  "won",
  "stopped",
  "not_qualified",
  "error",
] as const;
export type LaneStage = (typeof LANE_STAGES)[number];

/**
 * Which candidate files the lane has written so far, per host:
 * - change: the planted change is defined (task-report: planted.patch; Umami: the candidate's site record);
 * - checks: added check files written (task-report: checks/*.check.mjs; Umami: changed files of the check package);
 * - fix: a fix is defined (task-report: repair.patch; Umami: true together with change, because the harness derives the fix).
 */
export interface LaneFiles {
  change: boolean;
  checks: number;
  fix: boolean;
}

/**
 * The lane stage moves the builder may report; a terminal stage has none. qualifying -> won is
 * legal only on a job whose BuildJob.limits.confirm_rounds is 0.
 */
export const LANE_STAGE_NEXT: Readonly<Record<LaneStage, readonly LaneStage[]>> = Object.freeze({
  queued: ["setting_up", "stopped", "error"],
  setting_up: ["writing", "stopped", "error"],
  writing: ["prechecking", "stopped", "error"],
  prechecking: ["qualifying", "revising", "not_qualified", "stopped", "error"],
  qualifying: ["confirming", "won", "revising", "not_qualified", "stopped", "error"],
  revising: ["prechecking", "stopped", "error"],
  confirming: ["won", "not_qualified", "stopped", "error"],
  won: [],
  stopped: [],
  not_qualified: [],
  error: [],
});

/** The iteration a lane_stage event must carry: 1 on writing, +1 on revising, else unchanged; never above max_rounds. */
export function nextIteration(stage: LaneStage, current: number): number {
  return stage === "writing" ? 1 : stage === "revising" ? current + 1 : current;
}

export const CELL_VALUES = ["pass", "fail", "invalid", "incomplete", "error", "not_run"] as const;
export type CellValue = (typeof CELL_VALUES)[number];
export const COPY_STATES = ["clean", "buggy", "fixed"] as const;
export type CopyState = (typeof COPY_STATES)[number];
export type SixCells = Record<CopyState, { original_suite: CellValue; added_checks: CellValue }>;

/** The only six-cell result that qualifies. */
export const EXPECTED_CELLS: Readonly<SixCells> = Object.freeze({
  clean: Object.freeze({ original_suite: "pass", added_checks: "pass" }),
  buggy: Object.freeze({ original_suite: "pass", added_checks: "fail" }),
  fixed: Object.freeze({ original_suite: "pass", added_checks: "pass" }),
});

/** Metered model use. An upper bound: cached input is counted at the full input rate. */
export interface LaneMeter {
  tokens_in: number;
  tokens_out: number;
  requests: number;
  cost_microusd: number;
}

export const ADMISSION_RULES = ["adm_02", "adm_03", "adm_04", "adm_05", "adm_06"] as const;
export type AdmissionRule = (typeof ADMISSION_RULES)[number];
export const ADMISSION_DECISION_VALUES = ["pass", "reject", "invalid", "incomplete", "not_applicable", "not_run"] as const;
export type AdmissionDecision = (typeof ADMISSION_DECISION_VALUES)[number];
export const ADMISSION_COMPARISON_VALUES = ["blind_spot_demonstrated", "caught_by_original_suite", "not_demonstrated", "invalid", "incomplete", "not_run"] as const;
export type AdmissionComparison = (typeof ADMISSION_COMPARISON_VALUES)[number];
export const ALTERNATIVE_FIX_VALUES = ["pass", "fail", "not_run"] as const;
export type AlternativeFixResult = (typeof ALTERNATIVE_FIX_VALUES)[number];

/** What an admission round reports beside its six cells (docs/admission-rules.md). */
export interface OtfAdmissionResult {
  decisions: Record<AdmissionRule, AdmissionDecision>;
  comparison: AdmissionComparison;
  alternative_fix: AlternativeFixResult;
}

export const ROUND_KINDS = ["precheck_rejected", "qualification", "confirmation"] as const;
export const ROUND_RESULTS = ["qualified", "not_qualified", "rejected", "error"] as const;
export interface RoundResult {
  iteration: 1 | 2 | 3;
  kind: (typeof ROUND_KINDS)[number];
  result: (typeof ROUND_RESULTS)[number];
  /** null for precheck_rejected, and on an admission round whose admission copies did not run. */
  cells: SixCells | null;
  /** Admission hosts: set on every qualification and confirmation round. Tier-B hosts and precheck_rejected: null. */
  admission: OtfAdmissionResult | null;
  /** Whitelisted harness report lines, each at most FEEDBACK_LINE_MAX_CHARS. They never name files, functions or check ids. */
  feedback: string[];
  goose_ms: number | null;
  qualify_ms: number | null;
}

/** time_limit: the job deadline, or too little time left to start a round; cancelled: a customer stop only. */
export const LANE_OUTCOMES = ["won", "lost_race", "not_qualified", "spend_cap", "time_limit", "error", "cancelled"] as const;
export type LaneOutcome = (typeof LANE_OUTCOMES)[number];

export const OTF_OUTCOMES = [
  "delivered",
  "not_qualified", // every lane used its rounds
  "time_limit", // the job deadline passed
  "spend_limit", // a lane or job spend cap was reached
  "cancelled", // the customer stopped it
  "builder_start_failed", // the machine did not start, or no claim came within START_TIMEOUT_MS
  "builder_unavailable", // OTF was disabled or put on hold while the job waited, or the job's host became unavailable
  "builder_lost", // no builder post for BUILDER_LOST_MS on a claimed job
  "error", // an infrastructure failure, never worded as "the models could not build it"
] as const;
export type OtfOutcome = (typeof OTF_OUTCOMES)[number];

export const START_FAILURE_REASONS = ["capacity", "api_error", "timeout"] as const;
export type StartFailureReason = (typeof START_FAILURE_REASONS)[number];

export const STOP_REASONS = ["customer", "deadline", "spend_cap"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** Events production appends itself (lane_id null). */
export type ProductionEvent =
  | { type: "job_queued"; lane_id: null; data: { position: number } }
  | { type: "builder_starting"; lane_id: null; data: { preset: string; requested_at: string } }
  /**
   * Appended once per job, when a healthy claim moves it from starting_builder to queued.
   * cold_start_ms: from the later of the last start request and the job's creation, to that claim.
   */
  | { type: "builder_ready"; lane_id: null; data: { cold_start_ms: number } }
  | { type: "builder_start_failed"; lane_id: null; data: { reason: StartFailureReason } }
  | { type: "job_claimed"; lane_id: null; data: { builder_revision: string } }
  | { type: "job_finished"; lane_id: null; data: { outcome: OtfOutcome; reason: string | null } };

/** Events the builder posts. lane_id is set on lane events and null on job events. */
export type BuilderEvent =
  | { type: "lane_started"; lane_id: LaneId; data: { model: string; model_label: string; agent: typeof AGENT_LABEL } }
  | { type: "lane_stage"; lane_id: LaneId; data: { stage: LaneStage; iteration: number } }
  | { type: "lane_files"; lane_id: LaneId; data: LaneFiles }
  /** At most every 10 s per lane. */
  | { type: "lane_meter"; lane_id: LaneId; data: LaneMeter }
  | { type: "round_finished"; lane_id: LaneId; data: RoundResult }
  | { type: "lane_finished"; lane_id: LaneId; data: { outcome: LaneOutcome; reason: string | null } }
  | { type: "winner_selected"; lane_id: null; data: { lane_id: LaneId; candidate_id: string; qualified_at_iteration: number } }
  | { type: "packaging"; lane_id: null; data: Record<string, never> };

export const PRODUCTION_EVENT_TYPES = ["job_queued", "builder_starting", "builder_ready", "builder_start_failed", "job_claimed", "job_finished"] as const;
export const BUILDER_EVENT_TYPES = ["lane_started", "lane_stage", "lane_files", "lane_meter", "round_finished", "lane_finished", "winner_selected", "packaging"] as const;

/** One ordered stream per job: seq is assigned by production on insert, gap-free from 1. */
export type OtfEvent = { seq: number; at: string } & (ProductionEvent | BuilderEvent);
export type OtfEventType = OtfEvent["type"];

export const AGENT_LABEL = "goose 1.57.0";

/** Projected by the server from the events. */
export interface LaneView {
  lane_id: LaneId;
  model: string;
  model_label: string;
  stage: LaneStage;
  iteration: number;
  files: LaneFiles;
  meter: LaneMeter;
  rounds: RoundResult[];
  outcome: LaneOutcome | null;
}

export const OTF_JOB_STATES = ["queued", "starting_builder", "building", "finished"] as const;
export type OtfJobState = (typeof OTF_JOB_STATES)[number];

export const SPEND_SOURCE = "builder proxy meter (upper bound)";

/** GET /api/factory/otf/jobs/{id}?after=<seq> */
export interface OtfJobStatus {
  job_id: OtfJobId;
  created_at: string;
  state: OtfJobState;
  host_id: OtfHostId;
  /** 1 = next to be claimed; null unless queued or starting_builder. */
  queue_position: number | null;
  builder: BuilderState;
  outcome: OtfOutcome | null;
  reason: string | null;
  criterion_id: OtfCriterionId;
  spec: OtfSpecCard;
  spec_sha256: string;
  /** null until claimed: the deadline runs from the claim. */
  deadline_at: string | null;
  elapsed_ms: number;
  lanes: LaneView[];
  /** Events with seq > after, in seq order. */
  events: OtfEvent[];
  /** The highest seq the client has now seen; pass it back as after. */
  next_after: number;
  /** POLL_RUNNING_MS while not finished, POLL_FINISHED_MS once finished. */
  poll_after_ms: number;
  spend: { model_microusd: number; cap_microusd: number; source: typeof SPEND_SOURCE };
  winner: { lane_id: LaneId; model: string } | null;
  /** Present once delivered; empty before. */
  artifacts: OtfArtifact[];
  certificate: OtfCertificate | null;
  /** The latest validation of this job, if any. */
  validation: OtfValidation | null;
  catalog_request_id: string | null;
}

// ---- results

export const OTF_PARTS = ["agent", "grader", "certificate"] as const;
export type OtfPart = (typeof OTF_PARTS)[number];
export const MEDIA_TYPES = ["application/gzip", "application/json"] as const;

export interface OtfArtifact {
  part: OtfPart;
  /** SAFE_FILENAME, e.g. rbw-otf-agent-<job8>.tar.gz */
  filename: string;
  media_type: (typeof MEDIA_TYPES)[number];
  size: number;
  sha256: string;
  /** /api/factory/otf/jobs/{id}/artifacts/{part} */
  download_path: string;
}

/** The largest part (the agent bundle). */
export const PART_MAX_BYTES = 2 * 1024 * 1024;
/** Per-part caps. With base64 and the JSON envelope, a full result stays under RESULT_BODY_MAX_BYTES. */
export const PART_MAX_BYTES_BY_PART: Readonly<Record<OtfPart, number>> = Object.freeze({
  agent: PART_MAX_BYTES,
  grader: 512 * 1024,
  certificate: 64 * 1024,
});
/**
 * The largest serialized ResultPost a builder may send: under the 4.5 MB function body limit of the
 * hosting platform, which answers a larger body with its own 413 before the route runs. The builder
 * measures the body before posting and finishes the job error ("result too large") instead.
 */
export const RESULT_BODY_MAX_BYTES = 4_400_000;

export const CERTIFICATE_FORMAT = "rbw-otf-certificate/0";
export const CERTIFICATE_RUNNER = "docker on the RBW builder (Nebius VM)";
export const COPY_LIMITS = "4 vCPU / 8192 MB";
export const TOKEN_FACTORY_PROVIDER = "nebius-token-factory";
export const ADMISSION_EVIDENCE = "development evidence: the local runner's admission sequence, not an RBW release";

/** Task-report: one tier-B round (1 clean, 3 buggy, 3 fixed copies), then a confirmation round. */
export interface OtfTierBHarness {
  tier: "B";
  kit_image_id: string;
  copy_limits: typeof COPY_LIMITS;
  instances: { clean: 1; buggy: 3; fixed: 3 };
  runner: typeof CERTIFICATE_RUNNER;
  harness_sha256: string;
}

/** Umami: the local runner's admission sequence (docs/admission-rules.md ADM-02 to ADM-06 and ADM-08). */
export interface OtfAdmissionHarness {
  tier: "admission";
  /** The released kit's content hash; the round's kit image only replaces the check package. */
  kit_sha256: string;
  /** The round's kit image (built on the builder and never published). */
  kit_image_id: string;
  /** The hash of the check package the round ran. */
  added_suite_sha256: string;
  /** sha256:<64 hex>: the runtime image the agent bundle names. */
  runtime_image_digest: string;
  original_suite: { test_count: number; sha256: string };
  copy_limits: typeof COPY_LIMITS;
  copies: { kit_check_clean: 5; observe_planted: 1; clean: 1; planted: 5; fixed: 5; partial: 1; stub: 1 };
  /** Repetitions of the added checks in the first fixed and the first planted copy (ADM-05). */
  repetitions: 20;
  evidence: typeof ADMISSION_EVIDENCE;
  runner: typeof CERTIFICATE_RUNNER;
  harness_sha256: string;
}

/** The only admission result a certificate can carry. */
export interface QualifiedAdmission {
  decisions: Record<AdmissionRule, "pass">;
  comparison: "blind_spot_demonstrated";
  alternative_fix: "pass";
}

interface OtfCertificateBase {
  format: typeof CERTIFICATE_FORMAT;
  job_id: OtfJobId;
  /** The clean host app's source commit (40 hex): the task-report app, or upstream Umami. */
  app_base_commit: string;
  criterion: { criterion_id: OtfCriterionId; version: "1"; failure_code: string };
  /** The customer's accepted card. The certificate never names the planted file, line or check ids. */
  spec_sha256: string;
  designer: { model: string; route: "bug-spec" };
  implementer: { lane_id: LaneId; agent: typeof AGENT_LABEL; provider: typeof TOKEN_FACTORY_PROVIDER; model: string; rounds_used: number };
  bundles: { agent_sha256: string; grader_sha256: string };
  spend: { model_microusd: number; tokens_in: number; tokens_out: number; lanes: number };
  timings: { started_at: string; qualified_at: string; wall_ms: number };
  issued_at: string;
  builder_revision: string;
  /** null as the builder sends it; set by production once the hashes check. */
  received: { at: string; sha256_verified: true } | null;
}

/** Built by the builder; production hash-checks it on receipt and sets received. One variant per host. */
export type OtfCertificate =
  | (OtfCertificateBase & {
      host_id: "task-report";
      qualification: { cells: SixCells; confirmation_cells: SixCells; admission: null; result: "qualified" };
      harness: OtfTierBHarness;
    })
  | (OtfCertificateBase & {
      host_id: "umami";
      /** confirmation_cells is null when the job ran with confirm_rounds 0. */
      qualification: { cells: SixCells; confirmation_cells: SixCells | null; admission: QualifiedAdmission; result: "qualified" };
      harness: OtfAdmissionHarness;
    });

export const VALIDATION_STATES = ["queued", "running", "passed", "failed", "error"] as const;
export type OtfValidationState = (typeof VALIDATION_STATES)[number];
export const VALIDATION_WHERE = "RBW builder (Nebius VM)";

/** POST /api/factory/otf/jobs/{id}/validations (delivered jobs only). 201 new, 200 when one is already open. */
export interface OtfValidation {
  validation_id: string;
  state: OtfValidationState;
  cells: SixCells | null;
  /** Admission hosts: the validation's admission result; null on tier-B hosts and while not finished. */
  admission: OtfAdmissionResult | null;
  started_at: string;
  finished_at: string | null;
  where: typeof VALIDATION_WHERE;
}

/** Fewer finished jobs than this give no typical time. */
export const TYPICAL_MIN_SAMPLES = 5;

/**
 * What a typical time measured. otf_jobs: claim to finish of finished OTF jobs. development_attempts:
 * qualified single-lane experiment attempts (docs/otf/evidence), which leave out the queue, the cold
 * start, the confirmation round and packaging. Each source has its own copy (SPEC section 6).
 */
export const TYPICAL_SOURCES = ["otf_jobs", "development_attempts"] as const;
export type TypicalSource = (typeof TYPICAL_SOURCES)[number];

/**
 * A host's typical build time, set by the operator from a committed results file, or null when not
 * measured. Copy renders it only when present, always with its source, samples and measured_on.
 */
export interface OtfTypical {
  source: TypicalSource;
  median_min: number;
  p90_min: number;
  /** Finished jobs or qualified attempts measured, at least TYPICAL_MIN_SAMPLES. */
  samples: number;
  /** YYYY-MM-DD (UTC) of the last measurement. */
  measured_on: string;
}

/** builder_not_ready: the builder is running and its fresh heartbeat leaves the host out of ready_hosts. */
export const HOST_UNAVAILABLE_REASONS = ["disabled", "calendar", "builder_not_ready"] as const;
export type HostUnavailableReason = (typeof HOST_UNAVAILABLE_REASONS)[number];

export interface OtfHostAvailability {
  host_id: OtfHostId;
  label: string;
  offered: boolean;
  /** null exactly when offered. */
  unavailable_reason: HostUnavailableReason | null;
  active_jobs: number;
  queued_jobs: number;
  max_active: number;
  lanes: { lane_id: LaneId; model_label: string }[];
  deadline_min: number;
  typical: OtfTypical | null;
}

/** GET /api/factory/otf/availability: no session needed, and it never starts the machine. */
export interface OtfAvailability {
  enabled: boolean;
  builder: BuilderState;
  active_jobs: number;
  queued_jobs: number;
  max_queued: number;
  /** The behaviors of offered hosts only. */
  behaviors: OtfBehaviorOption[];
  /** Every host once, in any order. */
  hosts: OtfHostAvailability[];
  /** null until the cold start is measured; the UI then omits that sentence. */
  cold_start_min: number | null;
  spend_left_microusd: number;
}

/** POST /api/factory/otf/jobs/{id}/stop answers 202 with the current status. */
export type OtfStopResponse = OtfJobStatus;

// ---- builder-facing routes (§3.3). The builder pulls; production never calls the builder.

export const BUILDER_HEADERS = {
  id: "x-rbw-builder-id",
  ts: "x-rbw-builder-ts",
  sig: "x-rbw-builder-sig",
} as const;

/**
 * The string the builder signs: x-rbw-builder-sig = hex HMAC-SHA256(secret, this). ts is the
 * x-rbw-builder-ts value (Unix ms, decimal), method is upper case, path is the URL path without
 * the query, bodySha256 is lower-case hex sha256 of the exact body bytes (of "" for no body).
 */
export function builderSigningString(ts: string, method: string, path: string, bodySha256: string): string {
  return `${ts}\n${method.toUpperCase()}\n${path}\n${bodySha256}`;
}

/** POST /api/factory/otf/builder/claim (long poll, held up to CLAIM_HOLD_MS). Also the idle heartbeat. */
export interface ClaimRequest {
  builder_id: string;
  builder_revision: string;
  /** Changes on every boot. */
  boot_id: string;
  booted_at: string;
  /**
   * false after a pinned-image mismatch: no job is handed out and the state stays starting. Every
   * claim with images_ok true (from a new boot or the same one) moves each starting_builder job to
   * queued and appends builder_ready to it, so a builder that recovers without a reboot still picks
   * up jobs created while its heartbeat was stale.
   */
  images_ok: boolean;
  /** Free capacity per host. 0 for a host the builder cannot take now. */
  free: { build: Record<OtfHostId, number>; validate: Record<OtfHostId, number> };
  /**
   * Hosts whose lane profile is installed and checked on this boot and that can take a new build
   * (Umami: its pinned harness files match and an eligible target remains). While the builder is
   * running, production offers a host only when the last fresh heartbeat lists it. A stopped or
   * starting builder has no fresh heartbeat; then readiness is not checked at create, and a job
   * whose host the next fresh heartbeat leaves out finishes builder_unavailable on read.
   */
  ready_hosts: OtfHostId[];
}

export interface BuildJobLane {
  lane_id: LaneId;
  model: string;
  model_label: string;
  price_in_usd_per_m: string;
  price_out_usd_per_m: string;
}

export interface BuildJob {
  kind: "build";
  job_id: OtfJobId;
  host_id: OtfHostId;
  criterion_id: OtfCriterionId;
  spec: OtfSpecCard;
  spec_sha256: string;
  sentence: string;
  lanes: BuildJobLane[];
  limits: {
    max_rounds: 3;
    max_usd_lane: string;
    max_usd_job: string;
    goose_max_tokens: 32768;
    deadline_at: string;
    /** The host profile's confirm_rounds. */
    confirm_rounds: 0 | 1;
    /** The host profile's round_min_remaining_ms. */
    round_min_remaining_ms: number;
  };
}

export interface ValidateJob {
  kind: "validate";
  job_id: OtfJobId;
  host_id: OtfHostId;
  validation_id: string;
  artifacts: { part: "agent" | "grader"; sha256: string; size: number }[];
}

/** 200 with this body, or 204 with no body when nothing is waiting. A claim sets lease_until = now + LEASE_MS. */
export interface ClaimReply {
  job: BuildJob | ValidateJob;
}

/** One builder event as posted: builder_seq is the builder's own gap-free counter per job, from 1. */
export type BuilderEventIn = BuilderEvent & { builder_seq: number; at: string };

/**
 * POST /api/factory/otf/builder/jobs/{id}/events, at least every HEARTBEAT_MS (an empty list is the
 * heartbeat). Each post extends the lease. A builder_seq at or below accepted_through is ignored
 * when its canonical bytes equal the stored ones and refused with event_conflict otherwise; a
 * builder_seq that skips one is refused with event_conflict too.
 */
export interface EventsPost {
  builder_id: string;
  events: BuilderEventIn[];
}

export interface EventsReply {
  /** The highest builder_seq now stored for this job (0 when none). */
  accepted_through: number;
  control: { stop: boolean; reason: StopReason | null };
}

export interface ResultPart {
  part: OtfPart;
  filename: string;
  sha256: string;
  size: number;
  base64: string;
}

/**
 * POST /api/factory/otf/builder/jobs/{id}/result. Production reads at most RESULT_BODY_MAX_BYTES and
 * checks: gzip magic for the tarballs, size <= PART_MAX_BYTES_BY_PART[part] each, sha256 of the
 * decoded bytes, SAFE_FILENAME, one of each part, that certificate.bundles equal the part hashes,
 * that the certificate's host_id equals the job's, and that the job's spec_sha256 equals the
 * certificate's. Idempotent on (job_id, part sha256s). The answer is 200 ResultReply.
 */
export interface ResultPost {
  builder_id: string;
  outcome: OtfOutcome;
  reason: string | null;
  /** Required when outcome is delivered, absent otherwise. */
  certificate?: OtfCertificate;
  /** Required when outcome is delivered (agent, grader, certificate), absent otherwise. */
  parts?: ResultPart[];
}

/** POST /api/factory/otf/builder/jobs/{id}/result answers 200 with this. */
export interface ResultReply {
  job_id: OtfJobId;
  state: "finished";
  outcome: OtfOutcome;
}

/** GET /api/factory/otf/builder/jobs/{id}/artifacts/{part}: the stored bytes, for validate jobs. */

/** POST /api/factory/otf/builder/validations/{vid}/result */
export interface ValidationResultPost {
  builder_id: string;
  state: "passed" | "failed" | "error";
  cells: SixCells | null;
  /** Admission hosts: the admission result; null on tier-B hosts. */
  admission: OtfAdmissionResult | null;
  finished_at: string;
}

/** POST /api/factory/otf/builder/stop-intent: the machine asks before it stops itself. */
export interface StopIntent {
  builder_id: string;
  boot_id: string;
  reason: "idle" | "max_uptime" | "builder_fault";
  idle_since: string | null;
}

/**
 * Allowed only when no job is queued, starting_builder or building; max_uptime and builder_fault
 * are always allowed (their claimed jobs finish as builder_lost). On allow the state is stopping.
 */
export interface StopIntentReply {
  allow: boolean;
  reason: "ok" | "jobs_waiting" | "operator_hold";
}

// ---- timings and limits (host profiles and global caps are above, after the hosts)

export const SENTENCE_MIN_CHARS = 3;
export const SENTENCE_MAX_CHARS = 300;
export const FEEDBACK_LINE_MAX_CHARS = 400;
export const REASON_MAX_CHARS = 400;
/** SAFE_FILENAME, as the factory's download handler uses. */
export const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const POLL_RUNNING_MS = 2_000;
export const POLL_FINISHED_MS = 30_000;
export const CLAIM_HOLD_MS = 20_000;
export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 15_000;
/** A heartbeat younger than this makes the builder "running". */
export const BUILDER_FRESH_MS = 60_000;
/** No builder post for this long on a claimed job: builder_lost. */
export const BUILDER_LOST_MS = 180_000;
/** No claim this long after a start request: builder_start_failed (timeout). */
export const START_TIMEOUT_MS = 8 * 60_000;
export const SIGNATURE_WINDOW_MS = 120_000;
/** The builder asks to stop itself after this long with no job queued or active. */
export const IDLE_STOP_MS = 10 * 60_000;
/** Watchdog: instance running, no heartbeat this long, no active job: stop it. */
export const WATCHDOG_NO_HEARTBEAT_MS = 10 * 60_000;
/** Watchdog: instance running this long after the last job finished: stop it. */
export const WATCHDOG_AFTER_LAST_JOB_MS = 90 * 60_000;
/** Watchdog: at most one cloud API call per this interval. */
export const WATCHDOG_MIN_INTERVAL_MS = 30_000;
/** Longest continuous machine uptime. */
export const MAX_UPTIME_MS = 3 * 3_600_000;

// ---- the power port (W2 implements it with the cloud SDK; tests use a fake)

export type NebiusInstanceState = "RUNNING" | "STOPPED" | "STARTING" | "STOPPING" | "OTHER";

export interface VmPower {
  get(): Promise<{ state: NebiusInstanceState; preset: string }>;
  /** Idempotent in effect: already running or starting is a no-op. Throws StartError on failure. */
  start(): Promise<{ operation_id: string }>;
  stop(): Promise<{ operation_id: string }>;
}

/** What VmPower.start throws, so the caller can record builder_start_failed with a reason. */
export class StartError extends Error {
  readonly reason: Exclude<StartFailureReason, "timeout">;
  constructor(reason: Exclude<StartFailureReason, "timeout">, message: string) {
    super(message);
    this.name = "StartError";
    this.reason = reason;
  }
}

// ---- the store port (W1 implements it on Postgres; W2 consumes it, with an in-memory fake in tests)

/** Every time is an ISO 8601 UTC string; callers pass `at` so tests control the clock. */
export interface OtfJobRecord {
  job_id: OtfJobId;
  client_key: string;
  /** sha256 of the canonical create body (createSha256), for the idempotency check. */
  create_sha256: string;
  created_at: string;
  host_id: OtfHostId;
  criterion_id: OtfCriterionId;
  sentence: string;
  spec: OtfSpecCard;
  spec_sha256: string;
  state: OtfJobState;
  outcome: OtfOutcome | null;
  reason: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_until: string | null;
  /** Set on claim: claimed_at + deadline. */
  deadline_at: string | null;
  /** The last builder post (events, result) for this job. */
  last_builder_post_at: string | null;
  stop_requested_at: string | null;
  stop_reason: StopReason | null;
  winner_lane: LaneId | null;
  winner_model: string | null;
  model_microusd: number;
  catalog_request_id: string | null;
  certificate: OtfCertificate | null;
  finished_at: string | null;
}

export interface OtfNewJob {
  job_id: OtfJobId;
  client_key: string;
  create_sha256: string;
  created_at: string;
  host_id: OtfHostId;
  criterion_id: OtfCriterionId;
  sentence: string;
  spec: OtfSpecCard;
  spec_sha256: string;
  state: "queued" | "starting_builder";
  catalog_request_id: string | null;
}

export type CreateJobResult =
  | { kind: "created"; job: OtfJobRecord }
  /** Same client_key and same create_sha256: the stored job, unchanged. */
  | { kind: "replayed"; job: OtfJobRecord }
  /** Same client_key, different create_sha256. */
  | { kind: "conflict" };

export type AppendBuilderEventsResult =
  | { kind: "ok"; accepted_through: number }
  /** A repeated builder_seq with different canonical bytes, or a gap. Nothing from the post is stored. */
  | { kind: "conflict"; accepted_through: number; builder_seq: number }
  | { kind: "finished" }
  /** The job is not claimed by this builder_id (answered unauthorized). */
  | { kind: "wrong_builder" }
  | { kind: "not_found" };

export interface OtfBuilderInfo {
  builder_id: string;
  builder_revision: string;
  boot_id: string;
  booted_at: string;
  /** ClaimRequest.ready_hosts of this heartbeat. */
  ready_hosts: OtfHostId[];
}

export interface OtfArtifactRecord {
  job_id: OtfJobId;
  part: OtfPart;
  filename: string;
  media_type: OtfArtifact["media_type"];
  size: number;
  sha256: string;
}

export interface OtfValidationRecord {
  validation_id: string;
  job_id: OtfJobId;
  state: OtfValidationState;
  cells: SixCells | null;
  admission: OtfAdmissionResult | null;
  started_at: string;
  finished_at: string | null;
  claimed_by: string | null;
}

/** The single power row. hold_until is set by an operator script, never by a route. */
export interface OtfPowerRecord {
  state: BuilderState;
  since: string;
  preset: string | null;
  instance_state: NebiusInstanceState | null;
  last_api_call_at: string | null;
  last_start_at: string | null;
  last_stop_at: string | null;
  start_failures: number;
  running_since: string | null;
  last_job_finished_at: string | null;
  vm_seconds_today: number;
  /** YYYY-MM-DD (UTC) that vm_seconds_today counts. */
  vm_day: string;
  hold_until: string | null;
}

export interface OtfPowerLogEntry {
  at: string;
  actor: "create" | "watchdog" | "builder" | "operator";
  action: "start" | "stop" | "get";
  before: string | null;
  after: string | null;
  operation_id: string | null;
}

export type JobPatch = Partial<
  Pick<
    OtfJobRecord,
    "state" | "outcome" | "reason" | "stop_requested_at" | "stop_reason" | "winner_lane" | "winner_model" | "model_microusd" | "certificate" | "finished_at" | "lease_until" | "last_builder_post_at"
  >
>;

export interface OtfStore {
  /** Idempotent on client_key (see CreateJobResult). */
  createJob(job: OtfNewJob): Promise<CreateJobResult>;
  getJob(job_id: OtfJobId): Promise<OtfJobRecord | null>;
  /** Jobs in any of these states, oldest created first. */
  listJobs(states: readonly OtfJobState[]): Promise<OtfJobRecord[]>;
  /** Jobs created at or after this time (for the daily cap). */
  countJobsCreatedSince(at: string): Promise<number>;
  /** The sum of model_microusd over every job (for the spend cap). */
  totalModelMicrousd(): Promise<number>;
  /**
   * Applies the patch only when the job's state is one of `whenStates` (a compare-and-set, so two
   * finishes cannot both win). Returns the updated record, or null when the state did not match.
   */
  updateJob(job_id: OtfJobId, whenStates: readonly OtfJobState[], patch: JobPatch): Promise<OtfJobRecord | null>;

  /** Appends one production event with the next seq; returns the stored event. */
  appendJobEvent(job_id: OtfJobId, event: ProductionEvent, at: string): Promise<OtfEvent>;
  /**
   * Appends builder events in one transaction, assigning the next public seqs. builder_seq must
   * continue gap-free from the stored maximum; a repeat is skipped when canonicalJson of the event
   * (builderEventBytes) equals the stored bytes. Refuses a finished job, and a job claimed by
   * another builder_id. Extends the lease to
   * at + LEASE_MS and sets last_builder_post_at = at, even for an empty list.
   */
  appendBuilderEvents(job_id: OtfJobId, builder_id: string, events: readonly BuilderEventIn[], at: string): Promise<AppendBuilderEventsResult>;
  /** Events with seq > after, in seq order. */
  listEvents(job_id: OtfJobId, after: number): Promise<OtfEvent[]>;

  /**
   * Records the builder's heartbeat. first_of_boot is true exactly once per (builder_id, boot_id),
   * on the first call that carries a new boot_id.
   */
  recordBuilderSeen(info: OtfBuilderInfo, at: string): Promise<{ first_of_boot: boolean }>;
  /** The most recent heartbeat of any builder, or null. */
  lastBuilderSeen(): Promise<(OtfBuilderInfo & { last_seen_at: string }) | null>;
  /**
   * Atomically claims, in this order:
   * 1. the oldest queued validation whose host has validate true;
   * 2. else the oldest queued build whose host has build true and fewer than that host's
   *    maxActiveBuilds building.
   * A saturated host never blocks another host's jobs. A build claim sets building, claimed_by,
   * claimed_at, deadline_at = at + that host's deadlineMs and lease_until = at + LEASE_MS.
   * A validation claim sets running.
   */
  claimNext(
    builder_id: string,
    at: string,
    opts: { hosts: Readonly<Record<OtfHostId, { build: boolean; validate: boolean; maxActiveBuilds: number; deadlineMs: number }>> },
  ): Promise<{ kind: "build"; job: OtfJobRecord } | { kind: "validate"; validation: OtfValidationRecord } | null>;

  /**
   * Stores all parts, finishes the job and appends job_finished { outcome: "delivered" } at `at`, in
   * one transaction, only while the job is building and claimed by builder_id (checked under the same
   * row lock, so a concurrent finish on read cannot be overwritten). "replayed" when the job already
   * delivered with the same sha256s; "conflict" when it delivered with different ones; "finished"
   * when it finished with another outcome (nothing is changed); "wrong_builder" when another builder
   * holds the claim. With no parts, the same call finishes a claimed job with another outcome
   * (patch.outcome and patch.reason), appending that job_finished at `at` the same way.
   */
  storeDelivery(
    job_id: OtfJobId,
    builder_id: string,
    parts: readonly (OtfArtifactRecord & { bytes: Uint8Array })[],
    patch: JobPatch,
    at: string,
  ): Promise<"stored" | "replayed" | "conflict" | "finished" | "wrong_builder" | "not_found">;
  listArtifacts(job_id: OtfJobId): Promise<OtfArtifactRecord[]>;
  getArtifact(job_id: OtfJobId, part: OtfPart): Promise<(OtfArtifactRecord & { bytes: Uint8Array }) | null>;

  createValidation(job_id: OtfJobId, validation_id: string, at: string): Promise<OtfValidationRecord>;
  getValidation(validation_id: string): Promise<OtfValidationRecord | null>;
  latestValidation(job_id: OtfJobId): Promise<OtfValidationRecord | null>;
  /** Compare-and-set on state, as updateJob. */
  updateValidation(
    validation_id: string,
    whenStates: readonly OtfValidationState[],
    patch: Partial<Pick<OtfValidationRecord, "state" | "cells" | "admission" | "finished_at">>,
  ): Promise<OtfValidationRecord | null>;

  /** The power row as it is now (without a lock). */
  getPower(): Promise<OtfPowerRecord>;
  /**
   * Runs fn under the power row lock (SELECT ... FOR UPDATE). The returned patch, when not null, is
   * written before the lock is released, and the log entries are appended in the same transaction.
   */
  withPowerLock<T>(fn: (power: OtfPowerRecord) => Promise<{ patch: Partial<OtfPowerRecord> | null; log: OtfPowerLogEntry[]; result: T }>): Promise<T>;
}
