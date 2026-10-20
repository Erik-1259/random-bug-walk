// The factory handlers against stub ports: the contract's endpoints, status codes and refusal codes,
// the start order of contract section 7, idempotency, the lost-worker trigger, downloads and the
// payload rule. Every response body is checked against its contract definition.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RequestStatus, StartRequest } from "@rbw/factory-contract";
import { canonicalDigest } from "@rbw/schema";
import {
  getCapabilities,
  getExample,
  getPackage,
  getRequestStatus,
  getSession,
  getTestEvidence,
  getValidationRun,
  postInterpretation,
  postSession,
  postStart,
  postStop,
  postTestReconcile,
  postTestReset,
  postValidation,
  LOST_HEARTBEAT_MS,
  UNRESPONSIVE_HEARTBEAT_MS,
} from "../../src/factory-server/handlers.ts";
import { MAX_BODY_BYTES } from "../../src/factory-server/http.ts";
import { FACTORY_SESSION_COOKIE, FACTORY_SESSION_SECONDS } from "../../src/factory-server/session.ts";
import {
  CAPABILITIES,
  contractBody,
  cookie,
  EXAMPLE,
  expectValid,
  fixture,
  FULFILLED,
  harness,
  OTHER_REQUEST_ID,
  PASSCODE,
  PROFILE_LIMITS,
  QUEUED,
  readJson,
  request,
  REQUEST_ID,
  requestRoot,
  RUNNING,
  seedRequest,
  sha256,
  START,
  statusFor,
  startBody,
  SUPPORTED,
  UNSUPPORTED,
  VALIDATION_ID,
  VALIDATION_PASSED,
  VALIDATION_RUNNING,
} from "./support.ts";

const LOST = fixture("RequestStatus", "status-operational-error.json");
const CASE_ID = FULFILLED.cases[0]?.case_id ?? "";
const OTHER_CASE = "cd".repeat(32);
const OTHER_VALIDATION_ID = "00000000-0000-4000-8000-0000000002a2";
const ROOT = requestRoot(REQUEST_ID);
const STATUS_PATH = `/api/factory/requests/${REQUEST_ID}`;
const VALIDATIONS_PATH = `${STATUS_PATH}/cases/${CASE_ID}/validations`;

async function errorCode(response: Response): Promise<string> {
  const body = await contractBody("ErrorResponse", response);
  return body.error.code;
}

function start(h: ReturnType<typeof harness>, body: unknown = startBody()): Promise<Response> {
  return postStart(request("/api/factory/requests", { body }), h.server);
}

describe("session", () => {
  it("sets the factory cookie for the right passcode: an HMAC with its own label, scoped to /api/factory", async () => {
    const h = harness();
    const response = await postSession(request("/api/factory/session", { body: { passcode: PASSCODE }, session: false }), h.server);
    expect(response.status).toBe(204);
    const set = response.headers.get("set-cookie") ?? "";
    expect(set).toBe(`${cookie()}; Path=/api/factory; Max-Age=${String(FACTORY_SESSION_SECONDS)}; HttpOnly; Secure; SameSite=Strict`);
    expect(FACTORY_SESSION_SECONDS).toBe(7 * 24 * 3600);
    const judgeToken = createHmac("sha256", PASSCODE).update("rbw-judge-session:1").digest("base64url");
    expect(set).not.toContain(judgeToken);
    const signedIn = getSession(request("/api/factory/session", { headers: { cookie: set.split(";")[0] ?? "" }, session: false }), h.server);
    expect(await contractBody("SessionStatus", signedIn)).toEqual({ contract_version: "bug-request/1", signed_in: true });
  });

  it("refuses a wrong passcode with passcode_incorrect and a malformed body with invalid_request", async () => {
    const h = harness();
    const wrong = await postSession(request("/api/factory/session", { body: { passcode: "synthetic-wrong" }, session: false }), h.server);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await errorCode(wrong)).toBe("passcode_incorrect");
    for (const body of [{ passcode: 7 }, { passcode: PASSCODE, extra: true }, [], "not json {"]) {
      const response = await postSession(request("/api/factory/session", { body, session: false }), h.server);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_request");
    }
  });

  it("answers signed_in false without a valid cookie, and the judge cookie does not count", async () => {
    const h = harness();
    const judgeCookie = `rbw_judge_session=${createHmac("sha256", PASSCODE).update("rbw-judge-session:1").digest("base64url")}`;
    const variants: Record<string, string>[] = [{}, { cookie: judgeCookie }, { cookie: `${FACTORY_SESSION_COOKIE}=forged` }, { cookie: cookie("synthetic-old-passcode") }];
    for (const headers of variants) {
      const response = getSession(request("/api/factory/session", { headers, session: false }), h.server);
      expect(await contractBody("SessionStatus", response)).toEqual({ contract_version: "bug-request/1", signed_in: false });
    }
  });

  it("answers a sign-in unavailable and the session signed_in false when no passcode is configured (contract section 13)", async () => {
    const h = harness();
    h.ports.passcode = null;
    const post = await postSession(request("/api/factory/session", { body: { passcode: PASSCODE }, session: false }), h.server);
    expect(post.status).toBe(503);
    expect(await errorCode(post)).toBe("unavailable");
    for (const session of [false, true]) {
      const get = getSession(request("/api/factory/session", { session }), h.server);
      expect(get.status).toBe(200);
      expect(await contractBody("SessionStatus", get)).toEqual({ contract_version: "bug-request/1", signed_in: false });
    }
  });

  it("refuses every session-required endpoint with 401 unauthorized before any port call", async () => {
    const h = harness();
    seedRequest(h, FULFILLED);
    const params = { request_id: REQUEST_ID, case_id: CASE_ID, validation_id: VALIDATION_ID, part: "bug-case" };
    const calls: Promise<Response>[] = [
      postStart(request("/api/factory/requests", { body: startBody(), session: false }), h.server),
      getRequestStatus(request(STATUS_PATH, { session: false }), h.server, params),
      postStop(request(`${STATUS_PATH}/stop`, { body: {}, session: false }), h.server, params),
      getPackage(request(`${STATUS_PATH}/cases/${CASE_ID}/packages/bug-case`, { session: false }), h.server, params),
      postValidation(request(VALIDATIONS_PATH, { body: { validation_id: VALIDATION_ID }, session: false }), h.server, params),
      getValidationRun(request(`${VALIDATIONS_PATH}/${VALIDATION_ID}`, { session: false }), h.server, params),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("unauthorized");
    }
    expect(h.ports.calls).toEqual([]);
  });
});

