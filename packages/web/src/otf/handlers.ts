// OTF SPEC sections 2 and 5: customer admission and responses, separate from catalog execution.
import { randomUUID } from "node:crypto";
import { designSecurityTopic, holdsCode, securityTopic } from "../assist/safety.ts";
import { loadFactoryConfig } from "../config.ts";
import { readBody } from "../factory-server/http.ts";
import { hasFactorySession } from "../factory-server/session.ts";
import { createSha256, sha256Hex, specSha256 } from "./canonical.ts";
import {
  BUILDER_LOST_MS, CALENDAR_MARGIN_MS, CRITERION_HOST, HOST_CALENDAR_BLOCKS, HOST_SCOPE_EXCLUDED,
  OTF_CONTRACT_VERSION, OTF_ERROR_STATUS, OTF_HOST_DEFAULTS, OTF_OPEN_CRITERION_ID, OTF_HOST_IDS, OTF_HOST_LABELS, OTF_JOB_STATES,
  OTF_PARTS, PART_MAX_BYTES, POLL_FINISHED_MS, POLL_RUNNING_MS, SAFE_FILENAME, SPEND_SOURCE,
  START_TIMEOUT_MS, VALIDATION_WHERE, hostCalendarOpen,
  type BuilderState, type HostUnavailableReason, type LaneId, type OtfArtifact, type OtfBehaviorOption,
  type OtfBuilderInfo, type OtfCreateJob, type OtfErrorCode, type OtfHostAvailability, type OtfHostId,
  type OtfJobRecord, type OtfJobStatus, type OtfOutcome, type OtfPowerRecord, type OtfStore, type OtfTypical,
  type OtfValidation, type OtfValidationRecord, type VmPower,
} from "./contract.ts";
import { projectLanes } from "./projection.ts";
import { isOtf, type OtfBodies, type OtfSchemaName } from "./schemas.ts";

/** Structural W5 interface: injected until the conductor composes the runtime modules. */
export interface OtfPowerDependencies {
  store: OtfStore;
  power: VmPower | null;
  now: () => Date;
  vmHoursPerDay?: number;
}
export type OtfStartBlock = "unconfigured" | "hold" | "day_cap" | "start_backoff";
export type OtfStartResult =
  | { kind: "started"; requested_at: string }
  | { kind: "running" | "starting" | "deferred" }
  | { kind: "failed"; reason: "capacity" | "api_error" }
  | { kind: "unavailable"; block: OtfStartBlock };
export interface OtfCustomerLifecycle {
  requestStart(input: OtfPowerDependencies): Promise<OtfStartResult>;
  runWatchdog(input: OtfPowerDependencies): Promise<{ action: "none" | "get" | "start" | "stop"; reason: string | null; timed_out: number }>;
  builderState(power: OtfPowerRecord, lastSeenAt: string | null, now: Date): BuilderState;
}

/** One host's profile as the customer routes need it (W1's config supplies the values). */
export interface OtfCustomerHostConfig {
  /** false when the host's lanes are not configured: the host is disabled (fail closed per host). */
  enabled: boolean;
  lanes: { lane_id: LaneId; model: string; model_label: string }[];
  /** Build jobs of this host running at once. */
  maxActive: number;
  /** The host's max_usd_job, in micro-USD. */
  jobSpendCapMicrousd: number;
  /** From claim to the job deadline. */
  deadlineMs: number;
  typical: OtfTypical | null;
}

export interface OtfCustomerConfig {
  enabled: boolean;
  builderSecretConfigured: boolean;
  passcode: string | null;
  maxQueued: number;
  maxPerDay: number;
  totalSpendCapMicrousd: number;
  vmHoursPerDay: number;
  /** Every configured behavior. Availability lists those of offered hosts only. */
  behaviors: OtfBehaviorOption[];
  hosts: Record<OtfHostId, OtfCustomerHostConfig>;
  coldStartMin: number | null;
}

export interface OtfCustomerDependencies {
  store: OtfStore;
  power: VmPower | null;
  lifecycle: OtfCustomerLifecycle;
  config: OtfCustomerConfig;
  /**
   * An optional extra trusted, non-model scope check. The deterministic check (cardInScope) always
   * runs first; safety checks alone never establish scope.
   */
  inScope?: (input: OtfCreateJob) => Promise<boolean>;
  now?: () => Date;
  id?: () => string;
}

