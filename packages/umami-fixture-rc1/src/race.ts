import { backupCodeFor, type Fixture, type FixtureCheck } from "./fixture.ts";
import { execute, type HttpResult, type RequestContext } from "./http.ts";
import { errorSummary, isRecord, parseJsonBody } from "./json.ts";
import { loginRequest, verifyBackupCodeRequest, type Credentials } from "./requests.ts";

export type SetupFailureCode = "auth_failed" | "seed_failed";

/** A setup failure. The reason names the step and the status, never a response body or token. */
export interface SetupFailure {
  ok: false;
  failure_code: SetupFailureCode;
  reason: string;
}

export type ChallengeResult = { ok: true; partialToken: string } | SetupFailure;

/**
 * One POST /api/2fa/verify as the harness saw it. Times are milliseconds from the check's first
 * verify send. Holds the status and Umami's error code, never a token or a response body.
 */
export interface VerifyAttempt {
  sent_ms: number;
  settled_ms: number;
  /** Null when no response arrived. */
  status: number | null;
  /** error.code of a non-200 JSON body, when it has one. */
  error_code: string | null;
  /** True for HTTP 200 with a non-empty token: the code was accepted and a session issued. */
  token_issued: boolean;
  /** The first line of a network error, secrets redacted; null when a response arrived. */
  failure: string | null;
}

export interface SerialReuseEvidence {
  check_id: string;
  kind: "serial_reuse";
  /** The first use, then (only if the first was accepted) the reuse after it settled. */
  attempts: VerifyAttempt[];
}

export interface DoubleSpendEvidence {
  check_id: string;
  kind: "concurrent_double_spend";
  attempts: [VerifyAttempt, VerifyAttempt];
  /** How long both requests were in flight together: the earlier settle minus the later send. */
  overlap_ms: number;
}

export type Evidence = SerialReuseEvidence | DoubleSpendEvidence;

/**
 * A setup failure keeps the evidence of any verify request already sent, so the round still
 * writes it as the check's response artifact.
 */
export type RoundResult<E extends Evidence> = { ok: true; evidence: E } | (SetupFailure & { evidence?: E });

export type Clock = () => number;

function milliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function errorCode(result: HttpResult): string | null {
  const parsed = parseJsonBody(result.body);
  if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value.error)) {
    return null;
  }
  const code = parsed.value.error.code;
  return typeof code === "string" ? code : null;
}

function tokenIssued(result: HttpResult): boolean {
  if (result.status !== 200) {
    return false;
  }
  const parsed = parseJsonBody(result.body);
  return parsed.ok && isRecord(parsed.value) && typeof parsed.value.token === "string" && parsed.value.token !== "";
}

/**
 * POST /api/auth/login for a user with two-factor sign-in enabled. Requires HTTP 200 and a
 * partial token. A full sign-in with no challenge means the baked two-factor state is missing.
 */
export async function loginForChallenge(context: RequestContext, credentials: Credentials): Promise<ChallengeResult> {
  let result: HttpResult;
  try {
    result = await execute(context, loginRequest(credentials));
  } catch (error) {
    return { ok: false, failure_code: "auth_failed", reason: `login: request failed (${errorSummary(error, [credentials.password])})` };
  }
  if (result.status !== 200) {
    return { ok: false, failure_code: "auth_failed", reason: `login: HTTP ${String(result.status)}` };
  }
  const parsed = parseJsonBody(result.body);
  if (!parsed.ok) {
    return { ok: false, failure_code: "auth_failed", reason: `login: ${parsed.reason}` };
  }
  const body = parsed.value;
  if (!isRecord(body) || body.requiresTwoFactor !== true) {
    return { ok: false, failure_code: "seed_failed", reason: "login: no two-factor challenge (the baked two-factor state is missing)" };
  }
  const token = body.partialToken;
  if (typeof token !== "string" || token === "") {
    return { ok: false, failure_code: "auth_failed", reason: "login: no partial token in the response" };
  }
  return { ok: true, partialToken: token };
}

/** Sends one verify request, without retries, and records when it was sent and when it settled. */
export async function attemptVerify(context: RequestContext, partialToken: string, backupCode: string, now: Clock, origin: number): Promise<VerifyAttempt> {
  const sent = now();
  try {
    const result = await execute(context, verifyBackupCodeRequest(partialToken, backupCode));
    const settled = now();
    return {
      sent_ms: milliseconds(sent - origin),
      settled_ms: milliseconds(settled - origin),
      status: result.status,
      error_code: result.status === 200 ? null : errorCode(result),
      token_issued: tokenIssued(result),
      failure: null,
    };
  } catch (error) {
    const settled = now();
    return {
      sent_ms: milliseconds(sent - origin),
      settled_ms: milliseconds(settled - origin),
      status: null,
      error_code: null,
      token_issued: false,
      failure: errorSummary(error, [partialToken, backupCode]),
    };
  }
}

/**
 * The control: sign in, spend the check's backup code, and only if that was accepted sign in
 * again and spend the same code once more, after the first use has settled. The pinned app
 * refuses the reuse whether or not the race guard is in place.
 */
export async function runSerialReuse(
  context: RequestContext,
  fixture: Fixture,
  check: FixtureCheck,
  credentials: Credentials,
  now: Clock,
): Promise<RoundResult<SerialReuseEvidence>> {
  const code = backupCodeFor(fixture, check).plaintext;
  const first = await loginForChallenge(context, credentials);
  if (!first.ok) {
    return first;
  }
  const origin = now();
  const attempts = [await attemptVerify(context, first.partialToken, code, now, origin)];
  if (attempts[0]?.token_issued === true) {
    const second = await loginForChallenge(context, credentials);
    if (!second.ok) {
      return { ...second, evidence: { check_id: check.check_id, kind: "serial_reuse", attempts } };
    }
    attempts.push(await attemptVerify(context, second.partialToken, code, now, origin));
  }
  return { ok: true, evidence: { check_id: check.check_id, kind: "serial_reuse", attempts } };
}

/**
 * The race: two sign-ins, one per request context, then both verify requests for the same
 * backup code started together. Each context is its own connection pool, so neither request
 * waits for the other on the client side.
 */
export async function runDoubleSpend(
  contexts: readonly [RequestContext, RequestContext],
  fixture: Fixture,
  check: FixtureCheck,
  credentials: Credentials,
  now: Clock,
): Promise<RoundResult<DoubleSpendEvidence>> {
  const code = backupCodeFor(fixture, check).plaintext;
  const first = await loginForChallenge(contexts[0], credentials);
  if (!first.ok) {
    return first;
  }
  const second = await loginForChallenge(contexts[1], credentials);
  if (!second.ok) {
    return second;
  }
  const origin = now();
  const attempts = await Promise.all([
    attemptVerify(contexts[0], first.partialToken, code, now, origin),
    attemptVerify(contexts[1], second.partialToken, code, now, origin),
  ]);
  return { ok: true, evidence: { check_id: check.check_id, kind: "concurrent_double_spend", attempts, overlap_ms: overlapMs(attempts) } };
}

/** The time both requests were in flight together; zero or less when one settled before the other was sent. */
export function overlapMs(attempts: readonly [VerifyAttempt, VerifyAttempt]): number {
  const [a, b] = attempts;
  return milliseconds(Math.min(a.settled_ms, b.settled_ms) - Math.max(a.sent_ms, b.sent_ms));
}

/** The evidence as the check's response artifact: JSON with a trailing newline. */
export function encodeEvidence(evidence: Evidence): Uint8Array {
  return Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}
