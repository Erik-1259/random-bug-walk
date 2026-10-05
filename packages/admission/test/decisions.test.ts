import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decide, decisionErrors, importRecordSet, initialCells, type Cell, type Decision, type Evidence, type RuleDecision } from "../src/index.ts";
import { AKL, KOL, LA, TEST_IDS, UTC, baselineDraft, cleanupRecordSets, dropObservation, observe, recordSet, testOutcome, trial, type RecordSetDraft } from "./support/record-set.ts";

afterAll(cleanupRecordSets);

function run(mutate?: (draft: RecordSetDraft) => void): { evidence: Evidence; decision: Decision } {
  const evidence = importRecordSet(recordSet(mutate));
  return { evidence, decision: decide(evidence) };
}

function rules(decision: Decision): Record<string, string> {
  if (decision.decisions === null) throw new Error("no ADM decisions");
  return Object.fromEntries(Object.entries(decision.decisions).map(([rule, value]) => [rule, value.decision]));
}

function rule(decision: Decision, id: "ADM-02" | "ADM-03" | "ADM-04" | "ADM-05" | "ADM-06"): RuleDecision {
  if (decision.decisions === null) throw new Error("no ADM decisions");
  return decision.decisions[id];
}

const cellStates = (cells: readonly Cell[] | null): unknown => cells?.map((cell) => [cell.trial_id, cell.suite, cell.state, cell.matches_expectation]);

describe("baseline admission record set", () => {
  let evidence: Evidence;
  let decision: Decision;
  beforeAll(() => {
    ({ evidence, decision } = run());
  });

  it("ADM-02 ADM-03 ADM-04 ADM-05 ADM-06 pass, with outcome_verdict pass", () => {
    expect(rules(decision)).toEqual({ "ADM-02": "pass", "ADM-03": "pass", "ADM-04": "pass", "ADM-05": "pass", "ADM-06": "pass" });
    expect(decision.outcome_verdict).toBe("pass");
    expect(decisionErrors(decision)).toEqual([]);
  });

  it("ADM-08 classifies the baseline as blind_spot_demonstrated", () => {
    expect(decision.comparison?.classification).toBe("blind_spot_demonstrated");
  });

  it("ADM-08 six cells match their expectations", () => {
    expect(cellStates(evidence.cells)).toEqual([
      ["clean-01", "original", "pass", true],
      ["clean-01", "added", "pass", true],
      ["planted-01", "original", "pass", true],
      ["planted-01", "added", "fail", true],
      ["fixed-01", "original", "pass", true],
      ["fixed-01", "added", "pass", true],
    ]);
  });

  it("ADM-08 cells carry suite hashes, IDs, counts, failures and artifact keys, with all 20 repetitions", () => {
    const [cleanOriginal, , , plantedAdded, , fixedAdded] = evidence.cells ?? [];
    expect(cleanOriginal).toMatchObject({ suite_sha256: "1".repeat(64), expected_ids: TEST_IDS, expected_count: 3, executed_ids: TEST_IDS, executed_count: 3, failing: [] });
    expect(cleanOriginal?.artifact_keys).toEqual(["trials/clean-01/original-suite-outcomes.json"]);
    expect(plantedAdded).toMatchObject({ suite_sha256: "2".repeat(64), expected_count: 80, executed_count: 80 });
    expect(plantedAdded?.expected_ids).toEqual([UTC, LA, AKL, KOL]);
    expect(plantedAdded?.failing).toHaveLength(60);
    expect(plantedAdded?.failing[0]).toEqual({ id: AKL, repeat_index: 1, failure_code: "local_day_counts_mismatch" });
    expect(plantedAdded?.artifact_keys).toContain("trials/planted-01/observations.json");
    expect(plantedAdded?.artifact_keys).toContain("trials/planted-01/responses/tzarg.la-day-counts/20.json");
    expect(fixedAdded).toMatchObject({ expected_count: 80, executed_count: 80, failing: [] });
  });

  it("lists the rules decided elsewhere as not evaluated here", () => {
    expect(decision.not_evaluated_here).toEqual(["ADM-01", "ADM-07", "ADM-09", "ADM-10"]);
  });
});

