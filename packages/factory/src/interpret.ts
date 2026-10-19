// POST /api/factory/interpretations (contract section 6): interpreter criteria-match version 1 over
// the host registry, the criteria catalog and the factory profile. Deterministic: the same normalized
// input, versions, profile and host availability give the same interpretation and hash.
import { canonicalDigest } from "@rbw/schema";
import type {
  BugTypeId,
  EligibleSource,
  HostId,
  Interpretation,
  InterpretedItem,
  NormalizedRequestInput,
  Problem,
  TypeQuantity,
} from "@rbw/factory-contract";
import { CONTRACT_VERSION, DIFFICULTY_OPTIONS, INTERPRETER, QUALIFICATION_ROUTE } from "./capabilities.ts";
import { bugTypeOf } from "./criteria.ts";
import type { CriteriaCatalog } from "./criteria.ts";
import { defectId } from "./identity.ts";
import { matchDescription } from "./match.ts";
import { formatUsd } from "./money.ts";
import { candidateWorstCase, hostCandidateWorstCase, validationWorstCase } from "./profile.ts";
import type { FactoryProfileInput } from "./profile.ts";
import { HOST_PRESENTATION, adapterFor, entryServes, plannedWindow, sourceFor } from "./sources.ts";
import type { HostRegistry, SourceView } from "./sources.ts";

export const ESTIMATE_NOTE =
  "The worker's worst case is reserved when the request starts, and each candidate's worst case before it starts; afterward the actual spend is settled and the rest is released. A validation run reserves its host's worst case the same way. These are limits, not predictions.";

export interface InterpretInput {
  input: NormalizedRequestInput;
  registry: HostRegistry;
  catalog: CriteriaCatalog;
  profile: FactoryProfileInput;
  now: Date;
}

interface ItemWork {
  item: InterpretedItem;
  criterionIds: string[];
  /** Eligible entries with their defect IDs, in catalog order. */
  eligible: { host_id: HostId; defect_id: string; worst_case_microusd: number }[];
}