const MESSAGES: Record<OtfErrorCode, string> = {
  busy: "The custom build queue is full.", daily_cap: "The daily custom build limit has been reached.",
  spend_cap: "The custom build model budget has been reached.", refused_topic: "This request is outside the supported design topics.",
  invalid_spec: "The accepted design is invalid or outside the offered scope.",
  idempotency_conflict: "This client key already identifies a different request.", signed_out: "Sign in to continue.",
  host_unavailable: "Custom builds on this host are unavailable right now.",
  unavailable: "Custom builds are unavailable right now.", invalid_request: "The request is invalid.",
  not_found: "This custom build was not found.", not_delivered: "This custom build has not delivered artifacts.",
  job_finished: "This custom build has finished.", event_conflict: "The event conflicts with the stored stream.",
  unauthorized: "The request is not authorized.",
};
/** How a start that W5 refuses after insertion finishes the new job. */
const START_BLOCK_FINISH: Record<OtfStartBlock, { outcome: OtfOutcome; reason: string }> = {
  unconfigured: { outcome: "builder_unavailable", reason: "The builder machine could not be started: its power control is not configured." },
  hold: { outcome: "builder_unavailable", reason: "Custom builds were put on hold before the builder machine started." },
  day_cap: { outcome: "builder_unavailable", reason: "The builder machine's hours for today were used up before it started." },
  start_backoff: { outcome: "builder_start_failed", reason: "The builder machine failed to start several times; starts are paused for now." },
};
const JSON_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WAITING = ["queued", "starting_builder"] as const;
function failure(code: OtfErrorCode): Response {
  return Response.json({ contract_version: OTF_CONTRACT_VERSION, error: {
    code, message: MESSAGES[code], retryable: code === "unavailable" || code === "busy",
  } } satisfies OtfBodies["OtfErrorBody"], { status: OTF_ERROR_STATUS[code], headers: JSON_HEADERS });
}
function json<N extends OtfSchemaName>(name: N, body: OtfBodies[N], status = 200): Response {
  return isOtf(name, body) ? Response.json(body, { status, headers: JSON_HEADERS }) : failure("unavailable");
}
function validationView(value: OtfValidationRecord | null): OtfValidation | null {
  if (value === null) return null;
  return { validation_id: value.validation_id, state: value.state, cells: value.cells, admission: value.admission,
    started_at: value.started_at, finished_at: value.finished_at, where: VALIDATION_WHERE };
}
function unavailable(config: OtfCustomerConfig, power: OtfPowerRecord, at: string): boolean {
  const day = at.slice(0, 10);
  const closed = power.vm_day === day ? power.vm_seconds_today : 0;
  // W5 keeps the currently billed interval open until it observes a stopped instance.
  const open = power.running_since === null ? 0
    : Math.max(0, Date.parse(at) - Math.max(Date.parse(power.running_since), Date.parse(`${day}T00:00:00.000Z`))) / 1000;
  return !config.enabled || (power.hold_until !== null && Date.parse(power.hold_until) > Date.parse(at))
    || closed + open >= config.vmHoursPerDay * 3600;
}

/** The customer-facing reason for a host's calendar block, e.g. "Umami is unavailable on UTC days 2–5." */
export function calendarReason(host: OtfHostId): string {
  const block = HOST_CALENDAR_BLOCKS[host];
  const days = block === undefined ? "" : ` on UTC days ${String(block.first_utc_day)}–${String(block.last_utc_day)}`;
  return `${OTF_HOST_LABELS[host]} is unavailable${days}.`;
}

/**
 * SPEC section 2.1 step 4, deterministic: the criterion is configured for the host CRITERION_HOST
 * names, every card field passes the designer safety checks, and no card field touches the host's
 * HOST_SCOPE_EXCLUDED topics. Whether the host is offered right now is step 6a, not this check.
 */
