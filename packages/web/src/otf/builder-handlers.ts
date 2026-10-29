// The builder-facing OTF routes (docs/otf/SPEC.md section 3.2): claim (a long poll that is also
// the idle heartbeat), events with the control reply, result with every delivery check, the
// artifact fetch for validate jobs, the validation result and the stop intent. Each handler takes
// its dependencies (store, config, clock), so the tests run them against the in-memory store and
// PGlite. Every request is HMAC-checked first (builder-auth.ts), and every JSON answer passes its
// schema before it leaves (an answer that does not is sent as unavailable).
import { OTF_HOST_ENV, loadOtfConfig, otfConfigured, type OtfConfig } from "../config.ts";
import { verifyBuilderRequest } from "./builder-auth.ts";
import { canonicalJson } from "./canonical.ts";
import {
  CLAIM_HOLD_MS,
  EXPECTED_CELLS,
  LANE_IDS,
  ADMISSION_RULES,
  OTF_CONTRACT_VERSION,
  OTF_ERROR_STATUS,
  OTF_HOST_IDS,
  OTF_OPEN_CRITERION_ID,
  PART_MAX_BYTES_BY_PART,
  RESULT_BODY_MAX_BYTES,
  SAFE_FILENAME,
  VALIDATION_WHERE,
  type BuildJob,
  type ClaimReply,
  type ClaimRequest,
  type EventsReply,
  type LaneId,
  type OtfArtifactRecord,
  type OtfCertificate,
  type OtfErrorBody,
  type OtfAdmissionResult,
  type OtfErrorCode,
  type OtfHostId,
  type OtfJobRecord,
  type OtfOutcome,
  type OtfPart,
  type OtfStore,
  type OtfValidation,
  type OtfValidationRecord,
  type ResultPart,
  type ResultReply,
  type SixCells,
  type StopIntentReply,
  type StopReason,
  type ValidateJob,
} from "./contract.ts";
import { finishRunningValidations, openValidations } from "./power/lifecycle.ts";
import { parseOtf, validateOtf, type OtfBodies, type OtfSchemaName } from "./schemas.ts";
import { otfStoreFor } from "./store.ts";

export interface OtfBuilderDeps {
  store: OtfStore;
  config: OtfConfig;
  now: () => Date;
  /** Waits ms, or less when the signal aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  log: (line: string) => void;
  /** How long a claim is held and how often it looks again; CLAIM_HOLD_MS and CLAIM_POLL_MS by default. */
  claimHoldMs?: number;
  claimPollMs?: number;
}

/** How often a held claim looks for work again. */
export const CLAIM_POLL_MS = 2_000;

/**
 * Request body limits per route. A result is read up to RESULT_BODY_MAX_BYTES, under the hosting
 * platform's own body limit; its parts are capped by PART_MAX_BYTES_BY_PART.
 */
export const BODY_LIMITS = {
  claim: 16 * 1024,
  events: 1024 * 1024,
  result: RESULT_BODY_MAX_BYTES,
  validation: 16 * 1024,
  stopIntent: 16 * 1024,
  artifact: 0,
} as const;

/** Outcomes only production decides; a builder result naming one is refused. */
const PRODUCTION_OUTCOMES: readonly OtfOutcome[] = ["builder_start_failed", "builder_unavailable", "builder_lost"];

const MEDIA_TYPE: Record<OtfPart, OtfArtifactRecord["media_type"]> = { agent: "application/gzip", grader: "application/gzip", certificate: "application/json" };

