// Runtime validators for every OTF request and response body, with Ajv as the bug designer's schemas
// use it. Every object forbids unknown members, so nothing outside the contract can leave a route;
// a response that fails its schema should be answered as `unavailable` instead (as the factory's
// sendContract does). The enums come from contract.ts, so types and schemas share one source.
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import {
  AGENT_LABEL,
  BUILDER_EVENT_TYPES,
  BUILDER_STATES,
  CELL_VALUES,
  CERTIFICATE_FORMAT,
  CERTIFICATE_RUNNER,
  COPY_LIMITS,
  FEEDBACK_LINE_MAX_CHARS,
  LANE_IDS,
  LANE_OUTCOMES,
  LANE_STAGES,
  MEDIA_TYPES,
  OTF_CONTRACT_VERSION,
  OTF_CRITERION_IDS,
  OTF_ERROR_CODES,
  OTF_HOST_IDS,
  OTF_JOB_STATES,
  OTF_OUTCOMES,
  OTF_PARTS,
  PART_MAX_BYTES,
  REASON_MAX_CHARS,
  ROUND_KINDS,
  ROUND_RESULTS,
  SENTENCE_MAX_CHARS,
  SENTENCE_MIN_CHARS,
  SPEND_SOURCE,
  START_FAILURE_REASONS,
  STOP_REASONS,
  TOKEN_FACTORY_PROVIDER,
  TYPICAL_BASIS,
  VALIDATION_STATES,
  VALIDATION_WHERE,
  type BuilderEventIn,
  type ClaimReply,
  type ClaimRequest,
  type EventsPost,
  type EventsReply,
  type OtfAvailability,
  type OtfCertificate,
  type OtfCreateJob,
  type OtfCreateResponse,
  type OtfErrorBody,
  type OtfEvent,
  type OtfJobStatus,
  type OtfSpecCard,
  type OtfValidation,
  type ResultPost,
  type ResultReply,
  type StopIntent,
  type StopIntentReply,
  type ValidationResultPost,
} from "./contract.ts";

type Schema = Record<string, unknown>;

const text = (maxLength: number, minLength = 1): Schema => ({ type: "string", minLength, maxLength });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const object = (properties: Record<string, Schema>, optional: readonly string[] = []): Schema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  properties,
});
const oneOf = (values: readonly (string | number)[]): Schema => ({ enum: [...values] });
const literal = (value: string | number | boolean): Schema => ({ const: value });
const array = (items: Schema, maxItems: number, minItems = 0): Schema => ({ type: "array", items, minItems, maxItems });
/** An array keyword set: every listed part appears exactly once (with maxItems equal to the list length). */
const onceEach = (parts: readonly string[]): Schema => ({
  allOf: parts.map((part) => ({ contains: { type: "object", properties: { part: { const: part } }, required: ["part"] }, minContains: 1, maxContains: 1 })),
});
const count = (maximum = Number.MAX_SAFE_INTEGER): Schema => ({ type: "integer", minimum: 0, maximum });

const UUID = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const SHA256 = { type: "string", pattern: "^[0-9a-f]{64}$" };
const COMMIT = { type: "string", pattern: "^[0-9a-f]{40}$" };
/** ISO 8601 UTC with optional milliseconds, as Date.prototype.toISOString writes it. */
const TIME = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$" };
/** Builder ids, revisions, boot ids, presets, models and candidate ids: short printable tokens. */
const TOKEN = (max = 200): Schema => ({ type: "string", pattern: `^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,${String(max - 1)}}$` });
const LABEL = text(120);
const USD = { type: "string", pattern: "^\\d{1,6}(?:\\.\\d{1,6})?$" };
const FILENAME = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$" };
const REASON = nullable(text(REASON_MAX_CHARS));
const BASE64_MAX = Math.ceil(PART_MAX_BYTES / 3) * 4;

const LANE_ID = oneOf(LANE_IDS);
const CRITERION_ID = oneOf(OTF_CRITERION_IDS);
const OUTCOME = oneOf(OTF_OUTCOMES);
const CELL = oneOf(CELL_VALUES);
const CELL_PAIR = object({ original_suite: CELL, added_checks: CELL });
const SIX_CELLS = object({ clean: CELL_PAIR, buggy: CELL_PAIR, fixed: CELL_PAIR });

/** The bug designer's bug_spec limits. */
const SPEC_CARD = object({
  title: text(160),
  where: text(800),
  change: text(1500),
  why_tests_miss: text(1200),
  checks_to_add: array(text(400), 6, 1),
  fix: text(1200),
});

