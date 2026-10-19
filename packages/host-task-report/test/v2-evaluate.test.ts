import { describe, expect, it } from "vitest";
import { blockStatus } from "../src/f3/block.ts";
import { FAILURE_CODE } from "../src/f3/data.ts";
import type { Outcome } from "../src/f3/data.ts";
import { loadCatalogPins } from "../v2/entry.ts";
import { aggregateState, evaluateCopyV2, evaluateProtocolV2, overallVerdict, perStateV2, replayBlock } from "../v2/evaluate.ts";
import type { CopyCells } from "../v2/evaluate.ts";
import { expectedTrees, stateExpectation } from "../v2/expected.ts";
import { loadProtocolV2 } from "../v2/protocol.ts";
import type { CopySummaryV2 } from "../v2/record.ts";
import { BUGGY_TREE, CLEAN_TREE, CONTROL_RULE, ENTRY_ID, MAIN_RULE, TARGET, baseline, copyV2, data, instanceV2, nth, qualifyingSetV2, setBlock, stateFiles, trialsOf } from "./support-v2.ts";

const protocol = loadProtocolV2();
const catalog = loadCatalogPins();
const expectation = stateExpectation(baseline, catalog, ENTRY_ID);
const set = (): CopySummaryV2[] => qualifyingSetV2(protocol.sha256, catalog.sha256);

function stateOf(copies: readonly CopySummaryV2[], state: string): ReturnType<typeof evaluateProtocolV2>["states"][number] {
  const found = evaluateProtocolV2(protocol, data, expectation, copies).states.find((entry) => entry.state === state);
  if (found === undefined) throw new Error(`no ${state}`);
  return found;
}

const buggyOf = (copies: CopySummaryV2[]): CopySummaryV2 => nth(copies, 0);
const fixedOf = (copies: CopySummaryV2[]): CopySummaryV2 => nth(copies, 1);
const cleanOf = (copies: CopySummaryV2[]): CopySummaryV2 => nth(copies, 2);

describe("expected trees", () => {
  it("clean and fixed are the baseline tree; buggy is the baseline with the planted target file", () => {
    expect(expectation.trees).toEqual({ clean: CLEAN_TREE, fixed: CLEAN_TREE, buggy: BUGGY_TREE });
    expect(expectation.entry_id).toBe(ENTRY_ID);
    expect(expectation.catalog_sha256).toBe(catalog.sha256);
    expect(expectation.suite_sha256).toBe(baseline.suite.tree_sha256);
  });

  it("refuses an entry whose baseline target hash is not the baseline's", () => {
    const pins = nth(catalog.entries, 0);
    expect(() => expectedTrees(baseline.source.files, { ...pins, baseline_sha256: "1".repeat(64) })).toThrow();
    expect(() => expectedTrees(baseline.source.files, { ...pins, target_path: "src/missing.ts" })).toThrow();
  });
});

