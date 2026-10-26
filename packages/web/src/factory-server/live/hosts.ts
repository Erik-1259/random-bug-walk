// The hosts live mode offers. A registered host's catalog entry is available only when the prepared
// packages directory holds its packages: an index entry with the same host, entry and catalog version
// whose case ID is the one the factory core computes for the entry (a stale package is not offered,
// as the worker would not export it). Without a readable index no entry is available, so every
// combination is unsupported and an interpretation finds no eligible source.
import type { PreparedEntry, PreparedIndex } from "@rbw/case-package/format";
import { caseId, defectId } from "@rbw/factory";
import type { CatalogEntry, HostAdapter } from "@rbw/factory-contract";

export const NOT_PREPARED = "No prepared package is installed for this entry.";

/** The index entry that holds this catalog entry's current packages, or null. */
export function preparedEntry(index: PreparedIndex | null, adapter: HostAdapter, entry: CatalogEntry, criteriaCatalogVersion: string): PreparedEntry | null {
  const found = index?.entries.find((item) => item.host_id === adapter.host_id && item.entry_id === entry.entry_id && item.catalog_version === entry.catalog_version);
  if (found === undefined) return null;
  const expected = caseId({ defect_id: defectId(adapter.baseline(), entry), entry, criteria_catalog_version: criteriaCatalogVersion });
  return found.case_id === expected ? found : null;
}

/**
 * Each adapter as itself, except that an entry without prepared packages is unavailable. Only the
 * capabilities and the interpreter take these; the profile and the status projection's candidate
 * index read the registry's adapters unchanged.
 */
export function preparedOnly(adapters: readonly HostAdapter[], index: PreparedIndex | null, criteriaCatalogVersion: string): HostAdapter[] {
  return adapters.map((adapter) => ({
    host_id: adapter.host_id,
    baseline: () => adapter.baseline(),
    catalog: () => adapter.catalog(),
    protocol: (entry) => adapter.protocol(entry),
    availability(entry, from, until) {
      if (preparedEntry(index, adapter, entry, criteriaCatalogVersion) === null) return { available: false, reason: NOT_PREPARED };
      return adapter.availability?.(entry, from, until) ?? { available: true, reason: null };
    },
    bugCaseInputs: (entry) => adapter.bugCaseInputs(entry),
    validatorInputs: (entry) => adapter.validatorInputs(entry),
    copyPlans: (state, unpacked, protocol) => adapter.copyPlans(state, unpacked, protocol),
    collect: (plan, collected) => adapter.collect(plan, collected),
    interpret: (records, protocol) => adapter.interpret(records, protocol),
  }));
}
