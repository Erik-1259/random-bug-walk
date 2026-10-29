// Canonical JSON and the hashes OTF compares: spec_sha256 (client and server must agree), the
// create-body hash for idempotent creates, and the canonical bytes of a builder event for the
// duplicate check. Hashing uses Web Crypto, so the browser and the server share this module.
import type { BuilderEventIn, OtfCreateJob, OtfSpecCard } from "./contract.ts";

/**
 * JSON with object keys sorted by UTF-16 code unit, no whitespace, and undefined members left out.
 * Only plain JSON values are accepted: a non-finite number, a bigint, a function or a symbol throws,
 * so two sides can never hash different text for the same value.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}

/** Lower-case hex sha256 of the UTF-8 bytes of text (or of the given bytes). */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The six card fields only, so an extra member can never change the hash. */
export function specCanonical(spec: OtfSpecCard): string {
  return canonicalJson({
    title: spec.title,
    where: spec.where,
    change: spec.change,
    why_tests_miss: spec.why_tests_miss,
    checks_to_add: spec.checks_to_add,
    fix: spec.fix,
  });
}

/** spec_sha256: sha256 of the spec card's canonical JSON. */
export function specSha256(spec: OtfSpecCard): Promise<string> {
  return sha256Hex(specCanonical(spec));
}

/** The idempotency hash of a create body: every member, catalog_request_id included when set. */
export function createSha256(body: OtfCreateJob): Promise<string> {
  return sha256Hex(
    canonicalJson({
      client_key: body.client_key,
      criterion_id: body.criterion_id,
      sentence: body.sentence,
      spec: JSON.parse(specCanonical(body.spec)) as unknown,
      spec_sha256: body.spec_sha256,
      catalog_request_id: body.catalog_request_id,
    }),
  );
}

/** The bytes a stored builder event is compared by when its builder_seq repeats. */
export function builderEventBytes(event: BuilderEventIn): string {
  return canonicalJson(event);
}