const ERROR_TEXT: Record<OtfErrorCode, string> = {
  busy: "Custom builds are at their limit. Try again after one finishes.",
  daily_cap: "Today's custom builds are used up.",
  spend_cap: "The custom build budget is used up.",
  refused_topic: "This request is outside what custom builds cover.",
  invalid_spec: "The spec card does not match what custom builds accept.",
  idempotency_conflict: "This client key was already used with a different body.",
  host_unavailable: "Custom builds for this host are not available right now.",
  signed_out: "Sign in with the judges' passcode to use this endpoint.",
  unavailable: "Custom builds are not available right now. Try again later.",
  invalid_request: "The request does not match the OTF contract.",
  not_found: "No job, artifact or validation with this ID was found.",
  not_delivered: "This job did not deliver a bug.",
  job_finished: "This job has already finished.",
  event_conflict: "A builder_seq was repeated with different bytes, or skipped.",
  unauthorized: "The builder request is not authorized.",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** An OtfErrorBody with the code's status; the message is never more than the code's fixed text plus safe detail. */
export function otfError(code: OtfErrorCode, message: string = ERROR_TEXT[code]): Response {
  const body: OtfErrorBody = { contract_version: OTF_CONTRACT_VERSION, error: { code, message: message.slice(0, 600), retryable: code === "unavailable" } };
  return json(OTF_ERROR_STATUS[code], body);
}

/** Sends a body that passes its schema, or unavailable when it does not. */
export function sendOtf(log: (line: string) => void, status: number, name: OtfSchemaName, body: unknown): Response {
  const errors = validateOtf(name, body);
  if (errors.length === 0) return json(status, body);
  log(`otf: a ${name} answer did not match its schema (${errors.slice(0, 5).join(", ")}); answered unavailable`);
  return otfError("unavailable");
}

type Authed<N extends OtfSchemaName> = { ok: true; builder_id: string; at: Date; body: OtfBodies[N] } | { ok: false; response: Response };

/** Checks the signature, then parses the body against `name` and matches its builder_id to the header. */
async function authed<N extends OtfSchemaName>(request: Request, deps: OtfBuilderDeps, name: N, maxBytes: number): Promise<Authed<N>> {
  const at = deps.now();
  const auth = await verifyBuilderRequest(request, deps.config.builderSecret, at.getTime(), maxBytes);
  if (!auth.ok) return { ok: false, response: otfError(auth.code, auth.message) };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(auth.body));
  } catch {
    return { ok: false, response: otfError("invalid_request", "The request body is not UTF-8 JSON.") };
  }
  const parsed = parseOtf(name, value);
  if (!parsed.ok) return { ok: false, response: otfError("invalid_request", `The body does not match ${name}: ${parsed.errors.slice(0, 5).join(", ")}.`) };
  const builder_id = (parsed.value as { builder_id: string }).builder_id;
  if (builder_id !== auth.builder_id) return { ok: false, response: otfError("unauthorized", "The body's builder_id does not match the signed builder id.") };
  return { ok: true, builder_id, at, body: parsed.value };
}

/** A USD amount as the config holds it ("8.00") in micro-USD. */
export function microusd(usd: string): number {
  const [whole = "0", fraction = ""] = usd.split(".");
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0").slice(0, 6));
}

function laneModel(config: OtfConfig, host: OtfHostId, lane_id: LaneId): string | null {
  return config.hosts[host].lanes?.[LANE_IDS.indexOf(lane_id)]?.model ?? null;
}

// ---- claim

/** The build job for a claimed job: its host's lanes, and limits from that host's profile. */
function buildJob(job: OtfJobRecord, config: OtfConfig): BuildJob {
  const host = config.hosts[job.host_id];
  return {
    kind: "build",
    job_id: job.job_id,
    host_id: job.host_id,
    criterion_id: job.criterion_id,
    ...(job.criterion_id === OTF_OPEN_CRITERION_ID && job.rule != null ? { rule: job.rule } : {}),
    spec: job.spec,
    spec_sha256: job.spec_sha256,
    sentence: job.sentence,
    lanes: (host.lanes ?? []).flatMap((lane, index) => {
      const lane_id = LANE_IDS[index];
      return lane_id === undefined ? [] : [{ lane_id, ...lane }];
    }),
    limits: {
      max_rounds: host.profile.max_rounds,
      max_usd_lane: host.profile.max_usd_lane,
      max_usd_job: host.profile.max_usd_job,
      goose_max_tokens: 32768,
      deadline_at: job.deadline_at ?? job.created_at,
      confirm_rounds: host.profile.confirm_rounds,
      round_min_remaining_ms: host.profile.round_min_remaining_ms,
    },
  };
}

/**
 * The per-host claim options. A host gets builds only when it is enabled in config, the builder
 * lists it in ready_hosts and has a free build slot for it; validations need a free validate slot.
 * Limits and deadlines come from the host's profile.
 */
