// The judge routes (design note section 6), with their dependencies injected so tests use a local
// ledger, store and Sandbox SDK. The passcode session is checked first, and a refusal makes no
// ledger, Blob or Sandbox call. The POST then follows the route steps in order: the release, an
// existing root, the hold and the budget, the slot, the controller's reservation, and the writes,
// the launch record and the one create. The status route reads judge/<root>/ and the ledger and
// returns only the projection in ReplayStatus: never resource IDs, operation IDs, keys or paths.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { JudgeModule, JudgeSandboxSdk, JudgeStore, ReplayProgress } from "@rbw/controller/judge-types";
import type { Release } from "@rbw/schema";
import type { Spend } from "@rbw/spend";
import type { Evidence } from "@rbw/admission";
import type { JudgeConfig } from "../config.ts";
import { REPLAY_STATE_TEXT, REPLAY_UNAVAILABLE_TEXT, type ReplayCell, type ReplayStatus, type UnavailableReason } from "../model.ts";

export const SESSION_COOKIE = "rbw_judge_session";
/** A week; rotating the passcode ends every session before then. */
const SESSION_SECONDS = 7 * 24 * 3600;
const ACTOR = "judge-route";
const JSON_TYPE = "application/json";
const SMALL_BYTES = 1024 * 1024;
const EVIDENCE_BYTES = 64 * 1024 * 1024;

/** What the build froze into the server bundle: release.json's text and the pinned rate sheet. */
export interface FrozenJudge {
  release: string;
  rateSheet: string;
}

export interface JudgeLedger {
  spend: Spend;
  close: () => Promise<void>;
}

export interface JudgeServer {
  config: JudgeConfig;
  frozen: FrozenJudge | null;
  /** @rbw/controller/judge-web, loaded at request time. */
  judge: () => Promise<JudgeModule>;
  ledger: () => Promise<JudgeLedger>;
  /** The function's OIDC token for this request. */
  oidcToken: () => Promise<string>;
  /** The private store, with this request's OIDC token. */
  store: (oidcToken: string) => Promise<JudgeStore>;
  sandbox: () => JudgeSandboxSdk;
  now: () => number;
  log: (line: string) => void;
}

function respond(status: number, body: object, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": JSON_TYPE, "cache-control": "no-store", ...headers } });
}

const unauthorized = () => respond(401, { state: "unauthorized", message: "Enter the judge passcode." });
const badRequest = (message: string) => respond(400, { state: "bad_request", message });

function sessionToken(passcode: string): string {
  return createHmac("sha256", passcode).update("rbw-judge-session:1").digest("base64url");
}

function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
}

function hasSession(request: Request, config: JudgeConfig): boolean {
  if (config.passcode === null) return false;
  const cookie = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return cookie !== undefined && sameSecret(cookie.slice(SESSION_COOKIE.length + 1), sessionToken(config.passcode));
}