export function cardInScope(config: Pick<OtfCustomerConfig, "behaviors">, input: OtfCreateJob): boolean {
  // Open behaviors are not accepted until RBW_OTF_OPEN_BEHAVIORS exists (SPEC section 8).
  if (input.criterion_id === OTF_OPEN_CRITERION_ID) return false;
  const host = CRITERION_HOST[input.criterion_id];
  if (input.host_id !== host) return false;
  if (!config.behaviors.some((behavior) => behavior.criterion_id === input.criterion_id && behavior.host_id === host)) return false;
  const fields = [input.spec.title, input.spec.where, input.spec.change, input.spec.why_tests_miss, input.spec.fix, ...input.spec.checks_to_add];
  if (fields.some((field) => designSecurityTopic(field) || holdsCode(field))) return false;
  const excluded = HOST_SCOPE_EXCLUDED[host];
  return excluded === undefined || !fields.some((field) => excluded.test(field));
}

export function createCustomerHandlers(deps: OtfCustomerDependencies) {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const id = deps.id ?? randomUUID;
  const lifecycleInput = (): OtfPowerDependencies => ({ store, power: deps.power, now, vmHoursPerDay: config.vmHoursPerDay });
  type Seen = (OtfBuilderInfo & { last_seen_at: string }) | null;
  async function currentBuilder(at: string): Promise<{ builder: BuilderState; seen: Seen }> {
    const seen = await store.lastBuilderSeen();
    return { builder: deps.lifecycle.builderState(await store.getPower(), seen?.last_seen_at ?? null, new Date(at)), seen };
  }
  /** Section 2.1 step 6a and availability: why a host cannot take a new job now, or null. */
  function hostBlock(host: OtfHostId, at: string, builder: BuilderState, seen: Seen): HostUnavailableReason | null {
    const profile = config.hosts[host];
    if (!profile.enabled) return "disabled";
    const from = Date.parse(at);
    if (!hostCalendarOpen(host, from, from + START_TIMEOUT_MS + profile.deadlineMs + CALENDAR_MARGIN_MS)) return "calendar";
    // A stopped or starting builder has no fresh heartbeat, so readiness is not checked then.
    if (builder === "running" && !(seen?.ready_hosts ?? []).includes(host)) return "builder_not_ready";
    return null;
  }
  async function guard(request: Request, session: boolean, run: () => Promise<Response>): Promise<Response> {
    try {
      if (!config.builderSecretConfigured || !config.passcode || deps.power === null) return failure("unavailable");
      if (session && !hasFactorySession(request, config.passcode)) return failure("signed_out");
      return await run();
    } catch {
      // Do not expose provider errors, storage errors, input text or configuration in a response.
      return failure("unavailable");
    }
  }
  /** Compare-and-set finish from the job's current phase; a lost race returns the stored job unchanged. */
  async function finish(job: OtfJobRecord, outcome: OtfOutcome, reason: string, at: string, when?: { quietSince: string }): Promise<OtfJobRecord> {
    const updated = await store.updateJob(job.job_id, job.state === "building" ? ["building"] : WAITING,
      { state: "finished", outcome, reason, finished_at: at }, when);
    if (updated !== null) {
      await store.appendJobEvent(job.job_id, { type: "job_finished", lane_id: null, data: { outcome, reason } }, at);
      return updated;
    }
    const current = await store.getJob(job.job_id);
    if (current === null) throw new Error("Job disappeared during finish");
    return current;
  }
  /** Why a waiting job can no longer run, or null. */
  async function waitingBlock(job: OtfJobRecord, at: string, builder: BuilderState, seen: Seen): Promise<string | null> {
    const power = await store.getPower();
    const host = job.host_id; const label = OTF_HOST_LABELS[host]; const profile = config.hosts[host];
    if (!config.enabled) return `Custom builds were turned off while this ${label} job waited.`;
    if (power.hold_until !== null && Date.parse(power.hold_until) > Date.parse(at)) return `Custom builds were put on hold while this ${label} job waited.`;
    if (!profile.enabled) return `${label} builds were turned off while this job waited.`;
    const from = Date.parse(at);
    if (!hostCalendarOpen(host, from, from + profile.deadlineMs + CALENDAR_MARGIN_MS)) return calendarReason(host);
    if (builder === "running" && !(seen?.ready_hosts ?? []).includes(host)) return `${label} is not ready on the builder machine.`;
    return null;
  }
  async function finishOnRead(job: OtfJobRecord, at: string, builder: BuilderState, seen: Seen): Promise<OtfJobRecord> {
    if (job.state === "finished") return job;
    if (job.state === "building") {
      if (job.deadline_at !== null && Date.parse(at) >= Date.parse(job.deadline_at)) return finish(job, "time_limit", "The job deadline was reached.", at);
      const last = job.last_builder_post_at ?? job.claimed_at;
      if (last !== null && Date.parse(at) - Date.parse(last) >= BUILDER_LOST_MS) {
        // Finish only while the job is still quiet: a builder post that lands after the read above wins.
        return finish(job, "builder_lost", "The builder stopped reporting progress.", at, { quietSince: new Date(Date.parse(at) - BUILDER_LOST_MS).toISOString() });
      }
      return job;
    }
    const block = await waitingBlock(job, at, builder, seen);
    return block === null ? job : finish(job, "builder_unavailable", block, at);
  }
  /** A queued validation that no builder claimed within START_TIMEOUT_MS finishes error. */
  async function settleValidation(value: OtfValidationRecord | null, at: string): Promise<OtfValidationRecord | null> {
    if (value?.state !== "queued" || Date.parse(at) - Date.parse(value.started_at) < START_TIMEOUT_MS) return value;
    return await store.updateValidation(value.validation_id, ["queued"], { state: "error", finished_at: at })
      ?? await store.getValidation(value.validation_id);
  }
  /**
   * Asks W5 to start the builder for a queued validation (outside the power lock). A start that is
   * refused ends the validation error; a deferred one is asked for again on the next read, since the
   * watchdog only starts the machine for waiting jobs.
   */
  async function wakeForValidation(value: OtfValidationRecord): Promise<OtfValidationRecord> {
    if (value.state !== "queued") return value;
    const started = await deps.lifecycle.requestStart(lifecycleInput());
    if (started.kind !== "failed" && started.kind !== "unavailable") return value;
    return await store.updateValidation(value.validation_id, ["queued"], { state: "error", finished_at: now().toISOString() })
      ?? await store.getValidation(value.validation_id) ?? value;
  }
  async function status(job: OtfJobRecord, builder: BuilderState, after: number, at: string): Promise<OtfJobStatus> {
    const events = await store.listEvents(job.job_id, 0);
    const waiting = (await store.listJobs(WAITING)).filter((item) => item.host_id === job.host_id);
    const position = waiting.findIndex((item) => item.job_id === job.job_id);
    const artifacts: OtfArtifact[] = job.outcome === "delivered" ? (await store.listArtifacts(job.job_id)).map((part) => ({
      part: part.part, filename: part.filename, media_type: part.media_type, size: part.size, sha256: part.sha256,
      download_path: `/api/factory/otf/jobs/${job.job_id}/artifacts/${part.part}`,
    })) : [];
    const profile = config.hosts[job.host_id];
    return {
      job_id: job.job_id, created_at: job.created_at, state: job.state, host_id: job.host_id,
      queue_position: job.state === "queued" || job.state === "starting_builder" ? (position < 0 ? null : position + 1) : null,
      builder, outcome: job.outcome, reason: job.reason, criterion_id: job.criterion_id,
      spec: job.spec, spec_sha256: job.spec_sha256, deadline_at: job.deadline_at,
      elapsed_ms: Math.max(0, Date.parse(job.finished_at ?? at) - Date.parse(job.claimed_at ?? job.created_at)),
      lanes: projectLanes(events, profile.lanes, OTF_HOST_DEFAULTS[job.host_id].confirm_rounds),
      events: events.filter((event) => event.seq > after),
      next_after: Math.max(after, events.at(-1)?.seq ?? 0),
      poll_after_ms: job.state === "finished" ? POLL_FINISHED_MS : POLL_RUNNING_MS,
      spend: { model_microusd: job.model_microusd, cap_microusd: profile.jobSpendCapMicrousd, source: SPEND_SOURCE },
      winner: job.winner_lane !== null && job.winner_model !== null ? { lane_id: job.winner_lane, model: job.winner_model } : null,
      artifacts, certificate: job.outcome === "delivered" ? job.certificate : null,
      validation: validationView(await settleValidation(await store.latestValidation(job.job_id), at)),
      catalog_request_id: job.catalog_request_id,
    };
  }
  async function readStatus(jobId: string, after: number): Promise<OtfJobStatus | null> {
    await deps.lifecycle.runWatchdog(lifecycleInput());
    const at = now().toISOString(); const { builder, seen } = await currentBuilder(at);
    const job = await store.getJob(jobId);
    if (job === null) return null;
    if (job.outcome === "delivered" && builder !== "running") {
      const latest = await settleValidation(await store.latestValidation(job.job_id), at);
      if (latest !== null) await wakeForValidation(latest);
    }
    return status(await finishOnRead(job, at, builder, seen), builder, after, at);
  }

  return {
    availability(request: Request): Promise<Response> {
      return guard(request, false, async () => {
        await deps.lifecycle.runWatchdog(lifecycleInput());
        const at = now().toISOString(); const { builder, seen } = await currentBuilder(at);
        const jobs = await store.listJobs(["queued", "starting_builder", "building"]);
        const hosts = OTF_HOST_IDS.map((host): OtfHostAvailability => {
          const profile = config.hosts[host]; const reason = hostBlock(host, at, builder, seen);
          const own = jobs.filter((job) => job.host_id === host);
          return {
            host_id: host, label: OTF_HOST_LABELS[host], offered: reason === null, unavailable_reason: reason,
            active_jobs: own.filter((job) => job.state === "building").length,
            queued_jobs: own.filter((job) => job.state !== "building").length,
            max_active: profile.maxActive,
            lanes: profile.lanes.map(({ lane_id, model_label }) => ({ lane_id, model_label })),
            deadline_min: Math.round(profile.deadlineMs / 60_000), typical: profile.typical,
          };
        });
        const offered = new Set(hosts.filter((host) => host.offered).map((host) => host.host_id));
        return json("OtfAvailability", {
          enabled: !unavailable(config, await store.getPower(), at), builder,
          active_jobs: jobs.filter((job) => job.state === "building").length,
          queued_jobs: jobs.filter((job) => job.state !== "building").length,
          max_queued: config.maxQueued,
          behaviors: config.behaviors.filter((behavior) => offered.has(behavior.host_id)),
          hosts, cold_start_min: config.coldStartMin,
          spend_left_microusd: Math.max(0, config.totalSpendCapMicrousd - await store.totalModelMicrousd()),
        });
      });
    },
    create(request: Request): Promise<Response> {
      return guard(request, true, async () => {
        const parsed = await readBody(request);
        if (!parsed.ok || !isOtf("OtfCreateJob", parsed.value)) return failure("invalid_spec");
        const input = parsed.value;
        const fields = [input.spec.title, input.spec.where, input.spec.change, input.spec.why_tests_miss, input.spec.fix, ...input.spec.checks_to_add];
        if (securityTopic(input.sentence) || holdsCode(input.sentence) || fields.some((field) => designSecurityTopic(field) || holdsCode(field))) return failure("refused_topic");
        if (await specSha256(input.spec) !== input.spec_sha256) return failure("invalid_spec");
        if (!cardInScope(config, input) || (deps.inScope !== undefined && !await deps.inScope(input))) return failure("invalid_spec");
        const createHash = await createSha256(input); const at = now().toISOString();
        const activeLimit = OTF_HOST_IDS.reduce((sum, host) => sum + (config.hosts[host].enabled ? config.hosts[host].maxActive : 0), 0);
        // W1/W5 binding must use the same power lock. Do not nest lifecycle calls inside it.
        const admitted = await store.withPowerLock<{ kind: "created" | "replayed"; job: OtfJobRecord } | { kind: "refused"; code: OtfErrorCode }>(async (power) => {
          const all = await store.listJobs(OTF_JOB_STATES);
          const replay = all.find((job) => job.client_key === input.client_key);
          if (replay !== undefined) return { patch: null, log: [], result: replay.create_sha256 === createHash
            ? { kind: "replayed" as const, job: replay } : { kind: "refused" as const, code: "idempotency_conflict" as const } };
          const seen = await store.lastBuilderSeen();
          const builder = deps.lifecycle.builderState(power, seen?.last_seen_at ?? null, new Date(at));
          let code: OtfErrorCode | null = null;
          if (unavailable(config, power, at)) code = "unavailable";
          else if (all.filter((job) => job.state !== "finished").length >= activeLimit + config.maxQueued) code = "busy";
          else if (await store.countJobsCreatedSince(`${at.slice(0, 10)}T00:00:00.000Z`) >= config.maxPerDay) code = "daily_cap";
          else if (await store.totalModelMicrousd() >= config.totalSpendCapMicrousd) code = "spend_cap";
          else if (hostBlock(input.host_id, at, builder, seen) !== null) code = "host_unavailable";
          if (code !== null) return { patch: null, log: [], result: { kind: "refused" as const, code } };
          const result = await store.createJob({ job_id: id(), client_key: input.client_key, create_sha256: createHash,
            created_at: at, host_id: input.host_id, criterion_id: input.criterion_id, sentence: input.sentence, spec: input.spec,
            spec_sha256: input.spec_sha256, state: builder === "running" ? "queued" : "starting_builder",
            catalog_request_id: input.catalog_request_id ?? null });
          if (result.kind === "conflict") return { patch: null, log: [], result: { kind: "refused" as const, code: "idempotency_conflict" as const } };
          if (result.kind === "created") await store.appendJobEvent(result.job.job_id, { type: "job_queued", lane_id: null,
            data: { position: all.filter((job) => job.host_id === input.host_id && (job.state === "queued" || job.state === "starting_builder")).length + 1 } }, at);
          return { patch: null, log: [], result };
        });
        if (admitted.kind === "refused") return failure(admitted.code);
        if (admitted.kind === "created") {
          // W5 owns start events, start failures and start timeouts, including all waiting jobs.
          const started = await deps.lifecycle.requestStart(lifecycleInput());
          if (started.kind === "unavailable") {
            // The job is stored, so never answer 503 for it: finish it, unless a claim already took it.
            const { outcome, reason } = START_BLOCK_FINISH[started.block];
            await finish(admitted.job, outcome, reason, now().toISOString());
          }
        }
        const current = await readStatus(admitted.job.job_id, 0);
        return current === null ? failure("unavailable") : json("OtfCreateResponse", { job_id: admitted.job.job_id, status: current }, admitted.kind === "created" ? 201 : 200);
      });
    },
    status(request: Request, jobId: string): Promise<Response> {
      return guard(request, true, async () => {
        const query = new URL(request.url).searchParams; const afterText = query.get("after") ?? "0";
        if (!UUID.test(jobId) || [...query.keys()].some((key) => key !== "after") || query.getAll("after").length > 1
          || !/^(0|[1-9][0-9]*)$/.test(afterText) || !Number.isSafeInteger(Number(afterText))) return failure("invalid_request");
        const result = await readStatus(jobId, Number(afterText));
        return result === null ? failure("not_found") : json("OtfJobStatus", result);
      });
    },
    stop(request: Request, jobId: string): Promise<Response> {
      return guard(request, true, async () => {
        if (!UUID.test(jobId)) return failure("invalid_request");
        const at = now().toISOString(); let job = await store.getJob(jobId);
        if (job === null) return failure("not_found");
        if (job.state === "queued" || job.state === "starting_builder") job = await finish(job, "cancelled", "The customer stopped this job.", at);
        // A claim can win the queued/starting compare-and-set. Still deliver the stop to that builder.
        if (job.state === "building" && job.stop_requested_at === null) await store.updateJob(jobId, ["building"], { stop_requested_at: at, stop_reason: "customer" });
        const result = await readStatus(jobId, 0);
        return result === null ? failure("not_found") : json("OtfJobStatus", result, 202);
      });
    },
    artifact(request: Request, jobId: string, part: string): Promise<Response> {
      return guard(request, true, async () => {
        if (!UUID.test(jobId) || !OTF_PARTS.some((value) => value === part)) return failure("invalid_request");
        const job = await store.getJob(jobId);
        if (job === null) return failure("not_found");
        if (job.state !== "finished" || job.outcome !== "delivered") return failure("not_delivered");
        const artifact = await store.getArtifact(jobId, part as (typeof OTF_PARTS)[number]);
        if (artifact?.job_id !== jobId || artifact.part !== part || !SAFE_FILENAME.test(artifact.filename)
          || artifact.size < 1 || artifact.size > PART_MAX_BYTES || artifact.bytes.byteLength !== artifact.size
          || await sha256Hex(artifact.bytes) !== artifact.sha256
          || artifact.media_type !== (part === "certificate" ? "application/json" : "application/gzip")) return failure("unavailable");
        return new Response(new Uint8Array(artifact.bytes), { headers: { ...JSON_HEADERS,
          "content-type": artifact.media_type, "content-length": String(artifact.size),
          "content-disposition": `attachment; filename="${artifact.filename}"`,
        } });
      });
    },
    validate(request: Request, jobId: string): Promise<Response> {
      return guard(request, true, async () => {
        if (!UUID.test(jobId)) return failure("invalid_request");
        const at = now().toISOString();
        const result = await store.withPowerLock<{ code: OtfErrorCode } | { value: OtfValidationRecord; status: number }>(async (power) => {
          const job = await store.getJob(jobId);
          if (job === null) return { patch: null, log: [], result: { code: "not_found" as const } };
          if (job.state !== "finished" || job.outcome !== "delivered") return { patch: null, log: [], result: { code: "not_delivered" as const } };
          const latest = await settleValidation(await store.latestValidation(jobId), at);
          if (latest?.state === "queued" || latest?.state === "running") return { patch: null, log: [], result: { value: latest, status: 200 } };
          if (unavailable(config, power, at)) return { patch: null, log: [], result: { code: "unavailable" as const } };
          const seen = await store.lastBuilderSeen();
          const builder = deps.lifecycle.builderState(power, seen?.last_seen_at ?? null, new Date(at));
          if (hostBlock(job.host_id, at, builder, seen) !== null) return { patch: null, log: [], result: { code: "host_unavailable" as const } };
          return { patch: null, log: [], result: { value: await store.createValidation(jobId, id(), at), status: 201 } };
        });
        if ("code" in result) return failure(result.code);
        // Wake a stopped builder for a new or still queued validation, outside the power lock (W5 takes it).
        const view = validationView(await wakeForValidation(result.value));
        return view === null ? failure("unavailable") : json("OtfValidation", view, result.status);
      });
    },
  };
}

