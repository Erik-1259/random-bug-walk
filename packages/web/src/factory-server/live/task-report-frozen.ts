// The task-report adapter's read-only part, frozen at build time. The real adapter reads its catalog,
// baseline and protocol files next to its own sources, which a bundled copy cannot do, so the build
// (next.config.ts) freezes what the web calls into RBW_FACTORY_TASK_REPORT_FROZEN and points the
// bundler's `@rbw/host-task-report/adapter` at this module: the bundled host registry then registers
// this adapter for task-report and every other host's adapter unchanged. The web calls only
// baseline(), catalog(), protocol() and availability(); the worker, which runs the copies, uses the
// real adapter. Tests and Node (next.config.ts itself) use the real module.
import type { BaselineIdentity, CatalogEntry, HostAdapter, Protocol } from "@rbw/factory-contract";
import { canonicalDigest } from "@rbw/schema";

interface Frozen {
  baseline: BaselineIdentity;
  catalog: CatalogEntry[];
  /** Each catalog entry's protocol, by entry ID. */
  protocols: Record<string, Protocol>;
}

export class FrozenAdapterError extends Error {
  override name = "FrozenAdapterError";
}

/** The text the build freezes: the adapter's baseline, catalog and each entry's protocol. */
export function freezeTaskReport(adapter: HostAdapter): string {
  const catalog = adapter.catalog();
  const protocols = Object.fromEntries(catalog.map((entry) => [entry.entry_id, adapter.protocol(entry)]));
  return JSON.stringify({ baseline: adapter.baseline(), catalog, protocols } satisfies Frozen);
}

function parseFrozen(text: string | undefined): Frozen {
  if (text === undefined || text === "") throw new FrozenAdapterError("the build froze no task-report catalog");
  return JSON.parse(text) as Frozen;
}

function readOnly(): never {
  throw new FrozenAdapterError("the web holds only the task-report adapter's baseline, catalog and protocols");
}

/** An adapter over frozen text; only the read-only calls answer, each with a fresh copy. */
export function frozenTaskReportAdapter(text: () => string | undefined): HostAdapter {
  let frozen: Frozen | null = null;
  const load = (): Frozen => (frozen ??= parseFrozen(text()));
  return {
    host_id: "task-report",
    baseline: () => structuredClone(load().baseline),
    catalog: () => structuredClone(load().catalog),
    protocol: (entry) => {
      const { catalog, protocols } = load();
      const own = catalog.find((item) => item.entry_id === entry.entry_id);
      const protocol = protocols[entry.entry_id];
      if (own === undefined || protocol === undefined || canonicalDigest(own).sha256 !== canonicalDigest(entry).sha256) {
        throw new FrozenAdapterError(`${entry.entry_id} is not an entry of the frozen task-report catalog`);
      }
      return structuredClone(protocol);
    },
    availability: () => ({ available: true, reason: null }),
    bugCaseInputs: readOnly,
    validatorInputs: readOnly,
    copyPlans: readOnly,
    collect: readOnly,
    interpret: readOnly,
  };
}

/** What the bundled host registry imports in place of the real adapter. */
export const taskReportAdapter: HostAdapter = frozenTaskReportAdapter(() => process.env.RBW_FACTORY_TASK_REPORT_FROZEN);
