import { backupCodeFor, type Fixture, type FixtureCheck } from "./fixture.ts";
import { execute, type HttpResult, type RequestContext } from "./http.ts";
import { errorSummary, isRecord, parseJsonBody } from "./json.ts";
import { loginRequest, verifyBackupCodeRequest, type Credentials } from "./requests.ts";
import { fireConcurrent, fireOne, fireSequential, overlapOf } from "./template/index.ts";
import type { AttemptTiming, RequestOutcome, RequestPlan } from "./template/index.ts";

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

/** Builds the VerifyAttempt for one settled or thrown verify request. Redacts the token and code from a failure. */
function recordAttempt(outcome: RequestOutcome, timing: AttemptTiming, state: VerifyState): VerifyAttempt {
  if (outcome.settled) {
    const { result } = outcome;
    return {
      sent_ms: timing.sent_ms,
      settled_ms: timing.settled_ms,
      status: result.status,
      error_code: result.status === 200 ? null : errorCode(result),
      token_issued: tokenIssued(result),
      failure: null,
    };
  }
  return {
    sent_ms: timing.sent_ms,
    settled_ms: timing.settled_ms,
    status: null,
    error_code: null,
    token_issued: false,
    failure: errorSummary(outcome.error, [state.partialToken, state.backupCode]),
  };
}

interface VerifyState {
  partialToken: string;
  backupCode: string;
}

/** Which verify request to fire for a signed-in state, and how to record its answer. */
const verifyRequest: Pick<RequestPlan<VerifyState, VerifyAttempt, SetupFailure>, "request" | "record"> = {
  request: (state) => verifyBackupCodeRequest(state.partialToken, state.backupCode),
  record: recordAttempt,
};

/** The request plan for a backup-code check: sign in for a challenge, then verify the check's code. */
function verifyPlan(fixture: Fixture, check: FixtureCheck, credentials: Credentials): RequestPlan<VerifyState, VerifyAttempt, SetupFailure> {
  const backupCode = backupCodeFor(fixture, check).plaintext;
  return {
    setup: async (context) => {
      const challenge = await loginForChallenge(context, credentials);
      return challenge.ok ? { ok: true, state: { partialToken: challenge.partialToken, backupCode } } : challenge;
    },
    ...verifyRequest,
  };
}

/**
 * Sends one verify request, without retries, and records when it was sent and when it settled.
 * It fires through the same template step and record as the race and the control.
 */
export async function attemptVerify(context: RequestContext, partialToken: string, backupCode: string, now: Clock, origin: number): Promise<VerifyAttempt> {
  return (await fireOne(context, { partialToken, backupCode }, verifyRequest, now, origin)).attempt;
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
  const sequence = await fireSequential(context, verifyPlan(fixture, check, credentials), (first) => first.token_issued, now);
  if (!sequence.ok) {
    if (sequence.attempts.length > 0) {
      return { ...sequence.failure, evidence: { check_id: check.check_id, kind: "serial_reuse", attempts: sequence.attempts } };
    }
    return sequence.failure;
  }
  return { ok: true, evidence: { check_id: check.check_id, kind: "serial_reuse", attempts: sequence.attempts } };
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
  const burst = await fireConcurrent(contexts, verifyPlan(fixture, check, credentials), now);
  if (!burst.ok) {
    return burst.failure;
  }
  const [a, b] = burst.attempts;
  if (a === undefined || b === undefined) {
    return { ok: false, failure_code: "seed_failed", reason: "the race did not fire two verify requests" };
  }
  return { ok: true, evidence: { check_id: check.check_id, kind: "concurrent_double_spend", attempts: [a, b], overlap_ms: burst.overlap_ms } };
}

/** The time both requests were in flight together; zero or less when one settled before the other was sent. */
export function overlapMs(attempts: readonly [VerifyAttempt, VerifyAttempt]): number {
  return overlapOf(attempts.map((attempt) => ({ sent_ms: attempt.sent_ms, settled_ms: attempt.settled_ms })));
}

/** The evidence as the check's response artifact: JSON with a trailing newline. */
export function encodeEvidence(evidence: Evidence): Uint8Array {
  return Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}