describe("ADM-02 fresh copies and executions", () => {
  it("ADM-02 is incomplete when the fixed-04 result is missing", () => {
    const { decision } = run((draft) => {
      trial(draft, "fixed-04").write = false;
    });
    expect(rule(decision, "ADM-02")).toEqual({ decision: "incomplete", trials: [{ trial_id: "fixed-04", basis: "trial_status", status: "incomplete", reason: "artifact_missing", code: "import:result_missing" }] });
    expect(decision.outcome_verdict).toBe("incomplete");
  });

  it("ADM-02 is invalid when one expected original test is absent in clean-01", () => {
    const { evidence, decision } = run((draft) => {
      trial(draft, "clean-01").tests?.splice(1, 1);
    });
    expect(rule(decision, "ADM-02")).toEqual({ decision: "invalid", trials: [{ trial_id: "clean-01", basis: "execution", status: "invalid", reason: "test_missing", code: "import:test_missing" }] });
    expect(evidence.trials.find((item) => item.trial_id === "clean-01")?.status).toBe("incomplete");
    expect(decision.outcome_verdict).toBe("invalid");
  });

  it("ADM-02 is invalid when one expected original test is skipped in clean-01", () => {
    const { decision } = run((draft) => {
      testOutcome(draft, "clean-01", TEST_IDS[0] ?? "", "skipped");
    });
    expect(rule(decision, "ADM-02")).toEqual({ decision: "invalid", trials: [{ trial_id: "clean-01", basis: "execution", status: "invalid", reason: "test_skipped", code: "import:test_skipped" }] });
  });

  it("ADM-02 is invalid when a planted-02 added observation is not_run", () => {
    const { decision } = run((draft) => {
      observe(draft, "planted-02", KOL, 1, "not_run", "timeout");
    });
    expect(rule(decision, "ADM-02")).toEqual({ decision: "invalid", trials: [{ trial_id: "planted-02", basis: "execution", status: "invalid", reason: "timeout", code: "import:outcome_not_run" }] });
  });

  it("ADM-02 is invalid when a planted-02 added observation is skipped", () => {
    const { decision } = run((draft) => {
      observe(draft, "planted-02", KOL, 1, "skipped", "test_skipped");
    });
    expect(rule(decision, "ADM-02")).toEqual({ decision: "invalid", trials: [{ trial_id: "planted-02", basis: "execution", status: "invalid", reason: "test_skipped", code: "import:outcome_not_run" }] });
  });

  it("ADM-02 is invalid when an added-check repetition is absent in fixed-01", () => {
    const { decision } = run((draft) => {
      dropObservation(draft, "fixed-01", AKL, 17);
    });
    expect(rule(decision, "ADM-02")).toEqual({ decision: "invalid", trials: [{ trial_id: "fixed-01", basis: "execution", status: "invalid", reason: "test_missing", code: "import:check_missing" }] });
  });

  it("ADM-02 stays incomplete for a driver incomplete result", () => {
    const { decision } = run((draft) => {
      trial(draft, "fixed-05").status = "incomplete";
      trial(draft, "fixed-05").invalidReason = "timeout";
    });
    expect(rule(decision, "ADM-02")).toEqual({ decision: "incomplete", trials: [{ trial_id: "fixed-05", basis: "trial_status", status: "incomplete", reason: "timeout", code: "import:driver_status" }] });
  });

  it("ADM-02 is invalid for an unexpected extra check observation", () => {
    const { decision } = run((draft) => {
      trial(draft, "fixed-02").observations.push({ check_id: "tzarg.synthetic-extra", repeat_index: 1, observed: "pass", failure_code: null, duration_ms: 40, response_artifact_key: null, response_artifact_sha256: null });
    });
    expect(rule(decision, "ADM-02")).toEqual({ decision: "invalid", trials: [{ trial_id: "fixed-02", basis: "trial_status", status: "invalid", reason: null, code: "import:check_unexpected" }] });
    expect(decision.outcome_verdict).toBe("invalid");
  });

  it("ADM-02 is invalid when results/ holds a trial the manifest does not list", () => {
    const { decision } = run((draft) => {
      draft.extraResults.set("fixed-06", Buffer.from("{}"));
    });
    expect(rule(decision, "ADM-02").decision).toBe("invalid");
  });
});