describe("capabilities and interpretations", () => {
  it("answers the capabilities with the injected profile's limits, not the fixtures' illustrative ones", async () => {
    const h = harness();
    expect(PROFILE_LIMITS).not.toEqual(CAPABILITIES.limits);
    const body = await contractBody("Capabilities", await getCapabilities(request("/api/factory/capabilities", { session: false }), h.server));
    expect(body.limits).toEqual(h.ports.profile.limits);
    expect(body.service).toEqual({ state: "available", code: null, message: null });
    const reordered = Object.fromEntries(Object.entries(PROFILE_LIMITS).reverse()) as typeof PROFILE_LIMITS;
    h.ports.caps = { ...h.ports.caps, limits: reordered };
    expect((await getCapabilities(request("/api/factory/capabilities", { session: false }), h.server)).status).toBe(200);
  });

  it("answers unavailable when the capabilities' limits differ from the factory profile", async () => {
    const h = harness();
    h.ports.caps = structuredClone(CAPABILITIES);
    const response = await getCapabilities(request("/api/factory/capabilities", { session: false }), h.server);
    expect(response.status).toBe(503);
    expect(h.logs.join("\n")).toContain("limits");
  });

  it("reports a halted or unconfigured ledger in the service state", async () => {
    const h = harness();
    h.ports.ledger = { configured: true, halted: true };
    const halted = await contractBody("Capabilities", await getCapabilities(request("/api/factory/capabilities", { session: false }), h.server));
    expect(halted.service).toMatchObject({ state: "unavailable", code: "halted" });
    h.ports.ledger = { configured: false, halted: false };
    const missing = await contractBody("Capabilities", await getCapabilities(request("/api/factory/capabilities", { session: false }), h.server));
    expect(missing.service).toMatchObject({ state: "unavailable", code: "not_configured" });
  });

  it("interprets without a session and refuses invalid input with invalid_request", async () => {
    const h = harness();
    const ok = await postInterpretation(request("/api/factory/interpretations", { body: SUPPORTED.input, session: false }), h.server);
    expect(ok.status).toBe(200);
    expect(await contractBody("Interpretation", ok)).toEqual(SUPPORTED);
    for (const body of [{ ...SUPPORTED.input, extra: 1 }, "{", 5]) {
      const bad = await postInterpretation(request("/api/factory/interpretations", { body, session: false }), h.server);
      expect(bad.status).toBe(400);
      expect(await errorCode(bad)).toBe("invalid_request");
    }
    expect(h.ports.calls.filter((call) => call !== "interpret")).toEqual([]);
  });
});

describe("request body size", () => {
  const TOO_LARGE = "The request body is too large.";

  /** Valid JSON padded with trailing whitespace to `size` bytes; the request carries no content-length header. */
  function padded(value: unknown, size: number): string {
    const text = JSON.stringify(value);
    return text + " ".repeat(size - Buffer.byteLength(text, "utf8"));
  }

  /** A body stream that fails when read, under a declared content-length. */
  function declared(path: string, size: number, session: boolean): { request: Request; pulled: () => number } {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++;
          controller.error(new Error("synthetic: the body was read"));
        },
      },
      { highWaterMark: 0 },
    );
    const headers: Record<string, string> = { "content-type": "application/json", "content-length": String(size) };
    if (session) headers.cookie = cookie();
    const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body, duplex: "half" };
    return { request: new Request(`http://localhost${path}`, init), pulled: () => pulled };
  }

  async function tooLarge(response: Response): Promise<void> {
    expect(response.status).toBe(400);
    const body = await contractBody("ErrorResponse", response);
    expect([body.error.code, body.error.message]).toEqual(["invalid_request", TOO_LARGE]);
  }

  it("refuses a body over 64 KiB without a content-length header as invalid_request, before any port call", async () => {
    const h = harness();
    expect(new Request("http://localhost/", { method: "POST", body: "{}" }).headers.get("content-length")).toBeNull();
    await tooLarge(await postSession(request("/api/factory/session", { body: padded({ passcode: PASSCODE }, MAX_BODY_BYTES + 1), session: false }), h.server));
    await tooLarge(await postInterpretation(request("/api/factory/interpretations", { body: padded(SUPPORTED.input, MAX_BODY_BYTES + 1), session: false }), h.server));
    await tooLarge(await postStart(request("/api/factory/requests", { body: padded(startBody(), MAX_BODY_BYTES + 1) }), h.server));
    expect(h.ports.calls).toEqual([]);
    // Exactly the limit is accepted.
    const atLimit = await postSession(request("/api/factory/session", { body: padded({ passcode: PASSCODE }, MAX_BODY_BYTES), session: false }), h.server);
    expect(atLimit.status).toBe(204);
  });

  it("stops reading a streamed body without a content-length at the first chunk past 64 KiB", async () => {
    const h = harness();
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++;
          if (pulled > 1000) controller.close();
          else controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    const init: RequestInit & { duplex: "half" } = { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" };
    const streamed = new Request("http://localhost/api/factory/interpretations", init);
    expect(streamed.headers.get("content-length")).toBeNull();
    await tooLarge(await postInterpretation(streamed, h.server));
    // Four chunks are exactly 64 KiB; the fifth passes the limit, and nothing after it is read.
    expect(pulled).toBeGreaterThanOrEqual(5);
    expect(pulled).toBeLessThan(10);
    expect(h.ports.calls).toEqual([]);
  });

  it("refuses a declared content-length over 64 KiB without reading the body", async () => {
    const h = harness();
    const over = MAX_BODY_BYTES + 1;
    for (const [path, run] of [
      ["/api/factory/session", (req: Request) => postSession(req, h.server)],
      ["/api/factory/interpretations", (req: Request) => postInterpretation(req, h.server)],
      ["/api/factory/requests", (req: Request) => postStart(req, h.server)],
    ] as const) {
      const { request: req, pulled } = declared(path, over, path === "/api/factory/requests");
      await tooLarge(await run(req));
      expect(pulled(), path).toBe(0);
    }
    expect(h.ports.calls).toEqual([]);
  });
});

