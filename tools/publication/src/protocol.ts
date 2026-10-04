/** Request and response formats shared by the host helper and the rbw-publish wrapper. */

export const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
export const WORKTREE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SHA = /^[0-9a-f]{40}$/;
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_TITLE_CHARACTERS = 256;
export const MAX_BODY_CHARACTERS = 65_536;

export const OPERATIONS = ["push", "pr-create", "pr-comment"] as const;
export type Operation = (typeof OPERATIONS)[number];

export interface PublicationRequest {
  version: 1;
  requestId: string;
  worktreeId: string;
  operation: Operation;
  sha: string;
  /** The worktree's token from rbw.worktreeToken; the helper compares it with the registry. */
  token?: string;
  title?: string;
  body?: string;
}

export const OUTCOMES = ["published", "blocked", "unavailable", "stale"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface PublicationResponse {
  version: 1;
  requestId: string;
  requestedSha: string | null;
  outcome: Outcome;
  publishedSha?: string;
  locations?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Counts code points; the text is well formed, so each low surrogate ends a pair. */
function codePoints(text: string): number {
  return text.length - (text.match(/[\uDC00-\uDFFF]/g)?.length ?? 0);
}

function validText(text: string): boolean {
  return text.isWellFormed() && !text.includes("\0");
}

export function validTitle(title: string): boolean {
  return validText(title) && !/[\r\n]/.test(title) && codePoints(title) >= 1 && codePoints(title) <= MAX_TITLE_CHARACTERS;
}

export function validBody(body: string): boolean {
  return validText(body) && codePoints(body) <= MAX_BODY_CHARACTERS;
}

/** Parses a stored request; any deviation from the format gives null. */
export function parseRequest(bytes: Uint8Array, expectedId: string): PublicationRequest | null {
  if (bytes.byteLength > MAX_REQUEST_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { version, requestId, worktreeId, operation, sha, token, title, body } = value;
  const allowed = new Set(["version", "requestId", "worktreeId", "operation", "sha"]);
  if (operation === "pr-create") allowed.add("title").add("body");
  if (operation === "pr-comment") allowed.add("body");
  // A missing token is not a format error: the helper refuses it as invalid-token.
  const keys = Object.keys(value).filter((key) => key !== "token");
  if (!keys.every((key) => allowed.has(key)) || keys.length !== allowed.size) return null;
  if (token !== undefined && typeof token !== "string") return null;
  if (version !== 1 || requestId !== expectedId || typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return null;
  if (typeof worktreeId !== "string" || !WORKTREE_ID.test(worktreeId)) return null;
  if (typeof sha !== "string" || !SHA.test(sha)) return null;
  if (!OPERATIONS.includes(operation as Operation)) return null;
  const request: PublicationRequest = { version: 1, requestId, worktreeId, operation: operation as Operation, sha };
  if (token !== undefined) request.token = token;
  if (operation === "pr-create") {
    if (typeof title !== "string" || !validTitle(title)) return null;
    request.title = title;
  }
  if (operation !== "push") {
    if (typeof body !== "string" || !validBody(body)) return null;
    request.body = body;
  }
  return request;
}

/** Parses a response file for the wrapper; any deviation from the format gives null. */
export function parseResponse(bytes: Uint8Array, expectedId: string): PublicationResponse | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { version, requestId, requestedSha, outcome, publishedSha, locations } = value;
  if (version !== 1 || requestId !== expectedId || !OUTCOMES.includes(outcome as Outcome)) return null;
  if (requestedSha !== null && (typeof requestedSha !== "string" || !SHA.test(requestedSha))) return null;
  const response: PublicationResponse = { version: 1, requestId, requestedSha, outcome: outcome as Outcome };
  if (outcome === "published") {
    if (typeof publishedSha !== "string" || publishedSha !== requestedSha) return null;
    response.publishedSha = publishedSha;
  } else if (publishedSha !== undefined) {
    return null;
  }
  if (outcome === "blocked") {
    if (!Array.isArray(locations) || !locations.every((item) => typeof item === "string" && !/[\r\n]/.test(item))) return null;
    response.locations = locations as string[];
  } else if (locations !== undefined) {
    return null;
  }
  return response;
}

/** Builds a response with exactly the fields its outcome allows. */
export function buildResponse(
  requestId: string,
  requestedSha: string | null,
  outcome: Outcome,
  locations: readonly string[] = [],
): PublicationResponse {
  const response: PublicationResponse = { version: 1, requestId, requestedSha, outcome };
  if (outcome === "published" && requestedSha !== null) response.publishedSha = requestedSha;
  if (outcome === "blocked") response.locations = [...locations];
  return response;
}
