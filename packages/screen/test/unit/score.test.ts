import { describe, expect, it } from "vitest";
import type { ScreenAnswer } from "../../src/prompt.ts";
import { applyAnswer, isHit, scoreAnswer, verdictOf } from "../../src/score.ts";
import type { AttemptOutcome } from "../../src/score.ts";
import { plantedSite } from "../../src/site.ts";
import { LOCATED_AND_FIXED, LOCATED_ONLY, MISS } from "../fixtures/scripted.ts";
import { CLEAN_REPORT, PLANTED_REPORT } from "../fixtures/synthetic-source.ts";

const site = plantedSite(CLEAN_REPORT, PLANTED_REPORT);
const score = (answer: ScreenAnswer) => scoreAnswer(answer, "src/report.ts", site, PLANTED_REPORT, CLEAN_REPORT);
const at = (start: number, end: number, fixed = "  return 0;"): ScreenAnswer => ({ ...LOCATED_ONLY, start_line: start, end_line: end, fixed_code: fixed });

describe("scoreAnswer", () => {
  it("counts the planted line with the clean form as located and fixed", () => {
    expect(score(LOCATED_AND_FIXED)).toEqual({ outcome: "located_and_fixed", miss_kind: null });
  });

  it("ignores indentation and whitespace runs when comparing the fix with the clean file", () => {
    expect(score({ ...LOCATED_AND_FIXED, fixed_code: "return   formatTotal(total, rounding, currency);" }).outcome).toBe("located_and_fixed");
    expect(score({ ...LOCATED_AND_FIXED, file: "./src/report.ts" }).outcome).toBe("located_and_fixed");
  });

  it("counts a range near the site with another fix as located", () => {
    expect(score(LOCATED_ONLY)).toEqual({ outcome: "located", miss_kind: null });
  });

  it("accepts ranges within two lines of the site and no further", () => {
    expect(score(at(14, 14)).outcome).toBe("located");
    expect(score(at(10, 10)).outcome).toBe("located");
    expect(score(at(15, 15))).toEqual({ outcome: "miss", miss_kind: "other_lines" });
    expect(score(at(9, 9))).toEqual({ outcome: "miss", miss_kind: "other_lines" });
  });

  it("does not count a range wider than ten lines as locating the site", () => {
    expect(score(at(3, 12)).outcome).toBe("located");
    expect(score(at(2, 12))).toEqual({ outcome: "miss", miss_kind: "range_too_wide" });
  });

  it("counts a wide replacement that gives the clean file as fixed", () => {
    const lines = CLEAN_REPORT.split("\n");
    const fixed = lines.slice(1, 19).join("\n");
    expect(score({ ...LOCATED_AND_FIXED, start_line: 2, end_line: 19, fixed_code: fixed })).toEqual({ outcome: "fixed", miss_kind: null });
  });

  it("misses another file and a range outside the file", () => {
    expect(score(MISS)).toEqual({ outcome: "miss", miss_kind: "other_file" });
    expect(score(at(12, 400))).toEqual({ outcome: "miss", miss_kind: "invalid_range" });
    expect(score(at(0, 12))).toEqual({ outcome: "miss", miss_kind: "invalid_range" });
    expect(score(at(13, 12))).toEqual({ outcome: "miss", miss_kind: "invalid_range" });
  });

  it("applies a replacement by line", () => {
    expect(applyAnswer("a\nb\nc", { ...MISS, start_line: 2, end_line: 2, fixed_code: "B1\nB2" })).toBe("a\nB1\nB2\nc");
  });
});

describe("scoreAnswer with a mutation of two far-apart hunks", () => {
  const clean = Array.from({ length: 90 }, (_, i) => `const v${String(i + 1)} = ${String(i + 1)};`);
  const plantedLines = [...clean];
  plantedLines[9] = "const v10 = 0;";
  plantedLines[79] = "const v80 = 0;";
  const planted = plantedLines.join("\n");
  const twoHunks = plantedSite(clean.join("\n"), planted);
  const scoreTwo = (start: number, end: number) =>
    scoreAnswer({ ...LOCATED_ONLY, start_line: start, end_line: end, fixed_code: "const x = 1;" }, "src/report.ts", twoHunks, planted, clean.join("\n"));

  it("counts an answer between the hunks as a miss", () => {
    expect(scoreTwo(40, 45)).toEqual({ outcome: "miss", miss_kind: "other_lines" });
    expect(scoreTwo(13, 13)).toEqual({ outcome: "miss", miss_kind: "other_lines" });
  });

  it("counts an answer at either hunk, within the tolerance, as located", () => {
    expect(scoreTwo(10, 10).outcome).toBe("located");
    expect(scoreTwo(82, 82).outcome).toBe("located");
    expect(scoreTwo(8, 8).outcome).toBe("located");
  });

  it("calls a wide range that overlaps a hunk too wide", () => {
    expect(scoreTwo(5, 20)).toEqual({ outcome: "miss", miss_kind: "range_too_wide" });
  });
});

describe("verdictOf", () => {
  const outcomes = (...list: AttemptOutcome[]) => list;

  it("fails at the failing count of hits", () => {
    expect(verdictOf(outcomes("miss", "located"), 4, 1)).toBe("fail");
    expect(verdictOf(outcomes("miss", "located", "miss", "miss"), 4, 2)).toBe("pass");
    expect(verdictOf(outcomes("fixed", "located", "miss", "miss"), 4, 2)).toBe("fail");
  });

  it("passes only when every planned attempt was answered", () => {
    expect(verdictOf(outcomes("miss", "miss", "miss", "miss"), 4, 1)).toBe("pass");
    expect(verdictOf(outcomes("miss", "no_answer", "miss", "miss"), 4, 1)).toBe("inconclusive");
    expect(verdictOf(outcomes("miss", "miss"), 4, 1)).toBe("inconclusive");
  });

  it("treats every located or fixed outcome as a hit", () => {
    expect(["located_and_fixed", "located", "fixed", "miss", "no_answer"].map((o) => isHit(o as AttemptOutcome))).toEqual([true, true, true, false, false]);
  });
});
