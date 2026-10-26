// The modules `case-package prepare` loads to export the real hosts under the factory's own IDs:
//   [RBW_UMAMI_STORE=<prepared store>] node tools/case-package/src/cli.ts prepare \
//     --registry tools/case-validate/src/factory-prepare.ts \
//     --identity tools/case-validate/src/factory-prepare.ts (--scan-hook <module> | --no-scan) --out <dir>
// CASE_IDENTITY binds the factory core's defectId and caseId (contract section 10.4) to the criteria catalog
// version the core uses, so every prepared index case_id is the case ID the request loop computes.
// HOST_REGISTRY is the harness's registry; with RBW_UMAMI_STORE set its Umami adapter reads that prepared
// store, which exporting an Umami case needs (without it the export refuses with store_missing).
import type { CaseIdentity } from "@rbw/case-package/format";
import { caseId, criteriaCatalogV1, defectId } from "@rbw/factory";
import { createRealHostRegistry, HOST_REGISTRY as REGISTRY } from "./registry.ts";
import type { HostRegistry } from "./registry.ts";

/** The registry an export uses: the harness's own, or one whose Umami adapter reads the store RBW_UMAMI_STORE names. */
export function prepareRegistry(env: Readonly<Record<string, string | undefined>>): HostRegistry {
  const store = env.RBW_UMAMI_STORE;
  return store === undefined || store === "" ? REGISTRY : createRealHostRegistry({ umamiStore: store });
}

export const HOST_REGISTRY: HostRegistry = prepareRegistry(process.env);

export const CASE_IDENTITY: CaseIdentity = {
  defectId: (baseline, entry) => defectId(baseline, entry),
  caseId: (defect, entry) => caseId({ defect_id: defect, entry, criteria_catalog_version: criteriaCatalogV1().criteria_catalog_version }),
};