describe("evaluator v2 keeps version 1's decisions", () => {
  it("qualifies when buggy fails every valid main trial, fixed and clean pass every one, and every control passes", () => {
    const evaluation = evaluateProtocolV2(protocol, data, expectation, set());
    expect(evaluation.verdict).toBe("qualified");
    expect(evaluation.states.map((state) => [state.state, state.verdict])).toEqual([
      ["clean", "met"],
      ["buggy", "met"],
      ["fixed", "met"],
    ]);
    const buggy = stateOf(set(), "buggy").cells;
    expect(buggy.verification).toMatchObject({ observed: "fail", failure_codes: [FAILURE_CODE], runs_valid: 3, runs_total: 3 });
    expect(buggy.original_suite).toMatchObject({ observed: "pass", runs_valid: 3, runs_total: 3 });
  });

  it("does not qualify when one valid buggy main trial passes", () => {
    const copies = set();
    setBlock(nth(buggyOf(copies).instances, 0), "main", [...trialsOf("main", FAILURE_CODE).slice(1), "pass"]);
    const buggy = stateOf(copies, "buggy");
    expect(buggy.verdict).toBe("not_met");
    expect(buggy.cells.verification.observed).toBe("fail");
    expect(buggy.cells.verification.failure_codes).not.toContain(FAILURE_CODE);
    expect(evaluateProtocolV2(protocol, data, expectation, copies).verdict).toBe("not_qualified");
  });

  it("does not qualify when a clean or fixed trial shows the failure, or a control fails", () => {
    const clean = set();
    clean[2] = copyV2("clean", [instanceV2(1, FAILURE_CODE)], protocol.sha256, catalog.sha256);
    expect(stateOf(clean, "clean")).toMatchObject({ verdict: "not_met", cells: { verification: { observed: "fail" } } });
    const fixed = set();
    setBlock(nth(fixedOf(fixed).instances, 2), "x_alone", [...trialsOf("x_alone", "pass").slice(1), FAILURE_CODE]);
    expect(stateOf(fixed, "fixed").verdict).toBe("not_met");
    const control = set();
    control[0] = copyV2("buggy", [instanceV2(1, FAILURE_CODE), instanceV2(2, FAILURE_CODE, FAILURE_CODE), instanceV2(3, FAILURE_CODE)], protocol.sha256, catalog.sha256);
    const buggy = stateOf(control, "buggy");
    expect(buggy.verdict).toBe("not_met");
    expect(buggy.cells.verification.failure_codes).toEqual([protocol.verification_codes.control]);
  });

  it("does not qualify when the original suite fails on an instance", () => {
    const copies = set();
    nth(buggyOf(copies).instances, 1).suite = { verdict: "failed", tests_expected: 193, passed: 190, failed: ["t-1", "t-2", "t-3"] };
    const buggy = stateOf(copies, "buggy");
    expect(buggy.verdict).toBe("not_met");
    expect(buggy.cells.original_suite).toMatchObject({ observed: "fail", failure_codes: [protocol.verification_codes.original_suite] });
    const copy = evaluateCopyV2(protocol, data, expectation, buggyOf(copies));
    expect(copy.original_suite.failing_test_ids).toEqual(["t-1", "t-2", "t-3"]);
    expect(copy.original_suite.executed).toBe(579);
    expect(copy.original_suite.expected).toBe(579);
  });

  it("treats an incomplete block as neither reproduction nor a miss", () => {
    const copies = set();
    setBlock(nth(buggyOf(copies).instances, 2), "main", [...Array.from({ length: 12 }, (): Outcome => FAILURE_CODE), "invalid", "invalid", "invalid"]);
    const buggy = stateOf(copies, "buggy");
    expect(buggy.verdict).toBe("incomplete");
    expect(buggy.cells.verification).toMatchObject({ observed: "incomplete", runs_valid: 2, runs_total: 3 });
    expect(evaluateProtocolV2(protocol, data, expectation, copies).verdict).toBe("incomplete");
  });

  it("never counts invalid trials towards the target", () => {
    const copies = set();
    const instance = nth(fixedOf(copies).instances, 0);
    const outcomes: Outcome[] = [...Array.from({ length: 18 }, (): Outcome => "pass"), "invalid", "invalid"];
    instance.trials.main = outcomes;
    instance.blocks.main = { ...blockStatus(MAIN_RULE, outcomes), state: "complete", next_index: null };
    expect(stateOf(copies, "fixed").verdict).toBe("incomplete");
  });

  it("is incomplete with too few instances, a missing copy or a suite that did not run, and invalid for an invalid copy", () => {
    const short = set();
    short[0] = copyV2("buggy", [instanceV2(1, FAILURE_CODE), instanceV2(2, FAILURE_CODE)], protocol.sha256, catalog.sha256);
    expect(stateOf(short, "buggy").verdict).toBe("incomplete");
    expect(stateOf(set().slice(1), "buggy").verdict).toBe("incomplete");
    const noSuite = set();
    nth(cleanOf(noSuite).instances, 0).suite = null;
    expect(stateOf(noSuite, "clean")).toMatchObject({ verdict: "incomplete", cells: { original_suite: { observed: "incomplete" }, verification: { observed: "pass" } } });
    const invalid = set();
    cleanOf(invalid).invalid_reason = "dependency_manifests_differ";
    expect(stateOf(invalid, "clean")).toMatchObject({ verdict: "invalid", cells: { original_suite: { observed: "error" }, verification: { observed: "error" } } });
    expect(evaluateProtocolV2(protocol, data, expectation, invalid).verdict).toBe("invalid");
  });

  it("does not count copies made under another data file or protocol, or smoke copies", () => {
    const other = set();
    cleanOf(other).data_sha256 = "1".repeat(64);
    expect(stateOf(other, "clean").verdict).toBe("incomplete");
    const retuned = set();
    fixedOf(retuned).protocol_sha256 = "2".repeat(64);
    expect(stateOf(retuned, "fixed").verdict).toBe("incomplete");
    const smoke = set();
    cleanOf(smoke).purpose = "smoke";
    expect(stateOf(smoke, "clean").verdict).toBe("incomplete");
    const beside = set();
    const extra = copyV2("clean", [instanceV2(1, FAILURE_CODE)], protocol.sha256, catalog.sha256);
    extra.purpose = "smoke";
    expect(evaluateProtocolV2(protocol, data, expectation, [...beside, extra]).verdict).toBe("qualified");
  });

  it("refuses to evaluate against a data file the protocol does not pin", () => {
    expect(() => evaluateProtocolV2({ ...protocol, data_sha256: "3".repeat(64) }, data, expectation, set())).toThrow();
  });
});

