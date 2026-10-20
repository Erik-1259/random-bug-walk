// The factory service's endpoints (contract sections 4 to 15.1) over injected ports (ports.ts), in
// the pattern of the judge routes: thin route files call these with the server from server.ts.
// Session-required endpoints check the session before any port call. A port that throws answers
// `unavailable` (the message is not logged, since a dependency's error text may name its
// configuration). Every JSON body passes its contract definition before it is sent (http.ts).
import { createHash } from "node:crypto";
import type { Case, Limits, PackagePart, RequestStatus, StartRequest, TestResetRequest, ValidationRun } from "@rbw/factory-contract";
import { validateContract } from "@rbw/factory-contract/validate";
import { busy, CONTRACT_VERSION, invalidMessage, readBody, refuse, refuseInterpretation, sendContract } from "./http.ts";
import type { FactoryServer, FactoryServerPorts, SlotResult } from "./ports.ts";
import { factorySessionCookie, hasFactorySession, sameSecret } from "./session.ts";

/** A worker or validation run without a heartbeat for this long is lost (contract sections 8.1 and 11). */
export const LOST_HEARTBEAT_MS = 180_000;
/** A request worker without a heartbeat for this long is unresponsive (contract section 8.1). */
export const UNRESPONSIVE_HEARTBEAT_MS = 60_000;
/** `after` past every event: a status read for its cases only. */
const NO_EVENTS = Number.MAX_SAFE_INTEGER;

export const EXAMPLE_LABEL = "Completed example";
export const EXAMPLE_NOTE = "This case was qualified and published earlier under bug-request/1. It is not the output of a live request, and live progress never appears here.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const AFTER = /^(0|[1-9][0-9]*)$/;
/** A filename that needs no quoting or encoding in Content-Disposition. */
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const PARTS = { "bug-case": "bug_case", validator: "validator" } as const;
type PartPath = keyof typeof PARTS;

/**
 * Runs a handler; a dependency that throws answers `unavailable`. Only the error's name is logged.
 * Values that are not errors are not expected from any port and are rethrown.
 */
async function guard(server: FactoryServer, endpoint: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    server.log(`factory ${endpoint}: a dependency failed (${error.name}); answered unavailable`);
    return refuse("unavailable");
  }
}

function signedIn(request: Request, ports: FactoryServerPorts): boolean {
  return hasFactorySession(request, ports.passcode);
}

const unauthorized = (): Response => refuse("unauthorized");
const notFound = (): Response => refuse("not_found");

function invalid(name: string, errors: readonly string[]): Response {
  return refuse("invalid_request", invalidMessage(name, errors));
}

/** POST /api/factory/session { passcode }: 204 with the cookie, or 401 passcode_incorrect. */
export function postSession(request: Request, server: FactoryServer): Promise<Response> {
  return guard(server, "session", async () => {
    const { passcode } = server.ports;
    if (passcode === null) return refuse("unavailable");
    const body = await readBody(request);
    if (!body.ok) return refuse("invalid_request", body.message);
    const errors = validateContract("SessionRequest", body.value);
    if (errors.length > 0) return invalid("SessionRequest", errors);
    const given = (body.value as { passcode: string }).passcode;
    if (!sameSecret(given, passcode)) return refuse("passcode_incorrect");
    return new Response(null, { status: 204, headers: { "set-cookie": factorySessionCookie(passcode), "cache-control": "no-store" } });
  });
}

/** GET /api/factory/session: 200 { signed_in }; without a configured passcode no session is valid (contract section 13). */
export function getSession(request: Request, server: FactoryServer): Response {
  return sendContract(server.log, 200, "SessionStatus", { contract_version: CONTRACT_VERSION, signed_in: signedIn(request, server.ports) });
}

