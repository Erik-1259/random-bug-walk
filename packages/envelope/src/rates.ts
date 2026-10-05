import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import canonicalize from "canonicalize";
import { UNITS } from "@rbw/spend";
import type { Price, Unit } from "@rbw/spend";
import { z } from "zod";

// The shared schema package's canonical encoder replaces this encoder when available.
export function canonicalJson(value: unknown): string {
  function check(v: unknown): void {
    if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error("canonical JSON requires safe integers");
    if (Array.isArray(v)) { for (const item of v) check(item); }
    else if (v !== null && typeof v === "object") {
      for (const [key, item] of Object.entries(v)) {
        if (!/^[\x20-\x7e]*$/.test(key)) throw new Error("canonical JSON requires ASCII keys");
        check(item);
      }
    }
  }
  check(value);
  const bytes = canonicalize(value);
  if (typeof bytes !== "string") throw new Error("cannot encode canonical JSON");
  return bytes;
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const entrySchema = z.strictObject({
  service: z.string().regex(/^[a-z0-9._-]{1,64}$/), subject: z.string().min(1), unit: z.enum(UNITS),
  price: z.strictObject({ microusd: integer, per_units: integer.min(1) }), source_url: z.url(),
});
const sheetSchema = z.strictObject({
  schema_version: z.literal(1), rate_sheet_version: z.literal(1), checked_at: z.iso.datetime({ offset: false }),
  account_confirmed: z.literal(false), entries: z.array(entrySchema),
}).superRefine((sheet, context) => {
  const triples = new Set<string>();
  for (const entry of sheet.entries) {
    const key = JSON.stringify([entry.service, entry.subject, entry.unit]);
    if (triples.has(key)) context.addIssue({ code: "custom", message: "duplicate rate triple" });
    triples.add(key);
  }
});
export type RateSheet = z.infer<typeof sheetSchema>;
export interface Rates { sheet: RateSheet; rate_sheet_sha256: string }
export function parseRateSheet(bytes: string | Uint8Array): Rates {
  const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // Inspect number tokens before JSON.parse loses exponent/fraction spelling or integer precision.
  const tokens = text.replace(/"(?:[^"\\]|\\.)*"/g, '""').match(/-?\d[^\s,\]}:]*/g) ?? [];
  for (const token of tokens) {
    if (!/^-?(0|[1-9]\d*)$/.test(token) || BigInt(token) > 9007199254740991n || BigInt(token) < -9007199254740991n) throw new Error("invalid canonical integer token");
  }
  const value: unknown = JSON.parse(text);
  canonicalJson(value);
  const sheet = sheetSchema.parse(value);
  return { sheet, rate_sheet_sha256: digest(sheet) };
}
export async function loadRateSheet(path: string | URL): Promise<Rates> {
  return parseRateSheet(await readFile(path));
}
export function priceFor(sheet: RateSheet, service: string, subject: string, unit: Unit): Price | null {
  return sheet.entries.find(e => e.service === service && e.subject === subject && e.unit === unit)?.price ?? null;
}
