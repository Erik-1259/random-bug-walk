// The modules `case-package prepare` loads to export the real hosts under the factory's own IDs:
//   node tools/case-package/src/cli.ts prepare --registry tools/case-validate/src/factory-prepare.ts \
//     --identity tools/case-validate/src/factory-prepare.ts (--scan-hook <module> | --no-scan) --out <dir>
// CASE_IDENTITY binds the factory core's defectId and caseId (contract section 10.4) to the criteria catalog
// version the core uses, so every prepared index case_id is the case ID the request loop computes.
import type { CaseIdentity } from "@rbw/case-package/format";
import { caseId, criteriaCatalogV1, defectId } from "@rbw/factory";

export { HOST_REGISTRY } from "./registry.ts";

export const CASE_IDENTITY: CaseIdentity = {
  defectId: (baseline, entry) => defectId(baseline, entry),
  caseId: (defect, entry) => caseId({ defect_id: defect, entry, criteria_catalog_version: criteriaCatalogV1().criteria_catalog_version }),
};