export function claimHosts(config: OtfConfig, claim: Pick<ClaimRequest, "free" | "ready_hosts">): Parameters<OtfStore["claimNext"]>[2]["hosts"] {
  return Object.fromEntries(
    OTF_HOST_IDS.map((host) => {
      const profile = config.hosts[host].profile;
      return [
        host,
        {
          build: config.hosts[host].enabled && claim.ready_hosts.includes(host) && claim.free.build[host] > 0,
          validate: claim.free.validate[host] > 0,
          maxActiveBuilds: profile.max_active,
          deadlineMs: profile.deadline_ms,
        },
      ];
    }),
  ) as Parameters<OtfStore["claimNext"]>[2]["hosts"];
}

/**
 * Moves every starting_builder job to queued and appends builder_ready to each, with cold_start_ms
 * from the later of the last start request and the job's creation to `at`.
 */
async function promoteWaiting(deps: OtfBuilderDeps, at: string): Promise<void> {
  const waiting = await deps.store.listJobs(["starting_builder"]);
  if (waiting.length === 0) return;
  const lastStart = (await deps.store.getPower()).last_start_at;
  for (const job of waiting) {
    const moved = await deps.store.updateJob(job.job_id, ["starting_builder"], { state: "queued" });
    if (moved === null) continue;
    const from = Math.max(Date.parse(job.created_at), lastStart === null ? 0 : Date.parse(lastStart));
    await deps.store.appendJobEvent(job.job_id, { type: "builder_ready", lane_id: null, data: { cold_start_ms: Math.max(0, Date.parse(at) - from) } }, at);
  }
}

/** An allowed stop that has not stopped its boot after this long no longer holds that boot's claims back. */
export const STOP_GRACE_MS = 5 * 60_000;

/**
 * Marks the power row running on a healthy claim, unless a stop of this same boot was allowed less
 * than STOP_GRACE_MS ago (the machine is about to stop, so it gets no work). The row lock is taken
 * only when the state changes.
 */
async function markRunning(deps: OtfBuilderDeps, at: string, firstOfBoot: boolean): Promise<boolean> {
  if ((await deps.store.getPower()).state === "running") return true;
  return deps.store.withPowerLock((power) => {
    const stopping = power.state === "stopping" && !firstOfBoot && Date.parse(at) - Date.parse(power.since) < STOP_GRACE_MS;
    if (stopping) return Promise.resolve({ patch: null, log: [], result: false });
    const patch = power.state === "running" ? null : { state: "running" as const, since: at, start_failures: 0 };
    return Promise.resolve({ patch, log: [], result: true });
  });
}

/** Whether a stop was allowed at or after `since` (Unix ms), so a claim held since then hands out nothing more. */
async function stopAllowedSince(deps: OtfBuilderDeps, since: number): Promise<boolean> {
  const power = await deps.store.getPower();
  return power.state === "stopping" && Date.parse(power.since) >= since;
}

type Claimed = { kind: "reply"; reply: ClaimReply } | { kind: "none" };

async function claimOnce(deps: OtfBuilderDeps, builder_id: string, revision: string, hosts: Parameters<OtfStore["claimNext"]>[2]["hosts"]): Promise<Claimed> {
  const at = deps.now().toISOString();
  const claim = await deps.store.claimNext(builder_id, at, { hosts });
  if (claim === null) return { kind: "none" };
  if (claim.kind === "validate") {
    const artifacts = (await deps.store.listArtifacts(claim.validation.job_id)).filter((item): item is OtfArtifactRecord & { part: "agent" | "grader" } => item.part !== "certificate");
    const owner = await deps.store.getJob(claim.validation.job_id);
    const job: ValidateJob = {
      kind: "validate",
      job_id: claim.validation.job_id,
      host_id: owner?.host_id ?? ("" as OtfHostId),
      validation_id: claim.validation.validation_id,
      artifacts: artifacts.map((item) => ({ part: item.part, sha256: item.sha256, size: item.size })),
    };
    if (validateOtf("ClaimReply", { job }).length > 0) {
      deps.log("otf: a validation's job has no stored agent and grader bundles; the validation ends as error");
      await deps.store.updateValidation(claim.validation.validation_id, ["running"], { state: "error", finished_at: at });
      return { kind: "none" };
    }
    return { kind: "reply", reply: { job } };
  }
  const job = buildJob(claim.job, deps.config);
  const errors = validateOtf("ClaimReply", { job });
  if (errors.length > 0) {
    deps.log(`otf: a claimed build job did not match ClaimReply (${errors.slice(0, 5).join(", ")}); the job ends as error`);
    const finished = await deps.store.updateJob(claim.job.job_id, ["building"], { state: "finished", outcome: "error", reason: "production could not form the build job", finished_at: at });
    if (finished !== null) await deps.store.appendJobEvent(claim.job.job_id, { type: "job_finished", lane_id: null, data: { outcome: "error", reason: "production could not form the build job" } }, at);
    return { kind: "none" };
  }
  await deps.store.appendJobEvent(claim.job.job_id, { type: "job_claimed", lane_id: null, data: { builder_revision: revision } }, at);
  return { kind: "reply", reply: { job } };
}