async function body(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** POST /api/judge/session { passcode }: a correct passcode sets the session cookie. */
export async function postSession(request: Request, server: JudgeServer): Promise<Response> {
  const given = await body(request);
  const passcode = isObject(given) ? given.passcode : undefined;
  if (server.config.passcode === null || typeof passcode !== "string" || !sameSecret(passcode, server.config.passcode)) return unauthorized();
  const cookie = `${SESSION_COOKIE}=${sessionToken(server.config.passcode)}; Path=/api/judge; Max-Age=${String(SESSION_SECONDS)}; HttpOnly; Secure; SameSite=Strict`;
  return respond(200, { state: "ready" }, { "set-cookie": cookie });
}

/** GET /api/judge/session: 200 while the session cookie is valid, 401 otherwise, so a reloaded page knows it is signed in. */
export function getSession(request: Request, server: JudgeServer): Response {
  return hasSession(request, server.config) ? respond(200, { state: "ready" }) : unauthorized();
}

interface Context {
  judge: JudgeModule;
  release: Release;
  releaseBytes: Uint8Array;
  rates: ReturnType<JudgeModule["parseRateSheet"]>;
}

/** Route step 2: the frozen release is the configured one, by ID and by SHA-256. */
async function context(server: JudgeServer): Promise<Context | null> {
  const { frozen, config } = server;
  if (frozen === null || config.releaseId === null || config.releaseSha256 === null) return null;
  const judge = await server.judge();
  const releaseBytes = new TextEncoder().encode(frozen.release);
  if (createHash("sha256").update(releaseBytes).digest("hex") !== config.releaseSha256) return null;
  const release = JSON.parse(frozen.release) as Release;
  if (release.release_id !== config.releaseId) return null;
  return { judge, release, releaseBytes, rates: judge.parseRateSheet(frozen.rateSheet) };
}

function unavailable(requestId: string, reason: UnavailableReason): Response {
  return respond(200, { state: "unavailable", request_id: requestId, reason, message: REPLAY_UNAVAILABLE_TEXT[reason] });
}

async function readJson<T>(store: JudgeStore, key: string, limit: number, parse: (bytes: Uint8Array) => T): Promise<T | null> {
  const bytes = await store.get(key, limit);
  return bytes === null ? null : parse(bytes);
}

/** Every replay's progress.json, for the hold. */
async function replays(judge: JudgeModule, store: JudgeStore): Promise<ReplayProgress[]> {
  const keys = (await store.list("judge/")).filter((key) => /^judge\/[0-9a-f-]{36}\/progress\.json$/.test(key));
  const found: ReplayProgress[] = [];
  for (const key of keys) {
    const progress = await readJson(store, key, SMALL_BYTES, (bytes) => judge.parseProgress(bytes));
    if (progress !== null) found.push(progress);
  }
  return found;
}

/** POST /api/judge { request_id }: the route steps 1 to 7. */
export async function postJudge(request: Request, server: JudgeServer): Promise<Response> {
  if (!hasSession(request, server.config)) return unauthorized();
  const given = await body(request);
  if (!isObject(given) || Object.keys(given).length !== 1 || typeof given.request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(given.request_id)) {
    return badRequest("The body must be exactly { request_id } with a lowercase UUID.");
  }
  const requestId = given.request_id;
  const ctx = await context(server);
  if (ctx === null) return unavailable(requestId, "release");
  const { judge, release } = ctx;

  const token = await server.oidcToken().catch((error: unknown) => {
    if (error instanceof Error) return null;
    throw error;
  });
  if (token === null) return unavailable(requestId, "token");
  const store = await server.store(token);
  const ids = judge.judgeIds(requestId);
  const keys = judge.judgeKeys(ids.root);
  // A database outage (after the connect's own retries) reads as unavailable; nothing is written yet.
  const ledger = await server.ledger().catch((error: unknown) => {
    if (error instanceof Error) return null;
    throw error;
  });
  if (ledger === null) return unavailable(requestId, "ledger");
  try {
    const { spend } = ledger;
    if ((await store.get(keys.rootRun, SMALL_BYTES)) !== null) return respond(200, await projection(server, ctx, spend, store, requestId));
    // The controller writes its last files with this token, so it must outlive the sandbox's timeout.
    const createdMs = server.now();
    const expires = judge.tokenExpiresMs(token);
    if (expires === null || expires < createdMs + judge.CONTROLLER_TIMEOUT_MS) return unavailable(requestId, "token");

    if (judge.holdActive(await replays(judge, store), server.config.holdClearedAt)) return unavailable(requestId, "held");
    const whole = judge.judgeReservation(ctx.rates);
    const envelope = judge.controllerEnvelope(ctx.rates);
    if (!whole.ok || !envelope.ok) return unavailable(requestId, "budget");
    const pool = await spend.poolStatus({ pool_key: judge.JUDGE_POOL.pool_key });
    // The judge allocation and the pool as a whole must both cover the job. Public use is capped by
    // its own allocation, so only a public settlement over its envelope can make the pool bind first.
    const available = pool.ok ? pool.allocations.find((item) => item.allocation_key === judge.JUDGE_POOL.allocation_key)?.available_microusd : undefined;
    if (!pool.ok || available === undefined || available < whole.reserved_microusd || pool.available_microusd < whole.reserved_microusd) return unavailable(requestId, "budget");

    const slot = await spend.acquireSlot({ slot_key: judge.JUDGE_POOL.slot_key, root_execution_id: ids.root, actor_role: ACTOR });
    if (!slot.ok) return unavailable(requestId, "busy");
    if (slot.replay) return respond(200, await projection(server, ctx, spend, store, requestId));

    const r = judge.judgeRelease(release);
    const operation = judge.judgeOperation(requestId, r, envelope);
    try {
      const reserved = await spend.reserve(operation.request);
      if (!reserved.ok) {
        const released = await spend.releaseSlot({ slot_key: judge.JUDGE_POOL.slot_key, root_execution_id: ids.root, actor_role: ACTOR, evidence: null, reason: null });
        server.log(`judge ${requestId} reserve refused ${reserved.code}; slot released ${String(released.ok)}`);
        return unavailable(requestId, "budget");
      }

      const deadlineMs = judge.judgeDeadlineMs(createdMs);
      await store.putNew(keys.rootRun, judge.encodeRecord(judge.replayRootRun(r, requestId, "prepared", null)), JSON_TYPE);
      await store.putNew(keys.progress, judge.progressBytes(judge.newProgress(ids.root, createdMs, deadlineMs)), JSON_TYPE);
      const launching = await spend.transition({ operation_id: operation.operation_id, from_state: "prepared", to_state: "launching", actor_role: ACTOR, slot_key: judge.JUDGE_POOL.slot_key });
      if (!launching.ok) {
        server.log(`judge ${requestId} launching refused ${launching.code}`);
        return respond(200, await projection(server, ctx, spend, store, requestId));
      }
      const started = await judge.startJudgeController(server.sandbox(), {
        requestId,
        release,
        releaseBytes: ctx.releaseBytes,
        deadlineAtMs: deadlineMs,
        env: { ...server.config.credentials, VERCEL_OIDC_TOKEN: token },
      });
      if (started.ok || started.created !== null) {
        const running = await spend.transition({ operation_id: operation.operation_id, from_state: "launching", to_state: "running", actor_role: ACTOR, provider_resource_id: started.ok ? started.sandbox : (started.created ?? "") });
        if (!running.ok) server.log(`judge ${requestId} running refused ${running.code}`);
      }
      if (!started.ok) {
        // The controller is not running: the operator reconciles. Nothing is retried.
        const from = started.created === null ? "launching" : "running";
        const uncertain = await spend.transition({ operation_id: operation.operation_id, from_state: from, to_state: "uncertain", actor_role: ACTOR, uncertainty: started.created === null ? "lost_response" : "unknown_status" });
        await store.put(keys.rootRun, judge.encodeRecord(judge.replayRootRun(r, requestId, "needs_reconciliation", null)), JSON_TYPE);
        server.log(`judge ${requestId} start failed ${started.detail}; uncertain ${String(uncertain.ok)}`);
        return respond(200, await projection(server, ctx, spend, store, requestId));
      }
      server.log(`judge ${requestId} starting`);
      return respond(202, { state: "starting", request_id: requestId, message: REPLAY_STATE_TEXT.starting });
    } catch (error) {
      // A throw must not leave the slot held with no controller. The ledger refuses the release
      // while an operation of this root is prepared or later, so trying it is always safe.
      const released = await spend.releaseSlot({ slot_key: judge.JUDGE_POOL.slot_key, root_execution_id: ids.root, actor_role: ACTOR, evidence: null, reason: null }).catch(() => null);
      if (released?.ok === true) return unavailable(requestId, "error");
      await store.put(keys.rootRun, judge.encodeRecord(judge.replayRootRun(r, requestId, "needs_reconciliation", null)), JSON_TYPE).catch(() => undefined);
      server.log(`judge ${requestId} start threw ${error instanceof Error ? error.name : "non-error"}; slot held`);
      return respond(200, await projection(server, ctx, spend, store, requestId));
    }
  } finally {
    await ledger.close();
  }
}

function cellsOf(evidence: Evidence | null): ReplayCell[] {
  return (evidence?.cells ?? []).map((cell) => ({
    suite: cell.suite,
    trial_id: cell.trial_id,
    state: cell.state,
    matches_expectation: cell.matches_expectation,
    executed_count: cell.executed_count,
    expected_count: cell.expected_count,
    failing: cell.failing.map((item) => ({ id: item.id, repeat_index: item.repeat_index, failure_code: item.failure_code })),
  }));
}

/** The status projection of one replay, from judge/<root>/ and the ledger. */
async function projection(server: JudgeServer, ctx: Context, spend: Spend, store: JudgeStore, requestId: string): Promise<ReplayStatus> {
  const { judge, release } = ctx;
  const ids = judge.judgeIds(requestId);
  const keys = judge.judgeKeys(ids.root);
  const now = server.now();
  const base: ReplayStatus = {
    state: "starting",
    request_id: requestId,
    message: REPLAY_STATE_TEXT.starting,
    known_condition: false,
    release_id: release.release_id,
    release_created_at: release.created_at,
    created_at: null,
    ended_at: null,
    elapsed_seconds: null,
    hard_cap_seconds: judge.CONTROLLER_TIMEOUT_MS / 1000,
    copies: [],
    cells: [],
  };
  const rootRun = await readJson(store, keys.rootRun, SMALL_BYTES, (bytes) => JSON.parse(Buffer.from(bytes).toString("utf8")) as { status: string });
  const progress = await readJson(store, keys.progress, SMALL_BYTES, (bytes) => judge.parseProgress(bytes));
  const slot = await spend.slotStatus({ slot_key: judge.JUDGE_POOL.slot_key });
  const held = slot.ok && slot.holder === ids.root;
  const envelope = judge.controllerEnvelope(ctx.rates);
  const operation = envelope.ok ? await spend.operationStatus({ operation_id: judge.judgeOperation(requestId, judge.judgeRelease(release), envelope).operation_id }) : null;
  const opState = operation?.ok === true ? operation.state : null;
  if (progress === null && rootRun?.status === "needs_reconciliation") return { ...base, state: "needs_reconciliation", message: REPLAY_STATE_TEXT.needs_reconciliation };
  if (progress === null) return held ? base : { ...base, state: "unknown", message: REPLAY_STATE_TEXT.unknown };

  const created = Date.parse(progress.created_at);
  const ended = progress.ended_at === null ? null : Date.parse(progress.ended_at);
  const view: ReplayStatus = {
    ...base,
    created_at: progress.created_at,
    ended_at: progress.ended_at,
    elapsed_seconds: Math.max(0, Math.floor(((ended ?? now) - created) / 1000)),
    copies: progress.copies.map((copy) => ({ trial_id: copy.trial_id, status: copy.status, started_at: copy.started_at })),
  };
  let state: ReplayStatus["state"];
  if (rootRun?.status === "terminal") state = progress.state === "starting" || progress.state === "running" ? "incomplete" : progress.state;
  else if (rootRun?.status === "needs_reconciliation" || opState === "uncertain") state = "needs_reconciliation";
  else if (now > created + judge.CONTROLLER_TIMEOUT_MS) state = held || (opState !== null && opState !== "reconciled") ? "needs_reconciliation" : "incomplete";
  else state = progress.state === "starting" && progress.copies.every((copy) => copy.status === "not_started") ? "starting" : "running";
  const terminal = rootRun?.status === "terminal";
  const evidence = terminal ? await readJson(store, `${keys.run}jobs/${judge.JUDGE_JOB_NAME}/evidence.json`, EVIDENCE_BYTES, (bytes) => JSON.parse(Buffer.from(bytes).toString("utf8")) as Evidence) : null;
  const known = terminal && state === "verified" && progress.known_condition === true;
  return { ...view, state, known_condition: known, message: known ? judge.KNOWN_CONDITION_MESSAGE : REPLAY_STATE_TEXT[state], cells: cellsOf(evidence) };
}

/** GET /api/judge/status?request_id=<uuid>. */
export async function getStatus(request: Request, server: JudgeServer): Promise<Response> {
  if (!hasSession(request, server.config)) return unauthorized();
  const requestId = new URL(request.url).searchParams.get("request_id") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) return badRequest("request_id must be a lowercase UUID.");
  const ctx = await context(server);
  if (ctx === null) return unavailable(requestId, "release");
  const token = await server.oidcToken().catch((error: unknown) => {
    if (error instanceof Error) return null;
    throw error;
  });
  if (token === null) return unavailable(requestId, "token");
  // A database outage reads as unavailable, not a server error; the judge can poll again.
  const ledger = await server.ledger().catch((error: unknown) => {
    if (error instanceof Error) return null;
    throw error;
  });
  if (ledger === null) return unavailable(requestId, "ledger");
  try {
    const status = await projection(server, ctx, ledger.spend, await server.store(token), requestId);
    return respond(status.state === "unknown" ? 404 : 200, status);
  } finally {
    await ledger.close();
  }
}
