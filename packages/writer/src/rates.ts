// The injected rate record and the priced envelope. Until the shared rate-sheet package exists,
// rates come from a JSON file of `{ service, unit, price: { microusd, per_units }, source_url }`
// entries, and its exact bytes are hashed into rate_sheet_sha256.
import type { EnvelopeLine, Price } from "@rbw/spend";
import { z } from "zod";
import { WRITER_MODEL_PROFILE } from "./config.ts";
import { sha256Hex } from "./identity.ts";
import type { ModelProfile } from "./profile.ts";

const RateEntrySchema = z
  .object({
    service: z.string().min(1),
    unit: z.string().min(1),
    price: z
      .object({
        microusd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        per_units: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    source_url: z.url(),
  })
  .strict();
export type RateEntry = z.infer<typeof RateEntrySchema>;

const RateSheetSchema = z.array(RateEntrySchema);

export type RateSheetResult = { ok: true; entries: RateEntry[] } | { ok: false; detail: string };

export function rateSheetSha256(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

/** Parses the rate file's bytes. Anything unreadable, or a repeated (service, unit), is refused. */
export function parseRateSheet(bytes: Uint8Array): RateSheetResult {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, detail: "the rate file is not valid JSON" };
  }
  const parsed = RateSheetSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, detail: "the rate file does not match the rate entry format" };
  }
  const seen = new Set<string>();
  for (const entry of parsed.data) {
    const key = `${entry.service}\u0000${entry.unit}`;
    if (seen.has(key)) {
      return { ok: false, detail: `the rate file repeats ${entry.service} ${entry.unit}` };
    }
    seen.add(key);
  }
  return { ok: true, entries: parsed.data };
}

export type EnvelopeResult = { ok: true; envelope: EnvelopeLine[] } | { ok: false; detail: string };

function priceOf(entries: readonly RateEntry[], service: string, unit: string): Price | undefined {
  return entries.find((e) => e.service === service && e.unit === unit)?.price;
}

/** The two token lines of every call under `profile`, priced from its service's rate entries. */
export function buildEnvelope(entries: readonly RateEntry[], profile: ModelProfile = WRITER_MODEL_PROFILE): EnvelopeResult {
  const { service, hashed } = profile;
  const input = priceOf(entries, service, "input_token");
  const output = priceOf(entries, service, "output_token");
  if (input === undefined || output === undefined) {
    const missing = input === undefined ? "input_token" : "output_token";
    return { ok: false, detail: `the rate file has no ${service} ${missing} price` };
  }
  return {
    ok: true,
    envelope: [
      { service, unit: "input_token", limit: hashed.max_input_tokens, enforced_by: "client_counter", price: input },
      {
        service,
        unit: "output_token",
        limit: hashed.max_output_tokens,
        enforced_by: "request_parameter",
        price: output,
      },
    ],
  };
}

/** ceil(quantity × microusd ÷ per_units), computed exactly. */
export function actualMicrousd(quantity: number, price: Price): number {
  const product = BigInt(quantity) * BigInt(price.microusd);
  const perUnits = BigInt(price.per_units);
  const result = (product + perUnits - 1n) / perUnits;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("a settled amount is above the safe integer range");
  }
  return Number(result);
}

/** The worst case of one line: its price at its limit. */
export function lineWorstCase(line: EnvelopeLine): number {
  if (line.price === null) {
    throw new Error("an envelope line has no price");
  }
  return actualMicrousd(line.limit, line.price);
}
