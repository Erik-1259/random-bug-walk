// The live path's fetch. Node's built-in fetch (undici) gives up after 300 s without response
// headers, and a non-streaming completion sends none until it finishes. This fetch sends every
// request through an undici Agent whose header and body timeouts match the longest profile timeout.
import { Agent } from "undici";
import type { FetchFunction } from "@rbw/writer";
import { SCREEN_PROFILES } from "./profiles.ts";

/** The longest request timeout of the screen profiles. */
export const LIVE_HTTP_TIMEOUT_MS = Math.max(...Object.values(SCREEN_PROFILES).map((profile) => profile.hashed.request_timeout_ms));

/** Wraps `base` so that each request uses one Agent with the given header and body timeouts. */
export function liveFetch(base: FetchFunction = globalThis.fetch, timeoutMs: number = LIVE_HTTP_TIMEOUT_MS): FetchFunction {
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  return (input, init) => base(input, { ...init, dispatcher });
}
