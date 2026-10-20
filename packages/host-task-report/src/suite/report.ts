// Reads Playwright's JSON report into one entry per test, compares a run with the expected tests
// by ID, and strips a report down to structure before it is kept as evidence. Ported from the
// custom host harness at baseline 2, which ported it from this repository's umami-driver. Only
// the structure is read: test IDs, titles, statuses and durations, never error text or output.
import { posix } from "node:path";

export const TEST_STATUSES = ["expected", "unexpected", "flaky", "skipped"] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const RESULT_STATUSES = ["passed", "failed", "timedOut", "skipped", "interrupted"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export interface ReportedTest {
  id: string;
  /** The spec file relative to the suite root (the directory holding playwright.config.ts). */
  file: string;
  title_path: string[];
  status: TestStatus;
  expected_status: string | null;
  /** The status of the last result, or null when the test has no result. */
  result: ResultStatus | null;
  duration_ms: number;
}

export interface ParsedReport {
  tests: ReportedTest[];
  /** Top-level errors, such as a config or global setup failure. Counted, never read. */
  error_count: number;
}

export interface SuiteTest {
  id: string;
  file: string;
  title_path: string[];
}

export class ReportError extends Error {
  override name = "ReportError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown, path: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ReportError(`${path} must be an array`);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ReportError(`${path} must be a string`);
  return value;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function readSpec(spec: unknown, titles: string[], filePrefix: string, path: string): ReportedTest {
  if (!isRecord(spec)) throw new ReportError(`${path} must be an object`);
  const tests = list(spec.tests, `${path}.tests`);
  if (tests.length !== 1) throw new ReportError(`${path} must have exactly one test (the suite has one project), found ${String(tests.length)}`);
  const test = tests[0];
  if (!isRecord(test)) throw new ReportError(`${path}.tests[0] must be an object`);
  const status = test.status;
  if (!isOneOf(TEST_STATUSES, status)) throw new ReportError(`${path}.tests[0].status is not a Playwright test status`);
  const results = list(test.results, `${path}.tests[0].results`);
  const last = results.at(-1);
  let result: ResultStatus | null = null;
  let duration = 0;
  if (last !== undefined) {
    if (!isRecord(last) || !isOneOf(RESULT_STATUSES, last.status)) {
      throw new ReportError(`${path}.tests[0].results has a result without a Playwright result status`);
    }
    result = last.status;
    duration = typeof last.duration === "number" && Number.isFinite(last.duration) ? Math.max(0, Math.round(last.duration)) : 0;
  }
  return {
    id: text(spec.id, `${path}.id`),
    file: `${filePrefix}${text(spec.file, `${path}.file`)}`,
    title_path: [...titles, text(spec.title, `${path}.title`)],
    status,
    expected_status: typeof test.expectedStatus === "string" ? test.expectedStatus : null,
    result,
    duration_ms: duration,
  };
}

function walk(suite: unknown, titles: string[], filePrefix: string, path: string, out: ReportedTest[], depth: number): void {
  if (!isRecord(suite)) throw new ReportError(`${path} must be an object`);
  // The outermost suite of each file is titled with the file name, which `file` already carries.
  const inner = depth === 0 ? titles : [...titles, text(suite.title, `${path}.title`)];
  list(suite.specs, `${path}.specs`).forEach((spec, index) => {
    out.push(readSpec(spec, inner, filePrefix, `${path}.specs[${String(index)}]`));
  });
  list(suite.suites, `${path}.suites`).forEach((child, index) => {
    walk(child, inner, filePrefix, `${path}.suites[${String(index)}]`, out, depth + 1);
  });
}

/** The prefix that makes a spec's `file` relative to the suite root, read from the report's rootDir. */
export function reportFilePrefix(data: Record<string, unknown>, suiteDir: string): string {
  const config = data.config;
  if (!isRecord(config) || typeof config.rootDir !== "string" || !posix.isAbsolute(config.rootDir)) return "";
  const relative = posix.relative(suiteDir, config.rootDir);
  if (relative === "") return "";
  if (relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) throw new ReportError("the report's rootDir is outside the suite directory");
  return `${relative}/`;
}

export function parseReportValue(data: unknown, suiteDir: string): ParsedReport {
  if (!isRecord(data) || !Array.isArray(data.suites)) throw new ReportError("report has no suites array");
  const prefix = reportFilePrefix(data, suiteDir);
  const tests: ReportedTest[] = [];
  data.suites.forEach((suite, index) => {
    walk(suite, [], prefix, `suites[${String(index)}]`, tests, 0);
  });
  return { tests, error_count: list(data.errors, "errors").length };
}

export type TestOutcomeValue = "passed" | "failed" | "skipped" | "not_executed";

export interface TestOutcome {
  id: string;
  outcome: TestOutcomeValue;
  duration_ms: number;
}

export type SuiteVerdict = "passed" | "failed" | "invalid";

export interface SuiteComparison {
  tests_expected: number;
  passed: number;
  failed: string[];
  skipped: string[];
  /** Expected tests absent from the report, interrupted, or never given a result. */
  missing: string[];
  /** Report tests that are not expected; recorded, never counted. */
  unlisted: string[];
  error_count: number;
  outcomes: TestOutcome[];
  verdict: SuiteVerdict;
  invalid_code: "original_test_missing" | null;
}

/**
 * A test that ran counts as passed only when Playwright's own test status is `expected`, so a
 * flaky test or a `test.fail()` test that passed counts as failed.
 */
function outcomeOf(test: ReportedTest | undefined): TestOutcomeValue {
  if (test === undefined) return "not_executed";
  switch (test.result) {
    case "passed":
    case "failed":
    case "timedOut":
      return test.status === "expected" ? "passed" : "failed";
    case "skipped":
      return "skipped";
    case "interrupted":
    case null:
      return test.status === "skipped" ? "skipped" : "not_executed";
  }
}

/**
 * Compares one run with the expected tests by ID. A missing, skipped or interrupted expected test,
 * or no usable report (`report` null), makes the run invalid; otherwise the verdict is failed when
 * any expected test failed, else passed.
 */
export function compareSuiteRun(expected: readonly SuiteTest[], report: ParsedReport | null): SuiteComparison {
  const reported = new Map((report?.tests ?? []).map((test) => [test.id, test]));
  const outcomes = expected.map((test) => {
    const found = reported.get(test.id);
    return { id: test.id, outcome: outcomeOf(found), duration_ms: found?.duration_ms ?? 0 };
  });
  const known = new Set(expected.map((test) => test.id));
  const ids = (value: TestOutcomeValue): string[] => outcomes.filter((item) => item.outcome === value).map((item) => item.id);
  const missing = ids("not_executed");
  const skipped = ids("skipped");
  const failed = ids("failed");
  const unlisted = (report?.tests ?? []).filter((test) => !known.has(test.id)).map((test) => test.id).sort();
  const invalid = report === null || expected.length === 0 || missing.length > 0 || skipped.length > 0;
  return {
    tests_expected: expected.length,
    passed: ids("passed").length,
    failed,
    skipped,
    missing,
    unlisted,
    error_count: report?.error_count ?? 0,
    outcomes,
    verdict: invalid ? "invalid" : failed.length > 0 ? "failed" : "passed",
    invalid_code: invalid ? "original_test_missing" : null,
  };
}

const EMPTIED = new Set(["stdout", "stderr", "attachments"]);

function stripValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripValue);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    let kept: unknown;
    if (key === "error" && isRecord(item)) kept = {};
    else if (key === "errors" && Array.isArray(item)) kept = item.map(() => ({}));
    else if (EMPTIED.has(key) && Array.isArray(item)) kept = [];
    else kept = stripValue(item);
    // defineProperty keeps a "__proto__" key as data instead of changing the prototype.
    Object.defineProperty(out, key, { value: kept, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** The report with every error object emptied and every stdout, stderr and attachments array cleared. */
export function stripReport(value: unknown): unknown {
  return stripValue(value);
}
