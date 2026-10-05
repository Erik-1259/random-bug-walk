import { describe, expect, it } from "vitest";
import { importRecordSet } from "@rbw/admission";
import { tempDir } from "../helpers.ts";
import { trial } from "../trial-harness.ts";

/** The importer's evidence for the one trial the driver ran; the job's other trials have no result. */
async function imported(plan: Parameters<typeof trial>[1] = {}) {
  const run = await trial(tempDir(), plan);
  const evidence = importRecordSet(run.outDir);
  const evidenceFor = evidence.trials.find((item) => item.trial_id === run.trialId);
  return { run, evidence, trial: evidenceFor };
}

describe("the admission importer over the driver's record set", () => {
  it("passes a complete one-round trial through shape, identity, completeness and provenance", async () => {
    const { trial: evidence, evidence: all } = await imported();
    expect(evidence).toMatchObject({ status: "complete", stage: "outcomes", reason: null, code: null, findings: [], driver_status: "complete" });
    expect(evidence?.added?.verdict).toBe("match");
    expect(evidence?.original?.tests).toHaveLength(5);
    expect(all.unexpected_results).toEqual([]);
  });

  it("passes a complete 20-round trial with all 80 observations classified", async () => {
    const { trial: evidence } = await imported({ job: { trialId: "clean-01" } });
    expect(evidence).toMatchObject({ status: "complete", stage: "outcomes", findings: [] });
    expect(evidence?.added?.observations).toHaveLength(80);
    expect(evidence?.added?.observations.every((item) => item.classification === "positive")).toBe(true);
  });

  it("passes an observation trial, which has no original suite and no outcomes entry", async () => {
    const { trial: evidence } = await imported({ job: { kind: "observe", originalSuiteSha256: null, originalTestIds: [] } });
    expect(evidence).toMatchObject({ trial_id: "planted-01", status: "complete", stage: "outcomes", findings: [] });
    expect(evidence?.original_suite_key).toBeNull();
  });

  it("keeps a failing original test as valid evidence of a complete trial", async () => {
    const { trial: evidence } = await imported({ original: (test) => (test.id === "synthetic0002-bbbb0001" ? "failed" : "passed") });
    expect(evidence).toMatchObject({ status: "complete", stage: "outcomes" });
    expect(evidence?.original?.failed_test_ids).toEqual(["synthetic0002-bbbb0001"]);
  });

  it("keeps the driver's test_missing for a deleted spec, after the shape and identity stages pass", async () => {
    const { trial: evidence } = await imported({ deleteSpec: "tests/api/beta.spec.ts" });
    expect(evidence).toMatchObject({ status: "incomplete", stage: "driver", reason: "test_missing", driver_status: "incomplete" });
  });

  it("keeps an assertion failure as observed evidence, not an infrastructure failure", async () => {
    const { trial: evidence } = await imported({ round: () => ({ "tzarg.la-day-counts": "assertion_fail" }) });
    expect(evidence).toMatchObject({ status: "complete", stage: "outcomes" });
    expect(evidence?.added?.verdict).toBe("reject");
  });

  it("reports the job's other trials as missing results, not as failures of this one", async () => {
    const { evidence } = await imported();
    const others = evidence.trials.filter((item) => item.trial_id !== "clean-02");
    expect(others.map((item) => item.code)).toEqual(others.map(() => "import:result_missing"));
  });
});