describe("evaluator v2 checks the tree each copy ran", () => {
  it("is incomplete when a buggy copy ran the clean tree", () => {
    const copies = set();
    const buggy = buggyOf(copies);
    buggy.source_files = stateFiles("clean");
    buggy.source_tree_sha256 = CLEAN_TREE;
    buggy.expected_source_tree_sha256 = CLEAN_TREE;
    const state = stateOf(copies, "buggy");
    expect(state.verdict).toBe("incomplete");
    expect(state.cells.verification.observed).toBe("incomplete");
    expect(state.reasons.join(" ")).toContain("source tree");
    expect(evaluateProtocolV2(protocol, data, expectation, copies).verdict).toBe("incomplete");
  });

  it("is incomplete when a fixed copy ran the buggy tree, even though every cell would match", () => {
    const copies = set();
    const fixed = fixedOf(copies);
    fixed.source_files = stateFiles("buggy");
    fixed.source_tree_sha256 = BUGGY_TREE;
    expect(stateOf(copies, "fixed").verdict).toBe("incomplete");
  });

  it("recomputes the tree from the recorded file hashes instead of trusting the recorded tree hash", () => {
    const copies = set();
    const buggy = buggyOf(copies);
    buggy.source_files = { ...stateFiles("buggy"), [TARGET]: "4".repeat(64) };
    expect(buggy.source_tree_sha256).toBe(BUGGY_TREE);
    expect(stateOf(copies, "buggy").verdict).toBe("incomplete");
  });

  it("is incomplete when the copy expected another tree, names another entry or ran another catalog", () => {
    const expected = set();
    buggyOf(expected).expected_source_tree_sha256 = CLEAN_TREE;
    expect(stateOf(expected, "buggy").verdict).toBe("incomplete");
    const entry = set();
    buggyOf(entry).entry_id = "task-report-f3-002";
    expect(stateOf(entry, "buggy").verdict).toBe("incomplete");
    const catalogSha = set();
    cleanOf(catalogSha).catalog_sha256 = "5".repeat(64);
    expect(stateOf(catalogSha, "clean").verdict).toBe("incomplete");
  });

  it("is incomplete when the copy is not the one the plan asked for", () => {
    const buggy = buggyOf(set());
    expect(evaluateCopyV2(protocol, data, expectation, buggy, { copy_id: buggy.copy_id, state: "buggy" }).status).toBe("complete");
    expect(evaluateCopyV2(protocol, data, expectation, buggy, { copy_id: "f3q2-other", state: "buggy" }).status).toBe("incomplete");
    expect(evaluateCopyV2(protocol, data, expectation, buggy, { copy_id: buggy.copy_id, state: "fixed" }).status).toBe("incomplete");
  });
});

