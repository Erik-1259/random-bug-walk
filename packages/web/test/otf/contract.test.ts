// The OTF contract: canonical hashing both sides must agree on, the signing string, and every body
// schema against synthetic examples (invented values; no real job, model output or check content).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { builderEventBytes, canonicalJson, createSha256, sha256Hex, specSha256 } from "../../src/otf/canonical.ts";
import * as contract from "../../src/otf/contract.ts";
import {
  BUILDER_EVENT_TYPES,
  CRITERION_HOST,
  EXPECTED_CELLS,
  LANE_STAGE_NEXT,
  LANE_STAGES,
  OTF_CRITERION_IDS,
  OTF_HOST_DEFAULTS,
  OTF_HOST_IDS,
  PART_MAX_BYTES_BY_PART,
  RESULT_BODY_MAX_BYTES,
  criteriaOf,
  hostCalendarOpen,
  nextIteration,
  OTF_CREATE_REFUSALS,
  OTF_ERROR_CODES,
  OTF_ERROR_STATUS,
  OTF_JOB_STATES,
  OTF_OUTCOMES,
  PRODUCTION_EVENT_TYPES,
  StartError,
  builderSigningString,
  type BuilderEventIn,
  type OtfAvailability,
  type OtfCertificate,
  type OtfCreateJob,
  type OtfEvent,
  type OtfJobStatus,
  type OtfSpecCard,
  type ResultPost,
  type SixCells,
} from "../../src/otf/contract.ts";
import { isOtf, parseOtf, validateOtf } from "../../src/otf/schemas.ts";

const JOB = "00000000-0000-4000-8000-000000000001";
const CLIENT_REF = "00000000-0000-4000-8000-000000000002";
const VID = "00000000-0000-4000-8000-000000000003";
const T = "2026-10-29T10:00:00.000Z";
const H = "a".repeat(64);

const SPEC: OtfSpecCard = {
  title: "Synthetic: a saved edit can vanish",
  where: "The component that saves edits.",
  change: "Two quick saves can overwrite each other.",
  why_tests_miss: "The suite saves one edit at a time.",
  checks_to_add: ["Two overlapping saves both persist."],
  fix: "Serialize the saves.",
};

const node256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const create = async (extra: Partial<OtfCreateJob> = {}): Promise<OtfCreateJob> => ({
  client_key: CLIENT_REF,
  host_id: "task-report",
  criterion_id: "concurrency.lost-acknowledged-change",
  sentence: "My edit disappears when I save twice.",
  spec: SPEC,
  spec_sha256: await specSha256(SPEC),
  ...extra,
});

const CELLS: SixCells = structuredClone(EXPECTED_CELLS);

const CERTIFICATE: OtfCertificate = {
  format: "rbw-otf-certificate/0",
  job_id: JOB,
  host_id: "task-report",
  app_base_commit: "b".repeat(40),
  criterion: { criterion_id: "concurrency.lost-acknowledged-change", version: "1", failure_code: "synthetic-code" },
  spec_sha256: H,
  designer: { model: "synthetic-designer", route: "bug-spec" },
  implementer: { lane_id: "lane-1", agent: "goose 1.57.0", provider: "nebius-token-factory", model: "synthetic/model-a", rounds_used: 1 },
  qualification: { cells: CELLS, confirmation_cells: CELLS, admission: null, result: "qualified" },
  harness: {
    tier: "B",
    kit_image_id: "sha256:" + "c".repeat(64),
    copy_limits: "4 vCPU / 8192 MB",
    instances: { clean: 1, buggy: 3, fixed: 3 },
    runner: "docker on the RBW builder (Nebius VM)",
    harness_sha256: H,
  },
  bundles: { agent_sha256: H, grader_sha256: H },
  spend: { model_microusd: 900_000, tokens_in: 1000, tokens_out: 200, lanes: 3 },
  timings: { started_at: T, qualified_at: T, wall_ms: 600_000 },
  issued_at: T,
  builder_revision: "rev-1",
  received: null,
};