/** POST /api/factory/otf/builder/claim */
export async function postClaim(request: Request, deps: OtfBuilderDeps): Promise<Response> {
  const parsed = await authed(request, deps, "ClaimRequest", BODY_LIMITS.claim);
  if (!parsed.ok) return parsed.response;
  const { body, builder_id } = parsed;
  const started = parsed.at.getTime();
  const at = parsed.at.toISOString();
  const { first_of_boot } = await deps.store.recordBuilderSeen(
    { builder_id, builder_revision: body.builder_revision, boot_id: body.boot_id, booted_at: body.booted_at, ready_hosts: body.ready_hosts },
    at,
  );
  const healthy = body.images_ok && (await markRunning(deps, at, first_of_boot));
  const hold = deps.claimHoldMs ?? CLAIM_HOLD_MS;
  const poll = deps.claimPollMs ?? CLAIM_POLL_MS;
  const hosts = claimHosts(deps.config, body);
  const wantsWork = OTF_HOST_IDS.some((host) => hosts[host].build || hosts[host].validate);
  for (;;) {
    // A stop allowed while this claim is held ends it: the machine is about to stop.
    if (healthy && (await stopAllowedSince(deps, started))) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    // Jobs that started waiting during the hold are promoted on its next look, not the next claim.
    if (healthy) await promoteWaiting(deps, deps.now().toISOString());
    if (healthy && wantsWork) {
      const claimed = await claimOnce(deps, builder_id, body.builder_revision, hosts);
      if (claimed.kind === "reply") return sendOtf(deps.log, 200, "ClaimReply", claimed.reply);
    }
    const left = started + hold - deps.now().getTime();
    if (left <= 0 || request.signal.aborted) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    await deps.sleep(Math.min(poll, left), request.signal);
  }
}

// ---- events

async function stopControl(deps: OtfBuilderDeps, job: OtfJobRecord, at: number): Promise<EventsReply["control"]> {
  const stop = (reason: StopReason): EventsReply["control"] => ({ stop: true, reason });
  if (job.stop_requested_at !== null) return stop(job.stop_reason ?? "customer");
  if (job.deadline_at !== null && Date.parse(job.deadline_at) <= at) return stop("deadline");
  if (job.model_microusd >= microusd(deps.config.hosts[job.host_id].profile.max_usd_job)) return stop("spend_cap");
  if ((await deps.store.totalModelMicrousd()) >= deps.config.spendCapMicrousd) return stop("spend_cap");
  return { stop: false, reason: null };
}

/** POST /api/factory/otf/builder/jobs/{id}/events */
export async function postEvents(request: Request, deps: OtfBuilderDeps, params: { job_id: string }): Promise<Response> {
  const parsed = await authed(request, deps, "EventsPost", BODY_LIMITS.events);
  if (!parsed.ok) return parsed.response;
  const at = parsed.at.toISOString();
  const appended = await deps.store.appendBuilderEvents(params.job_id, parsed.builder_id, parsed.body.events, at);
  switch (appended.kind) {
    case "not_found":
      return otfError("not_found");
    case "finished":
      return otfError("job_finished");
    case "wrong_builder":
      return otfError("unauthorized", "This job is not claimed by this builder.");
    case "conflict":
      return otfError("event_conflict", `builder_seq ${String(appended.builder_seq)} conflicts with the stored events (accepted through ${String(appended.accepted_through)}).`);
    case "ok":
      break;
  }
  let job = await deps.store.getJob(params.job_id);
  if (job === null) return otfError("not_found");
  const winner = parsed.body.events.findLast((event) => event.type === "winner_selected");
  if (winner?.type === "winner_selected") {
    const lane = winner.data.lane_id;
    const started = (await deps.store.listEvents(params.job_id, 0)).find((event) => event.type === "lane_started" && event.lane_id === lane);
    const model = started?.type === "lane_started" ? started.data.model : laneModel(deps.config, job.host_id, lane);
    job = (await deps.store.updateJob(params.job_id, ["building"], { winner_lane: lane, winner_model: model })) ?? job;
  }
  const reply: EventsReply = { accepted_through: appended.accepted_through, control: await stopControl(deps, job, parsed.at.getTime()) };
  return sendOtf(deps.log, 200, "EventsReply", reply);
}