describe("evaluator v2 ranks an identity mismatch above a miss", () => {
  const failing = (): CopySummaryV2 => copyV2("fixed", [instanceV2(1, FAILURE_CODE), instanceV2(2, FAILURE_CODE), instanceV2(3, FAILURE_CODE)], protocol.sha256, catalog.sha256);
  const stale: [string, (copy: CopySummaryV2) => void][] = [
    [
      "another data file",
      (copy) => {
        copy.data_sha256 = "1".repeat(64);
      },
    ],
    [
      "another protocol",
      (copy) => {
        copy.protocol_sha256 = "2".repeat(64);
      },
    ],
    [
      "another baseline",
      (copy) => {
        copy.baseline_id = "task-report@0000000";
      },
    ],
    [
      "another source tree",
      (copy) => {
        copy.source_files = stateFiles("buggy");
        copy.source_tree_sha256 = BUGGY_TREE;
      },
    ],
  ];

  it.each(stale)("a fixed copy that ran %s and whose main trials show the failure is incomplete, never not qualified", (_, change) => {
    const fixed = failing();
    expect(evaluateCopyV2(protocol, data, expectation, fixed)).toMatchObject({ status: "complete", verification: { observed: "fail" } });
    change(fixed);
    expect(evaluateCopyV2(protocol, data, expectation, fixed)).toMatchObject({ status: "incomplete", original_suite: { observed: "incomplete" }, verification: { observed: "incomplete", failure_codes: [] } });
    const copies = set();
    copies[1] = fixed;
    expect(stateOf(copies, "fixed")).toMatchObject({ verdict: "incomplete", cells: { verification: { observed: "incomplete" } } });
    expect(evaluateProtocolV2(protocol, data, expectation, copies).verdict).toBe("incomplete");
  });

  it("a buggy copy whose main trials all pass is incomplete when it is not the copy the plan asked for", () => {
    const buggy = copyV2("buggy", [instanceV2(1, "pass"), instanceV2(2, "pass"), instanceV2(3, "pass")], protocol.sha256, catalog.sha256);
    expect(evaluateCopyV2(protocol, data, expectation, buggy, { copy_id: buggy.copy_id, state: "buggy" })).toMatchObject({ status: "complete", verification: { observed: "pass" } });
    expect(evaluateCopyV2(protocol, data, expectation, buggy, { copy_id: "f3q2-other", state: "buggy" })).toMatchObject({ status: "incomplete", verification: { observed: "incomplete" } });
  });
});

