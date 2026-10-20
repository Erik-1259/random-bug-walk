// Responses and request bodies of the factory routes. Every JSON body the service sends passes its
// contract definition first (sendContract): the definitions forbid unknown fields, so no field outside
// the contract, such as evaluator material, can leave the service, and a body that does not match
// answers `unavailable` instead.
import type { BusyReason, DefName, ErrorCode, ErrorResponse, Interpretation } from "@rbw/factory-contract";
import { validateContract } from "@rbw/factory-contract/validate";

export const CONTRACT_VERSION = "bug-request/1";
const JSON_TYPE = "application/json";
/** Request bodies are small JSON objects; anything larger is refused unread past this size. */
export const MAX_BODY_BYTES = 64 * 1024;

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  passcode_incorrect: 401,
  not_found: 404,
  idempotency_conflict: 409,
  interpretation_stale: 409,
  busy: 409,
  budget_unavailable: 409,
  unsupported_request: 422,
  unavailable: 503,
};

export const ERROR_TEXT: Record<ErrorCode, string> = {
  invalid_request: "The request does not match bug-request/1.",
  unauthorized: "Sign in with the judges' passcode to use this endpoint.",
  passcode_incorrect: "The passcode is not correct. Check it and try again.",
  not_found: "No request, case or validation run with this ID was found.",
  idempotency_conflict: "This ID was already used with a different body or on another request or case.",
  interpretation_stale: "The interpretation changed since it was shown. Review the current interpretation in details and start again.",
  busy: "Another factory request or validation run is active. Try again after it finishes.",
  budget_unavailable: "The factory pool's available amount or the request budget cannot cover this right now.",
  unsupported_request: "The interpretation has blocking problems, so the request cannot start. See details.interpretation.",
  unavailable: "The service is not available right now. Try again later.",
};

const BUSY_TEXT: Record<BusyReason, string> = {
  active: ERROR_TEXT.busy,
  needs_reconciliation: "Earlier factory work has spend that is waiting for an operator to reconcile it. No new factory work can start until then.",
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": JSON_TYPE, "cache-control": "no-store", ...headers } });
}

function errorBody(code: ErrorCode, message: string, details: ErrorResponse["error"]["details"]): ErrorResponse {
  const retryable = code === "unavailable" || (code === "busy" && details !== null && "reason" in details && details.reason === "active");
  return { contract_version: CONTRACT_VERSION, error: { code, message, retryable, details } };
}

/** A refusal without details. */
export function refuse(code: Exclude<ErrorCode, "busy" | "interpretation_stale" | "unsupported_request">, message: string = ERROR_TEXT[code]): Response {
  return json(STATUS[code], errorBody(code, message, null));
}

export function busy(reason: BusyReason): Response {
  return json(409, errorBody("busy", BUSY_TEXT[reason], { reason }));
}

export type Log = (line: string) => void;

/** Sends a body that matches its contract definition, or `unavailable` when it does not. */
export function sendContract(log: Log, status: number, name: DefName, body: unknown, headers: Record<string, string> = {}): Response {
  const errors = validateContract(name, body);
  if (errors.length === 0) return json(status, body, headers);
  log(`factory: a ${name} body did not match the contract (${errors.slice(0, 5).join(", ")}); answered unavailable`);
  return refuse("unavailable");
}

/** interpretation_stale or unsupported_request, with the current interpretation in details. */
export function refuseInterpretation(log: Log, code: "interpretation_stale" | "unsupported_request", interpretation: Interpretation): Response {
  return sendContract(log, STATUS[code], "ErrorResponse", errorBody(code, ERROR_TEXT[code], { interpretation }));
}

export type Body = { ok: true; value: unknown } | { ok: false; message: string };

/** The body as UTF-8 text, or null once it passes `limit` bytes: reading stops at that chunk. */
async function readText(request: Request, limit: number): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(chunk.value);
    chunk = await reader.read();
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

/** The request's JSON body: not JSON, or larger than MAX_BODY_BYTES, is an invalid request. */
export async function readBody(request: Request): Promise<Body> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return { ok: false, message: "The request body is too large." };
  const text = await readText(request, MAX_BODY_BYTES);
  if (text === null) return { ok: false, message: "The request body is too large." };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, message: "The request body is not JSON." };
    throw error;
  }
}

/** Contract errors as one sentence for an invalid_request message. */
export function invalidMessage(name: string, errors: readonly string[]): string {
  return `The body does not match ${name}: ${errors.slice(0, 5).join(", ")}.`;
}