describe("start (contract section 7)", () => {
  it("runs the steps in order and answers 202 with the queued status", async () => {
    const h = harness();
    const response = await start(h);
    expect(response.status).toBe(202);
    const body = await contractBody("RequestStatus", response);
    expect(body.request_id).toBe(REQUEST_ID);
    expect(["queued", "starting"]).toContain(body.state);
    expect(h.ports.calls).toEqual([
      "canonicalStart",
      `lock:${REQUEST_ID}`,
      "findRequest",
      "interpret",
      "ledgerState",
      "poolAvailable",
      `acquireSlot:${ROOT}`,
      "createRecordLaunch",
      "status:0",
    ]);
  });

  it("refuses an invalid body before the lock", async () => {
    const h = harness();
    for (const body of [{ ...startBody(), extra: true }, { ...startBody(), request_id: "NOT-A-UUID" }, "{"]) {
      const response = await start(h, body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_request");
    }
    // The last body is not JSON, so it never reaches canonicalStart.
    expect(h.ports.calls).toEqual(["canonicalStart", "canonicalStart"]);
  });

  it("replays the same body with 200 and the current status: no new record, reservation, slot or launch", async () => {
    const h = harness();
    expect((await start(h)).status).toBe(202);
    h.ports.calls.length = 0;
    const again = await start(h);
    expect(again.status).toBe(200);
    expect((await contractBody("RequestStatus", again)).request_id).toBe(REQUEST_ID);
    expect(h.ports.calls).toEqual(["canonicalStart", `lock:${REQUEST_ID}`, "findRequest", "status:0"]);
  });

  it("answers a replayed start with the status after the lost-worker finish, like the status route", async () => {
    const h = harness();
    seedRequest(h, RUNNING, REQUEST_ID, canonicalDigest(startBody()).sha256);
    h.ports.clock = Date.parse(RUNNING.last_heartbeat_at ?? "") + LOST_HEARTBEAT_MS;
    h.ports.finalizeEffect = () => {
      const stored = h.ports.requests.get(REQUEST_ID);
      if (stored !== undefined) stored.status = statusFor(REQUEST_ID, LOST);
    };
    const replay = await start(h);
    expect(replay.status).toBe(200);
    expect((await contractBody("RequestStatus", replay)).stop_reason?.code).toBe("worker_lost");
    expect(h.ports.calls).toContain(`finalizeLost:${REQUEST_ID}`);
    expect(h.ports.calls).not.toContain("createRecordLaunch");
  });

  it("answers idempotency_conflict for the same request_id with a different body", async () => {
    const h = harness();
    expect((await start(h)).status).toBe(202);
    const other = startBody();
    other.input.budget_microusd += 1;
    const response = await start(h, other);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("idempotency_conflict");
    expect(h.ports.calls.filter((call) => call === "createRecordLaunch")).toHaveLength(1);
  });

  it("answers interpretation_stale with the current interpretation, before unsupported_request", async () => {
    const h = harness();
    h.ports.interpretation = { ...UNSUPPORTED, interpretation_sha256: "9f".repeat(32) };
    const stale = await start(h);
    expect(stale.status).toBe(409);
    const body = await contractBody("ErrorResponse", stale);
    expect(body.error).toMatchObject({ code: "interpretation_stale", retryable: false, details: { interpretation: h.ports.interpretation } });
    h.ports.interpretation = UNSUPPORTED;
    const unsupported = await start(h, startBody(REQUEST_ID, UNSUPPORTED));
    expect(unsupported.status).toBe(422);
    expect(await contractBody("ErrorResponse", unsupported)).toMatchObject({ error: { code: "unsupported_request", details: { interpretation: UNSUPPORTED } } });
    expect(h.ports.calls).not.toContain("ledgerState");
  });

  it("answers unavailable for a halted or unconfigured ledger before the pool and the slot", async () => {
    for (const ledger of [{ configured: true, halted: true }, { configured: false, halted: false }]) {
      const h = harness();
      h.ports.ledger = ledger;
      const response = await start(h);
      expect(response.status).toBe(503);
      expect(await contractBody("ErrorResponse", response)).toMatchObject({ error: { code: "unavailable", retryable: true } });
      expect(h.ports.calls.some((call) => call === "poolAvailable" || call.startsWith("acquireSlot"))).toBe(false);
    }
  });

  it("answers budget_unavailable when the pool cannot cover the full budget, before the slot", async () => {
    const h = harness();
    h.ports.pool = SUPPORTED.input.budget_microusd - 1;
    const response = await start(h);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("budget_unavailable");
    expect(h.ports.calls.some((call) => call.startsWith("acquireSlot"))).toBe(false);
    h.ports.pool = SUPPORTED.input.budget_microusd;
    expect((await start(h)).status).toBe(202);
  });

  it("answers busy while the slot is held, records nothing, and accepts the same ID once it is free", async () => {
    const h = harness();
    h.ports.slotRoot = "root-of-another-request";
    const active = await start(h);
    expect(active.status).toBe(409);
    expect(await contractBody("ErrorResponse", active)).toMatchObject({ error: { code: "busy", retryable: true, details: { reason: "active" } } });
    h.ports.slotReason = "needs_reconciliation";
    const held = await start(h);
    expect(await contractBody("ErrorResponse", held)).toMatchObject({ error: { code: "busy", retryable: false, details: { reason: "needs_reconciliation" } } });
    expect(h.ports.calls).not.toContain("createRecordLaunch");
    expect(h.ports.calls.some((call) => call.startsWith("releaseSlot"))).toBe(false);
    expect(h.ports.requests.size).toBe(0);
    const unknown = await getRequestStatus(request(STATUS_PATH), h.server, { request_id: REQUEST_ID });
    expect(unknown.status).toBe(404);
    h.ports.slotRoot = null;
    expect((await start(h)).status).toBe(202);
  });

  it("asks for the slot holder's lost-worker finish before a start answers busy active, then answers from the slot after it", async () => {
    // A lost request worker that nobody polls: its finish keeps the slot for reconciliation.
    const lost = harness();
    lost.ports.slotRoot = requestRoot(OTHER_REQUEST_ID);
    lost.ports.finalizeEffect = (target) => {
      if ("request_id" in target && target.request_id === OTHER_REQUEST_ID) lost.ports.slotReason = "needs_reconciliation";
    };
    const held = await start(lost);
    expect(await contractBody("ErrorResponse", held)).toMatchObject({ error: { code: "busy", retryable: false, details: { reason: "needs_reconciliation" } } });
    expect(lost.ports.calls.slice(-4)).toEqual([`acquireSlot:${ROOT}`, "slotHolder", `finalizeLost:${OTHER_REQUEST_ID}`, `acquireSlot:${ROOT}`]);
    expect(lost.ports.calls).not.toContain("createRecordLaunch");

    // A lost validation run whose sandbox is confirmed stopped: its finish releases the slot.
    const released = harness();
    released.ports.slotRoot = "root-of-a-validation-run";
    released.ports.holderTarget = { validation_id: OTHER_VALIDATION_ID };
    released.ports.finalizeEffect = (target) => {
      if ("validation_id" in target && target.validation_id === OTHER_VALIDATION_ID) {
        released.ports.slotRoot = null;
        released.ports.holderTarget = null;
      }
    };
    expect((await start(released)).status).toBe(202);
    expect(released.ports.calls).toContain(`finalizeLost:${OTHER_VALIDATION_ID}`);
    expect(released.ports.slotRoot).toBe(ROOT);

    // A holder that awaits reconciliation is answered at once.
    const reconciling = harness();
    reconciling.ports.slotRoot = requestRoot(OTHER_REQUEST_ID);
    reconciling.ports.slotReason = "needs_reconciliation";
    expect((await start(reconciling)).status).toBe(409);
    expect(reconciling.ports.calls).not.toContain("slotHolder");
    expect(reconciling.ports.calls.filter((call) => call.startsWith("acquireSlot"))).toHaveLength(1);
  });

  it("releases the slot at once when the budget creation is refused, so the same ID can start later", async () => {
    const h = harness();
    h.ports.createResult = { ok: false, code: "budget_unavailable", message: "synthetic: the pool cannot cover the worker" };
    const refused = await start(h);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("budget_unavailable");
    expect(h.ports.calls.slice(-2)).toEqual(["createRecordLaunch", `releaseSlot:${ROOT}`]);
    expect(h.ports.slotRoot).toBeNull();
    expect(h.ports.requests.size).toBe(0);
    h.ports.createResult = { ok: false, code: "unavailable", message: "synthetic: the launcher did not answer" };
    const unavailable = await start(h);
    expect(unavailable.status).toBe(503);
    expect(h.ports.slotRoot).toBeNull();
    h.ports.createResult = { ok: true };
    expect((await start(h)).status).toBe(202);
    expect(h.ports.slotRoot).toBe(ROOT);
  });

  it("frees the slot after a thrown step 7 only when the request was not recorded", async () => {
    const h = harness();
    h.ports.createResult = new Error("synthetic: connection reset");
    const lost = await start(h);
    expect(lost.status).toBe(503);
    expect(h.ports.slotRoot).toBeNull();
    expect(h.ports.calls.slice(-3)).toEqual(["createRecordLaunch", "findRequest", `releaseSlot:${ROOT}`]);

    const recorded = harness();
    recorded.ports.createResult = new Error("synthetic: the answer was lost after the record");
    recorded.ports.recordBeforeThrow = true;
    const accepted = await start(recorded);
    expect(accepted.status).toBe(202);
    expect(recorded.ports.slotRoot).toBe(ROOT);
    expect(recorded.ports.calls.some((call) => call.startsWith("releaseSlot"))).toBe(false);
  });

  it("frees the slot when acquiring it threw, since this unrecorded ID may hold it", async () => {
    const h = harness();
    h.ports.acquireError = new Error("synthetic: the slot call timed out");
    const response = await start(h);
    expect(response.status).toBe(503);
    expect(h.ports.calls.slice(-2)).toEqual(["findRequest", `releaseSlot:${ROOT}`]);
  });

  it("releases the slot this ID holds from an unrecorded attempt when its start is refused at step 3, 4 or 5", async () => {
    const stale = { ...SUPPORTED, interpretation_sha256: "9f".repeat(32) };
    const refusals: [string, number, (h: ReturnType<typeof harness>) => void, StartRequest][] = [
      ["invalid_request", 400, (h) => { h.ports.interpret = () => ({ ok: false, message: "synthetic: outside the limits" }); }, startBody()],
      ["interpretation_stale", 409, (h) => { h.ports.interpretation = stale; }, startBody()],
      ["unsupported_request", 422, (h) => { h.ports.interpretation = UNSUPPORTED; }, startBody(REQUEST_ID, UNSUPPORTED)],
      ["unavailable", 503, (h) => { h.ports.ledger = { configured: true, halted: true }; }, startBody()],
      ["budget_unavailable", 409, (h) => { h.ports.pool = SUPPORTED.input.budget_microusd - 1; }, startBody()],
    ];
    for (const [code, httpStatus, refuseWith, body] of refusals) {
      const h = harness();
      // An earlier attempt with this ID took the slot and ended before step 7 recorded anything.
      h.ports.slotRoot = ROOT;
      refuseWith(h);
      const response = await start(h, body);
      expect(response.status, code).toBe(httpStatus);
      expect(await errorCode(response), code).toBe(code);
      expect(h.ports.calls.at(-1), code).toBe(`releaseSlot:${ROOT}`);
      expect(h.ports.slotRoot, code).toBeNull();
      expect(h.ports.requests.size, code).toBe(0);
    }
    // The release acts only on this ID's root: a slot another request holds stays held.
    const other = harness();
    other.ports.slotRoot = requestRoot(OTHER_REQUEST_ID);
    other.ports.pool = SUPPORTED.input.budget_microusd - 1;
    expect(await errorCode(await start(other))).toBe("budget_unavailable");
    expect(other.ports.slotRoot).toBe(requestRoot(OTHER_REQUEST_ID));
  });

  it("continues with step 7 when this ID already holds the slot from an unrecorded attempt", async () => {
    const h = harness();
    h.ports.slotRoot = ROOT;
    expect((await start(h)).status).toBe(202);
    expect(h.ports.calls).toContain("createRecordLaunch");
  });

  it("serializes a concurrent pair of identical starts: one record, one reservation, one launch", async () => {
    const h = harness();
    h.ports.holdMs = 50;
    const [first, second] = await Promise.all([start(h), start(h)]);
    expect([first.status, second.status].sort()).toEqual([200, 202]);
    expect(h.ports.calls.filter((call) => call === "createRecordLaunch")).toHaveLength(1);
    expect(h.ports.calls.filter((call) => call.startsWith("acquireSlot"))).toHaveLength(1);
    const [a, b] = await Promise.all([contractBody("RequestStatus", first), contractBody("RequestStatus", second)]);
    expect(a.request_id).toBe(b.request_id);
  });

  it("answers unavailable, not a server error, when a port throws before the slot", async () => {
    const h = harness();
    h.ports.ledgerState = () => Promise.reject(new Error("synthetic: the database is down"));
    const response = await start(h);
    expect(response.status).toBe(503);
    expect(h.logs.join("\n")).not.toContain("database is down");
  });
});

function heartbeatAt(status: RequestStatus, ms: number): RequestStatus {
  return { ...status, last_heartbeat_at: new Date(ms).toISOString() };
}

describe("status and stop", () => {
  it("answers the status with the after parameter, and 404 for an unknown or malformed ID", async () => {
    const h = harness();
    seedRequest(h, RUNNING);
    h.ports.clock = Date.parse(RUNNING.last_heartbeat_at ?? "") + 1000;
    const all = await contractBody("RequestStatus", await getRequestStatus(request(STATUS_PATH), h.server, { request_id: REQUEST_ID }));
    expect(all.events.map((event) => event.seq)).toEqual(RUNNING.events.map((event) => event.seq));
    const later = await contractBody("RequestStatus", await getRequestStatus(request(`${STATUS_PATH}?after=10`), h.server, { request_id: REQUEST_ID }));
    expect(later.events.map((event) => event.seq)).toEqual([11, 12]);
    expect(later.next_after).toBe(12);
    for (const id of [OTHER_REQUEST_ID, "not-a-uuid", REQUEST_ID.toUpperCase()]) {
      const missing = await getRequestStatus(request(`/api/factory/requests/${id}`), h.server, { request_id: id });
      expect(missing.status).toBe(404);
      expect(await errorCode(missing)).toBe("not_found");
    }
  });

  it("refuses a malformed after or an unknown query parameter with invalid_request", async () => {
    const h = harness();
    seedRequest(h, RUNNING);
    for (const query of ["?after=-1", "?after=1.5", "?after=x", "?after=", "?after=01", "?after=1&after=2", "?other=1", "?after=99999999999999999999"]) {
      const response = await getRequestStatus(request(`${STATUS_PATH}${query}`), h.server, { request_id: REQUEST_ID });
      expect(response.status, query).toBe(400);
    }
    expect(h.ports.calls).toEqual([]);
  });

  it("calls finalizeLost once the heartbeat is older than 180 s and answers the finished status", async () => {
    const h = harness();
    seedRequest(h, RUNNING);
    const heartbeat = Date.parse(RUNNING.last_heartbeat_at ?? "");
    h.ports.clock = heartbeat + LOST_HEARTBEAT_MS - 1;
    await getRequestStatus(request(STATUS_PATH), h.server, { request_id: REQUEST_ID });
    expect(h.ports.calls.some((call) => call.startsWith("finalizeLost"))).toBe(false);
    h.ports.clock = heartbeat + LOST_HEARTBEAT_MS;
    h.ports.finalizeEffect = () => {
      const stored = h.ports.requests.get(REQUEST_ID);
      if (stored !== undefined) stored.status = statusFor(REQUEST_ID, LOST);
    };
    const body = await contractBody("RequestStatus", await getRequestStatus(request(STATUS_PATH), h.server, { request_id: REQUEST_ID }));
    expect(body.state).toBe("finished");
    expect(h.ports.calls.slice(-3)).toEqual(["status:0", `finalizeLost:${REQUEST_ID}`, "status:0"]);
  });

  it("measures from created_at when no heartbeat was recorded, and never finalizes a finished request", async () => {
    const h = harness();
    seedRequest(h, QUEUED);
    h.ports.clock = Date.parse(QUEUED.created_at) + LOST_HEARTBEAT_MS;
    await getRequestStatus(request(STATUS_PATH), h.server, { request_id: REQUEST_ID });
    expect(h.ports.calls).toContain(`finalizeLost:${REQUEST_ID}`);
    const finished = harness();
    seedRequest(finished, FULFILLED);
    finished.ports.clock = Date.parse(FULFILLED.updated_at) + 10 * LOST_HEARTBEAT_MS;
    await getRequestStatus(request(STATUS_PATH), finished.server, { request_id: REQUEST_ID });
    expect(finished.ports.calls.some((call) => call.startsWith("finalizeLost"))).toBe(false);
    expect(finished.ports.calls.some((call) => call.startsWith("noteUnresponsive"))).toBe(false);
  });

  it("asks for the worker_unresponsive attention from 60 s without a heartbeat, and for its clearing once a heartbeat comes back", async () => {
    const h = harness();
    seedRequest(h, heartbeatAt(RUNNING, START));
    const stored = h.ports.requests.get(REQUEST_ID);
    if (stored === undefined) throw new Error("synthetic: missing request");
    const appended: string[] = [];
    // The port's job: append the change the heartbeat's age calls for, once.
    h.ports.unresponsiveEffect = (_id, now) => {
      const stale = now.getTime() - Date.parse(stored.status.last_heartbeat_at ?? "") >= UNRESPONSIVE_HEARTBEAT_MS;
      if (stale === (stored.status.attention?.code === "worker_unresponsive")) return false;
      const seq = (stored.status.events.at(-1)?.seq ?? 0) + 1;
      const located = { seq, at: now.toISOString(), host_id: null, candidate_id: null, item_key: null, case_id: null, message: "synthetic", data: { code: "worker_unresponsive" as const } };
      stored.status.events.push(stale ? { ...located, type: "attention" } : { ...located, type: "attention_cleared" });
      stored.status.attention = stale ? { code: "worker_unresponsive", message: "synthetic" } : null;
      appended.push(stale ? "attention" : "attention_cleared");
      return true;
    };
    const read = async (): Promise<RequestStatus> => contractBody("RequestStatus", await getRequestStatus(request(STATUS_PATH), h.server, { request_id: REQUEST_ID }));

    h.ports.clock = START + UNRESPONSIVE_HEARTBEAT_MS - 1;
    expect((await read()).attention).toBeNull();
    expect(h.ports.calls.some((call) => call.startsWith("noteUnresponsive"))).toBe(false);

    h.ports.clock = START + UNRESPONSIVE_HEARTBEAT_MS;
    h.ports.calls.length = 0;
    const raised = await read();
    expect(h.ports.calls).toEqual(["status:0", `noteUnresponsive:${REQUEST_ID}`, "status:0"]);
    expect(raised.attention?.code).toBe("worker_unresponsive");
    expect(raised.events.at(-1)).toMatchObject({ type: "attention", data: { code: "worker_unresponsive" } });
    await read();
    expect(appended).toEqual(["attention"]);

    stored.status.last_heartbeat_at = new Date(h.ports.clock).toISOString();
    const cleared = await read();
    expect(cleared.attention).toBeNull();
    expect(cleared.events.at(-1)).toMatchObject({ type: "attention_cleared", data: { code: "worker_unresponsive" } });
    expect(appended).toEqual(["attention", "attention_cleared"]);

    // From 180 s the lost-worker finish takes over; the stop route asks the same way.
    h.ports.clock += UNRESPONSIVE_HEARTBEAT_MS;
    h.ports.calls.length = 0;
    await postStop(request(`${STATUS_PATH}/stop`, { body: {} }), h.server, { request_id: REQUEST_ID });
    expect(h.ports.calls).toContain(`noteUnresponsive:${REQUEST_ID}`);
    h.ports.clock += LOST_HEARTBEAT_MS;
    h.ports.calls.length = 0;
    await read();
    expect(h.ports.calls).toContain(`finalizeLost:${REQUEST_ID}`);
    expect(h.ports.calls.some((call) => call.startsWith("noteUnresponsive"))).toBe(false);
  });

  it("asks for the lost-run finish of each case's unfinished validation run from the request status, so a run nobody reads still ends", async () => {
    const h = harness();
    const running = { ...VALIDATION_RUNNING, validation_id: VALIDATION_ID, case_id: CASE_ID };
    seedRequest(h, { ...FULFILLED, cases: FULFILLED.cases.map((item) => (item.case_id === CASE_ID ? { ...item, validation: running } : item)) });
    h.ports.finalizeEffect = (target) => {
      const first = h.ports.requests.get(REQUEST_ID)?.status.cases.find((item) => item.case_id === CASE_ID);
      if ("validation_id" in target && first !== undefined) first.validation = { ...fixture("ValidationRun", "validation-error.json"), validation_id: target.validation_id, case_id: CASE_ID };
    };
    const read = async (): Promise<RequestStatus> => contractBody("RequestStatus", await getRequestStatus(request(STATUS_PATH), h.server, { request_id: REQUEST_ID }));
    const body = await read();
    expect(h.ports.calls).toEqual(["status:0", `finalizeLost:${VALIDATION_ID}`, "status:0"]);
    expect(body.cases.find((item) => item.case_id === CASE_ID)?.validation).toMatchObject({ validation_id: VALIDATION_ID, state: "finished", result: "error" });
    h.ports.calls.length = 0;
    await read();
    expect(h.ports.calls).toEqual(["status:0"]);
  });

  it("gives concurrent polls of a lost request one consistent finished state", async () => {
    const h = harness();
    seedRequest(h, RUNNING);
    h.ports.clock = Date.parse(RUNNING.last_heartbeat_at ?? "") + LOST_HEARTBEAT_MS + 5000;
    let finishes = 0;
    h.ports.finalizeEffect = () => {
      const stored = h.ports.requests.get(REQUEST_ID);
      if (stored === undefined || stored.status.state === "finished") return;
      finishes += 1;
      stored.status = statusFor(REQUEST_ID, LOST);
    };
    const responses = await Promise.all(Array.from({ length: 5 }, () => getRequestStatus(request(STATUS_PATH), h.server, { request_id: REQUEST_ID })));
    const bodies = await Promise.all(responses.map((response) => contractBody("RequestStatus", response)));
    expect(bodies.map((body) => body.state)).toEqual(Array(5).fill("finished"));
    expect(finishes).toBe(1);
  });

  it("records a stop and answers the status; repeating it changes nothing; unknown is 404", async () => {
    const h = harness();
    seedRequest(h, RUNNING);
    h.ports.clock = Date.parse(RUNNING.last_heartbeat_at ?? "") + 1000;
    const first = await postStop(request(`${STATUS_PATH}/stop`, { body: {} }), h.server, { request_id: REQUEST_ID });
    expect(first.status).toBe(200);
    expectValid("RequestStatus", await first.json());
    const again = await postStop(request(`${STATUS_PATH}/stop`, { body: {} }), h.server, { request_id: REQUEST_ID });
    expect(again.status).toBe(200);
    expect(h.ports.stops.size).toBe(1);
    const unknown = await postStop(request(`/api/factory/requests/${OTHER_REQUEST_ID}/stop`, { body: {} }), h.server, { request_id: OTHER_REQUEST_ID });
    expect(unknown.status).toBe(404);
    for (const body of [{ now: true }, [], "{"]) {
      const bad = await postStop(request(`${STATUS_PATH}/stop`, { body }), h.server, { request_id: REQUEST_ID });
      expect(bad.status).toBe(400);
    }
  });

  it("calls finalizeLost from the stop route too once the heartbeat is stale", async () => {
    const h = harness();
    seedRequest(h, heartbeatAt(RUNNING, START));
    h.ports.clock = START + LOST_HEARTBEAT_MS + 1;
    await postStop(request(`${STATUS_PATH}/stop`, { body: {} }), h.server, { request_id: REQUEST_ID });
    expect(h.ports.calls).toContain(`finalizeLost:${REQUEST_ID}`);
  });
});

describe("downloads (contract section 10.2)", () => {
  function withPackage(bytes: Uint8Array, part: "bug-case" | "validator" = "bug-case", filename?: string): ReturnType<typeof harness> {
    const h = harness();
    const delivered = structuredClone(FULFILLED);
    const caseRecord = delivered.cases[0];
    if (caseRecord === undefined) throw new Error("synthetic: the fixture has no case");
    const recorded = part === "bug-case" ? caseRecord.packages.bug_case : caseRecord.packages.validator;
    recorded.sha256 = sha256(bytes);
    recorded.size_bytes = bytes.length;
    if (filename !== undefined) recorded.filename = filename;
    seedRequest(h, delivered);
    h.ports.packages.set(`${REQUEST_ID}/${CASE_ID}/${part}`, { bytes, sha256: sha256(bytes), size: bytes.length, filename: recorded.filename });
    return h;
  }

  it("streams a delivered case's part as an attachment after checking its SHA-256", async () => {
    const bytes = new TextEncoder().encode("synthetic archive bytes 0123456789");
    const h = withPackage(bytes);
    const response = await getPackage(request(`${STATUS_PATH}/cases/${CASE_ID}/packages/bug-case`), h.server, { request_id: REQUEST_ID, case_id: CASE_ID, part: "bug-case" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${FULFILLED.cases[0]?.packages.bug_case.filename ?? ""}"`);
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("answers unavailable and sends no archive byte when the bytes do not match the recorded SHA-256", async () => {
    const bytes = new TextEncoder().encode("synthetic archive bytes");
    const h = withPackage(bytes, "validator");
    const stored = h.ports.packages.get(`${REQUEST_ID}/${CASE_ID}/validator`);
    if (stored === undefined) throw new Error("synthetic: missing package");
    stored.bytes = new TextEncoder().encode("synthetic archive bytez");
    const response = await getPackage(request(`${STATUS_PATH}/cases/${CASE_ID}/packages/validator`), h.server, { request_id: REQUEST_ID, case_id: CASE_ID, part: "validator" });
    expect(response.status).toBe(503);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.text()).not.toContain("bytez");
  });

  it("answers unavailable when the store's recorded hash or size differs from the case's", async () => {
    const bytes = new TextEncoder().encode("synthetic archive bytes");
    const h = withPackage(bytes);
    const stored = h.ports.packages.get(`${REQUEST_ID}/${CASE_ID}/bug-case`);
    if (stored === undefined) throw new Error("synthetic: missing package");
    stored.size = bytes.length + 1;
    const response = await getPackage(request(`${STATUS_PATH}/cases/${CASE_ID}/packages/bug-case`), h.server, { request_id: REQUEST_ID, case_id: CASE_ID, part: "bug-case" });
    expect(response.status).toBe(503);
  });

  it("stops reading a stored stream at the first chunk past the recorded size, and sends nothing", async () => {
    const bytes = new TextEncoder().encode("synthetic archive bytes");
    const h = withPackage(bytes);
    const stored = h.ports.packages.get(`${REQUEST_ID}/${CASE_ID}/bug-case`);
    if (stored === undefined) throw new Error("synthetic: missing package");
    // The store's recorded hash and size match the case's, but its stream does not end.
    let pulled = 0;
    stored.body = async function* () {
      for (let index = 0; index < 1000; index++) {
        pulled++;
        await Promise.resolve();
        yield bytes;
      }
    };
    const response = await getPackage(request(`${STATUS_PATH}/cases/${CASE_ID}/packages/bug-case`), h.server, { request_id: REQUEST_ID, case_id: CASE_ID, part: "bug-case" });
    expect(response.status).toBe(503);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await errorCode(response)).toBe("unavailable");
    expect(pulled).toBe(2);
  });

  it("answers unavailable, with no Content-Disposition, for a recorded filename that is not a plain file name", async () => {
    const bytes = new TextEncoder().encode("synthetic archive bytes");
    for (const filename of ['rbw-bug-case-"x".tar.gz', "../rbw-bug-case.tar.gz", "rbw bug case.tar.gz", ".rbw-bug-case.tar.gz"]) {
      const h = withPackage(bytes, "bug-case", filename);
      const response = await getPackage(request(`${STATUS_PATH}/cases/${CASE_ID}/packages/bug-case`), h.server, { request_id: REQUEST_ID, case_id: CASE_ID, part: "bug-case" });
      expect(response.status, filename).toBe(503);
      expect(response.headers.get("content-disposition"), filename).toBeNull();
      expect(await errorCode(response), filename).toBe("unavailable");
      expect(h.logs.join("\n"), filename).toContain("not a plain file name");
    }
  });

  it("answers not_found for a case that is not a delivered case of this request, and for an unknown part", async () => {
    const h = withPackage(new TextEncoder().encode("synthetic"));
    for (const [caseId, part] of [[OTHER_CASE, "bug-case"], [CASE_ID, "evaluator"], [CASE_ID, "constructor"], [CASE_ID, "bug_case"], ["not-a-hash", "validator"]] as const) {
      const response = await getPackage(request(`${STATUS_PATH}/cases/${caseId}/packages/${part}`), h.server, { request_id: REQUEST_ID, case_id: caseId, part });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe("not_found");
    }
    const other = await getPackage(request(`/api/factory/requests/${OTHER_REQUEST_ID}/cases/${CASE_ID}/packages/bug-case`), h.server, { request_id: OTHER_REQUEST_ID, case_id: CASE_ID, part: "bug-case" });
    expect(other.status).toBe(404);
    expect(h.ports.calls.some((call) => call.startsWith("readPackage"))).toBe(false);
    const running = harness();
    seedRequest(running, RUNNING);
    const notYet = await getPackage(request(`${STATUS_PATH}/cases/${CASE_ID}/packages/bug-case`), running.server, { request_id: REQUEST_ID, case_id: CASE_ID, part: "bug-case" });
    expect(notYet.status).toBe(404);
  });

  it("answers not_found when the store has no archive for a delivered case", async () => {
    const h = harness();
    seedRequest(h, FULFILLED);
    const response = await getPackage(request(`${STATUS_PATH}/cases/${CASE_ID}/packages/bug-case`), h.server, { request_id: REQUEST_ID, case_id: CASE_ID, part: "bug-case" });
    expect(response.status).toBe(404);
  });
});

describe("validation runs (contract section 11)", () => {
  function post(h: ReturnType<typeof harness>, body: unknown = { validation_id: VALIDATION_ID }, requestId = REQUEST_ID, caseId = CASE_ID): Promise<Response> {
    return postValidation(request(`/api/factory/requests/${requestId}/cases/${caseId}/validations`, { body }), h.server, { request_id: requestId, case_id: caseId });
  }

  it("checks the ID first, then the delivered case, then starts the run: 202 with the run", async () => {
    const h = harness();
    seedRequest(h, FULFILLED);
    const response = await post(h);
    expect(response.status).toBe(202);
    const run = await contractBody("ValidationRun", response);
    expect(run).toMatchObject({ validation_id: VALIDATION_ID, case_id: CASE_ID });
    expect(h.ports.calls).toEqual([`lock:${VALIDATION_ID}`, "findValidation", `status:${String(Number.MAX_SAFE_INTEGER)}`, "startValidation"]);
  });

  it("answers 200 with the existing run for the same ID on the same path, and starts nothing", async () => {
    const h = harness();
    seedRequest(h, FULFILLED);
    expect((await post(h)).status).toBe(202);
    h.ports.calls.length = 0;
    const again = await post(h);
    expect(again.status).toBe(200);
    expect((await contractBody("ValidationRun", again)).validation_id).toBe(VALIDATION_ID);
    expect(h.ports.calls).not.toContain("startValidation");
  });

  it("asks for the lost-worker finish before it answers a replayed POST of an unfinished run", async () => {
    const h = harness();
    seedRequest(h, FULFILLED);
    expect((await post(h)).status).toBe(202);
    h.ports.finalizeEffect = (target) => {
      const stored = "validation_id" in target ? h.ports.validations.get(target.validation_id) : undefined;
      if (stored !== undefined) stored.run = { ...fixture("ValidationRun", "validation-error.json"), validation_id: VALIDATION_ID, case_id: CASE_ID };
    };
    const again = await post(h);
    expect(again.status).toBe(200);
    expect((await contractBody("ValidationRun", again)).state).toBe("finished");
    expect(h.ports.calls).toContain(`finalizeLost:${VALIDATION_ID}`);
  });

  it("answers idempotency_conflict for an ID used on another case or request, before the slot and budget", async () => {
    const h = harness();
    seedRequest(h, FULFILLED);
    seedRequest(h, FULFILLED, OTHER_REQUEST_ID);
    expect((await post(h)).status).toBe(202);
    h.ports.validationResult = { kind: "busy", reason: "active" };
    const otherCase = FULFILLED.cases[1]?.case_id ?? "";
    for (const [requestId, caseId] of [[REQUEST_ID, otherCase], [OTHER_REQUEST_ID, CASE_ID]]) {
      const response = await post(h, { validation_id: VALIDATION_ID }, requestId, caseId);
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe("idempotency_conflict");
    }
    expect(h.ports.calls.filter((call) => call === "startValidation")).toHaveLength(1);
  });

  it("answers not_found for a case that is not delivered, without starting anything", async () => {
    const h = harness();
    seedRequest(h, RUNNING);
    for (const [requestId, caseId] of [[REQUEST_ID, CASE_ID], [REQUEST_ID, OTHER_CASE], [OTHER_REQUEST_ID, CASE_ID], [REQUEST_ID, "short"]]) {
      const response = await post(h, { validation_id: VALIDATION_ID }, requestId, caseId);
      expect(response.status).toBe(404);
    }
    expect(h.ports.calls).not.toContain("startValidation");
  });

  it("maps the start's refusals: busy, budget_unavailable and unavailable, with nothing recorded", async () => {
    const h = harness();
    seedRequest(h, FULFILLED);
    h.ports.validationResult = { kind: "busy", reason: "needs_reconciliation" };
    expect(await contractBody("ErrorResponse", await post(h))).toMatchObject({ error: { code: "busy", retryable: false, details: { reason: "needs_reconciliation" } } });
    h.ports.validationResult = { kind: "busy", reason: "active" };
    expect(await contractBody("ErrorResponse", await post(h))).toMatchObject({ error: { code: "busy", retryable: true } });
    h.ports.validationResult = { kind: "budget_unavailable" };
    const budget = await post(h);
    expect(budget.status).toBe(409);
    expect(await errorCode(budget)).toBe("budget_unavailable");
    h.ports.validationResult = { kind: "unavailable", message: "synthetic: the launcher did not answer" };
    expect((await post(h)).status).toBe(503);
    const read = await getValidationRun(request(`${VALIDATIONS_PATH}/${VALIDATION_ID}`), h.server, { request_id: REQUEST_ID, case_id: CASE_ID, validation_id: VALIDATION_ID });
    expect(read.status).toBe(404);
  });

  it("asks for the slot holder's lost-worker finish before a validation start answers busy active, then starts once more", async () => {
    const h = harness();
    seedRequest(h, FULFILLED);
    h.ports.validationResult = { kind: "busy", reason: "active" };
    h.ports.holderTarget = { validation_id: OTHER_VALIDATION_ID };
    h.ports.finalizeEffect = (target) => {
      if ("validation_id" in target && target.validation_id === OTHER_VALIDATION_ID) h.ports.validationResult = null;
    };
    const response = await post(h);
    expect(response.status).toBe(202);
    expect(h.ports.calls.slice(-4)).toEqual(["startValidation", "slotHolder", `finalizeLost:${OTHER_VALIDATION_ID}`, "startValidation"]);

    // A live holder: still busy after the one retry, and nothing recorded.
    const alive = harness();
    seedRequest(alive, FULFILLED);
    alive.ports.validationResult = { kind: "busy", reason: "active" };
    alive.ports.holderTarget = { request_id: OTHER_REQUEST_ID };
    expect(await contractBody("ErrorResponse", await post(alive))).toMatchObject({ error: { code: "busy", retryable: true, details: { reason: "active" } } });
    expect(alive.ports.calls.filter((call) => call === "startValidation")).toHaveLength(2);
    expect(alive.ports.validations.size).toBe(0);

    const reconciling = harness();
    seedRequest(reconciling, FULFILLED);
    reconciling.ports.validationResult = { kind: "busy", reason: "needs_reconciliation" };
    expect((await post(reconciling)).status).toBe(409);
    expect(reconciling.ports.calls).not.toContain("slotHolder");
  });

  it("refuses a malformed body with invalid_request", async () => {
    const h = harness();
    seedRequest(h, FULFILLED);
    for (const body of [{}, { validation_id: "x" }, { validation_id: VALIDATION_ID, extra: 1 }, "{"]) {
      const response = await post(h, body);
      expect(response.status).toBe(400);
    }
    expect(h.ports.calls).toEqual([]);
  });

  it("runs concurrent POSTs with one ID one at a time: one start", async () => {
    const h = harness();
    seedRequest(h, FULFILLED);
    h.ports.holdMs = 30;
    const responses = await Promise.all([post(h), post(h), post(h)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 202]);
    expect(h.ports.calls.filter((call) => call === "startValidation")).toHaveLength(1);
  });

  it("reads a run, answers 404 for an unknown one, and asks for the lost-worker finish only while it is not finished", async () => {
    const h = harness();
    seedRequest(h, FULFILLED);
    expect((await post(h)).status).toBe(202);
    const path = `${VALIDATIONS_PATH}/${VALIDATION_ID}`;
    const params = { request_id: REQUEST_ID, case_id: CASE_ID, validation_id: VALIDATION_ID };
    const running = await getValidationRun(request(path), h.server, params);
    expect((await contractBody("ValidationRun", running)).state).toBe("running");
    expect(h.ports.calls.slice(-3)).toEqual(["getValidation", `finalizeLost:${VALIDATION_ID}`, "getValidation"]);
    const stored = h.ports.validations.get(VALIDATION_ID);
    if (stored === undefined) throw new Error("synthetic: missing run");
    stored.run = { ...VALIDATION_PASSED, validation_id: VALIDATION_ID, case_id: CASE_ID };
    h.ports.calls.length = 0;
    expect((await contractBody("ValidationRun", await getValidationRun(request(path), h.server, params))).result).toBe("passed");
    expect(h.ports.calls).toEqual(["getValidation"]);
    const unknown = await getValidationRun(request(path), h.server, { ...params, validation_id: OTHER_REQUEST_ID });
    expect(unknown.status).toBe(404);
    const wrongCase = await getValidationRun(request(path), h.server, { ...params, case_id: OTHER_CASE });
    expect(wrongCase.status).toBe(404);
  });
});

describe("example and test endpoints", () => {
  it("answers the published example with its label and note, or 404 while none is published", async () => {
    const h = harness();
    const body = await contractBody("ExampleResponse", await getExample(request("/api/factory/example", { session: false }), h.server));
    expect(body.case).toEqual(EXAMPLE.case);
    expect(body.label).toBe("Completed example");
    h.ports.exampleCase = null;
    const none = await getExample(request("/api/factory/example", { session: false }), h.server);
    expect(none.status).toBe(404);
    h.ports.exampleCase = { ...EXAMPLE.case, provenance: { ...EXAMPLE.case.provenance, origin: "live_request", request_id: REQUEST_ID } };
    expect((await getExample(request("/api/factory/example", { session: false }), h.server)).status).toBe(503);
  });

  it("answers not_found for every test endpoint outside test mode, without a session check", async () => {
    const h = harness();
    const responses = await Promise.all([
      getTestEvidence(request(`/api/factory/test/evidence?request_id=${REQUEST_ID}`, { session: false }), h.server),
      postTestReconcile(request("/api/factory/test/reconcile", { body: { request_id: REQUEST_ID }, session: false }), h.server),
      postTestReset(request("/api/factory/test/reset", { body: { scenario: "two-host-fulfilled" }, session: false }), h.server),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe("not_found");
    }
  });

  it("serves the test controls in test mode without a session", async () => {
    const evidence = fixture("TestEvidence", "test-evidence.json");
    const resets: string[] = [];
    const h = harness({
      evidence: (id) => Promise.resolve(id === REQUEST_ID ? { ...evidence, request_id: REQUEST_ID } : null),
      reconcile: (id) => Promise.resolve(id === REQUEST_ID),
      reset: (scenario) => {
        resets.push(scenario);
        return Promise.resolve();
      },
    });
    seedRequest(h, FULFILLED);
    const read = await getTestEvidence(request(`/api/factory/test/evidence?request_id=${REQUEST_ID}`, { session: false }), h.server);
    expect((await contractBody("TestEvidence", read)).request_id).toBe(REQUEST_ID);
    expect((await getTestEvidence(request(`/api/factory/test/evidence?request_id=${OTHER_REQUEST_ID}`, { session: false }), h.server)).status).toBe(404);
    expect((await getTestEvidence(request("/api/factory/test/evidence?request_id=x", { session: false }), h.server)).status).toBe(400);
    const reconciled = await postTestReconcile(request("/api/factory/test/reconcile", { body: { request_id: REQUEST_ID }, session: false }), h.server);
    expect((await contractBody("RequestStatus", reconciled)).request_id).toBe(REQUEST_ID);
    expect((await postTestReconcile(request("/api/factory/test/reconcile", { body: { request_id: OTHER_REQUEST_ID }, session: false }), h.server)).status).toBe(404);
    const reset = await postTestReset(request("/api/factory/test/reset", { body: { scenario: "worker-lost" }, session: false }), h.server);
    expect(await contractBody("TestResetResponse", reset)).toEqual({ contract_version: "bug-request/1", scenario: "worker-lost" });
    expect((await postTestReset(request("/api/factory/test/reset", { body: { scenario: "synthetic-unknown" }, session: false }), h.server)).status).toBe(400);
    expect(resets).toEqual(["worker-lost"]);
  });
});

describe("payload rule (contract section 10.1)", () => {
  const SENTINEL = "synthetic-evaluator-sentinel-7c1d";

  it("never sends a field outside the contract: a status carrying evaluator material answers unavailable", async () => {
    const h = harness();
    seedRequest(h, FULFILLED);
    h.ports.statusOverride = (status) => {
      const leaked = structuredClone(status) as RequestStatus & { candidates: Record<string, unknown>[] };
      const first = leaked.candidates[0];
      if (first !== undefined) {
        first.detail = SENTINEL;
        first.failure_codes = [SENTINEL];
      }
      return leaked;
    };
    const response = await getRequestStatus(request(STATUS_PATH), h.server, { request_id: REQUEST_ID });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(SENTINEL);
    expect(h.logs.join("\n")).not.toContain(SENTINEL);
  });

  it("never sends evaluator material placed in a case, a run or the capabilities", async () => {
    const h = harness();
    const leakyCase = { ...structuredClone(FULFILLED.cases[0]), reference_repair: SENTINEL };
    h.ports.exampleCase = { ...EXAMPLE.case, ...leakyCase, item_key: null, provenance: EXAMPLE.case.provenance };
    const example = await getExample(request("/api/factory/example", { session: false }), h.server);
    expect(example.status).toBe(503);
    expect(await example.text()).not.toContain(SENTINEL);
    h.ports.caps = { ...h.ports.caps, verification: SENTINEL } as typeof h.ports.caps;
    const caps = await getCapabilities(request("/api/factory/capabilities", { session: false }), h.server);
    expect(await caps.text()).not.toContain(SENTINEL);
    seedRequest(h, FULFILLED);
    h.ports.validationResult = { kind: "accepted", run: { ...VALIDATION_PASSED, validation_id: VALIDATION_ID, case_id: CASE_ID, expected_vectors: SENTINEL } as typeof VALIDATION_PASSED };
    const run = await postValidation(request(VALIDATIONS_PATH, { body: { validation_id: VALIDATION_ID } }), h.server, { request_id: REQUEST_ID, case_id: CASE_ID });
    expect(run.status).toBe(503);
    expect(await run.text()).not.toContain(SENTINEL);
  });
});

describe("refusal bodies", () => {
  it("match the contract's error fixtures in code, status and retryable", async () => {
    const h = harness();
    const pairs: [string, Response][] = [
      ["error-unauthorized.json", await postStart(request("/api/factory/requests", { body: startBody(), session: false }), h.server)],
      ["error-not-found.json", await getRequestStatus(request(STATUS_PATH), h.server, { request_id: REQUEST_ID })],
    ];
    for (const [file, response] of pairs) {
      const expected = fixture("ErrorResponse", file);
      const body = await contractBody("ErrorResponse", response);
      expect({ code: body.error.code, retryable: body.error.retryable, details: body.error.details }).toEqual({ code: expected.error.code, retryable: expected.error.retryable, details: expected.error.details });
    }
    const json = await readJson(await getRequestStatus(request(STATUS_PATH), h.server, { request_id: REQUEST_ID }));
    expect(json.contract_version).toBe("bug-request/1");
  });
});