const LANE_FILES = object({ change: { type: "boolean" }, checks: count(1000), fix: { type: "boolean" } });
const LANE_METER = object({ tokens_in: count(), tokens_out: count(), requests: count(), cost_microusd: count() });
const ROUND_RESULT = object({
  iteration: oneOf([1, 2, 3]),
  kind: oneOf(ROUND_KINDS),
  result: oneOf(ROUND_RESULTS),
  cells: nullable(SIX_CELLS),
  feedback: array(text(FEEDBACK_LINE_MAX_CHARS), 40),
  goose_ms: nullable(count()),
  qualify_ms: nullable(count()),
});

/** Event branches by type: [lane_id schema, data schema]. */
const PRODUCTION_EVENTS: Record<string, [Schema, Schema]> = {
  job_queued: [{ type: "null" }, object({ position: { type: "integer", minimum: 1, maximum: 1000 } })],
  builder_starting: [{ type: "null" }, object({ preset: TOKEN(), requested_at: TIME })],
  builder_ready: [{ type: "null" }, object({ cold_start_ms: count() })],
  builder_start_failed: [{ type: "null" }, object({ reason: oneOf(START_FAILURE_REASONS) })],
  job_claimed: [{ type: "null" }, object({ builder_revision: TOKEN() })],
  job_finished: [{ type: "null" }, object({ outcome: OUTCOME, reason: REASON })],
};
const BUILDER_EVENTS: Record<(typeof BUILDER_EVENT_TYPES)[number], [Schema, Schema]> = {
  lane_started: [LANE_ID, object({ model: TOKEN(), model_label: LABEL, agent: literal(AGENT_LABEL) })],
  lane_stage: [LANE_ID, object({ stage: oneOf(LANE_STAGES), iteration: count(3) })],
  lane_files: [LANE_ID, LANE_FILES],
  lane_meter: [LANE_ID, LANE_METER],
  round_finished: [LANE_ID, ROUND_RESULT],
  lane_finished: [LANE_ID, object({ outcome: oneOf(LANE_OUTCOMES), reason: REASON })],
  winner_selected: [{ type: "null" }, object({ lane_id: LANE_ID, candidate_id: TOKEN(), qualified_at_iteration: { type: "integer", minimum: 1, maximum: 3 } })],
  packaging: [{ type: "null" }, object({})],
};

const eventUnion = (branches: Record<string, [Schema, Schema]>, head: Record<string, Schema>): Schema => ({
  oneOf: Object.entries(branches).map(([type, [laneId, data]]) => object({ ...head, type: literal(type), lane_id: laneId, data })),
});

const OTF_EVENT = eventUnion({ ...PRODUCTION_EVENTS, ...BUILDER_EVENTS }, { seq: { type: "integer", minimum: 1 }, at: TIME });
const BUILDER_EVENT_IN = eventUnion(BUILDER_EVENTS, { builder_seq: { type: "integer", minimum: 1 }, at: TIME });

const LANE_VIEW = object({
  lane_id: LANE_ID,
  model: TOKEN(),
  model_label: LABEL,
  stage: oneOf(LANE_STAGES),
  iteration: count(3),
  files: LANE_FILES,
  meter: LANE_METER,
  rounds: array(ROUND_RESULT, 10),
  outcome: nullable(oneOf(LANE_OUTCOMES)),
});

const ARTIFACT = object({
  part: oneOf(OTF_PARTS),
  filename: FILENAME,
  media_type: oneOf(MEDIA_TYPES),
  size: count(PART_MAX_BYTES),
  sha256: SHA256,
  download_path: { type: "string", pattern: "^/api/factory/otf/jobs/[0-9a-f-]{36}/artifacts/(?:agent|grader|certificate)$" },
});

const CERTIFICATE = object({
  format: literal(CERTIFICATE_FORMAT),
  job_id: UUID,
  host_id: oneOf(OTF_HOST_IDS),
  app_base_commit: COMMIT,
  criterion: object({ criterion_id: CRITERION_ID, version: literal("1"), failure_code: TOKEN() }),
  spec_sha256: SHA256,
  designer: object({ model: TOKEN(), route: literal("bug-spec") }),
  implementer: object({
    lane_id: LANE_ID,
    agent: literal(AGENT_LABEL),
    provider: literal(TOKEN_FACTORY_PROVIDER),
    model: TOKEN(),
    rounds_used: { type: "integer", minimum: 1, maximum: 3 },
  }),
  qualification: object({ cells: SIX_CELLS, confirmation_cells: SIX_CELLS, result: literal("qualified") }),
  harness: object({
    tier: literal("B"),
    kit_image_id: TOKEN(),
    copy_limits: literal(COPY_LIMITS),
    instances: object({ clean: literal(1), buggy: literal(3), fixed: literal(3) }),
    runner: literal(CERTIFICATE_RUNNER),
    harness_sha256: SHA256,
  }),
  bundles: object({ agent_sha256: SHA256, grader_sha256: SHA256 }),
  spend: object({ model_microusd: count(), tokens_in: count(), tokens_out: count(), lanes: { type: "integer", minimum: 1, maximum: LANE_IDS.length } }),
  timings: object({ started_at: TIME, qualified_at: TIME, wall_ms: count() }),
  issued_at: TIME,
  builder_revision: TOKEN(),
  received: nullable(object({ at: TIME, sha256_verified: literal(true) })),
});

