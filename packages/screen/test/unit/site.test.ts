import { describe, expect, it } from "vitest";
import { plantedSite } from "../../src/site.ts";
import { CLEAN_REPORT, PLANTED_REPORT } from "../fixtures/synthetic-source.ts";

describe("plantedSite", () => {
  it("finds a one-line mutation, its clean form and its hunk", () => {
    const site = plantedSite(CLEAN_REPORT, PLANTED_REPORT);
    expect(site.start_line).toBe(12);
    expect(site.end_line).toBe(12);
    expect(site.planted_lines).toEqual(["  return formatTotal(total, rounding);"]);
    expect(site.clean_lines).toEqual(["  return formatTotal(total, rounding, currency);"]);
    expect(site.mutation).toBe(
      [
        "@@ -9,7 +9,7 @@",
        " export function buildReport(rows: number[], filters: ReportFilters): string {",
        '   const { currency = "usd", rounding = 2 } = filters;',
        "   const total = rows.reduce((sum, row) => sum + row, 0);",
        "-  return formatTotal(total, rounding, currency);",
        "+  return formatTotal(total, rounding);",
        " }",
        " ",
        " export function buildSummary(rows: number[], filters: ReportFilters): string {",
        "",
      ].join("\n"),
    );
  });

  it("finds one hunk per changed region and keeps the span of all of them", () => {
    const clean = ["a", "b", "c", "d", "e", "f"].join("\n");
    const planted = ["a", "B", "c", "d", "E", "f"].join("\n");
    const site = plantedSite(clean, planted);
    expect([site.start_line, site.end_line]).toEqual([2, 5]);
    expect(site.hunks.map((hunk) => [hunk.start_line, hunk.end_line, hunk.clean_lines, hunk.planted_lines])).toEqual([
      [2, 2, ["b"], ["B"]],
      [5, 5, ["e"], ["E"]],
    ]);
    expect(site.mutation).toBe(["@@ -1,6 +1,6 @@", " a", "-b", "+B", " c", " d", "-e", "+E", " f", ""].join("\n"));
  });

  it("writes far-apart hunks as separate sections with line numbers shifted by earlier hunks", () => {
    const clean = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1)}`);
    const planted = [...clean];
    planted.splice(4, 1, "new 5a", "new 5b");
    planted[30] = "changed 30";
    const site = plantedSite(clean.join("\n"), planted.join("\n"));
    expect(site.hunks.map((hunk) => [hunk.start_line, hunk.end_line])).toEqual([
      [5, 6],
      [31, 31],
    ]);
    expect(site.mutation.split("\n").filter((line) => line.startsWith("@@"))).toEqual(["@@ -2,7 +2,8 @@", "@@ -27,7 +28,7 @@"]);
  });

  it("takes the lines on both sides of a deletion inside a multi-hunk mutation", () => {
    const clean = ["a", "b", "guard", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const planted = ["a", "b", "c", "d", "e", "f", "g", "h", "I", "j"].join("\n");
    const site = plantedSite(clean, planted);
    expect(site.hunks.map((hunk) => [hunk.start_line, hunk.end_line, hunk.planted_lines])).toEqual([
      [2, 3, []],
      [9, 9, ["I"]],
    ]);
  });

  it("takes the lines on both sides of a pure deletion as the site", () => {
    const clean = ["a", "b", "guard", "c", "d"].join("\n");
    const planted = ["a", "b", "c", "d"].join("\n");
    const site = plantedSite(clean, planted);
    expect([site.start_line, site.end_line]).toEqual([2, 3]);
    expect(site.planted_lines).toEqual([]);
    expect(site.clean_lines).toEqual(["guard"]);
    expect(site.mutation).toContain("-guard");
  });

  it("refuses identical files", () => {
    expect(() => plantedSite(CLEAN_REPORT, CLEAN_REPORT)).toThrow(/identical/);
  });
});