/** Field by field, so the order of the keys does not matter; the values are numbers or lists of numbers. */
function sameLimits(a: Limits, b: Limits): boolean {
  const keys = Object.keys(b) as (keyof Limits)[];
  return Object.keys(a).length === keys.length && keys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

/** GET /api/factory/capabilities: public; the limits must be the factory profile's. */
export function getCapabilities(_request: Request, server: FactoryServer): Promise<Response> {
  return guard(server, "capabilities", async () => {
    const { ports } = server;
    const capabilities = ports.capabilities(ports.now());
    if (!sameLimits(capabilities.limits, ports.profile.limits)) {
      server.log("factory capabilities: the limits differ from the factory profile's; answered unavailable");
      return refuse("unavailable");
    }
    const ledger = await ports.ledgerState();
    const service: typeof capabilities.service = !ledger.configured
      ? { state: "unavailable", code: "not_configured", message: "The factory service is not configured." }
      : ledger.halted
        ? { state: "unavailable", code: "halted", message: "Spending is halted for an operator check, so no paid work can start." }
        : capabilities.service;
    return sendContract(server.log, 200, "Capabilities", { ...capabilities, service });
  });
}

/** POST /api/factory/interpretations: public, free and side-effect free. */
export function postInterpretation(request: Request, server: FactoryServer): Promise<Response> {
  return guard(server, "interpretations", async () => {
    const body = await readBody(request);
    if (!body.ok) return refuse("invalid_request", body.message);
    const { ports } = server;
    const result = ports.interpret(body.value, ports.now());
    if (!result.ok) return refuse("invalid_request", result.message);
    return sendContract(server.log, 200, "Interpretation", result.interpretation);
  });
}

/** POST /api/factory/requests: contract section 7, steps 1 to 7. */
export function postStart(request: Request, server: FactoryServer): Promise<Response> {
  return guard(server, "start", async () => {
    const { ports } = server;
    if (!signedIn(request, ports)) return unauthorized();
    const body = await readBody(request);
    if (!body.ok) return refuse("invalid_request", body.message);
    const canonical = ports.canonicalStart(body.value);
    if (!canonical.ok) return refuse("invalid_request", canonical.message);
    const { start, sha256 } = canonical;
    return ports.withRequestLock(start.request_id, () => startLocked(server, start, sha256));
  });
}

/** Steps 2 to 7, under the request_id lock. */
async function startLocked(server: FactoryServer, start: StartRequest, sha256: string): Promise<Response> {
  const { ports } = server;
  const requestId = start.request_id;
  const existing = await ports.findRequest(requestId);
  if (existing !== null) {
    if (existing.canonical_sha256 !== sha256) return refuse("idempotency_conflict", "A request with this ID already exists with a different body. Read its status, or start a new request with a new ID.");
    return statusResponse(server, requestId, 200);
  }

  const root = server.requestRoot(requestId);
  // Nothing is recorded under this ID, so a slot its root holds was taken by an earlier attempt that ended
  // before step 7 answered. A start refused before the record releases it (contract section 7); after a
  // refusal the client may never send this ID again, and the slot would stay held for nobody.
  const refuseUnrecorded = async (refusal: Response): Promise<Response> => {
    await ports.releaseSlot(root);
    return refusal;
  };
  const now = ports.now();
  const interpreted = ports.interpret(start.input, now);
  if (!interpreted.ok) return refuseUnrecorded(refuse("invalid_request", interpreted.message));
  const { interpretation } = interpreted;
  if (interpretation.interpretation_sha256 !== start.interpretation_sha256) return refuseUnrecorded(refuseInterpretation(server.log, "interpretation_stale", interpretation));
  if (!interpretation.startable) return refuseUnrecorded(refuseInterpretation(server.log, "unsupported_request", interpretation));

  const ledger = await ports.ledgerState();
  if (!ledger.configured || ledger.halted) {
    return refuseUnrecorded(refuse("unavailable", ledger.configured ? "The spend ledger is halted, so no paid work can start. Try again later." : "The factory service is not configured."));
  }
  if ((await ports.poolAvailable()) < interpretation.input.budget_microusd) {
    return refuseUnrecorded(refuse("budget_unavailable", "The factory pool's available amount cannot cover this request's budget right now."));
  }

  try {
    const slot = await acquireSlot(server, root);
    if (slot.kind === "held") return busy(slot.reason);
    // "replay": this ID holds the slot from an attempt that recorded nothing, so step 7 runs again.
    const launched = await ports.createRecordLaunch({ start, sha256, interpretation, root });
    if (!launched.ok) {
      await ports.releaseSlot(root);
      server.log(`factory start ${requestId}: refused at step 7 (${launched.code}); slot released`);
      return refuse(launched.code, launched.message);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // Unknown whether step 7 recorded the request. A recorded request reports any later failure through
    // its own outcome; an unrecorded one must not keep the slot, which this ID may hold.
    if ((await ports.findRequest(requestId)) !== null) {
      server.log(`factory start ${requestId}: step 7 failed (${error.name}) after the record; accepted`);
      return statusResponse(server, requestId, 202);
    }
    await ports.releaseSlot(root);
    server.log(`factory start ${requestId}: step 6 or 7 failed (${error.name}) before the record; slot released`);
    return refuse("unavailable");
  }
  return statusResponse(server, requestId, 202);
}

/**
 * Asks for the slot holder's lost-worker finish, which acts only on a lost holder. A worker or validation
 * run that is lost while nobody reads its own ID would otherwise keep the slot `active` without end.
 */
async function finishLostHolder(server: FactoryServer): Promise<void> {
  const holder = await server.ports.slotHolder();
  if (holder !== null) await server.ports.finalizeLost(holder);
}

/** Takes the slot; when it is held for an active holder, after that holder's lost-worker finish, once more. */
async function acquireSlot(server: FactoryServer, root: string): Promise<SlotResult> {
  const first = await server.ports.acquireSlot(root);
  if (first.kind !== "held" || first.reason !== "active") return first;
  await finishLostHolder(server);
  return server.ports.acquireSlot(root);
}

/** A start's answer: the current status, after the lost-worker finish when it is due, as the status route answers. */
async function statusResponse(server: FactoryServer, requestId: string, code: 200 | 202): Promise<Response> {
  const status = await currentStatus(server, requestId, 0);
  if (status === null) {
    server.log(`factory status ${requestId}: a recorded request has no status; answered unavailable`);
    return refuse("unavailable");
  }
  return sendContract(server.log, code, "RequestStatus", status);
}

/** How long the request worker has sent no heartbeat (before the first one, since the acceptance). */
function heartbeatAge(status: RequestStatus, now: Date): number {
  return now.getTime() - Date.parse(status.last_heartbeat_at ?? status.created_at);
}

/** Whether a request's worker counts as lost: active, with its heartbeat (or, before one, its acceptance) 180 s old. */
export function workerLost(status: RequestStatus, now: Date): boolean {
  if (status.state === "finished") return false;
  return heartbeatAge(status, now) >= LOST_HEARTBEAT_MS;
}

/**
 * Whether the worker_unresponsive attention may have to change: an active request whose heartbeat is 60 s
 * old but not yet lost (raise), or whose attention is worker_unresponsive (clear once a heartbeat came).
 */
function attentionDue(status: RequestStatus, now: Date): boolean {
  if (status.state === "finished" || workerLost(status, now)) return false;
  return heartbeatAge(status, now) >= UNRESPONSIVE_HEARTBEAT_MS || status.attention?.code === "worker_unresponsive";
}

/**
 * The status, after what its heartbeats call for (contract sections 8.1 and 11): the lost-worker finish
 * once the request's heartbeat is 180 s old, the worker_unresponsive attention change before that, and
 * the lost-run finish of each case's validation run that is not finished (it acts only on a lost run).
 */
async function currentStatus(server: FactoryServer, requestId: string, after: number): Promise<RequestStatus | null> {
  const { ports } = server;
  const now = ports.now();
  const status = await ports.status(requestId, after, now);
  if (status === null) return null;
  let changed = false;
  if (workerLost(status, now)) {
    await ports.finalizeLost({ request_id: requestId });
    changed = true;
  } else if (attentionDue(status, now)) {
    changed = await ports.noteUnresponsive(requestId, now);
  }
  for (const item of status.cases) {
    if (item.validation === null || item.validation.state === "finished") continue;
    await ports.finalizeLost({ validation_id: item.validation.validation_id });
    changed = true;
  }
  return changed ? ports.status(requestId, after, ports.now()) : status;
}

/** `after` from the query: absent is 0; anything but one non-negative safe integer is invalid. */
function parseAfter(url: URL): { ok: true; after: number } | { ok: false } {
  const names = [...url.searchParams.keys()];
  if (names.some((name) => name !== "after")) return { ok: false };
  const values = url.searchParams.getAll("after");
  if (values.length === 0) return { ok: true, after: 0 };
  const text = values[0] ?? "";
  if (values.length > 1 || !AFTER.test(text)) return { ok: false };
  const after = Number(text);
  return Number.isSafeInteger(after) ? { ok: true, after } : { ok: false };
}

/** GET /api/factory/requests/{request_id}?after={seq} */
export function getRequestStatus(request: Request, server: FactoryServer, params: { request_id: string }): Promise<Response> {
  return guard(server, "status", async () => {
    if (!signedIn(request, server.ports)) return unauthorized();
    const after = parseAfter(new URL(request.url));
    if (!after.ok) return refuse("invalid_request", "The only query parameter is after, a non-negative integer.");
    if (!UUID.test(params.request_id)) return notFound();
    const status = await currentStatus(server, params.request_id, after.after);
    return status === null ? notFound() : sendContract(server.log, 200, "RequestStatus", status);
  });
}

/** POST /api/factory/requests/{request_id}/stop with {}: idempotent; answers the current status. */
export function postStop(request: Request, server: FactoryServer, params: { request_id: string }): Promise<Response> {
  return guard(server, "stop", async () => {
    const { ports } = server;
    if (!signedIn(request, ports)) return unauthorized();
    if (!UUID.test(params.request_id)) return notFound();
    const body = await readBody(request);
    if (!body.ok) return refuse("invalid_request", body.message);
    const errors = validateContract("StopRequest", body.value);
    if (errors.length > 0) return invalid("StopRequest", errors);
    if ((await ports.recordStop(params.request_id)) === "not_found") return notFound();
    const status = await currentStatus(server, params.request_id, 0);
    return status === null ? notFound() : sendContract(server.log, 200, "RequestStatus", status);
  });
}

/** The delivered case of a request, from its status; null when the request or the case is unknown. */
async function deliveredCase(server: FactoryServer, requestId: string, caseId: string): Promise<Case | null> {
  if (!UUID.test(requestId) || !SHA256.test(caseId)) return null;
  const { ports } = server;
  const status = await ports.status(requestId, NO_EVENTS, ports.now());
  return status?.cases.find((item) => item.case_id === caseId) ?? null;
}

async function readAll(body: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) return null;
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

/**
 * GET /api/factory/requests/{request_id}/cases/{case_id}/packages/{bug-case|validator}: the whole
 * archive is read and its size and SHA-256 checked against the case's PackagePart before any byte is
 * sent, so a client never receives bytes other than the ones the status announced.
 */
export function getPackage(request: Request, server: FactoryServer, params: { request_id: string; case_id: string; part: string }): Promise<Response> {
  return guard(server, "download", async () => {
    if (!signedIn(request, server.ports)) return unauthorized();
    if (!Object.hasOwn(PARTS, params.part)) return notFound();
    const partPath = params.part as PartPath;
    const delivered = await deliveredCase(server, params.request_id, params.case_id);
    if (delivered === null) return notFound();
    const part: PackagePart = delivered.packages[PARTS[partPath]];
    if (!part.ready || part.download_path === null) return notFound();
    const read = await server.ports.readPackage(params.request_id, params.case_id, partPath);
    if (read === null) return notFound();
    const where = `factory download ${params.request_id} ${params.case_id} ${partPath}`;
    if (read.sha256 !== part.sha256 || read.size !== part.size_bytes) {
      server.log(`${where}: the stored part's recorded hash or size differs from the case's; answered unavailable`);
      return refuse("unavailable");
    }
    const bytes = await readAll(read.body, part.size_bytes);
    if (bytes?.length !== part.size_bytes || createHash("sha256").update(bytes).digest("hex") !== part.sha256) {
      server.log(`${where}: the bytes do not match the recorded SHA-256; answered unavailable`);
      return refuse("unavailable");
    }
    if (!SAFE_FILENAME.test(part.filename)) {
      server.log(`${where}: the recorded filename is not a plain file name; answered unavailable`);
      return refuse("unavailable");
    }
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        "content-type": part.media_type,
        "content-length": String(bytes.length),
        "content-disposition": `attachment; filename="${part.filename}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}

/**
 * POST /api/factory/requests/{request_id}/cases/{case_id}/validations { validation_id }: under the
 * validation_id lock, the ID check first (same path: 200 with the run; elsewhere: 409), then the
 * delivered case (404), then the start port, which takes the slot, reserves and records, or refuses
 * with nothing recorded (contract section 11).
 */
export function postValidation(request: Request, server: FactoryServer, params: { request_id: string; case_id: string }): Promise<Response> {
  return guard(server, "validation start", async () => {
    const { ports } = server;
    if (!signedIn(request, ports)) return unauthorized();
    if (!UUID.test(params.request_id) || !SHA256.test(params.case_id)) return notFound();
    const body = await readBody(request);
    if (!body.ok) return refuse("invalid_request", body.message);
    const errors = validateContract("ValidationStartRequest", body.value);
    if (errors.length > 0) return invalid("ValidationStartRequest", errors);
    const validationId = (body.value as { validation_id: string }).validation_id;
    return ports.withRequestLock(validationId, async () => {
      const existing = await ports.findValidation(validationId);
      if (existing !== null) {
        if (existing.request_id !== params.request_id || existing.case_id !== params.case_id) {
          return refuse("idempotency_conflict", "This validation ID was already used on another request or case.");
        }
        const run = await currentRun(server, params.request_id, params.case_id, validationId);
        if (run === null) {
          server.log(`factory validation ${validationId}: recorded but unreadable; answered unavailable`);
          return refuse("unavailable");
        }
        return sendContract(server.log, 200, "ValidationRun", run);
      }
      if ((await deliveredCase(server, params.request_id, params.case_id)) === null) return notFound();
      const args = { request_id: params.request_id, case_id: params.case_id, validation_id: validationId };
      let started = await ports.startValidation(args);
      if (started.kind === "busy" && started.reason === "active") {
        // A refusal records nothing, so after the holder's lost-worker finish the start can run once more.
        await finishLostHolder(server);
        started = await ports.startValidation(args);
      }
      switch (started.kind) {
        case "accepted":
          return sendContract(server.log, 202, "ValidationRun", started.run);
        case "busy":
          return busy(started.reason);
        case "budget_unavailable":
          return refuse("budget_unavailable", "The request budget's remaining amount or the factory pool's available amount cannot cover this validation run's worst case.");
        case "unavailable":
          return refuse("unavailable", started.message);
      }
    });
  });
}

/**
 * GET /api/factory/requests/{request_id}/cases/{case_id}/validations/{validation_id}. While the run is
 * not finished, the lost-worker finish is asked for first; it acts only on a run that is lost.
 */
export function getValidationRun(request: Request, server: FactoryServer, params: { request_id: string; case_id: string; validation_id: string }): Promise<Response> {
  return guard(server, "validation read", async () => {
    const { ports } = server;
    if (!signedIn(request, ports)) return unauthorized();
    if (!UUID.test(params.request_id) || !SHA256.test(params.case_id) || !UUID.test(params.validation_id)) return notFound();
    const run = await currentRun(server, params.request_id, params.case_id, params.validation_id);
    return run === null ? notFound() : sendContract(server.log, 200, "ValidationRun", run);
  });
}

/** The run; while it is not finished, after asking for the lost-worker finish, which acts only on a lost run. */
async function currentRun(server: FactoryServer, requestId: string, caseId: string, validationId: string): Promise<ValidationRun | null> {
  const { ports } = server;
  const run = await ports.getValidation(requestId, caseId, validationId);
  if (run === null || run.state === "finished") return run;
  await ports.finalizeLost({ validation_id: validationId });
  return ports.getValidation(requestId, caseId, validationId);
}

/** GET /api/factory/example: public; 404 while no example is published. */
export function getExample(_request: Request, server: FactoryServer): Promise<Response> {
  return guard(server, "example", async () => {
    const example = await server.ports.example();
    if (example === null) return notFound();
    return sendContract(server.log, 200, "ExampleResponse", { contract_version: CONTRACT_VERSION, label: EXAMPLE_LABEL, note: EXAMPLE_NOTE, case: example });
  });
}

/** GET /api/factory/test/evidence?request_id=: test mode only; no session. */
export function getTestEvidence(request: Request, server: FactoryServer): Promise<Response> {
  return guard(server, "test evidence", async () => {
    const { test } = server;
    if (test === null) return notFound();
    const url = new URL(request.url);
    const ids = url.searchParams.getAll("request_id");
    const id = ids[0] ?? "";
    if ([...url.searchParams.keys()].some((name) => name !== "request_id") || ids.length !== 1 || !UUID.test(id)) {
      return refuse("invalid_request", "The only query parameter is request_id, a lowercase UUID.");
    }
    const evidence = await test.evidence(id);
    return evidence === null ? notFound() : sendContract(server.log, 200, "TestEvidence", evidence);
  });
}

/** POST /api/factory/test/reconcile { request_id }: test mode only; answers the status after reconciliation. */
export function postTestReconcile(request: Request, server: FactoryServer): Promise<Response> {
  return guard(server, "test reconcile", async () => {
    const { test } = server;
    if (test === null) return notFound();
    const body = await readBody(request);
    if (!body.ok) return refuse("invalid_request", body.message);
    const errors = validateContract("TestReconcileRequest", body.value);
    if (errors.length > 0) return invalid("TestReconcileRequest", errors);
    const requestId = (body.value as { request_id: string }).request_id;
    if (!(await test.reconcile(requestId))) return notFound();
    const status = await server.ports.status(requestId, 0, server.ports.now());
    return status === null ? notFound() : sendContract(server.log, 200, "RequestStatus", status);
  });
}

/** POST /api/factory/test/reset { scenario }: test mode only. */
export function postTestReset(request: Request, server: FactoryServer): Promise<Response> {
  return guard(server, "test reset", async () => {
    const { test } = server;
    if (test === null) return notFound();
    const body = await readBody(request);
    if (!body.ok) return refuse("invalid_request", body.message);
    const errors = validateContract("TestResetRequest", body.value);
    if (errors.length > 0) return invalid("TestResetRequest", errors);
    const { scenario } = body.value as TestResetRequest;
    await test.reset(scenario);
    return sendContract(server.log, 200, "TestResetResponse", { contract_version: CONTRACT_VERSION, scenario });
  });
}