// ---- result

type Checked = { ok: true; parts: (OtfArtifactRecord & { bytes: Uint8Array })[]; certificate: OtfCertificate } | { ok: false; message: string };

function decodeBase64(text: string): Uint8Array | null {
  const bytes = Buffer.from(text, "base64");
  // Buffer skips characters it cannot read; only canonical base64 round-trips.
  return bytes.toString("base64") === text ? new Uint8Array(bytes) : null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Every delivery check of SPEC.md section 3.2, in order; the first failure names itself. */
async function checkDelivery(job: OtfJobRecord, certificate: OtfCertificate, posted: readonly ResultPart[]): Promise<Checked> {
  const parts: (OtfArtifactRecord & { bytes: Uint8Array })[] = [];
  for (const part of posted) {
    if (!SAFE_FILENAME.test(part.filename)) return { ok: false, message: `The ${part.part} filename is not a safe file name.` };
    const bytes = decodeBase64(part.base64);
    if (bytes === null) return { ok: false, message: `The ${part.part} part is not canonical base64.` };
    if (bytes.byteLength !== part.size) return { ok: false, message: `The ${part.part} part's size does not match its bytes.` };
    const cap = PART_MAX_BYTES_BY_PART[part.part];
    if (bytes.byteLength > cap) return { ok: false, message: `The ${part.part} part is larger than ${String(cap)} bytes.` };
    if ((await sha256Hex(bytes)) !== part.sha256) return { ok: false, message: `The ${part.part} part's sha256 does not match its bytes.` };
    if (part.part !== "certificate" && (bytes[0] !== 0x1f || bytes[1] !== 0x8b)) return { ok: false, message: `The ${part.part} part is not gzip.` };
    parts.push({ job_id: job.job_id, part: part.part, filename: part.filename, media_type: MEDIA_TYPE[part.part], size: part.size, sha256: part.sha256, bytes });
  }
  const sha = (name: OtfPart): string | undefined => parts.find((item) => item.part === name)?.sha256;
  if (certificate.bundles.agent_sha256 !== sha("agent") || certificate.bundles.grader_sha256 !== sha("grader")) return { ok: false, message: "The certificate's bundle hashes do not match the parts." };
  if (certificate.host_id !== job.host_id) return { ok: false, message: "The certificate's host_id does not match the job's." };
  if (certificate.spec_sha256 !== job.spec_sha256) return { ok: false, message: "The certificate's spec_sha256 does not match the job." };
  if (certificate.job_id !== job.job_id || certificate.criterion.criterion_id !== job.criterion_id) return { ok: false, message: "The certificate names another job or criterion." };
  if (job.criterion_id === OTF_OPEN_CRITERION_ID && (job.rule == null || canonicalJson(certificate.rule) !== canonicalJson(job.rule))) return { ok: false, message: "The certificate's rule does not match the job's." };
  if (certificate.received !== null) return { ok: false, message: "The certificate's received member is set by production; send null." };
  const certificatePart = parts.find((item) => item.part === "certificate");
  let stored: unknown;
  try {
    stored = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(certificatePart?.bytes));
  } catch {
    return { ok: false, message: "The certificate part is not UTF-8 JSON." };
  }
  if (canonicalJson(stored) !== canonicalJson(certificate)) return { ok: false, message: "The certificate part does not hold the posted certificate." };
  return { ok: true, parts, certificate };
}

function resultReply(deps: OtfBuilderDeps, job_id: string, outcome: OtfOutcome): Response {
  const reply: ResultReply = { job_id, state: "finished", outcome };
  return sendOtf(deps.log, 200, "ResultReply", reply);
}

