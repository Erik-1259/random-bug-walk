import { describe, expect, it } from "vitest";
import { decide, decisionErrors, evidenceErrors, importRecordSet } from "../src/index.ts";

// A directory of real records, written by the driver and the local runner; unset in CI.
const recordsDir = process.env.RBW_ADMISSION_RECORDS_DIR;

describe("real record set", () => {
  it.skipIf(recordsDir === undefined || recordsDir === "")("imports the supplied directory, with every record past the shape stage", () => {
    const evidence = importRecordSet(recordsDir ?? "");
    expect(evidenceErrors(evidence)).toEqual([]);
    const shapeFailures = evidence.trials.filter((trial) => trial.stage === "shape").map((trial) => `${trial.trial_id} ${trial.code ?? ""}`);
    expect(shapeFailures).toEqual([]);
    const decision = decide(evidence);
    expect(decisionErrors(decision)).toEqual([]);
    const lines = [
      `kind ${decision.kind}`,
      ...evidence.trials.map((trial) => `trial ${trial.trial_id} ${trial.status} ${trial.stage} ${trial.reason ?? "-"} ${trial.code ?? "-"}`),
      ...Object.entries(decision.decisions ?? {}).map(([rule, value]) => `rule ${rule} ${value.decision}`),
      `comparison ${decision.comparison?.classification ?? "-"}`,
      `outcome_verdict ${decision.outcome_verdict ?? "-"}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  });
});
