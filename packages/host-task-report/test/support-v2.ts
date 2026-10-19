// Synthetic record sets of evaluator v2 for the evaluation and adapter tests. The trees and hashes
// come from the committed baseline manifest and catalog; every outcome, time and ID is made up.
import { loadBaseline } from "../src/baseline.ts";
import { blockStatus } from "../src/f3/block.ts";
import type { BlockRule } from "../src/f3/block.ts";
import { FAILURE_CODE, KINDS, loadData } from "../src/f3/data.ts";
import type { CodeState, KindId, Outcome } from "../src/f3/data.ts";
import { treeSha256 } from "../src/hash.ts";
import type { CopySummaryV2, InstanceRecordV2 } from "../v2/record.ts";

export const ENTRY_ID = "task-report-f3-001";
export const TARGET = "src/completions/store.ts";
export const CLEAN_TARGET_SHA = "5424120c0110adf3a755fe6a1aed2fcd99d87565dce1c4c84a5d62965f67f93f";
export const BUGGY_TARGET_SHA = "22eb94274610254f2aee10463418af669afb46a1579468cfb11726d7baa3d71c";
/** The tree hashes the package README records for the clean (and fixed) and buggy trees. */
export const CLEAN_TREE = "22e67f24fdc4e2edffe357d10572ed3a799b7ddbeb8b8176a29d6f7581c3eedd";
export const BUGGY_TREE = "e3bfdfff056fff3d044c67246758a72698cc5e58a9755b18cfc3f9150afffa91";
export const MAIN_RULE: BlockRule = { valid_target: 20, max_invalid: 2, max_top_ups: 10 };
export const CONTROL_RULE: BlockRule = { valid_target: 5, max_invalid: 1, max_top_ups: 5 };

export const baseline = loadBaseline();
export const data = loadData();

export function ruleOf(kind: KindId): BlockRule {
  return kind === "main" ? MAIN_RULE : CONTROL_RULE;
}

/** The app tree's per-file hashes for a state: the baseline, with the target at its buggy hash for buggy. */
export function stateFiles(state: CodeState): Record<string, string> {
  return { ...baseline.source.files, [TARGET]: state === "buggy" ? BUGGY_TARGET_SHA : CLEAN_TARGET_SHA };
}

/** A block of `valid` trials of one outcome, with `invalid` invalid trials run first and topped up. */
export function trialsOf(kind: KindId, outcome: Exclude<Outcome, "invalid">, invalid = 0): Outcome[] {
  const valid = ruleOf(kind).valid_target;
  return [...Array.from({ length: invalid }, (): Outcome => "invalid"), ...Array.from({ length: valid }, (): Outcome => outcome)];
}

/** An instance whose suite passed 193 of 193 and whose blocks completed with the given outcomes. */
export function instanceV2(number: number, main: Exclude<Outcome, "invalid">, controls: Exclude<Outcome, "invalid"> = "pass"): InstanceRecordV2 {
  const trials: Partial<Record<KindId, Outcome[]>> = {};
  const blocks: InstanceRecordV2["blocks"] = {};
  for (const kind of KINDS) {
    const outcomes = trialsOf(kind, kind === "main" ? main : controls);
    trials[kind] = outcomes;
    blocks[kind] = blockStatus(ruleOf(kind), outcomes);
  }
  return { instance: number, failure: null, suite: { verdict: "passed", tests_expected: 193, passed: 193, failed: [] }, trials, blocks };
}

/** Replaces one block's outcomes and recomputes its recorded status under the given rule. */
export function setBlock(instance: InstanceRecordV2, kind: KindId, outcomes: Outcome[], rule: BlockRule = ruleOf(kind)): void {
  instance.trials[kind] = outcomes;
  instance.blocks[kind] = blockStatus(rule, outcomes);
}

export function copyV2(state: CodeState, instances: InstanceRecordV2[], protocolSha: string, catalogSha: string): CopySummaryV2 {
  const files = stateFiles(state);
  const tree = treeSha256(files);
  const rules = {} as Record<KindId, BlockRule>;
  for (const kind of KINDS) rules[kind] = { ...ruleOf(kind) };
  return {
    format: "rbw.task-report.copy.v2",
    copy_id: `f3q2-synthetic-${state}-1`,
    state,
    purpose: "counted",
    entry_id: ENTRY_ID,
    catalog_sha256: catalogSha,
    expected_source_tree_sha256: tree,
    baseline_id: "task-report@ca4a71f",
    data_sha256: data.sha256,
    protocol_sha256: protocolSha,
    source_tree_sha256: tree,
    source_files: files,
    rules,
    invalid_reason: null,
    instances,
    started_at: "2030-01-01T00:00:00.000Z",
    ended_at: "2030-01-01T00:01:30.000Z",
    phases: [],
  };
}

/** Copies on which the case qualifies: buggy fails every main trial, everything else passes. */
export function qualifyingSetV2(protocolSha: string, catalogSha: string): CopySummaryV2[] {
  return [
    copyV2("buggy", [instanceV2(1, FAILURE_CODE), instanceV2(2, FAILURE_CODE), instanceV2(3, FAILURE_CODE)], protocolSha, catalogSha),
    copyV2("fixed", [instanceV2(1, "pass"), instanceV2(2, "pass"), instanceV2(3, "pass")], protocolSha, catalogSha),
    copyV2("clean", [instanceV2(1, "pass")], protocolSha, catalogSha),
  ];
}

export function nth<T>(items: readonly T[], index: number): T {
  const found = items[index];
  if (found === undefined) throw new Error(`no item ${String(index)}`);
  return found;
}