async function noteJobFinished(deps: OtfBuilderDeps, at: string): Promise<void> {
  await deps.store.withPowerLock(() => Promise.resolve({ patch: { last_job_finished_at: at }, log: [], result: undefined }));
}

/** POST /api/factory/otf/builder/jobs/{id}/result */
export async function postResult(request: Request, deps: OtfBuilderDeps, params: { job_id: string }): Promise<Response> {
  const parsed = await authed(request, deps, "ResultPost", BODY_LIMITS.result);
  if (!parsed.ok) return parsed.response;
  const { body, builder_id } = parsed;
  const at = parsed.at.toISOString();
  if (PRODUCTION_OUTCOMES.includes(body.outcome)) return otfError("invalid_request", `The outcome ${body.outcome} is decided by production, not posted by the builder.`);
  const job = await deps.store.getJob(params.job_id);
  if (job === null) return otfError("not_found");
  let parts: (OtfArtifactRecord & { bytes: Uint8Array })[] = [];
  const base = { state: "finished" as const, outcome: body.outcome, reason: body.reason, finished_at: at, last_builder_post_at: at };
  let patch: Parameters<OtfStore["storeDelivery"]>[3] = base;
  if (body.outcome === "delivered") {
    if (body.certificate === undefined || body.parts === undefined) return otfError("invalid_request");
    const checked = await checkDelivery(job, body.certificate, body.parts);
    if (!checked.ok) return otfError("invalid_request", checked.message);
    parts = checked.parts;
    const certificate: OtfCertificate = { ...checked.certificate, received: { at, sha256_verified: true } };
    patch = {
      ...base,
      reason: null,
      certificate,
      winner_lane: certificate.implementer.lane_id,
      winner_model: certificate.implementer.model,
      model_microusd: Math.max(job.model_microusd, certificate.spend.model_microusd),
    };
  }
  const stored = await deps.store.storeDelivery(params.job_id, builder_id, parts, patch, at);
  switch (stored) {
    case "stored":
      await noteJobFinished(deps, at);
      return resultReply(deps, params.job_id, body.outcome);
    case "replayed":
      return resultReply(deps, params.job_id, body.outcome);
    case "finished": {
      // The same outcome posted again by the claiming builder is a retry; anything else came too late.
      const now = await deps.store.getJob(params.job_id);
      if (now?.outcome === body.outcome && now.claimed_by === builder_id && body.outcome !== "delivered") return resultReply(deps, params.job_id, body.outcome);
      return otfError("job_finished");
    }
    case "conflict":
      return otfError("job_finished", "This job already delivered different bundles.");
    case "wrong_builder":
      return otfError("unauthorized", "This job is not claimed by this builder.");
    case "not_found":
      return otfError("not_found");
  }
}

// ---- artifacts (validate jobs)

/** GET /api/factory/otf/builder/jobs/{id}/artifacts/{part}: agent or grader, re-checked before sending. */
export async function getBuilderArtifact(request: Request, deps: OtfBuilderDeps, params: { job_id: string; part: string }): Promise<Response> {
  const auth = await verifyBuilderRequest(request, deps.config.builderSecret, deps.now().getTime(), BODY_LIMITS.artifact);
  if (!auth.ok) return otfError(auth.code, auth.message);
  if (params.part !== "agent" && params.part !== "grader") return otfError("not_found");
  const job = await deps.store.getJob(params.job_id);
  if (job === null) return otfError("not_found");
  if (job.outcome !== "delivered") return otfError("not_delivered");
  const artifact = await deps.store.getArtifact(params.job_id, params.part);
  if (artifact === null) return otfError("not_found");
  if (artifact.bytes.byteLength !== artifact.size || (await sha256Hex(artifact.bytes)) !== artifact.sha256) {
    deps.log(`otf: a stored ${params.part} bundle no longer matches its sha256 or size; answered unavailable`);
    return otfError("unavailable");
  }
  return new Response(artifact.bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { "content-type": artifact.media_type, "content-length": String(artifact.size), "cache-control": "no-store", "x-rbw-otf-sha256": artifact.sha256 },
  });
}

// ---- validation result

function validationView(record: OtfValidationRecord): OtfValidation {
  return {
    validation_id: record.validation_id,
    state: record.state,
    cells: record.cells,
    admission: record.admission,
    started_at: record.started_at,
    finished_at: record.finished_at,
    where: VALIDATION_WHERE,
  };
}

