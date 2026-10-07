// One app copy's priced envelope and its settlement. @rbw/envelope prices whole jobs (a controller
// sandbox plus its copies); the controller here runs on the conductor's host and reserves each
// copy on its own, so the envelope is one copy's lines, priced from the same pinned rate sheet and
// fixed limits. Its time limit is the sandbox's own timeout, which the provider enforces: the
// run-copy path's outer limit (the driver's 600 s plus 120 s), plus the shutdown allowance.
import { fileURLToPath } from "node:url";
import { FIXED_LIMITS, priceFor, runtime_profile_sha256 } from "@rbw/envelope";
import type { Envelope, Fraction, Rates } from "@rbw/envelope";
import { COPY_OUTER_LIMIT_MS } from "@rbw/local-runner";
import type { EnforcedBy, EnvelopeLine, Unit, UsageSettlement } from "@rbw/spend";

export const RATE_SHEET_PATH = fileURLToPath(new URL("../rate-sheets/v1.json", import.meta.resolve("@rbw/envelope")));

const SERVICE = "vercel-sandbox";
const SUBJECT = "iad1";
/** Seconds a copy's sandbox may live: its timeout plus the shutdown allowance. */
export const COPY_ENVELOPE_SECONDS = COPY_OUTER_LIMIT_MS / 1000 + FIXED_LIMITS.shutdown_seconds;

export type CopyEnvelope = Extract<Envelope, { ok: true }>;

interface Quantity {
  unit: Unit;
  enforced_by: EnforcedBy;
  /** Per component: compute over the timeout, the shutdown allowance, and the creation. */
  parts: Record<string, bigint>;
}

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

function fraction(numerator: bigint, denominator: bigint): Fraction {
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function add(a: Fraction, b: Fraction): Fraction {
  return fraction(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}

function ceil(value: Fraction): bigint {
  return (value.numerator + value.denominator - 1n) / value.denominator;
}

function cost(quantity: bigint, price: { microusd: number; per_units: number }): Fraction {
  return fraction(quantity * BigInt(price.microusd), BigInt(price.per_units));
}

const { vcpu, memory_gb: memoryGb } = FIXED_LIMITS.app;
const TIMEOUT_S = BigInt(COPY_OUTER_LIMIT_MS / 1000);
const SHUTDOWN_S = BigInt(FIXED_LIMITS.shutdown_seconds);

const QUANTITIES: readonly Quantity[] = [
  { unit: "vcpu_second", enforced_by: "provider_timeout", parts: { compute: BigInt(vcpu) * TIMEOUT_S, shutdown_allowance: BigInt(vcpu) * SHUTDOWN_S } },
  { unit: "memory_gb_second", enforced_by: "provider_timeout", parts: { compute: BigInt(memoryGb) * TIMEOUT_S, shutdown_allowance: BigInt(memoryGb) * SHUTDOWN_S } },
  { unit: "creation", enforced_by: "client_counter", parts: { creations: 1n } },
];

/** One copy's envelope: vCPU and memory seconds for its sandbox's lifetime, and one creation. */
export function copyEnvelope(rates: Rates): Envelope {
  const missing = QUANTITIES.filter((q) => priceFor(rates.sheet, SERVICE, SUBJECT, q.unit) === null).map((q) => ({ service: SERVICE, subject: SUBJECT, unit: q.unit }));
  if (missing.length > 0) return { ok: false, code: "unknown_price", missing };
  const lines: EnvelopeLine[] = [];
  const components: Record<string, Fraction> = {};
  let reserved = 0n;
  for (const q of QUANTITIES) {
    const price = priceFor(rates.sheet, SERVICE, SUBJECT, q.unit);
    if (price === null) throw new Error("a checked price is missing");
    const limit = Object.values(q.parts).reduce((sum, part) => sum + part, 0n);
    lines.push({ service: SERVICE, unit: q.unit, limit: Number(limit), enforced_by: q.enforced_by, price });
    for (const [component, part] of Object.entries(q.parts)) components[component] = add(components[component] ?? fraction(0n, 1n), cost(part, price));
    reserved += ceil(cost(limit, price));
  }
  const exact = Object.values(components).reduce(add, fraction(0n, 1n));
  return {
    ok: true,
    lines,
    components,
    exact_microusd: exact,
    bound_microusd: ceil(exact),
    reserved_microusd: reserved,
    ceiling_microusd: null,
    rate_sheet_sha256: rates.rate_sheet_sha256,
    runtime_profile_sha256,
  };
}

/** What a copy used: whether its sandbox was created, and how long it lived (create call to confirmed stop). */
export interface CopyUsage {
  launched: boolean;
  lifetime_ms: number;
}

/** The copy's settlement: each line's actual quantity at the envelope's rates, rounded up; all usage known. */
export function copySettlement(envelope: CopyEnvelope, operationId: string, usage: CopyUsage, evidence: { key: string; sha256: string } | null): UsageSettlement {
  const seconds = usage.launched ? BigInt(Math.ceil(usage.lifetime_ms / 1000)) : 0n;
  const quantities: Record<string, bigint> = {
    vcpu_second: BigInt(vcpu) * seconds,
    memory_gb_second: BigInt(memoryGb) * seconds,
    creation: usage.launched ? 1n : 0n,
  };
  return {
    schema_version: 1,
    operation_id: operationId,
    runtime_profile_sha256: envelope.runtime_profile_sha256,
    rate_sheet_sha256: envelope.rate_sheet_sha256,
    reserved_microusd: Number(envelope.reserved_microusd),
    service_lines: envelope.lines.map((line) => {
      const quantity = quantities[line.unit] ?? 0n;
      if (line.price === null) throw new Error("a checked price is missing");
      return { service: line.service, unit: line.unit, actual_quantity: Number(quantity), actual_microusd: Number(ceil(cost(quantity, line.price))), retained_microusd: 0 };
    }),
    usage_state: "known",
    terminal_evidence_key: evidence?.key ?? null,
    terminal_evidence_sha256: evidence?.sha256 ?? null,
  };
}
