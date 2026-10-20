// The factory profile: the one frozen object that holds every limit, envelope and lifetime number
// of factory requests and validation runs. The request form's limits (contract section 4.3), the
// worker's lifetime and heartbeat timing, each host's copy limits and the validation window live
// here and nowhere else; the factory core and the web service receive them by injection. Its
// envelopes are priced from the pinned rate sheet (packages/envelope/rate-sheets/v1.json): the
// worker's and each copy's amounts are frozen below, a test recomputes them from the sheet, and
// every reservation re-prices its lines from the sheet it is given and refuses when the total
// differs. A validation run is priced from the protocol inside the case's delivered validator
// package (its copy count), so its amount is computed per run from the same sheet. The numbers for
// lifetimes are predictions until measured on the hosted path.
//
// This module is web-safe: it imports only @rbw/envelope and @rbw/schema.
import { priceFor } from "@rbw/envelope";
import type { Envelope, Fraction, Rates } from "@rbw/envelope";
import type { HostId, Limits } from "@rbw/factory-contract";
import { canonicalDigest } from "@rbw/schema";
import type { EnforcedBy, EnvelopeLine, Unit } from "@rbw/spend";

/** One sandbox's size and provider timeout. Vercel Sandbox gives 2 GB of memory per vCPU. */
export interface SandboxSize {
  vcpus: number;
  memory_gb: number;
  timeout_s: number;
}

/** The limits a host's copy plan must stay within; the copy envelope is priced from them. */
export interface CopyLimitsProfile {
  vcpus: number;
  memory_mb: number;
  timeout_s: number;
}

export interface FactoryProfileBody {
  schema_version: 1;
  profile_id: "factory-profile/1";
  /** The rate sheet the envelopes are priced from (its canonical sha256). */
  rate_sheet_sha256: string;
  pool_key: "factory";
  slot_key: "factory";
  /** Contract section 4.3, as capabilities publish them. */
  limits: Limits;
  /** Seconds a sandbox may live after its timeout, priced like the judge copies' allowance. */
  shutdown_seconds: number;
  heartbeat: {
    /** The worker writes a heartbeat this often (the contract asks for at least every 30 s). */
    interval_s: number;
    /** After this long without a heartbeat, attention is worker_unresponsive (contract section 8.1). */
    unresponsive_after_s: number;
    /** After this long without a heartbeat, the worker is lost (contract section 8.1). */
    lost_after_s: number;
  };
  /** The request worker's sandbox. Its timeout is its whole lifetime: no chaining in version 1. */
  worker: SandboxSize;
  /** A copy starts only when its timeout, the shutdown allowance and this margin fit before the worker's end. */
  copy_launch_margin_s: number;
  copy: Record<HostId, CopyLimitsProfile>;
  validation: {
    /** A validation run ends within this many seconds of its accepted POST (contract section 11). */
    max_run_s: number;
    /** A copy starts only when its timeout, the shutdown allowance and this margin end within the window, leaving time to settle and finish. */
    finish_margin_s: number;
    worker: SandboxSize;
  };
}

/** The envelopes priced from the rate sheet, in micro-USD. */
export interface FactoryPrices {
  worker_worst_case_microusd: number;
  copy_worst_case_microusd: Record<HostId, number>;
}

export type FactoryProfile = Readonly<FactoryProfileBody & { prices: FactoryPrices; profile_sha256: string }>;

/** The pinned v1 rate sheet's canonical sha256 (a test checks it against the file). */
export const RATE_SHEET_V1_SHA256 = "bc28c487dcda4e47493434d2266ec154d8e0c241c0faad2b239c084d013590fb";

const BODY: FactoryProfileBody = {
  schema_version: 1,
  profile_id: "factory-profile/1",
  rate_sheet_sha256: RATE_SHEET_V1_SHA256,
  pool_key: "factory",
  slot_key: "factory",
  limits: {
    max_items: 5,
    max_quantity_per_item: 3,
    max_total_quantity: 6,
    max_description_chars: 500,
    budget_presets_microusd: [1_000_000, 1_500_000, 2_000_000, 3_000_000],
    default_budget_microusd: 1_500_000,
    min_budget_microusd: 1_000_000,
    max_budget_microusd: 3_000_000,
    max_wall_clock_s: 2700,
    max_candidates: 10,
  },
  shutdown_seconds: 60,
  heartbeat: { interval_s: 15, unresponsive_after_s: 60, lost_after_s: 180 },
  worker: { vcpus: 2, memory_gb: 4, timeout_s: 3600 },
  copy_launch_margin_s: 120,
  copy: {
    umami: { vcpus: 4, memory_mb: 8192, timeout_s: 720 },
    "task-report": { vcpus: 4, memory_mb: 8192, timeout_s: 720 },
  },
  validation: {
    max_run_s: 1800,
    finish_margin_s: 30,
    worker: { vcpus: 2, memory_gb: 4, timeout_s: 1800 },
  },
};