describe("ADM-03 fixed copies pass", () => {
  it("ADM-03 rejects a fixed-03 Los Angeles assertion failure", () => {
    const { decision } = run((draft) => {
      observe(draft, "fixed-03", LA, 1, "assertion_fail", "local_day_counts_mismatch");
    });
    expect(rule(decision, "ADM-03")).toEqual({ decision: "reject", trials: [{ trial_id: "fixed-03", basis: "added_checks", status: "complete", reason: null, code: null }] });
    expect(rule(decision, "ADM-02").decision).toBe("pass");
    expect(decision.outcome_verdict).toBe("reject");
  });

  it("ADM-03 rejects one failed original test in clean-01", () => {
    const { decision } = run((draft) => {
      testOutcome(draft, "clean-01", TEST_IDS[1] ?? "", "failed");
    });
    expect(rule(decision, "ADM-03")).toEqual({ decision: "reject", trials: [{ trial_id: "clean-01", basis: "original_suite", status: "complete", reason: null, code: null }] });
    expect(decision.outcome_verdict).toBe("reject");
  });

  it("ADM-03 is invalid when a fixed-02 check is not_run", () => {
    const { decision } = run((draft) => {
      observe(draft, "fixed-02", UTC, 1, "not_run", "test_skipped");
    });
    expect(rule(decision, "ADM-03")).toEqual({ decision: "invalid", trials: [{ trial_id: "fixed-02", basis: "execution", status: "invalid", reason: "test_skipped", code: "import:outcome_not_run" }] });
    expect(decision.outcome_verdict).toBe("invalid");
  });

  it("ADM-03 is invalid when a fixed-04 check is skipped", () => {
    const { decision } = run((draft) => {
      observe(draft, "fixed-04", LA, 1, "skipped", "test_skipped");
    });
    expect(rule(decision, "ADM-03")).toEqual({ decision: "invalid", trials: [{ trial_id: "fixed-04", basis: "execution", status: "invalid", reason: "test_skipped", code: "import:outcome_not_run" }] });
  });

  it("ADM-03 is invalid when a fixed-03 check is missing", () => {
    const { decision } = run((draft) => {
      dropObservation(draft, "fixed-03", KOL, 1);
    });
    expect(rule(decision, "ADM-03")).toEqual({ decision: "invalid", trials: [{ trial_id: "fixed-03", basis: "execution", status: "invalid", reason: "test_missing", code: "import:check_missing" }] });
  });

  it("ADM-03 is invalid when a fixed-03 check is missing alongside an absent original test", () => {
    const { decision } = run((draft) => {
      dropObservation(draft, "fixed-03", KOL, 1);
      trial(draft, "fixed-03").tests?.splice(0, 1);
    });
    expect(rule(decision, "ADM-03")).toEqual({ decision: "invalid", trials: [{ trial_id: "fixed-03", basis: "execution", status: "invalid", reason: "test_missing", code: "import:check_missing" }] });
  });

  it("ADM-03 keeps the trial status for a fixed-02 driver incomplete result", () => {
    const { decision } = run((draft) => {
      trial(draft, "fixed-02").status = "incomplete";
      trial(draft, "fixed-02").invalidReason = "timeout";
    });
    expect(rule(decision, "ADM-03")).toEqual({ decision: "incomplete", trials: [{ trial_id: "fixed-02", basis: "trial_status", status: "incomplete", reason: "timeout", code: "import:driver_status" }] });
  });
});

