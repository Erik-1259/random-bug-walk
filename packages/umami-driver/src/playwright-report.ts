// Reads Playwright's JSON report (the `json` reporter's output) into one entry per test. Only the
// structure is read: test IDs, titles, statuses and durations. Log text is never evidence.

export const TEST_STATUSES = ["expected", "unexpected", "flaky", "skipped"] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const RESULT_STATUSES = ["passed", "failed", "timedOut", "skipped", "interrupted"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export interface ReportedTest {
  /** Playwright's test ID, which is derived from the file path relative to the config, the titles and the project. */
  id: string;
  file: string;
  /** Describe titles from the outermost inwards, then the test's own title; the file name is not included. */
  title_path: string[];
  status: TestStatus;
  /** The status of the last result, or null when the test has no result (listed but never run). */
  result: ResultStatus | null;
  duration_ms: number;
}

export interface ParsedReport {
  tests: ReportedTest[];
  /** Top-level errors, such as a global setup failure or a reporter error. */
  error_count: number;
}

export class ReportError extends Error {}

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

function readSpec(spec: unknown, titles: string[], filePrefix: string, path: string): ReportedTest {
  if (!isRecord(spec)) throw new ReportError(`${path} must be an object`);
  const tests = list(spec.tests, `${path}.tests`);
  if (tests.length !== 1) {
    throw new ReportError(`${path} must have exactly one test (the suite has one project), found ${String(tests.length)}`);
  }
  const test = tests[0];
  if (!isRecord(test)) throw new ReportError(`${path}.tests[0] must be an object`);
  const status = test.status;
  if (typeof status !== "string" || !(TEST_STATUSES as readonly string[]).includes(status)) {
    throw new ReportError(`${path}.tests[0].status is not a Playwright test status`);
  }
  const results = list(test.results, `${path}.tests[0].results`);
  const last = results.at(-1);
  let result: ResultStatus | null = null;
  let duration = 0;
  if (last !== undefined) {
    if (!isRecord(last) || typeof last.status !== "string" || !(RESULT_STATUSES as readonly string[]).includes(last.status)) {
      throw new ReportError(`${path}.tests[0].results has a result without a Playwright result status`);
    }
    result = last.status as ResultStatus;
    duration = typeof last.duration === "number" && Number.isFinite(last.duration) ? Math.max(0, Math.round(last.duration)) : 0;
  }
  return {
    id: text(spec.id, `${path}.id`),
    file: `${filePrefix}${text(spec.file, `${path}.file`)}`,
    title_path: [...titles, text(spec.title, `${path}.title`)],
    status: status as TestStatus,
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

/**
 * Parses a JSON report. `filePrefix` is prepended to each spec file, which Playwright reports
 * relative to the config's testDir (for the original suite, "tests/api/").
 */
export function parsePlaywrightReport(source: string, filePrefix: string): ParsedReport {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    throw new ReportError("report is not valid JSON");
  }
  if (!isRecord(data) || !Array.isArray(data.suites)) throw new ReportError("report has no suites array");
  const tests: ReportedTest[] = [];
  data.suites.forEach((suite, index) => {
    walk(suite, [], filePrefix, `suites[${String(index)}]`, tests, 0);
  });
  return { tests, error_count: list(data.errors, "errors").length };
}