const PRICES: FactoryPrices = {
  worker_worst_case_microusd: 346_482,
  copy_worst_case_microusd: { umami: 147_682, "task-report": 147_682 },
};

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** The factory profile, frozen, with the sha256 of its canonical body and prices. */
export const FACTORY_PROFILE: FactoryProfile = deepFreeze({
  ...BODY,
  prices: PRICES,
  profile_sha256: canonicalDigest({ ...BODY, prices: PRICES }).sha256,
});

export const FACTORY_HOSTS: readonly HostId[] = Object.freeze(["umami", "task-report"]);

// Pricing ------------------------------------------------------------------------------------

const SERVICE = "vercel-sandbox";
const SUBJECT = "iad1";

/** The quantity of one sandbox's lifetime: vCPU and memory seconds over its timeout plus the shutdown allowance, and creations. */
interface SandboxQuantity {
  vcpu_seconds: bigint;
  memory_gb_seconds: bigint;
  creations: bigint;
}

function sandboxQuantity(size: { vcpus: number; memory_gb: number }, seconds: number, creations: number): SandboxQuantity {
  return { vcpu_seconds: BigInt(size.vcpus) * BigInt(seconds), memory_gb_seconds: BigInt(size.memory_gb) * BigInt(seconds), creations: BigInt(creations) };
}

function sum(quantities: readonly SandboxQuantity[]): SandboxQuantity {
  return quantities.reduce((a, b) => ({ vcpu_seconds: a.vcpu_seconds + b.vcpu_seconds, memory_gb_seconds: a.memory_gb_seconds + b.memory_gb_seconds, creations: a.creations + b.creations }), {
    vcpu_seconds: 0n,
    memory_gb_seconds: 0n,
    creations: 0n,
  });
}

function copyMemoryGb(limits: CopyLimitsProfile): number {
  return limits.memory_mb / 1024;
}

/** The request worker's lifetime: its whole timeout plus the shutdown allowance, one creation. */
export function workerQuantity(profile: FactoryProfileBody = FACTORY_PROFILE): SandboxQuantity {
  return sandboxQuantity(profile.worker, profile.worker.timeout_s + profile.shutdown_seconds, 1);
}

/** One copy of a host: its timeout plus the shutdown allowance, one creation. */
export function copyQuantity(host: HostId, profile: FactoryProfileBody = FACTORY_PROFILE): SandboxQuantity {
  const limits = profile.copy[host];
  return sandboxQuantity({ vcpus: limits.vcpus, memory_gb: copyMemoryGb(limits) }, limits.timeout_s + profile.shutdown_seconds, 1);
}

/**
 * One validation run of a host's case whose protocol declares `copies` copies in all: its worker over
 * the whole window, and its copies. The copies run one at a time and none starts unless it ends within
 * the window, so together they live at most the window plus one shutdown allowance per copy (which
 * also covers rounding each lifetime up).
 */