describe("ADM-04 planted copies fail as declared", () => {
  it("ADM-04 rejects a valid unexpected pass of Los Angeles on planted-02", () => {
    const { decision } = run((draft) => {
      observe(draft, "planted-02", LA, 1, "pass", null);
    });
    expect(rule(decision, "ADM-04")).toEqual({ decision: "reject", trials: [{ trial_id: "planted-02", basis: "added_checks", status: "complete", reason: null, code: null }] });
    expect(decision.outcome_verdict).toBe("reject");
  });

  it("ADM-04 is invalid when planted-02 Los Angeles fails with the unrelated code bucket_labels_mismatch", () => {
    const { evidence, decision } = run((draft) => {
      observe(draft, "planted-02", LA, 1, "assertion_fail", "bucket_labels_mismatch");
    });
    expect(rule(decision, "ADM-04")).toEqual({ decision: "invalid", trials: [{ trial_id: "planted-02", basis: "trial_status", status: "invalid", reason: "unrelated_failure", code: "import:outcome_unrelated_code" }] });
    expect(evidence.trials.find((item) => item.trial_id === "planted-02")?.added?.verdict).toBe("invalid");
    expect(decision.outcome_verdict).toBe("invalid");
  });

  it("ADM-04 is invalid for a planted-03 setup failure with auth_failed", () => {
    const { decision } = run((draft) => {
      observe(draft, "planted-03", KOL, 1, "setup_fail", "auth_failed");
    });
    expect(rule(decision, "ADM-04")).toEqual({ decision: "invalid", trials: [{ trial_id: "planted-03", basis: "trial_status", status: "invalid", reason: "auth_failed", code: "import:outcome_setup_fail" }] });
    expect(rule(decision, "ADM-02")).toEqual({ decision: "invalid", trials: [{ trial_id: "planted-03", basis: "execution", status: "invalid", reason: "auth_failed", code: "import:outcome_setup_fail" }] });
  });

  it("ADM-04 rejects a planted-04 UTC control assertion failure", () => {
    const { decision } = run((draft) => {
      observe(draft, "planted-04", UTC, 1, "assertion_fail", "local_day_counts_mismatch");
    });
    expect(rule(decision, "ADM-04").decision).toBe("reject");
    expect(rule(decision, "ADM-04").trials.map((item) => item.trial_id)).toEqual(["planted-04"]);
  });
});

describe("ADM-05 stability", () => {
  it("ADM-05 is incomplete when fixed-01 repetition 17 is missing for one check", () => {
    const { decision } = run((draft) => {
      dropObservation(draft, "fixed-01", AKL, 17);
    });
    expect(rule(decision, "ADM-05")).toEqual({ decision: "incomplete", trials: [{ trial_id: "fixed-01", basis: "trial_status", status: "incomplete", reason: "test_missing", code: "import:check_missing" }] });
  });

  it("ADM-05 rejects a fixed-01 repetition 9 Kolkata assertion failure", () => {
    const { decision } = run((draft) => {
      observe(draft, "fixed-01", KOL, 9, "assertion_fail", "local_day_counts_mismatch");
    });
    expect(rule(decision, "ADM-05")).toEqual({ decision: "reject", trials: [{ trial_id: "fixed-01", basis: "added_checks", status: "complete", reason: null, code: null }] });
    expect(decision.outcome_verdict).toBe("reject");
  });

  it("ADM-05 rejects a planted-01 repetition 20 Auckland pass", () => {
    const { decision } = run((draft) => {
      observe(draft, "planted-01", AKL, 20, "pass", null);
    });
    expect(rule(decision, "ADM-05")).toEqual({ decision: "reject", trials: [{ trial_id: "planted-01", basis: "added_checks", status: "complete", reason: null, code: null }] });
  });
});