const EVENTS: OtfEvent[] = [
  { seq: 1, at: T, type: "builder_starting", lane_id: null, data: { preset: "preset-a", requested_at: T } },
  { seq: 2, at: T, type: "builder_ready", lane_id: null, data: { cold_start_ms: 150_000 } },
  { seq: 3, at: T, type: "job_queued", lane_id: null, data: { position: 1 } },
  { seq: 4, at: T, type: "job_claimed", lane_id: null, data: { builder_revision: "rev-1" } },
  { seq: 5, at: T, type: "lane_started", lane_id: "lane-1", data: { model: "synthetic/model-a", model_label: "Model A", agent: "goose 1.57.0" } },
  { seq: 6, at: T, type: "lane_stage", lane_id: "lane-1", data: { stage: "writing", iteration: 1 } },
  { seq: 7, at: T, type: "lane_files", lane_id: "lane-1", data: { change: true, checks: 2, fix: false } },
  { seq: 8, at: T, type: "lane_meter", lane_id: "lane-1", data: { tokens_in: 10, tokens_out: 5, requests: 1, cost_microusd: 30 } },
  {
    seq: 9,
    at: T,
    type: "round_finished",
    lane_id: "lane-1",
    data: { iteration: 1, kind: "qualification", result: "qualified", cells: CELLS, admission: null, feedback: ["synthetic line"], goose_ms: 1000, qualify_ms: 2000 },
  },
  { seq: 10, at: T, type: "winner_selected", lane_id: null, data: { lane_id: "lane-1", candidate_id: "cand-1", qualified_at_iteration: 1 } },
  { seq: 11, at: T, type: "lane_finished", lane_id: "lane-2", data: { outcome: "lost_race", reason: null } },
  { seq: 12, at: T, type: "packaging", lane_id: null, data: {} },
  { seq: 13, at: T, type: "builder_start_failed", lane_id: null, data: { reason: "capacity" } },
  { seq: 14, at: T, type: "job_finished", lane_id: null, data: { outcome: "delivered", reason: null } },
];

const status = (): OtfJobStatus => ({
  job_id: JOB,
  created_at: T,
  state: "finished",
  host_id: "task-report",
  queue_position: null,
  builder: "running",
  outcome: "delivered",
  reason: null,
  criterion_id: "concurrency.lost-acknowledged-change",
  spec: SPEC,
  spec_sha256: H,
  deadline_at: T,
  elapsed_ms: 1000,
  lanes: [
    {
      lane_id: "lane-1",
      model: "synthetic/model-a",
      model_label: "Model A",
      stage: "won",
      iteration: 1,
      files: { change: true, checks: 2, fix: true },
      meter: { tokens_in: 10, tokens_out: 5, requests: 1, cost_microusd: 30 },
      rounds: [],
      outcome: "won",
    },
  ],
  events: EVENTS,
  next_after: 14,
  poll_after_ms: 30_000,
  spend: { model_microusd: 30, cap_microusd: 5_000_000, source: "builder proxy meter (upper bound)" },
  winner: { lane_id: "lane-1", model: "synthetic/model-a" },
  artifacts: [{ part: "agent", filename: "rbw-otf-agent-00000000.tar.gz", media_type: "application/gzip", size: 100, sha256: H, download_path: `/api/factory/otf/jobs/${JOB}/artifacts/agent` }],
  certificate: { ...CERTIFICATE, received: { at: T, sha256_verified: true } },
  validation: { validation_id: VID, state: "passed", cells: CELLS, admission: null, started_at: T, finished_at: T, where: "RBW builder (Nebius VM)" },
  catalog_request_id: null,
});