const VALIDATION = object({
  validation_id: UUID,
  state: oneOf(VALIDATION_STATES),
  cells: nullable(SIX_CELLS),
  started_at: TIME,
  finished_at: nullable(TIME),
  where: literal(VALIDATION_WHERE),
});

const JOB_STATUS = object({
  job_id: UUID,
  created_at: TIME,
  state: oneOf(OTF_JOB_STATES),
  queue_position: nullable({ type: "integer", minimum: 1, maximum: 1000 }),
  builder: oneOf(BUILDER_STATES),
  outcome: nullable(OUTCOME),
  reason: REASON,
  criterion_id: CRITERION_ID,
  spec: SPEC_CARD,
  spec_sha256: SHA256,
  deadline_at: nullable(TIME),
  elapsed_ms: count(),
  lanes: array(LANE_VIEW, LANE_IDS.length),
  events: array(OTF_EVENT, 5000),
  next_after: count(),
  poll_after_ms: { type: "integer", minimum: 500, maximum: 600_000 },
  spend: object({ model_microusd: count(), cap_microusd: count(), source: literal(SPEND_SOURCE) }),
  winner: nullable(object({ lane_id: LANE_ID, model: TOKEN() })),
  artifacts: array(ARTIFACT, OTF_PARTS.length),
  certificate: nullable(CERTIFICATE),
  validation: nullable(VALIDATION),
  catalog_request_id: nullable(UUID),
});

const SPEC_LANE = object({ lane_id: LANE_ID, model: TOKEN(), model_label: LABEL, price_in_usd_per_m: USD, price_out_usd_per_m: USD });
const BUILD_JOB = object({
  kind: literal("build"),
  job_id: UUID,
  host_id: oneOf(OTF_HOST_IDS),
  criterion_id: CRITERION_ID,
  spec: SPEC_CARD,
  spec_sha256: SHA256,
  sentence: text(SENTENCE_MAX_CHARS, SENTENCE_MIN_CHARS),
  lanes: array(SPEC_LANE, LANE_IDS.length, 1),
  limits: object({
    max_rounds: literal(3),
    max_usd_lane: USD,
    max_usd_job: USD,
    goose_max_tokens: literal(32768),
    deadline_at: TIME,
    confirm_rounds: literal(1),
  }),
});
const VALIDATE_JOB = object({
  kind: literal("validate"),
  job_id: UUID,
  validation_id: UUID,
  artifacts: { ...array(object({ part: oneOf(["agent", "grader"]), sha256: SHA256, size: count(PART_MAX_BYTES) }), 2, 2), ...onceEach(["agent", "grader"]) },
});

const RESULT_PART = object({
  part: oneOf(OTF_PARTS),
  filename: FILENAME,
  sha256: SHA256,
  size: { type: "integer", minimum: 1, maximum: PART_MAX_BYTES },
  base64: { type: "string", minLength: 4, maxLength: BASE64_MAX, pattern: "^[A-Za-z0-9+/]*={0,2}$" },
});

