// Until the shared rate-sheet package exists, prices come from a JSON file of
// `{ service, unit, price: { microusd, per_units }, source_url }` entries.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Price } from "@rbw/spend";
import { sha256Hex } from "./canonical.ts";
import { SearchError } from "./errors.ts";

const rateEntrySchema = z.strictObject({
  service: z.string().min(1),
  unit: z.string().min(1),
  price: z.strictObject({ microusd: z.number().int().nonnegative(), per_units: z.number().int().positive() }),
  source_url: z.string().min(1),
});

export type RateEntry = z.infer<typeof rateEntrySchema>;

export interface RateSheet {
  /** SHA-256 of the file's bytes. */
  sha256: string;
  entries: RateEntry[];
}

export function parseRateSheet(text: string | Uint8Array): RateSheet {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SearchError("invalid_rate_sheet", "not valid JSON");
  }
  const parsed = z.array(rateEntrySchema).safeParse(json);
  if (!parsed.success) {
    throw new SearchError("invalid_rate_sheet", "entries must be { service, unit, price, source_url }");
  }
  return { sha256: sha256Hex(bytes), entries: parsed.data };
}

export function loadRateSheet(path: string): RateSheet {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new SearchError("invalid_rate_sheet", "the file cannot be read");
  }
  return parseRateSheet(bytes);
}

export function priceOf(sheet: RateSheet, service: string, unit: string): Price | null {
  const entry = sheet.entries.find((e) => e.service === service && e.unit === unit);
  return entry === undefined ? null : { microusd: entry.price.microusd, per_units: entry.price.per_units };
}