const availability = (): OtfAvailability => ({
  enabled: true,
  builder: "stopped",
  active_jobs: 0,
  queued_jobs: 0,
  max_queued: 4,
  behaviors: [{ criterion_id: "concurrency.lost-acknowledged-change", host_id: "task-report", label: "Lost change", example_phrases: ["my edit vanished"] }],
  hosts: [
    {
      host_id: "task-report",
      label: "task-report service",
      offered: true,
      unavailable_reason: null,
      active_jobs: 0,
      queued_jobs: 0,
      max_active: 2,
      lanes: [{ lane_id: "lane-1", model_label: "Model A" }],
      deadline_min: 45,
      typical: null,
    },
    {
      host_id: "umami",
      label: "Umami",
      offered: false,
      unavailable_reason: "calendar",
      active_jobs: 0,
      queued_jobs: 0,
      max_active: 1,
      lanes: [{ lane_id: "lane-1", model_label: "Model A" }],
      deadline_min: 60,
      typical: null,
    },
  ],
  cold_start_min: null,
  spend_left_microusd: 1_000_000,
});

const BUILD_LIMITS = { max_rounds: 3, max_usd_lane: "2.00", max_usd_job: "5.00", goose_max_tokens: 32768, deadline_at: T, confirm_rounds: 1, round_min_remaining_ms: 0 };

describe("canonicalJson", () => {
  it("sorts keys at every depth, drops undefined members and adds no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: true, y: null }], c: "x" }, u: undefined })).toBe('{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}');
  });
  it("refuses values that are not plain JSON", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });
});

describe("hashes", () => {
  it("sha256Hex matches node:crypto on non-ASCII text", async () => {
    expect(await sha256Hex("édit ✓")).toBe(node256("édit ✓"));
  });
  it("spec_sha256 is independent of key order and ignores members outside the card", async () => {
    const reordered = { fix: SPEC.fix, checks_to_add: SPEC.checks_to_add, why_tests_miss: SPEC.why_tests_miss, change: SPEC.change, where: SPEC.where, title: SPEC.title };
    const extra = { ...SPEC, in_scope: true } as OtfSpecCard;
    const expected = node256(canonicalJson(SPEC));
    expect(await specSha256(SPEC)).toBe(expected);
    expect(await specSha256(reordered)).toBe(expected);
    expect(await specSha256(extra)).toBe(expected);
    expect(await specSha256({ ...SPEC, fix: SPEC.fix + " " })).not.toBe(expected);
  });
  it("the create hash changes with any member, catalog_request_id included", async () => {
    const base = await createSha256(await create());
    expect(await createSha256(await create())).toBe(base);
    expect(await createSha256(await create({ catalog_request_id: VID }))).not.toBe(base);
    expect(await createSha256(await create({ sentence: "My edit disappears when I save two times." }))).not.toBe(base);
  });
  it("builder event bytes ignore key order", () => {
    const a: BuilderEventIn = { builder_seq: 1, at: T, type: "lane_files", lane_id: "lane-1", data: { change: true, checks: 1, fix: false } };
    const b = { data: { fix: false, checks: 1, change: true }, lane_id: "lane-1", type: "lane_files", at: T, builder_seq: 1 } as BuilderEventIn;
    expect(builderEventBytes(a)).toBe(builderEventBytes(b));
    expect(builderEventBytes(a)).not.toBe(builderEventBytes({ ...a, data: { ...a.data, checks: 2 } }));
  });
  it("the signing string is ts, METHOD, path and body hash on four lines", () => {
    expect(builderSigningString("1761732000000", "post", "/api/factory/otf/builder/claim", H)).toBe(`1761732000000\nPOST\n/api/factory/otf/builder/claim\n${H}`);
  });
});