export type OtfCustomerHandlers = ReturnType<typeof createCustomerHandlers>;
/** W1/W5 install the real dependency loader at server composition; no in-memory production fallback. */
let loadCustomerDependencies: (() => Promise<OtfCustomerDependencies>) | null = null;
export function setOtfCustomerDependencies(loader: (() => Promise<OtfCustomerDependencies>) | null): void {
  loadCustomerDependencies = loader;
}
export async function handleOtfCustomer(run: (handlers: OtfCustomerHandlers) => Promise<Response>): Promise<Response> {
  if (loadCustomerDependencies === null) return failure("unavailable");
  try { return await run(createCustomerHandlers(await loadCustomerDependencies())); }
  catch { return failure("unavailable"); }
}

// ---- test mode only: POST /api/factory/otf/test/reset { scenario }

type Env = Readonly<Record<string, string | undefined>>;
/** Bound at composition to W4's otfTestWorld().reset; answers false for an unknown scenario. */
let resetTestWorld: ((scenario: string) => boolean | Promise<boolean>) | null = null;
export function setOtfTestReset(reset: ((scenario: string) => boolean | Promise<boolean>) | null): void {
  resetTestWorld = reset;
}
/** 404 outside the factory's test mode (a local server with RBW_FACTORY_TEST_MODE=1), or when no reset is bound. */
export async function handleOtfTestReset(request: Request, env: Env = process.env): Promise<Response> {
  if (loadFactoryConfig(env).mode !== "test" || resetTestWorld === null) return failure("not_found");
  try {
    const parsed = await readBody(request);
    const value = parsed.ok ? parsed.value : null;
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((key) => key !== "scenario")) return failure("invalid_request");
    const scenario: unknown = (value as { scenario?: unknown }).scenario;
    if (typeof scenario !== "string" || !await resetTestWorld(scenario)) return failure("invalid_request");
    return Response.json({ scenario }, { headers: JSON_HEADERS });
  } catch {
    return failure("unavailable");
  }
}
