// Compares executed test counts per suite with the committed floors.
// Exit codes: 0 every listed suite met its floor, 1 a suite is below its floor, missing or
// unfloored, 2 the floor file or a report is missing, unreadable or malformed.
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { isEntryPoint, runMain } from "./main.ts";

export const RUNNERS = ["vitest", "pytest"] as const;
export type Runner = (typeof RUNNERS)[number];
export type Counts = Map<string, number>;
export type Floors = Record<Runner, Counts>;

export class CannotRun extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A floor key is "." or one or two directory levels without "." or ".." segments. */
export function isSuiteKey(key: string): boolean {
  if (key === ".") {
    return true;
  }
  const segments = key.split("/");
  return segments.length <= 2 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function parseFloors(text: string): Floors {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CannotRun("floor file is not valid JSON");
  }
  if (!isRecord(data)) {
    throw new CannotRun("floor file must be a JSON object");
  }
  const keys = Object.keys(data).sort();
  if (keys.join(",") !== [...RUNNERS].sort().join(",")) {
    throw new CannotRun(`floor file must have exactly the keys ${RUNNERS.join(" and ")}`);
  }
  const floors: Floors = { vitest: new Map(), pytest: new Map() };
  for (const runner of RUNNERS) {
    const entries = data[runner];
    if (!isRecord(entries)) {
      throw new CannotRun(`floors for ${runner} must be an object`);
    }
    for (const [suite, floor] of Object.entries(entries)) {
      if (!isSuiteKey(suite)) {
        throw new CannotRun(`floor key ${JSON.stringify(suite)} under ${runner} is not a suite`);
      }
      if (typeof floor !== "number" || !Number.isInteger(floor) || floor < 1) {
        throw new CannotRun(`floor for ${runner} ${suite} must be an integer of at least 1`);
      }
      floors[runner].set(suite, floor);
    }
  }
  return floors;
}

/** Maps a test file to its suite: its repository-relative directory, cut to two levels. */
export function suiteOf(root: string, file: string): string {
  const relativePath = relative(root, resolve(root, file));
  if (relativePath === "" || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new CannotRun("a reported test file does not resolve inside the repository");
  }
  const directories = relativePath.split(sep).slice(0, -1);
  return directories.length === 0 ? "." : directories.slice(0, 2).join("/");
}

function readReport(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new CannotRun(`report ${path} is unreadable`);
  }
}

function increment(counts: Counts, suite: string): void {
  counts.set(suite, (counts.get(suite) ?? 0) + 1);
}

/** Counts Vitest assertion results that passed or failed; skipped, pending, todo and disabled are not executed. */
export function countVitest(root: string, text: string): Counts {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CannotRun("Vitest report is not valid JSON");
  }
  if (!isRecord(data) || !Array.isArray(data.testResults)) {
    throw new CannotRun("Vitest report has no testResults array");
  }
  const counts: Counts = new Map();
  for (const fileResult of data.testResults as unknown[]) {
    if (!isRecord(fileResult) || typeof fileResult.name !== "string" || !Array.isArray(fileResult.assertionResults)) {
      throw new CannotRun("Vitest report has a malformed file result");
    }
    const suite = suiteOf(root, fileResult.name);
    for (const assertion of fileResult.assertionResults as unknown[]) {
      if (!isRecord(assertion) || typeof assertion.status !== "string") {
        throw new CannotRun("Vitest report has an assertion result without a status");
      }
      if (assertion.status === "passed" || assertion.status === "failed") {
        increment(counts, suite);
      }
    }
  }
  return counts;
}

/**
 * Counts pytest tests whose call phase finished passed or failed, once per test ID.
 * Setup skips have no call phase; expected failures carry "wasxfail"; reruns repeat the ID.
 */
export function countPytest(root: string, text: string): Counts {
  const executed = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new CannotRun("pytest report has a line that is not valid JSON");
    }
    if (!isRecord(record) || typeof record.$report_type !== "string") {
      throw new CannotRun("pytest report has a malformed record");
    }
    if (record.$report_type !== "TestReport") {
      continue;
    }
    if (typeof record.nodeid !== "string" || typeof record.when !== "string" || typeof record.outcome !== "string") {
      throw new CannotRun("pytest report has a test report without nodeid, when or outcome");
    }
    if (record.when === "call" && (record.outcome === "passed" || record.outcome === "failed") && !("wasxfail" in record)) {
      executed.add(record.nodeid);
    }
  }
  const counts: Counts = new Map();
  for (const nodeid of executed) {
    increment(counts, suiteOf(root, nodeid.split("::")[0] ?? nodeid));
  }
  return counts;
}

export interface SuiteResult {
  runner: Runner;
  suite: string;
  executed: number;
  floor: number | undefined;
  status: "ok" | "below floor" | "missing" | "unfloored";
}

export function evaluate(floors: Floors, executed: Record<Runner, Counts>): SuiteResult[] {
  const results: SuiteResult[] = [];
  for (const runner of RUNNERS) {
    const suites = new Set([...floors[runner].keys(), ...executed[runner].keys()]);
    for (const suite of [...suites].sort()) {
      const floor = floors[runner].get(suite);
      const count = executed[runner].get(suite) ?? 0;
      let status: SuiteResult["status"];
      if (floor === undefined) {
        status = "unfloored";
      } else if (count === 0) {
        status = "missing";
      } else if (count < floor) {
        status = "below floor";
      } else {
        status = "ok";
      }
      results.push({ runner, suite, executed: count, floor, status });
    }
  }
  return results;
}

export function formatResult(result: SuiteResult): string {
  const head = `${result.runner} ${result.suite}: executed ${String(result.executed)}, floor ${result.floor === undefined ? "none" : String(result.floor)}`;
  if (result.status === "unfloored") {
    return `${head}, unfloored; add ${JSON.stringify(result.suite)}: ${String(result.executed)} under ${JSON.stringify(result.runner)}`;
  }
  return `${head}, ${result.status}`;
}

function main(): number {
  const { values } = parseArgs({
    options: {
      floors: { type: "string" },
      vitest: { type: "string" },
      pytest: { type: "string" },
      root: { type: "string", default: "." },
    },
  });
  if (values.floors === undefined) {
    throw new CannotRun("--floors is required");
  }
  const root = resolve(values.root);
  let floorText: string;
  try {
    floorText = readFileSync(values.floors, "utf8");
  } catch {
    throw new CannotRun(`floor file ${values.floors} is missing or unreadable`);
  }
  const floors = parseFloors(floorText);
  const vitestText = readReport(values.vitest);
  const pytestText = readReport(values.pytest);
  const executed: Record<Runner, Counts> = {
    vitest: vitestText === undefined ? new Map<string, number>() : countVitest(root, vitestText),
    pytest: pytestText === undefined ? new Map<string, number>() : countPytest(root, pytestText),
  };
  const results = evaluate(floors, executed);
  for (const result of results) {
    process.stdout.write(`${formatResult(result)}\n`);
  }
  const failed = results.some((result) => result.status !== "ok");
  process.stdout.write(`test floors: ${failed ? "failed" : "ok"}\n`);
  return failed ? 1 : 0;
}

if (isEntryPoint(import.meta)) {
  runMain("test floors", main);
}
