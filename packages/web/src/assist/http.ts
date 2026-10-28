// Responses of the bug designer's routes (/api/assist/*): JSON, never cached, and errors as
// { error: { code, message } }. The designer is an addition beside the factory contract, so its
// error codes are its own; the body reader is the factory routes' one.
import { json } from "../factory-server/http.ts";

export type AssistErrorCode = "invalid_request" | "signed_out" | "not_found" | "refused" | "rate_limited" | "assist_unavailable";

const STATUS: Record<AssistErrorCode, number> = {
  invalid_request: 400,
  signed_out: 401,
  not_found: 404,
  refused: 422,
  rate_limited: 429,
  assist_unavailable: 503,
};

export const ASSIST_TEXT: Record<AssistErrorCode, string> = {
  invalid_request: "The request does not match what this endpoint takes.",
  signed_out: "Sign in on /factory with the judges' passcode to use the bug designer.",
  not_found: "No delivered case with this request and case ID was found.",
  refused: "The bug designer covers date and time, concurrency, data handling, state and UI logic bugs. It does not design security bugs.",
  rate_limited: "The bug designer has had many requests in the last hour. Try again later.",
  assist_unavailable: "The bug designer is unavailable right now. The request form below works as before.",
};

export function assistError(code: Exclude<AssistErrorCode, "rate_limited">, message: string = ASSIST_TEXT[code]): Response {
  return json(STATUS[code], { error: { code, message } });
}

export function rateLimited(retryAfterS: number): Response {
  return json(429, { error: { code: "rate_limited", message: ASSIST_TEXT.rate_limited, retry_after_s: retryAfterS } }, { "retry-after": String(retryAfterS) });
}

export function sendJson(body: unknown): Response {
  return json(200, body);
}

/** A provider or a model answer the route cannot use; the route answers assist_unavailable with this message. */
export class AssistUnavailable extends Error {
  override name = "AssistUnavailable";
  /** What the visitor reads; never a provider's own text. */
  readonly visible: string;

  constructor(reason: string, visible: string = ASSIST_TEXT.assist_unavailable) {
    super(reason);
    this.visible = visible;
  }
}
