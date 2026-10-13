import { describe, expect, it } from "vitest";
import {
  attemptVerify,
  classify,
  encodeEvidence,
  loadFixture,
  loginForChallenge,
  overlapMs,
  runDoubleSpend,
  runSerialReuse,
  type RequestContext,
  type VerifyAttempt,
} from "../src/index.ts";
import { FakeApp, steppingClock } from "./fake-app.ts";

const fixture = loadFixture();
const credentials = { username: "synthetic-admin", password: "synthetic-password" };
const [serialCheck, raceCheck] = fixture.checks;
if (serialCheck === undefined || raceCheck === undefined) {
  throw new Error("the fixture has two checks");
}

function answering(status: number, body: unknown): RequestContext {
  return {
    fetch: () => {
      const bytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      return Promise.resolve({ status: () => status, body: () => Promise.resolve(bytes) });
    },
  };
}

function attempt(sent: number, settled: number): VerifyAttempt {
  return { sent_ms: sent, settled_ms: settled, status: 200, error_code: null, token_issued: true, failure: null };
}

describe("loginForChallenge", () => {
  it("returns the partial token of a two-factor challenge", async () => {
    await expect(loginForChallenge(answering(200, { requiresTwoFactor: true, partialToken: "synthetic-partial" }), credentials)).resolves.toEqual({
      ok: true,
      partialToken: "synthetic-partial",
    });
  });

  it("reports a full sign-in with no challenge as missing baked state (seed_failed)", async () => {
    await expect(loginForChallenge(answering(200, { token: "synthetic-token" }), credentials)).resolves.toEqual({
      ok: false,
      failure_code: "seed_failed",
      reason: "login: no two-factor challenge (the baked two-factor state is missing)",
    });
  });

  it.each([
    [401, { error: { code: "incorrect-username-password" } }, "login: HTTP 401"],
    [200, "not json", "login: body is not JSON"],
    [200, { requiresTwoFactor: true }, "login: no partial token in the response"],
  ])("reports HTTP %i %j as auth_failed", async (status, body, reason) => {
    await expect(loginForChallenge(answering(status, body), credentials)).resolves.toEqual({ ok: false, failure_code: "auth_failed", reason });
  });

  it("redacts the password from a network error", async () => {
    const context: RequestContext = { fetch: () => Promise.reject(new Error("connect refused for synthetic-password\nCall log: body")) };
    await expect(loginForChallenge(context, credentials)).resolves.toEqual({
      ok: false,
      failure_code: "auth_failed",
      reason: "login: request failed (connect refused for [redacted])",
    });
  });
});

describe("attemptVerify", () => {
  it("records times from the origin, the status, the error code and no token", async () => {
    const clock = steppingClock();
    const origin = clock();
    const result = await attemptVerify(answering(400, { error: { code: "two-factor-error-invalid-backup-code" } }), "synthetic-partial", "SYNTHETIC-RC1-CODE-01", clock, origin);
    expect(result).toEqual({ sent_ms: 1, settled_ms: 2, status: 400, error_code: "two-factor-error-invalid-backup-code", token_issued: false, failure: null });
  });

  it("counts HTTP 200 as accepted only with a non-empty token", async () => {
    const clock = steppingClock();
    expect((await attemptVerify(answering(200, { token: "synthetic-full" }), "p", "c", clock, 0)).token_issued).toBe(true);
    expect((await attemptVerify(answering(200, { token: "" }), "p", "c", clock, 0)).token_issued).toBe(false);
  });

  it("records a network error with the token and the code redacted", async () => {
    const context: RequestContext = { fetch: () => Promise.reject(new Error("reset by peer synthetic-partial SYNTHETIC-RC1-CODE-01")) };
    const result = await attemptVerify(context, "synthetic-partial", "SYNTHETIC-RC1-CODE-01", steppingClock(), 0);
    expect(result).toMatchObject({ status: null, token_issued: false, failure: "reset by peer [redacted] [redacted]" });
  });
});

describe("overlapMs", () => {
  it("is the earlier settle minus the later send", () => {
    expect(overlapMs([attempt(0, 40), attempt(2, 55)])).toBe(38);
    expect(overlapMs([attempt(3, 20), attempt(0, 90)])).toBe(17);
  });

  it("is zero or less when one request settled before the other was sent", () => {
    expect(overlapMs([attempt(0, 10), attempt(10, 30)])).toBe(0);
    expect(overlapMs([attempt(0, 10), attempt(15, 30)])).toBe(-5);
  });
});