function hostName(host: HostId): string {
  return HOST_PRESENTATION[host].name;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The most item units distinct defects can fill: each defect fills at most one unit of one item it can serve. */
function deliverable(items: { quantity: number; defects: Set<string> }[]): number {
  const units: Set<string>[] = items.flatMap((item) => Array.from({ length: item.quantity }, () => item.defects));
  const owner = new Map<string, number>();
  const assign = (unit: number, seen: Set<string>): boolean => {
    for (const defect of units[unit] ?? new Set<string>()) {
      if (seen.has(defect)) continue;
      seen.add(defect);
      const current = owner.get(defect);
      if (current === undefined || assign(current, seen)) {
        owner.set(defect, unit);
        return true;
      }
    }
    return false;
  };
  let filled = 0;
  for (let unit = 0; unit < units.length; unit += 1) if (assign(unit, new Set())) filled += 1;
  return filled;
}

export function interpret(args: InterpretInput): Interpretation {
  const { input, registry, catalog, profile } = args;
  const window = plannedWindow(args.now, profile.limits.max_wall_clock_s);
  const hostsInCatalogOrder = registry.map((adapter) => adapter.host_id).filter((host) => input.hosts.includes(host));
  const sources = new Map<string, SourceView>();
  for (const host of hostsInCatalogOrder) {
    const adapter = adapterFor(registry, host);
    if (adapter === null) continue;
    for (const type of catalog.bug_types) {
      const view = sourceFor(adapter, catalog, window, type.bug_type_id);
      if (view !== null) sources.set(`${host}:${type.bug_type_id}`, view);
    }
  }
  const baselines = new Map(hostsInCatalogOrder.flatMap((host) => {
    const adapter = adapterFor(registry, host);
    return adapter === null ? [] : [[host, adapter.baseline()] as const];
  }));
  const candidateWorst = new Map<HostId, number>(input.hosts.map((host) => {
    const adapter = adapterFor(registry, host);
    return [host, adapter === null ? 0 : hostCandidateWorstCase(adapter, profile)];
  }));

  const work: ItemWork[] = input.items.map((raw) => {
    const type = bugTypeOf(catalog, raw.bug_type_id);
    const typeName = type.label.toLowerCase();
    const difficultyAvailable = DIFFICULTY_OPTIONS.some((option) => option.option_id === raw.difficulty && option.available);
    const match = raw.description === null ? null : matchDescription(raw.description, type.criteria, catalog.filler_phrases);
    const criteria = (match?.criteria ?? []).map(({ criterion, matched_text }) => ({ criterion_id: criterion.criterion_id, version: criterion.version, label: criterion.label, matched_text }));
    const criterionIds = criteria.map((criterion) => criterion.criterion_id);
    const unmatched = match?.unmatched_text ?? [];
    const supportedHosts = hostsInCatalogOrder.filter((host) => (sources.get(`${host}:${raw.bug_type_id}`)?.available.length ?? 0) > 0);
    const eligibleSources: EligibleSource[] = [];
    const eligible: ItemWork["eligible"] = [];
    for (const host of supportedHosts) {
      const view = sources.get(`${host}:${raw.bug_type_id}`);
      const baseline = baselines.get(host);
      const adapter = adapterFor(registry, host);
      if (view === undefined || baseline === undefined || adapter === null) continue;
      const serving = view.available.filter((entry) => entryServes(entry, { bug_type_id: raw.bug_type_id, criterion_ids: criterionIds }));
      if (serving.length === 0) continue;
      eligibleSources.push({ host_id: host, source_id: view.source_id, entries: serving.length });
      for (const entry of serving) eligible.push({ host_id: host, defect_id: defectId(baseline, entry), worst_case_microusd: candidateWorstCase(adapter, entry, profile) });
    }
    const problems: Problem[] = [];
    const block = (code: Problem["code"], message: string): void => {
      problems.push({ code, severity: "blocking", message, item_key: raw.item_key });
    };
    if (!difficultyAvailable) block("unsupported_difficulty", "Source-only difficulty is not available yet. This item is refused rather than run without it.");
    if (supportedHosts.length === 0) {
      const elsewhere = registry.map((adapter) => adapter.host_id).filter((host) => !input.hosts.includes(host) && (() => {
        const adapter = adapterFor(registry, host);
        return adapter !== null && (sourceFor(adapter, catalog, window, raw.bug_type_id)?.available.length ?? 0) > 0;
      })());
      const hint = elsewhere.length === 0 ? "" : ` ${elsewhere.map((host) => HOST_PRESENTATION[host].label).join(" and ")} ${plural(elsewhere.length, "supports", "support")} them.`;
      block("unsupported_combination", `No selected host supports ${typeName} bugs.${hint}`);
    }
    if (unmatched.length > 0) {
      block("unrecognized_description", `${unmatched.map((text) => `"${text}"`).join(", ")} ${plural(unmatched.length, "matches", "match")} no ${typeName} criterion. Remove it or describe the behavior with a listed criterion.`);
    }
    if (supportedHosts.length > 0 && eligibleSources.length === 0) {
      block("no_matching_source", `No catalog entry on the selected hosts targets ${criteria.map((criterion) => `"${criterion.label}"`).join(" and ")}.`);
    }
    const item: InterpretedItem = {
      item_key: raw.item_key,
      bug_type_id: raw.bug_type_id,
      quantity: raw.quantity,
      description: raw.description,
      difficulty: { requested: raw.difficulty, status: difficultyAvailable ? "not_required" : "unsupported" },
      criteria,
      unmatched_text: unmatched,
      eligible_sources: eligibleSources,
      status: problems.length > 0 ? "unsupported" : "supported",
      problems,
    };
    return { item, criterionIds, eligible };
  });

  const budget = input.budget_microusd;
  const worker = profile.worker_worst_case_microusd;
  const afterWorker = budget - worker;
  // The loop admits candidates entry by entry, so "no candidate can start" compares the cheapest
  // eligible entry of each host with the room after the worker.
  const cheapestOn = (eligible: ItemWork["eligible"], host: HostId): number => Math.min(...eligible.filter((entry) => entry.host_id === host).map((entry) => entry.worst_case_microusd));
  for (const { item, eligible } of work) {
    const hosts = item.eligible_sources.map((source) => source.host_id);
    if (hosts.length === 0) continue;
    if (hosts.every((host) => cheapestOn(eligible, host) > afterWorker)) {
      const costs = hosts.map((host) => `${formatUsd(cheapestOn(eligible, host))} on ${hostName(host)}`).join(" and ");
      const which = hosts.length === 1 ? "the only host eligible for this item" : "every host eligible for this item";
      item.problems.push({
        code: "budget_below_item_minimum",
        severity: "warning",
        message: `A budget of ${formatUsd(budget)} leaves ${formatUsd(Math.max(afterWorker, 0))} after the worker's worst case of ${formatUsd(worker)}, which is below one candidate's worst case of ${costs}, ${which}. No candidate for it can start, so the request cannot end fulfilled.`,
        item_key: item.item_key,
      });
    }
  }

  const typeOrder: BugTypeId[] = [];
  for (const { item } of work) if (!typeOrder.includes(item.bug_type_id)) typeOrder.push(item.bug_type_id);
  for (const type of typeOrder) {
    const supported = work.filter((entry) => entry.item.bug_type_id === type && entry.item.status === "supported");
    if (supported.length === 0) continue;
    const requested = supported.reduce((sum, entry) => sum + entry.item.quantity, 0);
    const distinct = new Set(supported.flatMap((entry) => entry.eligible.map((eligible) => eligible.defect_id)));
    const capacity = deliverable(supported.map((entry) => ({ quantity: entry.item.quantity, defects: new Set(entry.eligible.map((eligible) => eligible.defect_id)) })));
    if (capacity >= requested) continue;
    const typeName = bugTypeOf(catalog, type).label.toLowerCase();
    const message = `Only ${String(distinct.size)} distinct ${typeName} ${plural(distinct.size, "defect is", "defects are")} eligible on the selected hosts, so at most ${String(capacity)} of the ${String(requested)} ${typeName} cases that supported items ask for can be delivered.`;
    for (const entry of supported) entry.item.problems.push({ code: "quantity_exceeds_source", severity: "warning", message, item_key: entry.item.item_key });
  }

  const problems: Problem[] = [];
  let cheapest: { host_id: HostId; worst_case_microusd: number } | null = null;
  for (const entry of work.filter((candidate) => candidate.item.status === "supported").flatMap((candidate) => candidate.eligible)) {
    if (cheapest === null || entry.worst_case_microusd < cheapest.worst_case_microusd) cheapest = entry;
  }
  if (cheapest !== null) {
    const least = cheapest.worst_case_microusd;
    if (budget < worker + least) {
      problems.push({
        code: "budget_below_minimum",
        severity: "blocking",
        message: `A budget of ${formatUsd(budget)} cannot cover the worker's worst case of ${formatUsd(worker)} plus one candidate's worst case of ${formatUsd(least)} on ${hostName(cheapest.host_id)}. Raise the budget to at least ${formatUsd(worker + least)}.`,
        item_key: null,
      });
    }
  }
  const usedHosts = new Set(work.flatMap((entry) => entry.item.eligible_sources.map((source) => source.host_id)));
  for (const host of input.hosts) {
    if (!usedHosts.has(host)) problems.push({ code: "host_unused", severity: "warning", message: `${HOST_PRESENTATION[host].label} serves none of the items.`, item_key: null });
  }

  const typeTotals: TypeQuantity[] = typeOrder.map((type) => ({ bug_type_id: type, quantity: input.items.filter((item) => item.bug_type_id === type).reduce((sum, item) => sum + item.quantity, 0) }));
  const items = work.map((entry) => entry.item);
  const startable = problems.every((problem) => problem.severity !== "blocking") && items.every((item) => item.status === "supported");
  const interpreter = { ...INTERPRETER, criteria_catalog_version: catalog.criteria_catalog_version };
  const hashInput = {
    kind: "rbw-factory-interpretation",
    version: 1,
    input,
    interpreter,
    qualification_route: { ...QUALIFICATION_ROUTE },
    profile_sha256: profile.profile_sha256,
    hosts: input.hosts.map((host) => ({
      host_id: host,
      baseline_id: baselines.get(host)?.baseline_id ?? null,
      sources: catalog.bug_types.flatMap((type) => {
        const view = sources.get(`${host}:${type.bug_type_id}`);
        return view === undefined
          ? []
          : [{ bug_type_id: view.bug_type_id, source_id: view.source_id, catalog_version: view.catalog_version, available: view.available.map((entry) => entry.entry_id), unavailable: view.unavailable }];
      }),
    })),
  };
  return {
    contract_version: CONTRACT_VERSION,
    interpretation_sha256: canonicalDigest(hashInput).sha256,
    interpreter,
    qualification_route: { ...QUALIFICATION_ROUTE },
    input: structuredClone(input),
    startable,
    items,
    type_totals: typeTotals,
    hosts: input.hosts.map((host) => ({ host_id: host, used: usedHosts.has(host), reason: usedHosts.has(host) ? null : "No item of this request can use this host." })),
    budget: {
      budget_microusd: budget,
      worker_worst_case_microusd: worker,
      worst_case_per_candidate_microusd: input.hosts.map((host) => ({ host_id: host, microusd: candidateWorst.get(host) ?? 0 })),
      worst_case_per_validation_microusd: input.hosts.map((host) => ({ host_id: host, microusd: adapterFor(registry, host) === null ? 0 : validationWorstCase(profile, host) })),
      estimate_note: ESTIMATE_NOTE,
    },
    limits: { max_wall_clock_s: profile.limits.max_wall_clock_s, max_candidates: profile.limits.max_candidates },
    problems,
  };
}
