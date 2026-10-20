// Request input (contract section 5): schema validation, the limits of section 4.3, normalization
// (section 6), and the canonical body and hash of a start (section 7). Out-of-range input is refused
// with a message for `400 invalid_request`; it never yields an interpretation.
import { canonicalDigest } from "@rbw/schema";
import { validateContract } from "@rbw/factory-contract/validate";
import type { Limits, NormalizedRequestInput, RequestInput, StartRequest } from "@rbw/factory-contract";

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** Trims each description and maps an empty result to null (contract section 6). */
export function normalizeInput(input: RequestInput): NormalizedRequestInput {
  return {
    hosts: [...input.hosts],
    items: input.items.map((item) => {
      const trimmed = item.description?.trim() ?? "";
      return { item_key: item.item_key, bug_type_id: item.bug_type_id, quantity: item.quantity, description: trimmed === "" ? null : trimmed, difficulty: item.difficulty };
    }),
    budget_microusd: input.budget_microusd,
  };
}

function codePoints(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) index += 1;
    count += 1;
  }
  return count;
}

/** The first rule of contract sections 4.3 and 5 that the normalized input breaks, or null. */
export function limitProblem(input: NormalizedRequestInput, limits: Limits): string | null {
  if (input.items.length > limits.max_items) return `A request has at most ${String(limits.max_items)} items.`;
  const keys = new Set<string>();
  let total = 0;
  for (const item of input.items) {
    if (keys.has(item.item_key)) return `The item key ${item.item_key} is used twice.`;
    keys.add(item.item_key);
    if (item.quantity > limits.max_quantity_per_item) return `An item asks for at most ${String(limits.max_quantity_per_item)} cases.`;
    total += item.quantity;
    if (item.description !== null && !item.description.isWellFormed()) return "A description holds text that is not well-formed Unicode.";
    if (item.description !== null && codePoints(item.description) > limits.max_description_chars) {
      return `A description has at most ${String(limits.max_description_chars)} characters after trimming.`;
    }
  }
  if (total > limits.max_total_quantity) return `A request asks for at most ${String(limits.max_total_quantity)} cases in all.`;
  if (input.budget_microusd < limits.min_budget_microusd || input.budget_microusd > limits.max_budget_microusd) {
    return `The budget must be from ${String(limits.min_budget_microusd)} to ${String(limits.max_budget_microusd)} micro-USD.`;
  }
  return null;
}

function schemaMessage(errors: readonly string[]): string {
  return `The body does not match the contract: ${errors.slice(0, 5).join(", ")}.`;
}

/** Validates a POST /api/factory/interpretations body and returns its normalized form. */
export function parseRequestInput(body: unknown, limits: Limits): Parsed<NormalizedRequestInput> {
  const errors = validateContract("RequestInput", body);
  if (errors.length > 0) return { ok: false, message: schemaMessage(errors) };
  const input = normalizeInput(body as RequestInput);
  const problem = limitProblem(input, limits);
  return problem === null ? { ok: true, value: input } : { ok: false, message: problem };
}

/** The canonical body of a start: the request ID, the normalized input and the interpretation hash. */
export interface CanonicalStart {
  request_id: string;
  input: NormalizedRequestInput;
  interpretation_sha256: string;
}

export function canonicalStartSha256(start: CanonicalStart): string {
  return canonicalDigest({ request_id: start.request_id, input: start.input, interpretation_sha256: start.interpretation_sha256 }).sha256;
}

/**
 * Validates a POST /api/factory/requests body (unknown and missing fields refused) and returns the
 * start with its input normalized, and the canonical body's hash that the idempotency check compares.
 */
export function canonicalStart(body: unknown, limits: Limits): { ok: true; start: StartRequest; canonical: CanonicalStart; sha256: string } | { ok: false; message: string } {
  const errors = validateContract("StartRequest", body);
  if (errors.length > 0) return { ok: false, message: schemaMessage(errors) };
  const start = body as StartRequest;
  const input = normalizeInput(start.input);
  const problem = limitProblem(input, limits);
  if (problem !== null) return { ok: false, message: problem };
  const canonical: CanonicalStart = { request_id: start.request_id, input, interpretation_sha256: start.interpretation_sha256 };
  return { ok: true, start: { request_id: start.request_id, input, interpretation_sha256: start.interpretation_sha256 }, canonical, sha256: canonicalStartSha256(canonical) };
}