function sameCells(a: SixCells | null, b: SixCells | null): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function sameAdmission(a: OtfAdmissionResult | null, b: OtfAdmissionResult | null): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Every rule passed, the blind spot was demonstrated and the alternative fix passed. */
function admissionQualified(admission: OtfAdmissionResult): boolean {
  return ADMISSION_RULES.every((rule) => admission.decisions[rule] === "pass") && admission.comparison === "blind_spot_demonstrated" && admission.alternative_fix === "pass";
}

/**
 * Why a validation result does not fit its job's host, or null.
 * - passed: the expected six cells; an admission host also sends a qualifying admission result.
 * - failed: task-report sends six cells that differ from the expected ones. An admission host sends
 *   its admission result, and either cells that differ (or none, when the copies did not run) or an
 *   admission result that does not qualify: a later copy, repetition or probe can fail while the
 *   first copies' cells still match.
 * - Tier-B hosts always send admission null.
 */
function validationProblem(host: OtfHostId, body: { state: "passed" | "failed" | "error"; cells: SixCells | null; admission: OtfAdmissionResult | null }): string | null {
  if (body.state === "passed" && !sameCells(body.cells, EXPECTED_CELLS)) return "A passed validation must carry the expected six cells.";
  if (host === "task-report") {
    if (body.admission !== null) return "A task-report validation carries no admission result.";
    if (body.state === "failed" && (body.cells === null || sameCells(body.cells, EXPECTED_CELLS))) return "A failed validation must carry six cells that differ from the expected ones.";
    return null;
  }
  if (body.state === "error") return null;
  if (body.admission === null) return "An Umami validation that passed or failed must carry its admission result.";
  const qualified = admissionQualified(body.admission);
  if (body.state === "passed" && !qualified) return "A passed Umami validation must carry a qualifying admission result.";
  if (body.state === "failed" && qualified && sameCells(body.cells, EXPECTED_CELLS)) return "A failed Umami validation must carry differing cells or an admission result that does not qualify.";
  return null;
}

/** POST /api/factory/otf/builder/validations/{vid}/result */
export async function postValidationResult(request: Request, deps: OtfBuilderDeps, params: { validation_id: string }): Promise<Response> {
  const parsed = await authed(request, deps, "ValidationResultPost", BODY_LIMITS.validation);
  if (!parsed.ok) return parsed.response;
  const { body, builder_id } = parsed;
  const found = await deps.store.getValidation(params.validation_id);
  if (found === null) return otfError("not_found");
  if (found.claimed_by !== builder_id) return otfError("unauthorized", "This validation is not claimed by this builder.");
  const owner = await deps.store.getJob(found.job_id);
  if (owner === null) return otfError("not_found");
  const problem = validationProblem(owner.host_id, body);
  if (problem !== null) return otfError("invalid_request", problem);
  const patch = { state: body.state, cells: body.cells, admission: body.admission, finished_at: body.finished_at };
  const updated = found.state === "running" ? await deps.store.updateValidation(params.validation_id, ["running"], patch) : null;
  const record = updated ?? (await deps.store.getValidation(params.validation_id));
  if (record === null) return otfError("not_found");
  // A repeat of the stored result is a retry; a different result for a finished validation came too late.
  if (updated === null && (record.state !== body.state || !sameCells(record.cells, body.cells) || !sameAdmission(record.admission, body.admission))) {
    return otfError("job_finished", "This validation has already finished.");
  }
  return sendOtf(deps.log, 200, "OtfValidation", validationView(record));
}

// ---- stop intent

/** Whether any job waits or builds, or a delivered job has a validation open. */
async function workWaiting(store: OtfStore): Promise<boolean> {
  if ((await store.listJobs(["queued", "starting_builder", "building"])).length > 0) return true;
  return (await openValidations(store)).length > 0;
}

const LOST_REASON = { max_uptime: "the builder machine reached its uptime limit", builder_fault: "the builder service failed" } as const;

/**
 * POST /api/factory/otf/builder/stop-intent, decided under the power row lock. An operator hold refuses
 * every stop. An idle stop is allowed only with no job queued, starting or building and no
 * validation open. max_uptime and builder_fault are always allowed (outside a hold), and this
 * builder's claimed jobs and validations then finish as builder_lost and error.
 */
