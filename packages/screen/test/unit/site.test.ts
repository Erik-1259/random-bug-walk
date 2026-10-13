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

  it("spans every changed line when the mutation has two hunks", () => {
    const clean = ["a", "b", "c", "d", "e", "f"].join("\n");
    const planted = ["a", "B", "c", "d", "E", "f"].join("\n");
    const site = plantedSite(clean, planted);
    expect([site.start_line, site.end_line]).toEqual([2, 5]);
    expect(site.clean_lines).toEqual(["b", "c", "d", "e"]);
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