describe("runDoubleSpend against an app that follows the pinned verify route", () => {
  it("sends both verify requests before either settles, each with its own sign-in", async () => {
    const app = new FakeApp(fixture, "clean");
    const result = await runDoubleSpend([app.context(), app.context()], fixture, raceCheck, credentials, steppingClock());
    if (!result.ok) throw new Error(result.reason);
    const verifies = app.calls.filter((call) => call.url === "/api/2fa/verify");
    expect(verifies.map((call) => call.headers.authorization)).toEqual(["Bearer synthetic-partial-1", "Bearer synthetic-partial-2"]);
    expect(verifies.map((call) => call.data)).toEqual(['{"backupCode":"SYNTHETIC-RC1-CODE-10"}', '{"backupCode":"SYNTHETIC-RC1-CODE-10"}']);
    const [a, b] = result.evidence.attempts;
    expect(Math.max(a.sent_ms, b.sent_ms)).toBeLessThan(Math.min(a.settled_ms, b.settled_ms));
    expect(result.evidence.overlap_ms).toBeGreaterThan(0);
  });

  it("passes on the clean route: one request accepted, the other refused", async () => {
    const app = new FakeApp(fixture, "clean");
    const result = await runDoubleSpend([app.context(), app.context()], fixture, raceCheck, credentials, steppingClock());
    if (!result.ok) throw new Error(result.reason);
    expect(result.evidence.attempts.map((item) => item.token_issued).sort()).toEqual([false, true]);
    expect(classify(result.evidence)).toMatchObject({ observed: "pass", failure_code: null });
  });

  it("fails with double_spend on the planted route: both requests accepted", async () => {
    const app = new FakeApp(fixture, "planted");
    const result = await runDoubleSpend([app.context(), app.context()], fixture, raceCheck, credentials, steppingClock());
    if (!result.ok) throw new Error(result.reason);
    expect(result.evidence.attempts.map((item) => item.token_issued)).toEqual([true, true]);
    expect(classify(result.evidence)).toMatchObject({ observed: "assertion_fail", failure_code: "double_spend" });
  });

  it("passes on the planted route when the first write lands before the second read, so one passing round is not evidence of a fix", async () => {
    const app = new FakeApp(fixture, "planted", { serializeVerifies: true });
    const result = await runDoubleSpend([app.context(), app.context()], fixture, raceCheck, credentials, steppingClock());
    if (!result.ok) throw new Error(result.reason);
    expect(result.evidence.attempts.map((item) => item.token_issued)).toEqual([true, false]);
    expect(result.evidence.attempts[1]).toMatchObject({ status: 400, error_code: "two-factor-error-invalid-backup-code" });
    expect(result.evidence.overlap_ms).toBeGreaterThan(0);
    expect(classify(result.evidence)).toMatchObject({ observed: "pass", failure_code: null });
  });

  it("stops at a failed sign-in and sends no verify request", async () => {
    const app = new FakeApp(fixture, "clean");
    app.twoFactorEnabled = false;
    const result = await runDoubleSpend([app.context(), app.context()], fixture, raceCheck, credentials, steppingClock());
    expect(result).toMatchObject({ ok: false, failure_code: "seed_failed" });
    expect(app.calls.map((call) => call.url)).toEqual(["/api/auth/login"]);
  });
});

/** Passes sign-in to the app but rejects the verify, naming the request's partial token and code in the error. */
function verifyThrows(appContext: RequestContext): RequestContext {
  return {
    fetch: (url, options) => {
      if (url !== "/api/2fa/verify") return appContext.fetch(url, options);
      const token = (options.headers.authorization ?? "").replace("Bearer ", "");
      const code = (JSON.parse(options.data ?? "{}") as { backupCode: string }).backupCode;
      return Promise.reject(new Error(`reset by peer ${token} ${code}`));
    },
  };
}

