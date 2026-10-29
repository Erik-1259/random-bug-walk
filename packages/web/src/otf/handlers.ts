// OTF SPEC sections 2 and 5: customer admission and responses, separate from catalog execution.
import { randomUUID } from "node:crypto";
import { designSecurityTopic, holdsCode, securityTopic } from "../assist/safety.ts";
import { readBody } from "../factory-server/http.ts";
import { hasFactorySession } from "../factory-server/session.ts";
import { createSha256, sha256Hex, specSha256 } from "./canonical.ts";
import {
  BUILDER_LOST_MS, OTF_CONTRACT_VERSION, OTF_ERROR_STATUS, OTF_JOB_STATES, OTF_PARTS,
  PART_MAX_BYTES, POLL_FINISHED_MS, POLL_RUNNING_MS, SAFE_FILENAME, SPEND_SOURCE,
  VALIDATION_WHERE,
  type BuilderState, type LaneId, type OtfAvailability, type OtfArtifact, type OtfBehaviorOption, type OtfCreateJob,
  type OtfErrorCode, type OtfJobRecord, type OtfJobStatus, type OtfOutcome, type OtfPowerRecord,
  type OtfStore, type OtfValidation, type OtfValidationRecord, type VmPower,
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
export type OtfStartResult =
  | { kind: "started"; requested_at: string }
  | { kind: "running" | "starting" | "deferred" }
  | { kind: "failed"; reason: "capacity" | "api_error" }
  | { kind: "unavailable"; block: "unconfigured" | "hold" | "day_cap" | "start_backoff" };
export interface OtfCustomerLifecycle {
  requestStart(input: OtfPowerDependencies): Promise<OtfStartResult>;
  runWatchdog(input: OtfPowerDependencies): Promise<{ action: "none" | "get" | "start" | "stop"; reason: string | null; timed_out: number }>;
  builderState(power: OtfPowerRecord, lastSeenAt: string | null, now: Date): BuilderState;
}

export interface OtfCustomerConfig {
  enabled: boolean;
  builderSecretConfigured: boolean;
  passcode: string | null;
  maxActive: number;
  maxQueued: number;
  maxPerDay: number;
  totalSpendCapMicrousd: number;
  jobSpendCapMicrousd: number;
  vmHoursPerDay: number;
  behaviors: OtfBehaviorOption[];
  lanes: { lane_id: LaneId; model: string; model_label: string }[];
  typical: OtfAvailability["typical"];
}

export interface OtfCustomerDependencies {
  store: OtfStore;
  power: VmPower | null;
  lifecycle: OtfCustomerLifecycle;
  config: OtfCustomerConfig;
  /** Required trusted, non-model scope check. Safety checks alone never establish scope. */
  inScope(input: OtfCreateJob): Promise<boolean>;
  /** W1 binding proposal: compare state, last post, claim and deadline under the builder-post job lock. */
  finishBuildingIfUnchanged(expected: OtfJobRecord, finish: {
    outcome: "builder_lost" | "time_limit"; reason: string; at: string;
  }): Promise<OtfJobRecord | null>;
  now?: () => Date;
  id?: () => string;
}

const MESSAGES: Record<OtfErrorCode, string> = {
  busy: "The custom build queue is full.", daily_cap: "The daily custom build limit has been reached.",
  spend_cap: "The custom build model budget has been reached.", refused_topic: "This request is outside the supported design topics.",
  invalid_spec: "The accepted design is invalid or outside the offered scope.",
  idempotency_conflict: "This client key already identifies a different request.", signed_out: "Sign in to continue.",
  unavailable: "Custom builds are unavailable right now.", invalid_request: "The request is invalid.",
  not_found: "This custom build was not found.", not_delivered: "This custom build has not delivered artifacts.",
  job_finished: "This custom build has finished.", event_conflict: "The event conflicts with the stored stream.",
  unauthorized: "The request is not authorized.",
};
const JSON_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  return { validation_id: value.validation_id, state: value.state, cells: value.cells,
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

export function createCustomerHandlers(deps: OtfCustomerDependencies) {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const id = deps.id ?? randomUUID;
  const lifecycleInput = (): OtfPowerDependencies => ({ store, power: deps.power, now, vmHoursPerDay: config.vmHoursPerDay });
  async function currentBuilder(at: string): Promise<BuilderState> {
    return deps.lifecycle.builderState(await store.getPower(), (await store.lastBuilderSeen())?.last_seen_at ?? null, new Date(at));
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
  async function finish(job: OtfJobRecord, outcome: OtfOutcome, reason: string, at: string): Promise<OtfJobRecord> {
    const updated = job.state === "building" && (outcome === "builder_lost" || outcome === "time_limit")
      ? await deps.finishBuildingIfUnchanged(job, { outcome, reason, at })
      : await store.updateJob(job.job_id, ["queued", "starting_builder"], { state: "finished", outcome, reason, finished_at: at });
    if (updated !== null) {
      await store.appendJobEvent(job.job_id, { type: "job_finished", lane_id: null, data: { outcome, reason } }, at);
      return updated;
    }
    const current = await store.getJob(job.job_id);
    if (current === null) throw new Error("Job disappeared during finish");
    return current;
  }
  async function finishOnRead(job: OtfJobRecord, at: string): Promise<OtfJobRecord> {
    if (job.state === "finished") return job;
    if (job.state === "building") {
      if (job.deadline_at !== null && Date.parse(at) >= Date.parse(job.deadline_at)) return finish(job, "time_limit", "The job deadline was reached.", at);
      const last = job.last_builder_post_at ?? job.claimed_at;
      if (last !== null && Date.parse(at) - Date.parse(last) >= BUILDER_LOST_MS) return finish(job, "builder_lost", "The builder stopped reporting progress.", at);
    } else {
      const power = await store.getPower();
      if (!config.enabled || (power.hold_until !== null && Date.parse(power.hold_until) > Date.parse(at))) {
        return finish(job, "builder_unavailable", "Custom builds became unavailable while this job waited.", at);
      }
    }
    return job;
  }
  async function status(job: OtfJobRecord, builder: BuilderState, after: number, at: string): Promise<OtfJobStatus> {
    const events = await store.listEvents(job.job_id, 0);
    const waiting = await store.listJobs(["queued", "starting_builder"]);
    const position = waiting.findIndex((item) => item.job_id === job.job_id);
    const artifacts: OtfArtifact[] = job.outcome === "delivered" ? (await store.listArtifacts(job.job_id)).map((part) => ({
      part: part.part, filename: part.filename, media_type: part.media_type, size: part.size, sha256: part.sha256,
      download_path: `/api/factory/otf/jobs/${job.job_id}/artifacts/${part.part}`,
    })) : [];
    return {
      job_id: job.job_id, created_at: job.created_at, state: job.state,
      queue_position: job.state === "queued" || job.state === "starting_builder" ? (position < 0 ? null : position + 1) : null,
      builder, outcome: job.outcome, reason: job.reason, criterion_id: job.criterion_id,
      spec: job.spec, spec_sha256: job.spec_sha256, deadline_at: job.deadline_at,
      elapsed_ms: Math.max(0, Date.parse(job.finished_at ?? at) - Date.parse(job.claimed_at ?? job.created_at)),
      lanes: projectLanes(events, config.lanes), events: events.filter((event) => event.seq > after),
      next_after: Math.max(after, events.at(-1)?.seq ?? 0),
      poll_after_ms: job.state === "finished" ? POLL_FINISHED_MS : POLL_RUNNING_MS,
      spend: { model_microusd: job.model_microusd, cap_microusd: config.jobSpendCapMicrousd, source: SPEND_SOURCE },
      winner: job.winner_lane !== null && job.winner_model !== null ? { lane_id: job.winner_lane, model: job.winner_model } : null,
      artifacts, certificate: job.outcome === "delivered" ? job.certificate : null,
      validation: validationView(await store.latestValidation(job.job_id)), catalog_request_id: job.catalog_request_id,
    };
  }
  async function readStatus(jobId: string, after: number): Promise<OtfJobStatus | null> {
    await deps.lifecycle.runWatchdog(lifecycleInput());
    const at = now().toISOString(); const builder = await currentBuilder(at);
    const job = await store.getJob(jobId);
    return job === null ? null : status(await finishOnRead(job, at), builder, after, at);
  }

  return {
    availability(request: Request): Promise<Response> {
      return guard(request, false, async () => {
        await deps.lifecycle.runWatchdog(lifecycleInput());
        const at = now().toISOString(); const builder = await currentBuilder(at);
        const jobs = await store.listJobs(["queued", "starting_builder", "building"]);
        return json("OtfAvailability", {
          enabled: !unavailable(config, await store.getPower(), at), builder,
          active_jobs: jobs.filter((job) => job.state === "building").length,
          queued_jobs: jobs.filter((job) => job.state !== "building").length,
          max_active: config.maxActive, max_queued: config.maxQueued,
          behaviors: config.behaviors, lanes: config.lanes.map(({ lane_id, model_label }) => ({ lane_id, model_label })),
          typical: config.typical,
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
        if (!config.behaviors.some((behavior) => behavior.criterion_id === input.criterion_id) || !await deps.inScope(input)) return failure("invalid_spec");
        const createHash = await createSha256(input); const at = now().toISOString();
        // W1/W5 binding must use the same power lock. Do not nest lifecycle calls inside it.
        const admitted = await store.withPowerLock<{ kind: "created" | "replayed"; job: OtfJobRecord } | { kind: "refused"; code: OtfErrorCode }>(async (power) => {
          const all = await store.listJobs(OTF_JOB_STATES);
          const replay = all.find((job) => job.client_key === input.client_key);
          if (replay !== undefined) return { patch: null, log: [], result: replay.create_sha256 === createHash
            ? { kind: "replayed" as const, job: replay } : { kind: "refused" as const, code: "idempotency_conflict" as const } };
          let code: OtfErrorCode | null = null;
          if (unavailable(config, power, at)) code = "unavailable";
          else if (all.filter((job) => job.state !== "finished").length >= config.maxActive + config.maxQueued) code = "busy";
          else if (await store.countJobsCreatedSince(`${at.slice(0, 10)}T00:00:00.000Z`) >= config.maxPerDay) code = "daily_cap";
          else if (await store.totalModelMicrousd() >= config.totalSpendCapMicrousd) code = "spend_cap";
          if (code !== null) return { patch: null, log: [], result: { kind: "refused" as const, code } };
          const seen = await store.lastBuilderSeen();
          const builder = deps.lifecycle.builderState(power, seen?.last_seen_at ?? null, new Date(at));
          const result = await store.createJob({ job_id: id(), client_key: input.client_key, create_sha256: createHash,
            created_at: at, criterion_id: input.criterion_id, sentence: input.sentence, spec: input.spec, spec_sha256: input.spec_sha256,
            state: builder === "running" ? "queued" : "starting_builder", catalog_request_id: input.catalog_request_id ?? null });
          if (result.kind === "conflict") return { patch: null, log: [], result: { kind: "refused" as const, code: "idempotency_conflict" as const } };
          if (result.kind === "created") await store.appendJobEvent(result.job.job_id, { type: "job_queued", lane_id: null,
            data: { position: all.filter((job) => job.state === "queued" || job.state === "starting_builder").length + 1 } }, at);
          return { patch: null, log: [], result };
        });
        if (admitted.kind === "refused") return failure(admitted.code);
        if (admitted.kind === "created") {
          // W5 owns start events, start failures and start timeouts, including all waiting jobs.
          const started = await deps.lifecycle.requestStart(lifecycleInput());
          if (started.kind === "unavailable") return failure("unavailable");
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
          const latest = await store.latestValidation(jobId);
          if (latest?.state === "queued" || latest?.state === "running") return { patch: null, log: [], result: { value: latest, status: 200 } };
          // W5's validation wake-up contract is pending. Never strand new work on an idle VM.
          const seen = await store.lastBuilderSeen();
          if (unavailable(config, power, at)
            || deps.lifecycle.builderState(power, seen?.last_seen_at ?? null, new Date(at)) !== "running") {
            return { patch: null, log: [], result: { code: "unavailable" } };
          }
          return { patch: null, log: [], result: { value: await store.createValidation(jobId, id(), at), status: 201 } };
        });
        if ("code" in result) return failure(result.code);
        const view = validationView(result.value);
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