export async function postStopIntent(request: Request, deps: OtfBuilderDeps): Promise<Response> {
  const parsed = await authed(request, deps, "StopIntent", BODY_LIMITS.stopIntent);
  if (!parsed.ok) return parsed.response;
  const { body, builder_id } = parsed;
  const at = parsed.at.toISOString();
  const idle = body.reason === "idle";
  const waiting: StopIntentReply = { allow: false, reason: "jobs_waiting" };
  // The work check runs outside the power lock, so the lock never waits on another connection; a
  // job that arrives between the check and the lock is caught by the second check below.
  const busy = idle && (await workWaiting(deps.store));
  const decided = await deps.store.withPowerLock((power) => {
    if (power.hold_until !== null && Date.parse(power.hold_until) > parsed.at.getTime()) return Promise.resolve({ patch: null, log: [], result: { reply: { allow: false, reason: "operator_hold" }, before: power.state } });
    if (busy) return Promise.resolve({ patch: null, log: [], result: { reply: waiting, before: power.state } });
    return Promise.resolve({
      patch: { state: "stopping" as const, since: at },
      log: [{ at, actor: "builder" as const, action: "stop" as const, before: power.state, after: "stopping", operation_id: null }],
      result: { reply: { allow: true, reason: "ok" }, before: power.state },
    });
  });
  let reply = decided.reply;
  if (reply.allow && idle && (await workWaiting(deps.store))) {
    // Take the stop back: the builder has not been told yet, and it keeps claiming.
    await deps.store.withPowerLock((power) => {
      const ours = power.state === "stopping" && power.since === at;
      return Promise.resolve({
        patch: ours ? { state: decided.before, since: at } : null,
        log: ours ? [{ at, actor: "builder" as const, action: "stop" as const, before: "stopping", after: decided.before, operation_id: null }] : [],
        result: undefined,
      });
    });
    reply = waiting;
  }
  if (reply.allow && body.reason !== "idle") {
    const reason = LOST_REASON[body.reason];
    for (const job of await deps.store.listJobs(["building"])) {
      if (job.claimed_by !== builder_id) continue;
      const finished = await deps.store.updateJob(job.job_id, ["building"], { state: "finished", outcome: "builder_lost", reason, finished_at: at });
      if (finished !== null) await deps.store.appendJobEvent(job.job_id, { type: "job_finished", lane_id: null, data: { outcome: "builder_lost", reason } }, at);
    }
    await finishRunningValidations(deps.store, at, builder_id);
  }
  return sendOtf(deps.log, 200, "StopIntentReply", reply);
}

// ---- route wiring

function log(line: string): void {
  console.log(line);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Why OTF is not configured, by variable name only; logged once per process. */
let notConfiguredLogged = false;

function notConfigured(config: OtfConfig): string {
  const missing = [
    config.builderSecret === null ? "RBW_OTF_BUILDER_SECRET" : null,
    config.databaseUrl === null ? "DATABASE_URL" : null,
    OTF_HOST_IDS.every((host) => !config.hosts[host].enabled)
      ? OTF_HOST_IDS.map((host) => config.hosts[host].lanesError ?? `${OTF_HOST_ENV[host].lanes} (unset)`).join(", ")
      : null,
  ].filter((item) => item !== null);
  return missing.join(", ");
}

/**
 * Runs a builder route's handler with the live dependencies. OTF unconfigured (no builder secret,
 * database or enabled host) or a store that cannot open answers unavailable, as does a handler that throws;
 * the log names only the error's class.
 */
export async function handleOtfBuilder(run: (deps: OtfBuilderDeps) => Promise<Response>): Promise<Response> {
  const config = loadOtfConfig();
  if (!otfConfigured(config)) {
    if (!notConfiguredLogged) log(`otf: custom builds are not configured (${notConfigured(config)}); every builder route answers unavailable`);
    notConfiguredLogged = true;
    return otfError("unavailable");
  }
  try {
    const store = await otfStoreFor(config);
    if (store === null) return otfError("unavailable");
    return await run({ store, config, now: () => new Date(), sleep, log });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    log(`otf: a builder route failed (${error.name}); answered unavailable`);
    return otfError("unavailable");
  }
}