describe("ADM-06 negative probes", () => {
  it("ADM-06 rejects a partial-01 Auckland assertion failure", () => {
    const { decision } = run((draft) => {
      observe(draft, "partial-01", AKL, 1, "assertion_fail", "local_day_counts_mismatch");
    });
    expect(rule(decision, "ADM-06")).toEqual({ decision: "reject", trials: [{ trial_id: "partial-01", basis: "added_checks", status: "complete", reason: null, code: null }] });
    expect(decision.outcome_verdict).toBe("reject");
  });

  it("ADM-06 rejects a partial-01 Los Angeles pass", () => {
    const { decision } = run((draft) => {
      observe(draft, "partial-01", LA, 1, "pass", null);
    });
    expect(rule(decision, "ADM-06").decision).toBe("reject");
  });

  it("ADM-06 is incomplete when the stub-01 driver status is invalid with build_failed", () => {
    const { decision } = run((draft) => {
      trial(draft, "stub-01").status = "invalid";
      trial(draft, "stub-01").invalidReason = "build_failed";
    });
    expect(rule(decision, "ADM-06")).toEqual({ decision: "incomplete", trials: [{ trial_id: "stub-01", basis: "trial_status", status: "invalid", reason: "build_failed", code: "import:driver_status" }] });
  });

  it("ADM-06 is incomplete when stub-01 Los Angeles fails with local_day_counts_mismatch instead of bucket_labels_mismatch", () => {
    const { evidence, decision } = run((draft) => {
      observe(draft, "stub-01", LA, 1, "assertion_fail", "local_day_counts_mismatch");
    });
    expect(evidence.trials.find((item) => item.trial_id === "stub-01")?.status).toBe("invalid");
    expect(rule(decision, "ADM-06").decision).toBe("incomplete");
  });

  it("ADM-06 is incomplete when a stub-01 check is not_run", () => {
    const { decision } = run((draft) => {
      observe(draft, "stub-01", UTC, 1, "not_run", "timeout");
    });
    expect(rule(decision, "ADM-06")).toEqual({ decision: "incomplete", trials: [{ trial_id: "stub-01", basis: "trial_status", status: "incomplete", reason: "timeout", code: "import:outcome_not_run" }] });
    expect(rule(decision, "ADM-02").decision).toBe("invalid");
  });

  it("ADM-06 is incomplete when a partial-01 check is missing", () => {
    const { decision } = run((draft) => {
      dropObservation(draft, "partial-01", LA, 1);
    });
    expect(rule(decision, "ADM-06")).toEqual({ decision: "incomplete", trials: [{ trial_id: "partial-01", basis: "trial_status", status: "incomplete", reason: "test_missing", code: "import:check_missing" }] });
  });
});