describe("contract constants", () => {
  it("applies the on-demand lifecycle", () => {
    expect(OTF_JOB_STATES).toEqual(["queued", "starting_builder", "building", "finished"]);
    expect(OTF_OUTCOMES).toContain("builder_start_failed");
    expect(OTF_CREATE_REFUSALS).not.toContain("builder_offline" as never);
    expect(PRODUCTION_EVENT_TYPES).toEqual(expect.arrayContaining(["builder_starting", "builder_ready", "builder_start_failed"]));
  });
  it("maps every error code to a status, and keeps production and builder event types apart", () => {
    expect(Object.keys(OTF_ERROR_STATUS).sort()).toEqual([...OTF_ERROR_CODES].sort());
    expect(PRODUCTION_EVENT_TYPES.filter((type) => (BUILDER_EVENT_TYPES as readonly string[]).includes(type))).toEqual([]);
  });
  it("freezes the expected six cells", () => {
    expect(Object.isFrozen(EXPECTED_CELLS) && Object.isFrozen(EXPECTED_CELLS.buggy)).toBe(true);
    expect(EXPECTED_CELLS.buggy).toEqual({ original_suite: "pass", added_checks: "fail" });
  });
  it("StartError carries its reason", () => {
    const error = new StartError("capacity", "no capacity");
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe("capacity");
  });
});

describe("customer schemas", () => {
  it("accepts a create body with and without catalog_request_id", async () => {
    expect(validateOtf("OtfCreateJob", await create())).toEqual([]);
    expect(validateOtf("OtfCreateJob", await create({ catalog_request_id: VID }))).toEqual([]);
  });
  it("refuses unknown members, short sentences, oversized cards and bad hashes", async () => {
    const body = await create();
    expect(validateOtf("OtfCreateJob", { ...body, extra: 1 })).not.toEqual([]);
    expect(validateOtf("OtfCreateJob", { ...body, sentence: "hi" })).not.toEqual([]);
    expect(validateOtf("OtfCreateJob", { ...body, spec: { ...SPEC, checks_to_add: [] } })).not.toEqual([]);
    expect(validateOtf("OtfCreateJob", { ...body, spec: { ...SPEC, checks_to_add: Array(7).fill("x") } })).not.toEqual([]);
    expect(validateOtf("OtfCreateJob", { ...body, spec: { ...SPEC, in_scope: true } })).not.toEqual([]);
    expect(validateOtf("OtfCreateJob", { ...body, spec_sha256: "A".repeat(64) })).not.toEqual([]);
    expect(validateOtf("OtfCreateJob", { ...body, client_key: "not-a-uuid" })).not.toEqual([]);
    expect(validateOtf("OtfCreateJob", { ...body, criterion_id: "timezone.wrong-day" })).not.toEqual([]);
  });
  it("accepts a full status with every event type and refuses a job event that carries a lane", () => {
    const value = status();
    expect(validateOtf("OtfJobStatus", value)).toEqual([]);
    expect(validateOtf("OtfCreateResponse", { job_id: JOB, status: value })).toEqual([]);
    const bad = { ...value, events: [{ seq: 1, at: T, type: "job_queued", lane_id: "lane-1", data: { position: 1 } }] };
    expect(validateOtf("OtfJobStatus", bad)).not.toEqual([]);
    expect(validateOtf("OtfJobStatus", { ...value, state: "waiting_for_builder" })).not.toEqual([]);
    expect(validateOtf("OtfJobStatus", { ...value, builder: "online" })).not.toEqual([]);
  });
  it("accepts availability with an unmeasured cold start", () => {
    const value = availability();
    expect(validateOtf("OtfAvailability", value)).toEqual([]);
    expect(isOtf("OtfAvailability", { ...value, cold_start_min: 3 })).toBe(true);
    expect(isOtf("OtfAvailability", { ...value, builder: "offline" })).toBe(false);
    expect(isOtf("OtfAvailability", { ...value, hosts: [value.hosts[0], value.hosts[0]] })).toBe(false);
  });
  it("accepts every error code in an error body", () => {
    for (const code of OTF_ERROR_CODES) {
      expect(validateOtf("OtfErrorBody", { contract_version: "otf/0", error: { code, message: "Synthetic.", retryable: false } })).toEqual([]);
    }
    expect(validateOtf("OtfErrorBody", { contract_version: "otf/0", error: { code: "builder_offline", message: "x", retryable: false } })).not.toEqual([]);
  });
});

