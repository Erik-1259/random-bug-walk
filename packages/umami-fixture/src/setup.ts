import type { Fixture } from "./fixture.ts";
import { execute, type ApiRequest, type HttpResult, type RequestContext } from "./http.ts";
import { errorSummary, isRecord, parseJsonBody } from "./json.ts";
import { createWebsiteRequest, loginRequest, sendRequests, type Credentials } from "./requests.ts";

export type SetupFailureCode = "auth_failed" | "seed_failed";

/** A setup failure. The reason names the step and the status, never a response body or token. */
export interface SetupFailure {
  ok: false;
  failure_code: SetupFailureCode;
  reason: string;
}

export type LoginResult = { ok: true; token: string } | SetupFailure;
export type SeedResult = { ok: true } | SetupFailure;

type Step = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

function failure(failureCode: SetupFailureCode, reason: string): SetupFailure {
  return { ok: false, failure_code: failureCode, reason };
}

/**
 * Sends one request and requires HTTP 200 with a JSON object body. A network error is a failed
 * step: the first line of its message, with the secrets redacted, is kept as the reason.
 */
async function step(context: RequestContext, request: ApiRequest, name: string, secrets: readonly string[]): Promise<Step> {
  let result: HttpResult;
  try {
    result = await execute(context, request);
  } catch (error) {
    return { ok: false, reason: `${name}: request failed (${errorSummary(error, secrets)})` };
  }
  if (result.status !== 200) {
    return { ok: false, reason: `${name}: HTTP ${String(result.status)}` };
  }
  const parsed = parseJsonBody(result.body);
  if (!parsed.ok) {
    return { ok: false, reason: `${name}: ${parsed.reason}` };
  }
  if (!isRecord(parsed.value)) {
    return { ok: false, reason: `${name}: body is not a JSON object` };
  }
  return { ok: true, value: parsed.value };
}

/** POST /api/auth/login. Requires HTTP 200 and a non-empty token, which stays in memory. */
export async function login(context: RequestContext, credentials: Credentials): Promise<LoginResult> {
  const result = await step(context, loginRequest(credentials), "login", [credentials.password]);
  if (!result.ok) {
    return failure("auth_failed", result.reason);
  }
  const token = result.value.token;
  if (typeof token !== "string" || token === "") {
    return failure("auth_failed", "login: no token in the response");
  }
  return { ok: true, token };
}

/**
 * Creates the website and sends the twelve events once each, serially and in table order. The
 * first failed or uncertain step stops the round: nothing is retried and no later event is sent.
 */
export async function seed(context: RequestContext, fixture: Fixture, token: string): Promise<SeedResult> {
  const website = await step(context, createWebsiteRequest(fixture, token), "create website", [token]);
  if (!website.ok) {
    return failure("seed_failed", website.reason);
  }
  if (website.value.id !== fixture.website.id) {
    return failure("seed_failed", "create website: the returned id differs from the requested id");
  }
  for (const send of sendRequests(fixture)) {
    const name = `send ${send.event_id}`;
    const result = await step(context, send, name, [token]);
    if (!result.ok) {
      return failure("seed_failed", result.reason);
    }
    if ("beep" in result.value) {
      return failure("seed_failed", `${name}: classified as a bot (beep field present)`);
    }
    const cache = result.value.cache;
    if (typeof cache !== "string" || cache === "") {
      return failure("seed_failed", `${name}: no cache field`);
    }
  }
  return { ok: true };
}

/** Login, website creation and the twelve sends: the setup of one round. */
export async function runSetup(context: RequestContext, fixture: Fixture, credentials: Credentials): Promise<LoginResult> {
  const session = await login(context, credentials);
  if (!session.ok) {
    return session;
  }
  const seeded = await seed(context, fixture, session.token);
  return seeded.ok ? session : seeded;
}
