// A kit-check baseline under a run directory: a complete, synthetic kit-check record set at
// jobs/kit-check/records and its imported evidence at the baseline key. A test may change a trial
// first, for example to make one invalid.
import { join } from "node:path";
import { baselineDraft, trial, writeRecordSet } from "../../../../packages/admission/test/support/record-set.ts";
import type { RecordSetDraft } from "../../../../packages/admission/test/support/record-set.ts";
import { importJob } from "../../src/records.ts";

export interface KitCheckBaseline {
  records: string;
  evidenceSha256: string;
}

export function writeKitCheckBaseline(root: string, mutate: (draft: RecordSetDraft) => void = () => undefined): KitCheckBaseline {
  const draft = baselineDraft("kit_check");
  mutate(draft);
  const records = join(root, "jobs", "kit-check", "records");
  writeRecordSet(draft, records);
  const imported = importJob(records, join(root, "jobs", "kit-check"));
  if (imported.evidence_sha256 === null) throw new Error(`the synthetic kit-check records did not import (${imported.refusal ?? "-"})`);
  return { records, evidenceSha256: imported.evidence_sha256 };
}

/** Marks one kit-check trial invalid with the given reason, as a driver whose seed failed records it. */
export function invalidTrial(trialId: string, reason: "seed_failed" | "startup_failed" = "seed_failed"): (draft: RecordSetDraft) => void {
  return (draft) => {
    const target = trial(draft, trialId);
    target.status = "invalid";
    target.invalidReason = reason;
  };
}
