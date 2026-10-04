import { describe, expect, it } from "vitest";
import { branchName, isCiBranchName } from "../src/naming.ts";

describe("branchName", () => {
  it("builds the per-run name", () => {
    expect(branchName("12", "9876543210", "1")).toBe("ci-pr-12-9876543210-1");
    expect(branchName("12", "9876543210", "2")).toBe("ci-pr-12-9876543210-2");
  });

  it("keeps run IDs longer than 15 digits exactly", () => {
    expect(branchName("5", "12345678901234567890123", "3")).toBe("ci-pr-5-12345678901234567890123-3");
  });

  it.each(["0", "012", "12a", "", "-4", " 1", "1.0", "1e3"])("rejects the invalid pull request number %j", (pr) => {
    expect(() => branchName(pr, "9876543210", "1")).toThrow(/pr/);
  });

  it("rejects invalid run IDs and attempts", () => {
    expect(() => branchName("1", "0", "1")).toThrow(/runId/);
    expect(() => branchName("1", "7", "01")).toThrow(/runAttempt/);
  });
});

describe("isCiBranchName", () => {
  it("matches only the exact CI pattern", () => {
    expect(isCiBranchName("ci-pr-7-100-1")).toBe(true);
    for (const name of ["ci-keep", "ci-pr-7-100", "ci-pr-7-100-1-2", "ci-pr-0-1-1", "xci-pr-7-100-1", "ci-pr-7-100-1\n", "main"]) {
      expect(isCiBranchName(name)).toBe(false);
    }
  });
});