describe("evaluator v2 takes every block rule from the protocol file", () => {
  it("is incomplete when the record's rules differ from the protocol's", () => {
    const copies = set();
    buggyOf(copies).rules.main = { ...MAIN_RULE, max_invalid: 5 };
    expect(stateOf(copies, "buggy").verdict).toBe("incomplete");
    const control = set();
    cleanOf(control).rules.dx_order = { ...CONTROL_RULE, valid_target: 2 };
    expect(stateOf(control, "clean").verdict).toBe("incomplete");
  });

  it("recomputes a block under the protocol's rule: a block a looser rule called complete is incomplete", () => {
    const copies = set();
    const loose = { ...MAIN_RULE, max_invalid: 5 };
    const outcomes: Outcome[] = ["invalid", "invalid", "invalid", ...trialsOf("main", FAILURE_CODE)];
    setBlock(nth(buggyOf(copies).instances, 0), "main", outcomes, loose);
    buggyOf(copies).rules.main = loose;
    expect(nth(buggyOf(copies).instances, 0).blocks.main?.state).toBe("complete");
    expect(stateOf(copies, "buggy").verdict).toBe("incomplete");
  });

  it("is incomplete when trials continue after the rule stops the block, or the block ends early", () => {
    const extra = set();
    setBlock(nth(cleanOf(extra).instances, 0), "sequential", [...trialsOf("sequential", "pass"), "pass"]);
    expect(stateOf(extra, "clean").verdict).toBe("incomplete");
    const early = set();
    setBlock(nth(cleanOf(early).instances, 0), "valid_partner", trialsOf("valid_partner", "pass").slice(1));
    expect(stateOf(early, "clean").verdict).toBe("incomplete");
  });

  it("is incomplete when a recorded block status differs from the recomputed one", () => {
    const copies = set();
    const instance = nth(fixedOf(copies).instances, 1);
    const recorded = instance.blocks.main;
    if (recorded === undefined) throw new Error("no block");
    instance.blocks.main = { ...recorded, invalid: 1 };
    expect(stateOf(copies, "fixed").verdict).toBe("incomplete");
  });

  it("replays a block: invalid trials are topped up and never counted", () => {
    const outcomes: Outcome[] = ["invalid", ...trialsOf("x_alone", "pass")];
    const replay = replayBlock(CONTROL_RULE, outcomes, blockStatus(CONTROL_RULE, outcomes));
    expect(replay.problems).toEqual([]);
    expect(replay.status).toMatchObject({ state: "complete", valid: 5, invalid: 1, attempts: 6 });
    expect(replayBlock(CONTROL_RULE, outcomes, undefined).problems.length).toBeGreaterThan(0);
  });
});

describe("evaluator v2 keeps invalid and incomplete apart", () => {
  it("an instance that could not be prepared makes the copy invalid; one that ended early makes it incomplete", () => {
    const setup = set();
    nth(buggyOf(setup).instances, 1).failure = { kind: "setup", detail: "db_start failed" };
    const invalid = evaluateCopyV2(protocol, data, expectation, buggyOf(setup));
    expect(invalid).toMatchObject({ status: "invalid", original_suite: { observed: "error" }, verification: { observed: "error" } });
    const run = set();
    nth(buggyOf(run).instances, 1).failure = { kind: "run", detail: "instance error TypeError" };
    const incomplete = evaluateCopyV2(protocol, data, expectation, buggyOf(run));
    expect(incomplete).toMatchObject({ status: "incomplete", verification: { observed: "incomplete", runs_valid: 2 } });
  });

  it("an original-suite run with a missing test is not a valid run", () => {
    const copies = set();
    nth(fixedOf(copies).instances, 0).suite = { verdict: "invalid", tests_expected: 193, passed: 192, failed: [] };
    expect(stateOf(copies, "fixed")).toMatchObject({ verdict: "incomplete", cells: { original_suite: { observed: "incomplete", runs_valid: 2 } } });
    const forged = set();
    nth(fixedOf(forged).instances, 0).suite = { verdict: "passed", tests_expected: 192, passed: 192, failed: [] };
    expect(stateOf(forged, "fixed").cells.original_suite.observed).toBe("incomplete");
  });
});

