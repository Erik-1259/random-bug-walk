// Assignment (contract sections 6.3 and 10.5) and candidate selection order.
import type { BugTypeId, CatalogEntry, Criterion, HostAdapter, Interpretation } from "@rbw/factory-contract";
import { bugTypeOf } from "./criteria.ts";
import type { CriteriaCatalog } from "./criteria.ts";
import { entryServes } from "./sources.ts";
import type { CandidateInfo } from "./sources.ts";

/** One request item during a run. */
export interface ItemState {
  item_key: string;
  bug_type_id: BugTypeId;
  criterion_ids: string[];
  quantity: number;
  delivered: number;
  /** Position in the request. */
  index: number;
}

/** A catalog entry the run may try, in catalog order, with its worst case priced. */
export interface PlannedCandidate extends CandidateInfo {
  baseline_id: string;
  entry: CatalogEntry;
  adapter: HostAdapter;
  worst_case_microusd: number;
}

/** The frozen interpretation's items with their matched criteria, in request order, none delivered yet. */
export function itemStates(interpretation: Interpretation): ItemState[] {
  return interpretation.items.map((item, index) => ({
    item_key: item.item_key,
    bug_type_id: item.bug_type_id,
    criterion_ids: item.criteria.map((criterion) => criterion.criterion_id),
    quantity: item.quantity,
    delivered: 0,
    index,
  }));
}

/** An item's unfilled units: its quantity less its delivered cases. */
export function unfilledUnits(item: ItemState): number {
  return Math.max(item.quantity - item.delivered, 0);
}

/** Items with more criteria first, then request order (contract section 10.5). */
export function assignmentOrder(items: readonly ItemState[]): ItemState[] {
  return [...items].sort((a, b) => b.criterion_ids.length - a.criterion_ids.length || a.index - b.index);
}

/**
 * The criteria of a bug type that a candidate demonstrates: those whose published failure code was
 * observed on the buggy copy in export verification. The entry's own declaration does not count.
 */
export function demonstratedCriteria(catalog: CriteriaCatalog, bugTypeId: BugTypeId, failureCodes: readonly string[]): Criterion[] {
  return bugTypeOf(catalog, bugTypeId).criteria.filter((criterion) => failureCodes.includes(criterion.failure_code));
}

function fits(item: ItemState, demonstrated: readonly string[]): boolean {
  if (item.criterion_ids.length === 0) return demonstrated.length > 0;
  return item.criterion_ids.every((id) => demonstrated.includes(id));
}

/**
 * The item a candidate is assigned to: the first, in assignment order, of its bug type with an unfilled
 * unit whose every criterion it demonstrates (an item without criteria takes any demonstrated criterion
 * of its type). Null means the candidate fits no such item: `wrong_failure`.
 */
export function assignItem(items: readonly ItemState[], bugTypeId: BugTypeId, demonstrated: readonly string[]): ItemState | null {
  for (const item of assignmentOrder(items)) {
    if (item.bug_type_id === bugTypeId && unfilledUnits(item) > 0 && fits(item, demonstrated)) return item;
  }
  return null;
}

/** Whether an entry is eligible for an item: same bug type, and it declares every criterion of the item. */
export function servesItem(candidate: Pick<PlannedCandidate, "entry">, item: ItemState): boolean {
  return entryServes(candidate.entry, item);
}

/**
 * The next candidate to try: for the items with an unfilled unit in assignment order, the first entry in
 * catalog order that is eligible for the item and not yet tried in this request. Null when none is left.
 */
export function nextCandidate(items: readonly ItemState[], planned: readonly PlannedCandidate[], tried: ReadonlySet<string>): PlannedCandidate | null {
  for (const item of assignmentOrder(items)) {
    if (unfilledUnits(item) === 0) continue;
    const found = planned.find((candidate) => !tried.has(candidate.candidate_id) && servesItem(candidate, item));
    if (found !== undefined) return found;
  }
  return null;
}
