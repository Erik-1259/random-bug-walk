import type { EnvelopeLine, EnforcedBy, Unit, ReserveRequest } from "@rbw/spend";
import { z } from "zod";
import { digest, priceFor } from "./rates.ts";
import type { Rates } from "./rates.ts";
import { add, ceil, fraction } from "./fraction.ts";
import type { Fraction } from "./fraction.ts";
export { loadRateSheet, parseRateSheet, priceFor } from "./rates.ts";
export type { RateSheet, Rates } from "./rates.ts";
export type { Fraction } from "./fraction.ts";

export const FIXED_LIMITS = Object.freeze({
  app: Object.freeze({ vcpu: 4, memory_gb: 8, deadline_seconds: 600 }),
  observe: Object.freeze({ vcpu: 2, memory_gb: 4, deadline_seconds: 900, app_copies: 1, resources: 2 }),
  admission: Object.freeze({ vcpu: 2, memory_gb: 4, deadline_seconds: 9000, app_copies: 13, resources: 14 }),
  judge: Object.freeze({ vcpu: 2, memory_gb: 4, deadline_seconds: 2100, app_copies: 3, resources: 4 }),
  shutdown_seconds: 60,
  model: Object.freeze({ input_tokens: 32768, output_tokens: 8192, calls: 12 }),
  tavily: Object.freeze({ calls: 6, credits: 12, credits_per_call: 2 }),
  ceilings: Object.freeze({ observe: 1000000, admission: 8000000, candidate_generation: 8000000, judge: 2000000 }),
});
export const runtime_profile_sha256 = digest(FIXED_LIMITS);
export interface MissingPrice { service: string; subject: string; unit: Unit }
export type Envelope = { ok: false; code: "unknown_price"; missing: MissingPrice[] } | { ok: false; code: "ceiling_exceeded" } | {
  ok: true; lines: EnvelopeLine[]; components: Record<string, Fraction>; exact_microusd: Fraction;
  bound_microusd: bigint; reserved_microusd: bigint; ceiling_microusd: bigint | null;
  rate_sheet_sha256: string; runtime_profile_sha256: string;
};
interface Quantity extends MissingPrice { quantity: bigint; enforced_by: EnforcedBy; component: string }
const subjects = { sandbox: { service: "vercel-sandbox", subject: "iad1" }, model: { service: "token-factory", subject: "nvidia/Nemotron-3_5-Lightning" }, tavily: { service: "tavily", subject: "api" } };
function model(calls: bigint): Quantity[] {
  return [
    { ...subjects.model, unit: "input_token", quantity: calls * BigInt(FIXED_LIMITS.model.input_tokens), enforced_by: "client_counter", component: "model" },
    { ...subjects.model, unit: "output_token", quantity: calls * BigInt(FIXED_LIMITS.model.output_tokens), enforced_by: "request_parameter", component: "model" },
  ];
}
function tavily(credits: bigint): Quantity[] { return [{ ...subjects.tavily, unit: "credit", quantity: credits, enforced_by: "request_parameter", component: "tavily" }]; }
function build(rates: Rates, quantities: Quantity[], ceiling: bigint | null): Envelope {
  const missing = new Map<string, MissingPrice>();
  for (const q of quantities) if (priceFor(rates.sheet, q.service, q.subject, q.unit) === null) missing.set(JSON.stringify([q.service, q.subject, q.unit]), { service: q.service, subject: q.subject, unit: q.unit });
  if (missing.size > 0) return { ok: false, code: "unknown_price", missing: [...missing.values()] };
  const lines = new Map<string, EnvelopeLine>(); const components: Record<string, Fraction> = {};
  for (const q of quantities) {
    const price = priceFor(rates.sheet, q.service, q.subject, q.unit);
    if (price === null) throw new Error("missing checked price");
    const key = JSON.stringify([q.service, q.unit]);
    const previous = lines.get(key);
    const quantity = q.quantity + BigInt(previous?.limit ?? 0);
    if (quantity > 9007199254740991n) throw new Error("line limit exceeds safe integer");
    lines.set(key, { service: q.service, unit: q.unit, limit: Number(quantity), enforced_by: q.enforced_by, price });
    const cost = fraction(q.quantity * BigInt(price.microusd), BigInt(price.per_units));
    components[q.component] = add(components[q.component] ?? fraction(0n, 1n), cost);
  }
  const exact_microusd = Object.values(components).reduce(add, fraction(0n, 1n));
  const bound_microusd = ceil(exact_microusd);
  const reserved_microusd = [...lines.values()].reduce((sum, line) => {
    if (line.price === null) throw new Error("missing checked price");
    return sum + ceil(fraction(BigInt(line.limit) * BigInt(line.price.microusd), BigInt(line.price.per_units)));
  }, 0n);
  if (ceiling !== null && reserved_microusd > ceiling) return { ok: false, code: "ceiling_exceeded" };
  return { ok: true, lines: [...lines.values()], components, exact_microusd, bound_microusd, reserved_microusd, ceiling_microusd: ceiling, rate_sheet_sha256: digest(rates.sheet), runtime_profile_sha256 };
}
function compute(rates: Rates, operation: "observe" | "admission" | "judge", generation = false): Envelope {
  const controller = FIXED_LIMITS[operation]; const app = FIXED_LIMITS.app;
  const quantities: Quantity[] = [];
  for (const [component, allowance] of [["compute", false], ["shutdown_allowance", true]] as const) {
    for (const [unit, dimension] of [["vcpu_second", "vcpu"], ["memory_gb_second", "memory_gb"]] as const) {
      const quantity = BigInt(controller[dimension]) * BigInt(allowance ? FIXED_LIMITS.shutdown_seconds : controller.deadline_seconds) + BigInt(controller.app_copies) * BigInt(app[dimension]) * BigInt(allowance ? FIXED_LIMITS.shutdown_seconds : app.deadline_seconds);
      quantities.push({ ...subjects.sandbox, unit, quantity, enforced_by: "provider_timeout", component });
    }
  }
  quantities.push({ ...subjects.sandbox, unit: "creation", quantity: BigInt(controller.resources), enforced_by: "client_counter", component: "creations" });
  if (generation) quantities.push(...model(BigInt(FIXED_LIMITS.model.calls)), ...tavily(BigInt(FIXED_LIMITS.tavily.credits)));
  return build(rates, quantities, BigInt(FIXED_LIMITS.ceilings[operation]));
}
function generationEnvelope(rates: Rates): Envelope {
  return build(rates, [...model(BigInt(FIXED_LIMITS.model.calls)), ...tavily(BigInt(FIXED_LIMITS.tavily.credits))], BigInt(FIXED_LIMITS.ceilings.candidate_generation));
}
export function observeEnvelope(rates: Rates): Envelope { return compute(rates, "observe"); }
export function admissionEnvelope(rates: Rates, options: { includeGeneration: boolean }): Envelope {
  const validated = z.strictObject({ includeGeneration: z.boolean() }).parse(options);
  const envelope = compute(rates, "admission", validated.includeGeneration);
  if (!envelope.ok) return envelope;
  const generation = generationEnvelope(rates);
  return generation.ok ? envelope : generation;
}
export function judgeEnvelope(rates: Rates): Envelope { return compute(rates, "judge"); }
function generationCallEnvelope(rates: Rates, quantities: Quantity[]): Envelope {
  const generation = generationEnvelope(rates);
  if (!generation.ok) return generation;
  return build(rates, quantities, BigInt(FIXED_LIMITS.ceilings.candidate_generation));
}
export function modelCallEnvelope(rates: Rates): Envelope { return generationCallEnvelope(rates, model(1n)); }
export function tavilyCallEnvelope(rates: Rates): Envelope { return generationCallEnvelope(rates, tavily(BigInt(FIXED_LIMITS.tavily.credits_per_call))); }
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const label = z.string().regex(/^[a-z0-9._-]{1,64}$/);
const key = z.string().regex(/^[a-z0-9-]{1,64}$/);
const identitySchema = z.strictObject({
  operation_id: hash, payload_hash: hash, attempt_ordinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), previous_operation_id: hash.nullable(),
  project_id: uuid, project_policy_sha256: hash, batch_id: uuid.nullable(), task_revision: hash,
  root_execution_id: uuid, execution_id: uuid, parent_execution_id: uuid.nullable(), kind: label, call_name: label, provider: label,
  provider_replay_key: z.string().min(1).max(512).refine(value => Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)).nullable(), pool_key: key, allocation_key: key.nullable(),
}).refine(identity => (identity.attempt_ordinal === 1) === (identity.previous_operation_id === null), { message: "invalid attempt predecessor" });
export type ReserveIdentity = z.infer<typeof identitySchema>;
export function toReserveRequest(envelope: Envelope, identity: unknown): ReserveRequest {
  if (!envelope.ok) throw new Error(`cannot reserve refused envelope: ${envelope.code}`);
  return { ...identitySchema.parse(identity), rate_sheet_sha256: envelope.rate_sheet_sha256, runtime_profile_sha256: envelope.runtime_profile_sha256, envelope: envelope.lines };
}
