import { describe, expect, it } from "vitest";
import { blockMatches, blockStatus } from "../src/f3/block.ts";
import type { Outcome } from "../src/f3/data.ts";
import { FAILURE_CODE } from "../src/f3/data.ts";
import { loadProtocol } from "../src/protocol.ts";

const main = loadProtocol().blocks.main;

function times(outcome: Outcome, count: number): Outcome[] {
  return Array.from({ length: count }, () => outcome);
}

describe("blockStatus", () => {
  it("uses the protocol's main rule: 20 valid, at most 2 invalid, at most 10 top-ups", () => {
    expect(main).toEqual({ valid_target: 20, max_invalid: 2, max_top_ups: 10 });
  });

  it("runs until the block has its target of valid trials", () => {
    expect(blockStatus(main, [])).toMatchObject({ state: "running", next_index: 1 });
    expect(blockStatus(main, times(FAILURE_CODE, 19))).toMatchObject({ state: "running", next_index: 20 });
    expect(blockStatus(main, times(FAILURE_CODE, 20))).toMatchObject({ state: "complete", valid: 20, invalid: 0, top_ups: 0, next_index: null, outcomes: { [FAILURE_CODE]: 20 } });
  });

  it("tops up each invalid trial with a new index, and invalid trials never count as valid", () => {
    const outcomes = [...times("pass", 10), "invalid", ...times("pass", 9)] as Outcome[];
    expect(blockStatus(main, outcomes)).toMatchObject({ state: "running", valid: 19, invalid: 1, next_index: 21 });
    expect(blockStatus(main, [...outcomes, "pass"])).toMatchObject({ state: "complete", valid: 20, invalid: 1, top_ups: 1, outcomes: { pass: 20 } });
  });

  it("is incomplete as soon as the invalid ceiling is passed", () => {
    expect(blockStatus(main, ["invalid", "invalid"])).toMatchObject({ state: "running", next_index: 3 });
    expect(blockStatus(main, ["invalid", "invalid", "invalid"])).toMatchObject({ state: "incomplete", next_index: null, valid: 0, invalid: 3 });
  });

  it("is incomplete once the top-up cap is reached without the target", () => {
    const loose = { valid_target: 3, max_invalid: 10, max_top_ups: 2 };
    expect(blockStatus(loose, ["pass", "invalid", "invalid", "pass"])).toMatchObject({ state: "running", next_index: 5 });
    expect(blockStatus(loose, ["pass", "invalid", "invalid", "invalid", "pass"])).toMatchObject({ state: "incomplete", valid: 2 });
  });
});

describe("blockMatches", () => {
  it("needs a complete block whose valid trials all equal the expected outcome", () => {
    expect(blockMatches(blockStatus(main, times(FAILURE_CODE, 20)), FAILURE_CODE)).toBe(true);
    expect(blockMatches(blockStatus(main, [...times(FAILURE_CODE, 19), "pass"]), FAILURE_CODE)).toBe(false);
    expect(blockMatches(blockStatus(main, [...times(FAILURE_CODE, 19), "invalid", FAILURE_CODE]), FAILURE_CODE)).toBe(true);
    expect(blockMatches(blockStatus(main, times(FAILURE_CODE, 19)), FAILURE_CODE)).toBe(false);
    expect(blockMatches(blockStatus(main, [...times(FAILURE_CODE, 5), "invalid", "invalid", "invalid"]), FAILURE_CODE)).toBe(false);
  });
});