const SCHEMAS = {
  OtfSpecCard: SPEC_CARD,
  OtfCreateJob: object(
    {
      client_key: UUID,
      criterion_id: CRITERION_ID,
      sentence: text(SENTENCE_MAX_CHARS, SENTENCE_MIN_CHARS),
      spec: SPEC_CARD,
      spec_sha256: SHA256,
      catalog_request_id: UUID,
    },
    ["catalog_request_id"],
  ),
  OtfCreateResponse: object({ job_id: UUID, status: JOB_STATUS }),
  OtfJobStatus: JOB_STATUS,
  OtfAvailability: object({
    enabled: { type: "boolean" },
    builder: oneOf(BUILDER_STATES),
    active_jobs: count(1000),
    queued_jobs: count(1000),
    max_active: count(100),
    max_queued: count(1000),
    behaviors: array(object({ criterion_id: CRITERION_ID, label: LABEL, example_phrases: array(text(200), 10) }), OTF_CRITERION_IDS.length),
    lanes: array(object({ lane_id: LANE_ID, model_label: LABEL }), LANE_IDS.length),
    typical: object({
      median_min: { type: "number", minimum: 0, maximum: 600 },
      p90_min: { type: "number", minimum: 0, maximum: 600 },
      cold_start_min: nullable({ type: "number", minimum: 0, maximum: 600 }),
      basis: literal(TYPICAL_BASIS),
    }),
    spend_left_microusd: count(),
  }),
  OtfValidation: VALIDATION,
  OtfCertificate: CERTIFICATE,
  OtfEvent: OTF_EVENT,
  OtfErrorBody: object({
    contract_version: literal(OTF_CONTRACT_VERSION),
    error: object({ code: oneOf(OTF_ERROR_CODES), message: text(600), retryable: { type: "boolean" } }),
  }),
  ClaimRequest: object({
    builder_id: TOKEN(64),
    builder_revision: TOKEN(),
    boot_id: TOKEN(64),
    booted_at: TIME,
    images_ok: { type: "boolean" },
    free: object({ build: count(16), validate: count(16) }),
  }),
  ClaimReply: object({ job: { oneOf: [BUILD_JOB, VALIDATE_JOB] } }),
  BuilderEventIn: BUILDER_EVENT_IN,
  EventsPost: object({ builder_id: TOKEN(64), events: array(BUILDER_EVENT_IN, 500) }),
  EventsReply: object({ accepted_through: count(), control: object({ stop: { type: "boolean" }, reason: nullable(oneOf(STOP_REASONS)) }) }),
  ResultPost: {
    ...object({ builder_id: TOKEN(64), outcome: OUTCOME, reason: REASON, certificate: CERTIFICATE, parts: { ...array(RESULT_PART, OTF_PARTS.length, OTF_PARTS.length), ...onceEach(OTF_PARTS) } }, ["certificate", "parts"]),
    // certificate and parts exactly when delivered.
    if: { type: "object", properties: { outcome: { const: "delivered" } }, required: ["outcome"] },
    then: { type: "object", properties: { certificate: true, parts: true }, required: ["certificate", "parts"] },
    else: { not: { anyOf: [{ type: "object", properties: { certificate: true }, required: ["certificate"] }, { type: "object", properties: { parts: true }, required: ["parts"] }] } },
  },
  ResultReply: object({ job_id: UUID, state: literal("finished"), outcome: OUTCOME }),
  ValidationResultPost: object({ builder_id: TOKEN(64), state: oneOf(["passed", "failed", "error"]), cells: nullable(SIX_CELLS), finished_at: TIME }),
  StopIntent: object({ builder_id: TOKEN(64), boot_id: TOKEN(64), reason: oneOf(["idle", "max_uptime", "builder_fault"]), idle_since: nullable(TIME) }),
  StopIntentReply: object({ allow: { type: "boolean" }, reason: oneOf(["ok", "jobs_waiting", "operator_hold"]) }),
} as const;

export type OtfSchemaName = keyof typeof SCHEMAS;

/** The TypeScript type each schema checks. */
export interface OtfBodies {
  OtfSpecCard: OtfSpecCard;
  OtfCreateJob: OtfCreateJob;
  OtfCreateResponse: OtfCreateResponse;
  OtfJobStatus: OtfJobStatus;
  OtfAvailability: OtfAvailability;
  OtfValidation: OtfValidation;
  OtfCertificate: OtfCertificate;
  OtfEvent: OtfEvent;
  OtfErrorBody: OtfErrorBody;
  ClaimRequest: ClaimRequest;
  ClaimReply: ClaimReply;
  BuilderEventIn: BuilderEventIn;
  EventsPost: EventsPost;
  EventsReply: EventsReply;
  ResultPost: ResultPost;
  ResultReply: ResultReply;
  ValidationResultPost: ValidationResultPost;
  StopIntent: StopIntent;
  StopIntentReply: StopIntentReply;
}

const ajv = new Ajv2020({ strict: true, allErrors: true, unicodeRegExp: true });
const validators = new Map<string, ValidateFunction>(Object.entries(SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]));

function messages(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`);
}

/** The schema errors of value against name; empty when it matches. */
export function validateOtf(name: OtfSchemaName, value: unknown): string[] {
  const validate = validators.get(name);
  if (validate === undefined) throw new Error(`no OTF schema ${name}`);
  return validate(value) ? [] : messages(validate.errors);
}

/** A type guard over validateOtf. */
export function isOtf<N extends OtfSchemaName>(name: N, value: unknown): value is OtfBodies[N] {
  return validateOtf(name, value).length === 0;
}

/** The parsed value when it matches, or the errors. */
export function parseOtf<N extends OtfSchemaName>(name: N, value: unknown): { ok: true; value: OtfBodies[N] } | { ok: false; errors: string[] } {
  const errors = validateOtf(name, value);
  return errors.length === 0 ? { ok: true, value: value as OtfBodies[N] } : { ok: false, errors };
}
