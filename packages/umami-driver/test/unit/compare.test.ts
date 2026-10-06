import { describe, expect, it } from "vitest";
import { compareSuiteRun } from "../../src/compare.ts";
import type { SuiteTest } from "../../src/manifest.ts";
import { parsePlaywrightReport } from "../../src/playwright-report.ts";
import { CANNED_TESTS, playwrightReport } from "../helpers.ts";
import type { CannedTest } from "../helpers.ts";

const MANIFEST_TESTS: SuiteTest[] = CANNED_TESTS.map((test) => ({
  id: test.id,
  file: `tests/api/${test.file}`,
  title_path: [...(test.describe ?? []), test.title],
})).sort((a, b) => a.id.localeCompare(b.id));

function run(tests: CannedTest[], errors: string[] = []) {
  return compareSuiteRun(MANIFEST_TESTS, parsePlaywrightReport(playwrightReport(tests, errors), "tests/api/"));
}

const allPassed = CANNED_TESTS.map((test) => ({ ...test, result: "passed" as const }));

describe("comparing a suite run with the frozen manifest", () => {
  it("gives no reason when every manifest test ran", () => {
    const comparison = run(allPassed);
    expect(comparison.reason).toBeNull();
    expect(comparison.missing).toEqual([]);
    expect(comparison.skipped).toEqual([]);
    expect(comparison.outcomes.map((outcome) => outcome.outcome)).toEqual(Array(5).fill("passed"));
  });

  it("gives test_missing with the IDs of a spec file whose tests are absent", () => {
    const comparison = run(allPassed.filter((test) => test.file !== "beta.spec.ts"));
    expect(comparison.reason).toBe("test_missing");
    expect(comparison.missing).toEqual(["synthetic0002-bbbb0001", "synthetic0002-bbbb0002", "synthetic0002-bbbb0003"]);
    expect(comparison.outcomes.filter((outcome) => outcome.outcome === "not_executed")).toHaveLength(3);
  });

  it("gives test_skipped for an unexpected skip", () => {
    const comparison = run(allPassed.map((test, index) => (index === 1 ? { ...test, result: "skipped" as const } : test)));
    expect(comparison.reason).toBe("test_skipped");
    expect(comparison.skipped).toEqual(["synthetic0001-aaaa0002"]);
  });

  it("prefers test_missing over test_skipped when both happen", () => {
    const tests = allPassed.slice(1).map((test, index) => (index === 0 ? { ...test, result: "skipped" as const } : test));
    expect(run(tests).reason).toBe("test_missing");
  });

  it("records an original-test failure as failed evidence without a reason, so the trial can be complete", () => {
    const comparison = run(
      allPassed.map((test, index) => (index === 3 ? { ...test, result: "failed" as const, duration: 40 } : test)),
    );
    expect(comparison.reason).toBeNull();
    expect(comparison.outcomes.find((outcome) => outcome.id === "synthetic0002-bbbb0002")).toEqual({
      id: "synthetic0002-bbbb0002",
      file: "tests/api/beta.spec.ts",
      title_path: ["Beta", "migration", "retention report migrates"],
      outcome: "failed",
      duration_ms: 40,
    });
  });

  it("counts a timed-out test as failed and an interrupted one as not executed", () => {
    const comparison = run(
      allPassed.map((test, index) =>
        index === 0 ? { ...test, result: "timedOut" as const } : index === 1 ? { ...test, result: "interrupted" as const } : test,
      ),
    );
    expect(comparison.outcomes[0]?.outcome).toBe("failed");
    expect(comparison.outcomes[1]?.outcome).toBe("not_executed");
    expect(comparison.reason).toBe("test_missing");
    expect(comparison.missing).toEqual(["synthetic0001-aaaa0002"]);
  });

  it("lists report tests that the manifest does not know, without counting them as manifest tests", () => {
    const comparison = run([...allPassed, { id: "synthetic9999-ffff0001", file: "alpha.spec.ts", title: "extra", result: "passed" }]);
    expect(comparison.unlisted).toEqual(["synthetic9999-ffff0001"]);
    expect(comparison.outcomes).toHaveLength(5);
  });

  it("gives seed_failed when the report has errors and no test produced a result (global setup failed)", () => {
    const comparison = run(
      CANNED_TESTS.map((test) => ({ ...test })),
      ["Error: global setup failed"],
    );
    expect(comparison.reason).toBe("seed_failed");
  });

  it("never reads a missing test as passed", () => {
    const comparison = run([]);
    expect(comparison.reason).toBe("test_missing");
    expect(comparison.outcomes.every((outcome) => outcome.outcome === "not_executed")).toBe(true);
  });
});

describe("parsing a Playwright JSON report", () => {
  it("refuses a report that is not a Playwright JSON report", () => {
    expect(() => parsePlaywrightReport("{}", "")).toThrow(/suites/);
    expect(() => parsePlaywrightReport("not json", "")).toThrow(/JSON/);
  });

  it("refuses a spec with more than one project result, which the single-project suite never produces", () => {
    const report = JSON.parse(playwrightReport([{ id: "x-1", file: "a.spec.ts", title: "t", result: "passed" }])) as {
      suites: { specs: { tests: unknown[] }[] }[];
    };
    const spec = report.suites[0]?.specs[0];
    if (spec === undefined) throw new Error("canned report has no spec");
    spec.tests.push(spec.tests[0]);
    expect(() => parsePlaywrightReport(JSON.stringify(report), "")).toThrow(/one test/);
  });
});
