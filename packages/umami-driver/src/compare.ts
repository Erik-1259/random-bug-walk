// Compares one run's JSON report with the frozen manifest. Every manifest test must execute: a
// test absent from the report is missing, never passed, and a skip is never an outcome.
import type { TrialReason } from "@rbw/schema";
import type { SuiteTest } from "./manifest.ts";
import type { ParsedReport, ReportedTest } from "./playwright-report.ts";

export type TestOutcomeValue = "passed" | "failed" | "skipped" | "not_executed";

export interface TestOutcome {
  id: string;
  file: string;
  title_path: string[];
  outcome: TestOutcomeValue;
  duration_ms: number;
}

export interface SuiteComparison {
  /** One outcome per manifest test, in manifest order. */
  outcomes: TestOutcome[];
  /** Manifest tests absent from the report, or interrupted before they finished. */
  missing: string[];
  /** Manifest tests the report shows as skipped. */
  skipped: string[];
  /** Report tests that are not in the manifest; they never count as manifest tests. */
  unlisted: string[];
  reason: TrialReason | null;
}

function outcomeOf(test: ReportedTest | undefined): TestOutcomeValue {
  if (test === undefined) return "not_executed";
  switch (test.result) {
    case "passed":
      return "passed";
    case "failed":
    case "timedOut":
      return "failed";
    case "skipped":
      return "skipped";
    case "interrupted":
    case null:
      return test.status === "skipped" ? "skipped" : "not_executed";
  }
}

export function compareSuiteRun(manifestTests: readonly SuiteTest[], report: ParsedReport): SuiteComparison {
  const byId = new Map(report.tests.map((test) => [test.id, test]));
  const outcomes = manifestTests.map((test) => {
    const reported = byId.get(test.id);
    return {
      id: test.id,
      file: test.file,
      title_path: [...test.title_path],
      outcome: outcomeOf(reported),
      duration_ms: reported?.duration_ms ?? 0,
    };
  });
  const known = new Set(manifestTests.map((test) => test.id));
  const missing = outcomes.filter((outcome) => outcome.outcome === "not_executed").map((outcome) => outcome.id);
  const skipped = outcomes.filter((outcome) => outcome.outcome === "skipped").map((outcome) => outcome.id);
  const unlisted = report.tests.filter((test) => !known.has(test.id)).map((test) => test.id);
  // Global setup (heartbeat, OpenAPI fetch, seeding) failing leaves every test without a result.
  const nothingRan = report.tests.every((test) => test.result === null);
  let reason: TrialReason | null = null;
  if (report.error_count > 0 && nothingRan && manifestTests.length > 0) {
    reason = "seed_failed";
  } else if (missing.length > 0) {
    reason = "test_missing";
  } else if (skipped.length > 0) {
    reason = "test_skipped";
  }
  return { outcomes, missing, skipped, unlisted, reason };
}