describe("ADM-08 original-suite comparison", () => {
  it("ADM-08 cells are all not_run before import", () => {
    const cells = initialCells(baselineDraft().manifest);
    expect(cells?.map((cell) => [cell.trial_id, cell.suite, cell.state, cell.matches_expectation, cell.executed_count])).toEqual([
      ["clean-01", "original", "not_run", false, 0],
      ["clean-01", "added", "not_run", false, 0],
      ["planted-01", "original", "not_run", false, 0],
      ["planted-01", "added", "not_run", false, 0],
      ["fixed-01", "original", "not_run", false, 0],
      ["fixed-01", "added", "not_run", false, 0],
    ]);
    expect(initialCells(baselineDraft("kit_check").manifest)).toBeNull();
  });

  it("ADM-08 is caught_by_original_suite for an original test failure in planted-01", () => {
    const { evidence, decision } = run((draft) => {
      testOutcome(draft, "planted-01", TEST_IDS[2] ?? "", "failed");
    });
    expect(decision.comparison).toEqual({ classification: "caught_by_original_suite", trials: [{ trial_id: "planted-01", basis: "original_suite", status: "complete", reason: null, code: null }] });
    expect(cellStates(evidence.cells)).toEqual([
      ["clean-01", "original", "pass", true],
      ["clean-01", "added", "pass", true],
      ["planted-01", "original", "fail", false],
      ["planted-01", "added", "fail", true],
      ["fixed-01", "original", "pass", true],
      ["fixed-01", "added", "pass", true],
    ]);
    expect(evidence.cells?.[2]?.failing).toEqual([{ id: TEST_IDS[2], repeat_index: null, failure_code: null }]);
  });

  it("ADM-08 is caught_by_original_suite for a failure only in planted-04, with planted-01 missed", () => {
    const { evidence, decision } = run((draft) => {
      testOutcome(draft, "planted-04", TEST_IDS[0] ?? "", "failed");
    });
    expect(decision.comparison?.classification).toBe("caught_by_original_suite");
    expect(evidence.cells?.[2]?.state).toBe("pass");
  });

  it("ADM-08 is not_demonstrated for an original test failure in fixed-02", () => {
    const { decision } = run((draft) => {
      testOutcome(draft, "fixed-02", TEST_IDS[0] ?? "", "failed");
    });
    expect(decision.comparison?.classification).toBe("not_demonstrated");
  });

  it("ADM-08 is not_demonstrated for an original test failure in partial-01", () => {
    const { decision } = run((draft) => {
      testOutcome(draft, "partial-01", TEST_IDS[0] ?? "", "failed");
    });
    expect(decision.comparison?.classification).toBe("not_demonstrated");
    expect(rule(decision, "ADM-06").decision).toBe("pass");
  });

  it("ADM-08 is not_demonstrated when clean and fixed fail an original test and a planted copy is caught", () => {
    const { decision } = run((draft) => {
      testOutcome(draft, "fixed-02", TEST_IDS[0] ?? "", "failed");
      testOutcome(draft, "planted-01", TEST_IDS[0] ?? "", "failed");
    });
    expect(decision.comparison?.classification).toBe("not_demonstrated");
  });

  it("ADM-08 is not_demonstrated when a probe copy does not match its declared vector", () => {
    const { decision } = run((draft) => {
      observe(draft, "stub-01", AKL, 1, "pass", null);
    });
    expect(decision.comparison?.classification).toBe("not_demonstrated");
  });

  it("ADM-08 is invalid when any trial is invalid, before a caught original-suite failure", () => {
    const { evidence, decision } = run((draft) => {
      observe(draft, "planted-03", LA, 1, "setup_fail", "auth_failed");
      testOutcome(draft, "planted-01", TEST_IDS[0] ?? "", "failed");
    });
    expect(decision.comparison?.classification).toBe("invalid");
    expect(decision.comparison?.trials.map((item) => item.trial_id)).toEqual(["planted-03"]);
    expect(evidence.cells?.[2]?.state).toBe("fail");
  });

  it("ADM-08 is incomplete when any trial is incomplete", () => {
    const { evidence, decision } = run((draft) => {
      trial(draft, "fixed-01").write = false;
    });
    expect(decision.comparison?.classification).toBe("incomplete");
    expect(cellStates(evidence.cells?.slice(4) ?? null)).toEqual([
      ["fixed-01", "original", "incomplete", false],
      ["fixed-01", "added", "incomplete", false],
    ]);
  });

  it("ADM-08 added-checks cell is invalid for a setup failure while the original cell stays observed", () => {
    const { evidence } = run((draft) => {
      observe(draft, "clean-01", UTC, 1, "setup_fail", "seed_failed");
    });
    expect(cellStates(evidence.cells?.slice(0, 2) ?? null)).toEqual([
      ["clean-01", "original", "pass", true],
      ["clean-01", "added", "invalid", false],
    ]);
  });
});

describe("other job kinds", () => {
  it("gives no rule decisions, comparison or outcome verdict for a kit_check record set", () => {
    const decision = decide(importRecordSet(recordSet(undefined, undefined, "kit_check")));
    expect(decision).toMatchObject({ kind: "kit_check", decisions: null, comparison: null, outcome_verdict: null });
    expect(decisionErrors(decision)).toEqual([]);
  });
});
