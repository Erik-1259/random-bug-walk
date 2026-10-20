// Host presentation and the candidate sources the host adapters declare. The registry is an ordered
// list of adapters; its order is the catalog order the request loop selects candidates in.
import type { BaselineIdentity, BugTypeId, CatalogEntry, HostAdapter, HostId } from "@rbw/factory-contract";
import { bugTypeOf } from "./criteria.ts";
import type { CriteriaCatalog } from "./criteria.ts";
import { candidateId, defectId } from "./identity.ts";

/**
 * Client-facing host text. `name` is the host as it reads inside a sentence. `baseline_id` is the pinned
 * revision the contract publishes for the host (section 4.1); capabilities show it only while the host has
 * no adapter in the registry, and otherwise take the adapter's own baseline.
 */
export interface HostPresentation {
  label: string;
  description: string;
  name: string;
  baseline_id: string;
}

export const HOST_PRESENTATION: Readonly<Record<HostId, HostPresentation>> = {
  umami: { label: "Umami", description: "Umami web analytics at a pinned upstream revision.", name: "Umami", baseline_id: "umami@ec0ff503" },
  "task-report": {
    label: "Task and report service",
    description: "The custom task-and-report service at a pinned revision.",
    name: "the task-and-report service",
    baseline_id: "task-report@ca4a71f",
  },
};

export type HostRegistry = readonly HostAdapter[];

export interface TimeWindow {
  from: string;
  until: string;
}

/** The planned span of a run that starts now: now to now plus the wall-clock limit. */
export function plannedWindow(now: Date, maxWallClockS: number): TimeWindow {
  return { from: now.toISOString(), until: new Date(now.getTime() + maxWallClockS * 1000).toISOString() };
}

export interface UnavailableEntry {
  entry_id: string;
  reason: string;
}

/** One declared source of one host and bug type. */
export interface SourceView {
  host_id: HostId;
  bug_type_id: BugTypeId;
  source_id: string;
  catalog_version: string;
  /** Entries that can run in the window, in catalog order. */
  available: CatalogEntry[];
  unavailable: UnavailableEntry[];
}

function knownCriteria(catalog: CriteriaCatalog, entry: CatalogEntry): boolean {
  const type = bugTypeOf(catalog, entry.bug_type_id);
  return entry.criteria.length > 0 && entry.criteria.every((ref) => type.criteria.some((criterion) => criterion.criterion_id === ref.criterion_id && criterion.version === ref.version));
}

/** The adapter's sources in catalog order, each with its available and unavailable entries. */
export function sourcesOf(adapter: HostAdapter, catalog: CriteriaCatalog, window: TimeWindow): SourceView[] {
  const views: SourceView[] = [];
  for (const entry of adapter.catalog()) {
    if (entry.host_id !== adapter.host_id) throw new Error(`the ${adapter.host_id} adapter lists an entry of another host`);
    let view = views.find((candidate) => candidate.source_id === entry.source_id && candidate.bug_type_id === entry.bug_type_id);
    if (view === undefined) {
      view = { host_id: adapter.host_id, bug_type_id: entry.bug_type_id, source_id: entry.source_id, catalog_version: entry.catalog_version, available: [], unavailable: [] };
      views.push(view);
    }
    if (view.catalog_version !== entry.catalog_version) throw new Error(`source ${entry.source_id} lists two catalog versions`);
    if (!knownCriteria(catalog, entry)) {
      view.unavailable.push({ entry_id: entry.entry_id, reason: `It targets a criterion outside criteria catalog version ${catalog.criteria_catalog_version}.` });
      continue;
    }
    const availability = adapter.availability?.(entry, window.from, window.until) ?? { available: true, reason: null };
    if (availability.available) view.available.push(entry);
    else view.unavailable.push({ entry_id: entry.entry_id, reason: availability.reason ?? "The host marks it unavailable for this period." });
  }
  return views;
}

/** The single source of a host and bug type in version 1, or null when the host declares none. */
export function sourceFor(adapter: HostAdapter, catalog: CriteriaCatalog, window: TimeWindow, bugTypeId: BugTypeId): SourceView | null {
  const views = sourcesOf(adapter, catalog, window).filter((view) => view.bug_type_id === bugTypeId);
  if (views.length > 1) throw new Error(`the ${adapter.host_id} adapter declares more than one ${bugTypeId} source; version 1 allows one`);
  return views[0] ?? null;
}

export function adapterFor(registry: HostRegistry, host: HostId): HostAdapter | null {
  return registry.find((adapter) => adapter.host_id === host) ?? null;
}

/** Whether an entry declares every criterion of an item; an item without criteria accepts any entry of its type. */
export function entryServes(entry: CatalogEntry, item: { bug_type_id: BugTypeId; criterion_ids: readonly string[] }): boolean {
  if (entry.bug_type_id !== item.bug_type_id) return false;
  return item.criterion_ids.every((id) => entry.criteria.some((ref) => ref.criterion_id === id));
}

/** What the request loop and the status projection know about one candidate. */
export interface CandidateInfo {
  candidate_id: string;
  defect_id: string;
  host_id: HostId;
  bug_type_id: BugTypeId;
  source_id: string;
  entry_id: string;
}

export function candidateInfo(baseline: BaselineIdentity, entry: CatalogEntry): CandidateInfo {
  return {
    candidate_id: candidateId(entry),
    defect_id: defectId(baseline, entry),
    host_id: entry.host_id,
    bug_type_id: entry.bug_type_id,
    source_id: entry.source_id,
    entry_id: entry.entry_id,
  };
}

/** Every catalog entry of the registry by candidate ID; the status projection reads candidates through it. */
export function candidateIndex(registry: HostRegistry): Map<string, CandidateInfo> {
  const index = new Map<string, CandidateInfo>();
  for (const adapter of registry) {
    const baseline = adapter.baseline();
    for (const entry of adapter.catalog()) {
      const info = candidateInfo(baseline, entry);
      index.set(info.candidate_id, info);
    }
  }
  return index;
}