describe("builder schemas", () => {
  it("accepts a claim and both job kinds", () => {
    const claim = {
      builder_id: "builder-1",
      builder_revision: "rev-1",
      boot_id: "boot-1",
      booted_at: T,
      images_ok: true,
      free: { build: { "task-report": 2, umami: 1 }, validate: { "task-report": 1, umami: 1 } },
      ready_hosts: ["task-report", "umami"],
    };
    expect(validateOtf("ClaimRequest", claim)).toEqual([]);
    expect(validateOtf("ClaimRequest", { ...claim, free: { build: 2, validate: 1 } })).not.toEqual([]);
    expect(validateOtf("ClaimRequest", { ...claim, ready_hosts: ["umami", "umami"] })).not.toEqual([]);
    const build = {
      kind: "build",
      job_id: JOB,
      host_id: "task-report",
      criterion_id: "concurrency.lost-acknowledged-change",
      spec: SPEC,
      spec_sha256: H,
      sentence: "My edit disappears when I save twice.",
      lanes: [{ lane_id: "lane-1", model: "synthetic/model-a", model_label: "Model A", price_in_usd_per_m: "0.10", price_out_usd_per_m: "0.40" }],
      limits: BUILD_LIMITS,
    };
    expect(validateOtf("ClaimReply", { job: build })).toEqual([]);
    expect(validateOtf("ClaimReply", { job: { ...build, host_id: "umami" } })).not.toEqual([]);
    const umami = { ...build, host_id: "umami", criterion_id: "date_time.time-zone-grouping", limits: { ...BUILD_LIMITS, confirm_rounds: 0, round_min_remaining_ms: 660_000 } };
    expect(validateOtf("ClaimReply", { job: umami })).toEqual([]);
    const validate = { kind: "validate", job_id: JOB, host_id: "task-report", validation_id: VID, artifacts: [{ part: "agent", sha256: H, size: 10 }, { part: "grader", sha256: H, size: 10 }] };
    expect(validateOtf("ClaimReply", { job: validate })).toEqual([]);
    expect(validateOtf("ClaimReply", { job: { ...validate, artifacts: [validate.artifacts[0], validate.artifacts[0]] } })).not.toEqual([]);
  });
  it("accepts builder event posts and refuses production event types in them", () => {
    const events = EVENTS.filter((event) => (BUILDER_EVENT_TYPES as readonly string[]).includes(event.type)).map(({ seq, ...rest }) => ({ ...rest, builder_seq: seq }));
    expect(events.length).toBe(BUILDER_EVENT_TYPES.length);
    expect(validateOtf("EventsPost", { builder_id: "builder-1", events })).toEqual([]);
    expect(validateOtf("EventsPost", { builder_id: "builder-1", events: [] })).toEqual([]);
    const forged = { builder_seq: 1, at: T, type: "job_finished", lane_id: null, data: { outcome: "delivered", reason: null } };
    expect(validateOtf("EventsPost", { builder_id: "builder-1", events: [forged] })).not.toEqual([]);
    expect(validateOtf("EventsPost", { builder_id: "builder-1", events: [{ ...events[0], seq: 1 }] })).not.toEqual([]);
    expect(validateOtf("EventsReply", { accepted_through: 3, control: { stop: true, reason: "customer" } })).toEqual([]);
  });
  it("requires certificate and parts exactly when the result is delivered", () => {
    const part = (name: "agent" | "grader" | "certificate") => ({ part: name, filename: `rbw-otf-${name}-00000000.tar.gz`, sha256: H, size: 3, base64: "H4sI" });
    const delivered: ResultPost = { builder_id: "builder-1", outcome: "delivered", reason: null, certificate: CERTIFICATE, parts: [part("agent"), part("grader"), part("certificate")] };
    expect(validateOtf("ResultPost", delivered)).toEqual([]);
    expect(validateOtf("ResultPost", { ...delivered, parts: undefined })).not.toEqual([]);
    expect(validateOtf("ResultPost", { builder_id: "builder-1", outcome: "not_qualified", reason: "No lane qualified." })).toEqual([]);
    expect(validateOtf("ResultPost", { builder_id: "builder-1", outcome: "error", reason: null, parts: delivered.parts })).not.toEqual([]);
    expect(validateOtf("ResultPost", { ...delivered, parts: [part("agent"), part("grader"), { ...part("certificate"), filename: "../x" }] })).not.toEqual([]);
    expect(validateOtf("ResultPost", { ...delivered, parts: [part("agent"), part("agent"), part("certificate")] })).not.toEqual([]);
  });
  it("accepts validation results and stop intents", () => {
    expect(validateOtf("ValidationResultPost", { builder_id: "builder-1", state: "passed", cells: CELLS, admission: null, finished_at: T })).toEqual([]);
    expect(validateOtf("ValidationResultPost", { builder_id: "builder-1", state: "running", cells: null, admission: null, finished_at: T })).not.toEqual([]);
    expect(validateOtf("StopIntent", { builder_id: "builder-1", boot_id: "boot-1", reason: "idle", idle_since: T })).toEqual([]);
    expect(validateOtf("StopIntentReply", { allow: false, reason: "jobs_waiting" })).toEqual([]);
  });
  it("parseOtf returns the value or the errors", () => {
    const parsed = parseOtf("StopIntentReply", { allow: true, reason: "ok" });
    expect(parsed.ok && parsed.value.allow).toBe(true);
    const failed = parseOtf("StopIntentReply", { allow: true });
    expect(failed.ok).toBe(false);
  });
});

