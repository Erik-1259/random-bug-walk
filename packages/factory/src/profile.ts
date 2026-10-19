// What this package reads from the factory profile. The hosted worker's frozen profile holds the
// numbers; this package defines no limit, envelope or worst case, and tests use a synthetic test profile.
import { COPY_STATE_VALUES } from "@rbw/factory-contract";
import type { CatalogEntry, HostAdapter, HostId, Limits, Protocol } from "@rbw/factory-contract";

export interface FactoryProfileInput {
  /** The frozen profile's hash; part of every interpretation hash. */
  profile_sha256: string;
  /** The request-form limits of contract section 4. */
  limits: Limits;
  /** The worker's worst case, reserved once at start. */
  worker_worst_case_microusd: number;
  /** The worst case of one copy (one sandbox run) on each host. */
  copy_envelope_microusd: Partial<Record<HostId, number>>;
  /** The worst case of one validation run of a case on each host. */
  validation_worst_case_microusd: Partial<Record<HostId, number>>;
}

function amount(value: number | undefined, what: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) throw new Error(`the factory profile has no ${what}`);
  return value;
}

export function copyEnvelope(profile: FactoryProfileInput, host: HostId): number {
  return amount(profile.copy_envelope_microusd[host], `copy envelope for ${host}`);
}

export function validationWorstCase(profile: FactoryProfileInput, host: HostId): number {
  return amount(profile.validation_worst_case_microusd[host], `validation worst case for ${host}`);
}

/** A candidate's worst case: every copy its protocol declares, at the host's copy envelope. */
export function entryWorstCase(protocol: Protocol, envelopeMicrousd: number): number {
  let copies = 0;
  for (const state of COPY_STATE_VALUES) copies += protocol.per_state[state].copies;
  return copies * envelopeMicrousd;
}

export function candidateWorstCase(adapter: HostAdapter, entry: CatalogEntry, profile: FactoryProfileInput): number {
  return entryWorstCase(adapter.protocol(entry), copyEnvelope(profile, adapter.host_id));
}

/** A host's published candidate worst case: the largest over its catalog's entries (0 for an empty catalog). */
export function hostCandidateWorstCase(adapter: HostAdapter, profile: FactoryProfileInput): number {
  let worst = 0;
  for (const entry of adapter.catalog()) worst = Math.max(worst, candidateWorstCase(adapter, entry, profile));
  return worst;
}