describe("aggregateState", () => {
  const cells = (status: CopyCells["status"], suite: "pass" | "fail" | "error" | "incomplete", checks: "pass" | "fail" | "error" | "incomplete", codes: string[] = []): CopyCells & { state: "buggy" } => ({
    state: "buggy",
    status,
    original_suite: { observed: suite, runs_valid: 3, runs_total: 3, failure_codes: [], detail: "", executed: 579, expected: 579, failing_test_ids: [], suite_sha256: "6".repeat(64) },
    verification: { observed: checks, runs_valid: 3, runs_total: 3, failure_codes: codes, detail: "" },
  });
  const per = perStateV2(protocol, "buggy");

  it("maps the protocol's counts: one copy, one round per instance, every instance valid", () => {
    expect(per).toEqual({ copies: 1, rounds_per_copy: 3, min_valid_runs: 3 });
    expect(perStateV2(protocol, "clean")).toEqual({ copies: 1, rounds_per_copy: 1, min_valid_runs: 1 });
  });

  it("passes a complete copy's cells through", () => {
    const out = aggregateState(per, "buggy", [cells("complete", "pass", "fail", [FAILURE_CODE])]);
    expect(out.original_suite).toMatchObject({ observed: "pass", runs_valid: 3, runs_total: 3 });
    expect(out.verification).toMatchObject({ observed: "fail", failure_codes: [FAILURE_CODE] });
  });

  it("is incomplete with no copy, too many copies, a copy of another state or too few runs", () => {
    expect(aggregateState(per, "buggy", []).verification.observed).toBe("incomplete");
    expect(aggregateState(per, "buggy", [cells("complete", "pass", "pass"), cells("complete", "pass", "pass")]).original_suite.observed).toBe("incomplete");
    expect(aggregateState(per, "clean", [cells("complete", "pass", "pass")]).original_suite.observed).toBe("incomplete");
    const short = cells("complete", "pass", "pass");
    short.verification.runs_valid = 2;
    expect(aggregateState(per, "buggy", [short]).verification.observed).toBe("incomplete");
  });

  it("keeps a failure code only when every copy of the state reports it", () => {
    const two = { copies: 2, rounds_per_copy: 3, min_valid_runs: 6 };
    const declared = protocol.verification_codes.declared;
    expect(aggregateState(two, "buggy", [cells("complete", "pass", "fail", [declared]), cells("complete", "pass", "fail", [declared])]).verification).toMatchObject({ observed: "fail", failure_codes: [declared] });
    expect(aggregateState(two, "buggy", [cells("complete", "pass", "fail", [declared]), cells("complete", "pass", "fail", [protocol.verification_codes.inconsistent])]).verification).toMatchObject({ observed: "fail", failure_codes: [] });
    expect(aggregateState(two, "buggy", [cells("complete", "pass", "fail", [declared]), cells("complete", "pass", "pass")]).verification).toMatchObject({ observed: "fail", failure_codes: [] });
  });

  it("gives the overall verdict: a mismatch counts only on complete evidence, and invalid comes before incomplete", () => {
    expect(overallVerdict(["met", "met", "met"])).toBe("qualified");
    expect(overallVerdict(["met", "not_met", "met"])).toBe("not_qualified");
    expect(overallVerdict(["not_met", "incomplete", "met"])).toBe("incomplete");
    expect(overallVerdict(["not_met", "incomplete", "invalid"])).toBe("invalid");
    expect(overallVerdict([])).toBe("incomplete");
  });

  it("keeps error and incomplete distinct, and refuses a record whose status contradicts its cells", () => {
    expect(aggregateState(per, "buggy", [cells("invalid", "error", "error")])).toMatchObject({ original_suite: { observed: "error" }, verification: { observed: "error" } });
    expect(aggregateState(per, "buggy", [cells("incomplete", "pass", "incomplete")])).toMatchObject({ original_suite: { observed: "pass" }, verification: { observed: "incomplete" } });
    expect(aggregateState(per, "buggy", [cells("complete", "pass", "incomplete")]).original_suite.observed).toBe("incomplete");
    expect(aggregateState(per, "buggy", [cells("incomplete", "pass", "pass")]).verification.observed).toBe("incomplete");
    expect(aggregateState(per, "buggy", [cells("invalid", "pass", "pass")]).verification.observed).toBe("incomplete");
  });
});