const ADMISSION_PASS = {
  decisions: { adm_02: "pass", adm_03: "pass", adm_04: "pass", adm_05: "pass", adm_06: "pass" },
  comparison: "blind_spot_demonstrated",
  alternative_fix: "pass",
} as const;

const UMAMI_CERTIFICATE: OtfCertificate = {
  ...CERTIFICATE,
  host_id: "umami",
  criterion: { criterion_id: "date_time.time-zone-grouping", version: "1", failure_code: "synthetic_code" },
  implementer: { ...CERTIFICATE.implementer, lane_id: "lane-2" },
  spend: { ...CERTIFICATE.spend, lanes: 2 },
  qualification: { cells: CELLS, confirmation_cells: null, admission: ADMISSION_PASS, result: "qualified" },
  harness: {
    tier: "admission",
    kit_sha256: "d".repeat(64),
    kit_image_id: "sha256:" + "e".repeat(64),
    added_suite_sha256: "f".repeat(64),
    runtime_image_digest: "sha256:" + "1".repeat(64),
    original_suite: { test_count: 10, sha256: "2".repeat(64) },
    copy_limits: "4 vCPU / 8192 MB",
    copies: { kit_check_clean: 5, observe_planted: 1, clean: 1, planted: 5, fixed: 5, partial: 1, stub: 1 },
    repetitions: 20,
    evidence: "development evidence: the local runner's admission sequence, not an RBW release",
    runner: "docker on the RBW builder (Nebius VM)",
    harness_sha256: H,
  },
};