describe("a verify request that throws", () => {
  it("in the race keeps both records, with the thrown one's partial token and code redacted", async () => {
    const app = new FakeApp(fixture, "clean");
    const result = await runDoubleSpend([app.context(), verifyThrows(app.context())], fixture, raceCheck, credentials, steppingClock());
    if (!result.ok) throw new Error(result.reason);
    const [a, b] = result.evidence.attempts;
    expect(a).toMatchObject({ status: 200, token_issued: true, failure: null });
    expect(b).toMatchObject({ status: null, token_issued: false, failure: "reset by peer [redacted] [redacted]" });
    expect(classify(result.evidence)).toMatchObject({ observed: "setup_fail" });
  });

  it("in the control is recorded redacted and is not reused", async () => {
    const app = new FakeApp(fixture, "clean");
    const result = await runSerialReuse(verifyThrows(app.context()), fixture, serialCheck, credentials, steppingClock());
    if (!result.ok) throw new Error(result.reason);
    expect(result.evidence.attempts).toEqual([{ sent_ms: 1, settled_ms: 2, status: null, error_code: null, token_issued: false, failure: "reset by peer [redacted] [redacted]" }]);
    expect(classify(result.evidence)).toMatchObject({ observed: "setup_fail" });
  });
});

describe("runSerialReuse", () => {
  it.each(["clean", "planted"] as const)("passes on the %s route: the reuse after the first use settled is refused", async (variant) => {
    const app = new FakeApp(fixture, variant);
    const result = await runSerialReuse(app.context(), fixture, serialCheck, credentials, steppingClock());
    if (!result.ok) throw new Error(result.reason);
    expect(app.calls.map((call) => call.url)).toEqual(["/api/auth/login", "/api/2fa/verify", "/api/auth/login", "/api/2fa/verify"]);
    const [first, second] = result.evidence.attempts;
    expect(first?.token_issued).toBe(true);
    expect(second).toMatchObject({ status: 400, error_code: "two-factor-error-invalid-backup-code" });
    expect(second?.sent_ms).toBeGreaterThan(first?.settled_ms ?? Infinity);
    expect(classify(result.evidence)).toMatchObject({ observed: "pass", failure_code: null });
  });

  it("does not reuse a code whose first use was refused", async () => {
    let logins = 0;
    const context: RequestContext = {
      fetch: (url: string) => {
        if (url === "/api/auth/login") logins += 1;
        const body = url === "/api/auth/login" ? { requiresTwoFactor: true, partialToken: "synthetic-partial" } : { error: { code: "two-factor-error-invalid-backup-code" } };
        return answering(url === "/api/auth/login" ? 200 : 400, body).fetch(url, { method: "POST", headers: {} });
      },
    };
    const result = await runSerialReuse(context, fixture, serialCheck, credentials, steppingClock());
    if (!result.ok) throw new Error(result.reason);
    expect(result.evidence.attempts).toHaveLength(1);
    expect(logins).toBe(1);
    expect(classify(result.evidence)).toMatchObject({ observed: "setup_fail", failure_code: "seed_failed" });
  });

  it("keeps the first use as evidence when the follow-up sign-in fails", async () => {
    const app = new FakeApp(fixture, "clean");
    const appContext = app.context();
    let logins = 0;
    const context: RequestContext = {
      fetch: (url, options) => {
        if (url === "/api/auth/login") {
          logins += 1;
          if (logins === 2) return answering(401, { error: { code: "incorrect-username-password" } }).fetch(url, options);
        }
        return appContext.fetch(url, options);
      },
    };
    const result = await runSerialReuse(context, fixture, serialCheck, credentials, steppingClock());
    expect(result).toMatchObject({ ok: false, failure_code: "auth_failed", reason: "login: HTTP 401" });
    if (result.ok) throw new Error("expected a setup failure");
    expect(result.evidence).toMatchObject({ check_id: serialCheck.check_id, kind: "serial_reuse" });
    expect(result.evidence?.attempts).toHaveLength(1);
    expect(result.evidence?.attempts[0]).toMatchObject({ status: 200, token_issued: true });
  });
});

describe("encodeEvidence", () => {
  it("writes the evidence as JSON with no token, partial token or backup code in it", async () => {
    const app = new FakeApp(fixture, "planted");
    const result = await runDoubleSpend([app.context(), app.context()], fixture, raceCheck, credentials, steppingClock());
    if (!result.ok) throw new Error(result.reason);
    const text = Buffer.from(encodeEvidence(result.evidence)).toString("utf8");
    expect(JSON.parse(text)).toEqual(result.evidence);
    expect(text.endsWith("}\n")).toBe(true);
    for (const secret of ["synthetic-full-token", "synthetic-partial", "SYNTHETIC-RC1-CODE"]) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(result.evidence)).toEqual(["check_id", "kind", "attempts", "overlap_ms"]);
  });
});
