// GET /api/factory/capabilities (contract section 4), built from the host registry, the criteria
// catalog and the injected factory profile, with an injected clock for host availability.
import { BUG_TYPE_ID_VALUES, CONTRACT_VERSION_VALUES, HOST_ID_VALUES } from "@rbw/factory-contract";
import type { BugTypeId, Capabilities, Combination, DifficultyOption, HostId, ServiceStatus } from "@rbw/factory-contract";
import { bugTypeOf } from "./criteria.ts";
import type { CriteriaCatalog } from "./criteria.ts";
import type { FactoryProfileInput } from "./profile.ts";
import { HOST_PRESENTATION, adapterFor, plannedWindow, sourceFor } from "./sources.ts";
import type { HostRegistry, TimeWindow } from "./sources.ts";

export const CONTRACT_VERSION = CONTRACT_VERSION_VALUES[0];
export const INTERPRETER = { interpreter_id: "criteria-match", version: "1" } as const;
export const QUALIFICATION_ROUTE = { route_id: "behavioral-qualification", version: "1" } as const;
export const PACKAGE_FORMATS = { bug_case: "rbw-bug-case/1", validator: "rbw-validator/1" } as const;

export const DIFFICULTY_OPTIONS: readonly DifficultyOption[] = [
  { option_id: "source_inferable_allowed", label: "Source-inferable allowed", default: true, available: true, reason: null },
  {
    option_id: "source_only_difficulty_required",
    label: "Source-only difficulty required",
    default: false,
    available: false,
    reason: "Source-only difficulty assessment is not implemented and validated yet. Items that require it are refused, never downgraded.",
  },
];

export const AVAILABLE_SERVICE: ServiceStatus = { state: "available", code: null, message: null };

function typeName(catalog: CriteriaCatalog, bugTypeId: BugTypeId): string {
  return bugTypeOf(catalog, bugTypeId).label.toLowerCase();
}

/** One (host, bug type) pair: supported when an available entry of a declared source exists. */
export function combinationOf(registry: HostRegistry, catalog: CriteriaCatalog, window: TimeWindow, host: HostId, bugTypeId: BugTypeId): Combination {
  const name = HOST_PRESENTATION[host].name;
  const adapter = adapterFor(registry, host);
  const source = adapter === null ? null : sourceFor(adapter, catalog, window, bugTypeId);
  if (source === null) {
    return { host_id: host, bug_type_id: bugTypeId, status: "unsupported", reason: `No ${typeName(catalog, bugTypeId)} catalog with implemented verification checks is declared for ${name} yet.`, source: null };
  }
  const criteriaIds: string[] = [];
  for (const entry of source.available) {
    for (const ref of entry.criteria) if (!criteriaIds.includes(ref.criterion_id)) criteriaIds.push(ref.criterion_id);
  }
  const summary = {
    source_id: source.source_id,
    kind: "finite_recipe_catalog" as const,
    catalog_version: source.catalog_version,
    entries: source.available.length,
    criteria_ids: criteriaIds,
    description: `A finite catalog of declared ${typeName(catalog, bugTypeId)} recipes for ${name}.`,
  };
  if (source.available.length === 0) {
    const reason = source.unavailable[0]?.reason ?? "No entry of this catalog can run now.";
    return { host_id: host, bug_type_id: bugTypeId, status: "unsupported", reason, source: summary };
  }
  return { host_id: host, bug_type_id: bugTypeId, status: "supported", reason: null, source: summary };
}

export interface CapabilitiesInput {
  registry: HostRegistry;
  catalog: CriteriaCatalog;
  profile: FactoryProfileInput;
  now: Date;
  /** The service's state (the web service knows the ledger and its configuration); available by default. */
  service?: ServiceStatus;
}

export function buildCapabilities(input: CapabilitiesInput): Capabilities {
  const { registry, catalog, profile } = input;
  const window = plannedWindow(input.now, profile.limits.max_wall_clock_s);
  const hosts = HOST_ID_VALUES.filter((host) => adapterFor(registry, host) !== null);
  return {
    contract_version: CONTRACT_VERSION,
    service: input.service ?? AVAILABLE_SERVICE,
    hosts: hosts.map((host) => {
      const adapter = adapterFor(registry, host);
      if (adapter === null) throw new Error(`no adapter for ${host}`);
      return { host_id: host, label: HOST_PRESENTATION[host].label, description: HOST_PRESENTATION[host].description, baseline_id: adapter.baseline().baseline_id };
    }),
    bug_types: BUG_TYPE_ID_VALUES.map((id) => structuredClone(bugTypeOf(catalog, id))),
    combinations: hosts.flatMap((host) => BUG_TYPE_ID_VALUES.map((type) => combinationOf(registry, catalog, window, host, type))),
    difficulty_options: DIFFICULTY_OPTIONS.map((option) => ({ ...option })),
    limits: structuredClone(profile.limits),
    interpreter: { ...INTERPRETER, criteria_catalog_version: catalog.criteria_catalog_version, filler_phrases: [...catalog.filler_phrases] },
    qualification_route: { ...QUALIFICATION_ROUTE },
    package_formats: { ...PACKAGE_FORMATS },
  };
}