export function validationQuantity(host: HostId, copies: number, profile: FactoryProfileBody = FACTORY_PROFILE): SandboxQuantity {
  const v = profile.validation;
  const copy = profile.copy[host];
  return sum([
    sandboxQuantity(v.worker, v.worker.timeout_s + profile.shutdown_seconds, 1),
    sandboxQuantity({ vcpus: copy.vcpus, memory_gb: copyMemoryGb(copy) }, v.max_run_s + copies * profile.shutdown_seconds, copies),
  ]);
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

const UNITS: readonly { unit: Unit; enforced_by: EnforcedBy; of: (q: SandboxQuantity) => bigint }[] = [
  { unit: "vcpu_second", enforced_by: "provider_timeout", of: (q) => q.vcpu_seconds },
  { unit: "memory_gb_second", enforced_by: "provider_timeout", of: (q) => q.memory_gb_seconds },
  { unit: "creation", enforced_by: "client_counter", of: (q) => q.creations },
];

export type FactoryEnvelope = Extract<Envelope, { ok: true }>;

/** A priced envelope of one quantity: one line per unit, each rounded up, as the spend ledger prices it. */
export function priceQuantity(rates: Rates, quantity: SandboxQuantity, profile: Pick<FactoryProfile, "profile_sha256"> = FACTORY_PROFILE): Envelope {
  const missing = UNITS.filter((u) => priceFor(rates.sheet, SERVICE, SUBJECT, u.unit) === null).map((u) => ({ service: SERVICE, subject: SUBJECT, unit: u.unit }));
  if (missing.length > 0) return { ok: false, code: "unknown_price", missing };
  const lines: EnvelopeLine[] = [];
  const components: Record<string, Fraction> = {};
  let reserved = 0n;
  let exact = fraction(0n, 1n);
  for (const u of UNITS) {
    const price = priceFor(rates.sheet, SERVICE, SUBJECT, u.unit);
    if (price === null) throw new Error("a checked price is missing");
    const limit = u.of(quantity);
    const cost = fraction(limit * BigInt(price.microusd), BigInt(price.per_units));
    lines.push({ service: SERVICE, unit: u.unit, limit: Number(limit), enforced_by: u.enforced_by, price });
    components[u.unit] = cost;
    exact = add(exact, cost);
    reserved += ceil(cost);
  }
  return {
    ok: true,
    lines,
    components,
    exact_microusd: exact,
    bound_microusd: ceil(exact),
    reserved_microusd: reserved,
    ceiling_microusd: null,
    rate_sheet_sha256: rates.rate_sheet_sha256,
    runtime_profile_sha256: profile.profile_sha256,
  };
}

/** Prices the frozen envelopes of a profile body (the worker's and each host's copy) from a rate sheet. */
export function priceProfile(rates: Rates, profile: FactoryProfileBody = FACTORY_PROFILE): FactoryPrices | { error: string } {
  const amount = (quantity: SandboxQuantity): number | null => {
    const envelope = priceQuantity(rates, quantity, { profile_sha256: "0".repeat(64) });
    return envelope.ok ? Number(envelope.reserved_microusd) : null;
  };
  const worker = amount(workerQuantity(profile));
  const copy = { umami: amount(copyQuantity("umami", profile)), "task-report": amount(copyQuantity("task-report", profile)) };
  if (worker === null || copy.umami === null || copy["task-report"] === null) return { error: "the rate sheet has no sandbox price" };
  return {
    worker_worst_case_microusd: worker,
    copy_worst_case_microusd: { umami: copy.umami, "task-report": copy["task-report"] },
  };
}

/** `copies`: the total copies the protocol inside the case's delivered validator package declares. */
export type EnvelopeKind = { kind: "worker" } | { kind: "copy"; host: HostId } | { kind: "validation"; host: HostId; copies: number };

export class ProfileMismatch extends Error {
  override name = "ProfileMismatch";
}

/** The validation run's copy count is not a positive whole number. */
export class CopyCountInvalid extends Error {
  override name = "CopyCountInvalid";
}

/**
 * The envelope a factory operation reserves, priced from `rates`. Throws ProfileMismatch when the
 * sheet is not the profile's, or, for the worker and a copy, when its total differs from the
 * profile's frozen amount, so a changed sheet can never reserve amounts other than the ones the
 * service published. A validation run's amount depends on its package's copy count; the sheet's
 * hash fixes its prices.
 */
export function factoryEnvelope(rates: Rates, which: EnvelopeKind, profile: FactoryProfile = FACTORY_PROFILE): FactoryEnvelope {
  if (rates.rate_sheet_sha256 !== profile.rate_sheet_sha256) throw new ProfileMismatch("the rate sheet is not the factory profile's");
  if (which.kind === "validation" && (!Number.isSafeInteger(which.copies) || which.copies < 1)) throw new CopyCountInvalid("a validation run's copy count must be a positive whole number");
  const quantity = which.kind === "worker" ? workerQuantity(profile) : which.kind === "copy" ? copyQuantity(which.host, profile) : validationQuantity(which.host, which.copies, profile);
  const envelope = priceQuantity(rates, quantity, profile);
  if (!envelope.ok) throw new ProfileMismatch(`the rate sheet cannot price the factory profile (${envelope.code})`);
  const expected = which.kind === "worker" ? profile.prices.worker_worst_case_microusd : which.kind === "copy" ? profile.prices.copy_worst_case_microusd[which.host] : null;
  if (expected !== null && envelope.reserved_microusd !== BigInt(expected)) throw new ProfileMismatch("the priced envelope differs from the factory profile's amount");
  return envelope;
}

/**
 * The worst case of a validation run of a host's case whose protocol declares `copies` copies in
 * all, in micro-USD: what its accepted POST reserves (contract section 11), and what an
 * interpretation publishes as the host's worst case per validation for the host's protocol.
 */
export function validationWorstCase(rates: Rates, host: HostId, copies: number, profile: FactoryProfile = FACTORY_PROFILE): number {
  return Number(factoryEnvelope(rates, { kind: "validation", host, copies }, profile).reserved_microusd);
}

/** The request form's limits and the profile hash, as the web service publishes them. */
export function profileForService(profile: FactoryProfile = FACTORY_PROFILE): { limits: Limits; profile_sha256: string } {
  return { limits: profile.limits, profile_sha256: profile.profile_sha256 };
}