describe("hosts and the Umami profile", () => {
  it("pairs every criterion with one host and lists each host's criteria", () => {
    expect(Object.keys(CRITERION_HOST)).toEqual([...OTF_CRITERION_IDS]);
    expect(criteriaOf("umami")).toEqual(["date_time.time-zone-grouping"]);
    expect(criteriaOf("task-report")).toEqual(["concurrency.lost-acknowledged-change", "concurrency.stale-success-response"]);
    expect(Object.keys(OTF_HOST_DEFAULTS).sort()).toEqual([...OTF_HOST_IDS].sort());
    expect(OTF_HOST_DEFAULTS.umami.deadline_ms).toBeGreaterThan(OTF_HOST_DEFAULTS.umami.round_min_remaining_ms);
  });
  it("refuses a create whose host and criterion do not pair, and hashes the host", async () => {
    expect(validateOtf("OtfCreateJob", await create({ host_id: "umami" }))).not.toEqual([]);
    const umami = await create({ host_id: "umami", criterion_id: "date_time.time-zone-grouping" });
    expect(validateOtf("OtfCreateJob", umami)).toEqual([]);
    expect(await createSha256(umami)).not.toBe(await createSha256(await create({ criterion_id: "date_time.time-zone-grouping" })));
  });
  it("accepts an Umami certificate with an admission harness and refuses mixed shapes", () => {
    expect(validateOtf("OtfCertificate", UMAMI_CERTIFICATE)).toEqual([]);
    expect(validateOtf("OtfCertificate", { ...UMAMI_CERTIFICATE, harness: CERTIFICATE.harness })).not.toEqual([]);
    expect(validateOtf("OtfCertificate", { ...CERTIFICATE, qualification: { ...CERTIFICATE.qualification, confirmation_cells: null } })).not.toEqual([]);
    const decisions = { ...ADMISSION_PASS.decisions, adm_04: "reject" };
    expect(validateOtf("OtfCertificate", { ...UMAMI_CERTIFICATE, qualification: { ...UMAMI_CERTIFICATE.qualification, admission: { ...ADMISSION_PASS, decisions } } })).not.toEqual([]);
    const caught = { ...ADMISSION_PASS, comparison: "caught_by_original_suite" };
    expect(validateOtf("OtfCertificate", { ...UMAMI_CERTIFICATE, qualification: { ...UMAMI_CERTIFICATE.qualification, admission: caught } })).not.toEqual([]);
    expect(validateOtf("OtfCertificate", { ...UMAMI_CERTIFICATE, criterion: CERTIFICATE.criterion })).not.toEqual([]);
  });
  it("carries admission on rounds and validations", () => {
    const admission = { decisions: { ...ADMISSION_PASS.decisions, adm_04: "reject" }, comparison: "not_demonstrated", alternative_fix: "not_run" };
    const round = { builder_seq: 1, at: T, type: "round_finished", lane_id: "lane-1", data: { iteration: 1, kind: "qualification", result: "not_qualified", cells: null, admission, feedback: [], goose_ms: 1000, qualify_ms: 2000 } };
    expect(validateOtf("BuilderEventIn", round)).toEqual([]);
    const withoutAdmission = Object.fromEntries(Object.entries(round.data).filter(([key]) => key !== "admission"));
    expect(validateOtf("BuilderEventIn", { ...round, data: withoutAdmission })).not.toEqual([]);
    expect(validateOtf("OtfValidation", { validation_id: VID, state: "failed", cells: CELLS, admission, started_at: T, finished_at: T, where: "RBW builder (Nebius VM)" })).toEqual([]);
    expect(validateOtf("ValidationResultPost", { builder_id: "builder-1", state: "failed", cells: CELLS, admission, finished_at: T })).toEqual([]);
  });
  it("caps each result part and keeps a full result under the body limit", () => {
    const base64Max = (bytes: number): number => Math.ceil(bytes / 3) * 4;
    const part = (name: "agent" | "grader" | "certificate", size = 3) => ({ part: name, filename: `rbw-otf-${name}-00000000.tar.gz`, sha256: H, size, base64: "H4sI" });
    const delivered = { builder_id: "builder-1", outcome: "delivered", reason: null, certificate: CERTIFICATE };
    expect(validateOtf("ResultPost", { ...delivered, parts: [part("agent", 2 * 1024 * 1024), part("grader", 512 * 1024), part("certificate", 64 * 1024)] })).toEqual([]);
    expect(validateOtf("ResultPost", { ...delivered, parts: [part("agent"), part("grader", 512 * 1024 + 1), part("certificate")] })).not.toEqual([]);
    expect(validateOtf("ResultPost", { ...delivered, parts: [part("agent"), part("grader"), part("certificate", 64 * 1024 + 1)] })).not.toEqual([]);
    const parts = Object.values(PART_MAX_BYTES_BY_PART).reduce((sum, bytes) => sum + base64Max(bytes), 0);
    expect(parts + 64 * 1024 + 16 * 1024).toBeLessThanOrEqual(RESULT_BODY_MAX_BYTES);
    expect(RESULT_BODY_MAX_BYTES).toBeLessThan(4_500_000);
  });
  it("opens the Umami calendar only off UTC days 2 to 5", () => {
    const at = (iso: string): number => Date.parse(iso);
    expect(hostCalendarOpen("umami", at("2026-11-01T23:00:00Z"), at("2026-11-01T23:30:00Z"))).toBe(true);
    expect(hostCalendarOpen("umami", at("2026-11-06T00:00:00Z"), at("2026-11-06T01:00:00Z"))).toBe(true);
    expect(hostCalendarOpen("umami", at("2026-11-02T10:00:00Z"), at("2026-11-02T11:00:00Z"))).toBe(false);
    expect(hostCalendarOpen("umami", at("2026-11-05T22:00:00Z"), at("2026-11-05T23:00:00Z"))).toBe(false);
    expect(hostCalendarOpen("umami", at("2026-11-01T23:30:00Z"), at("2026-11-02T00:10:00Z"))).toBe(false);
    expect(hostCalendarOpen("task-report", at("2026-11-02T10:00:00Z"), at("2026-11-05T11:00:00Z"))).toBe(true);
  });
  it("keeps the lane stage order and the iteration rule", () => {
    expect(Object.keys(LANE_STAGE_NEXT)).toEqual([...LANE_STAGES]);
    for (const stage of ["won", "stopped", "not_qualified", "error"] as const) expect(LANE_STAGE_NEXT[stage]).toEqual([]);
    expect(LANE_STAGE_NEXT.qualifying).toContain("won");
    expect(nextIteration("writing", 2)).toBe(1);
    expect(nextIteration("revising", 1)).toBe(2);
    expect(nextIteration("qualifying", 2)).toBe(2);
  });
  it("accepts a measured typical time and refuses a basis string or too few samples", () => {
    const value = availability();
    const withTypical = (typical: unknown) => ({ ...value, hosts: [{ ...value.hosts[0], typical }, value.hosts[1]] });
    const typical = { median_min: 20, p90_min: 40, samples: 5, measured_on: "2026-10-30" };
    expect(validateOtf("OtfAvailability", withTypical(typical))).toEqual([]);
    expect(validateOtf("OtfAvailability", withTypical({ ...typical, samples: 4 }))).not.toEqual([]);
    expect(validateOtf("OtfAvailability", withTypical({ ...typical, basis: "synthetic basis" }))).not.toEqual([]);
    expect("TYPICAL_BASIS" in contract).toBe(false);
  });
  it("accepts lane outcome time_limit and a ResultReply", () => {
    const finished = { builder_seq: 1, at: T, type: "lane_finished", lane_id: "lane-1", data: { outcome: "time_limit", reason: null } };
    expect(validateOtf("BuilderEventIn", finished)).toEqual([]);
    expect(validateOtf("ResultReply", { job_id: JOB, state: "finished", outcome: "delivered" })).toEqual([]);
    expect(validateOtf("ResultReply", { job_id: JOB, state: "building", outcome: "delivered" })).not.toEqual([]);
  });
});
