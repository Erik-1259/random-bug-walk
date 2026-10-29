// HMAC auth of the builder routes (docs/otf/SPEC.md section 3.1). The builder signs
// builderSigningString(ts, METHOD, path, sha256hex(body)) with RBW_OTF_BUILDER_SECRET; production
// recomputes it over the exact body bytes it read, refuses a timestamp outside SIGNATURE_WINDOW_MS,
// and compares the signature in constant time. With no secret configured every builder request is
// refused as unavailable (fail closed). Nothing here logs or returns the secret, a signature or a body.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { BUILDER_HEADERS, SIGNATURE_WINDOW_MS, builderSigningString } from "./contract.ts";

/** The builder id header: the TOKEN(64) shape of the bodies' builder_id. */
const BUILDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,63}$/;
const TIMESTAMP = /^\d{1,15}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;

export type BuilderAuth =
  | { ok: true; builder_id: string; body: Uint8Array }
  | { ok: false; code: "unavailable" | "unauthorized" | "invalid_request"; message: string };

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The hex signature the builder sends for this request. */
export function builderSignature(secret: string, ts: string, method: string, path: string, body: Uint8Array | string): string {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return createHmac("sha256", secret).update(builderSigningString(ts, method, path, sha256Hex(bytes))).digest("hex");
}

/** The three auth headers for a request, as the builder (and the tests) send them. */
export function builderHeaders(secret: string, builder_id: string, ts: number, method: string, path: string, body: Uint8Array | string): Record<string, string> {
  const stamp = String(ts);
  return { [BUILDER_HEADERS.id]: builder_id, [BUILDER_HEADERS.ts]: stamp, [BUILDER_HEADERS.sig]: builderSignature(secret, stamp, method, path, body) };
}

/** The body's bytes, or null once it passes `limit`: reading stops at that chunk. */
async function readBytes(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

const UNAUTHORIZED = "The builder request is not signed correctly, or its timestamp is outside the window.";

/**
 * Reads the request body (at most `maxBytes`) and checks its signature at `now` (Unix ms). The
 * signed path is the URL path without the query. A missing secret answers unavailable; a missing,
 * malformed, stale or wrong signature answers unauthorized; a body over the limit, invalid_request.
 */
export async function verifyBuilderRequest(request: Request, secret: string | null, now: number, maxBytes: number): Promise<BuilderAuth> {
  if (secret === null) return { ok: false, code: "unavailable", message: "Custom builds are not configured on this deployment." };
  const builder_id = request.headers.get(BUILDER_HEADERS.id) ?? "";
  const ts = request.headers.get(BUILDER_HEADERS.ts) ?? "";
  const sig = request.headers.get(BUILDER_HEADERS.sig) ?? "";
  if (!BUILDER_ID.test(builder_id) || !TIMESTAMP.test(ts) || !SIGNATURE.test(sig)) return { ok: false, code: "unauthorized", message: UNAUTHORIZED };
  if (Math.abs(now - Number(ts)) > SIGNATURE_WINDOW_MS) return { ok: false, code: "unauthorized", message: UNAUTHORIZED };
  const body = await readBytes(request, maxBytes);
  if (body === null) return { ok: false, code: "invalid_request", message: "The request body is too large." };
  const expected = Buffer.from(builderSignature(secret, ts, request.method, new URL(request.url).pathname, body), "hex");
  const given = Buffer.from(sig, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, code: "unauthorized", message: UNAUTHORIZED };
  return { ok: true, builder_id, body };
}
