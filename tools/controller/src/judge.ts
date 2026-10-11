// The judge path (design note section 6): everything the judge routes use (judge-web.ts), and the
// replay's verdict, with the Dec 2–5 known condition, which only the judge controller computes.
import type { Evidence } from "@rbw/admission";
import { revenueKnownLimit } from "@rbw/local-runner";
import { JUDGE_TRIALS } from "./judge-web.ts";

export * from "./judge-web.ts";

/** The two upstream revenue tests of the driver's known limit (packages/umami-driver README, Known limits). */
const REVENUE_FILE = "tests/api/revenue.spec.ts";
const REVENUE_TITLES = ["/revenue/sessions lists sessions with revenue", "/revenue/stats returns revenue totals"];

export interface SuiteTests {
  tests: readonly { id: string; file: string; title_path: readonly string[] }[];
}

/** The IDs of the two revenue tests, from the frozen suite manifest. */
export function revenueTestIds(suite: SuiteTests): string[] {
  return suite.tests
    .filter((test) => test.file === REVENUE_FILE && REVENUE_TITLES.some((title) => (test.title_path.at(-1) ?? "").endsWith(title)))
    .map((test) => test.id)
    .sort();
}

/**
 * Whether the replay reproduced the release: every one of the six cells as expected, for the
 * released task revision. On the 2nd to the 5th of a month (UTC), original-suite cells whose failures
 * are exactly the two revenue tests, both of them, are the known condition: the replay is verified with
 * known_condition set. Anything else unexpected is not_reproduced.
 */
export function replayVerdict(evidence: Evidence, release: { task_revision: string }, runDateMs: number, suite: SuiteTests): { state: "verified" | "not_reproduced"; known_condition: boolean } {
  const cells = evidence.cells ?? [];
  const sixCells = JUDGE_TRIALS.every((trial) => ["original", "added"].every((suiteName) => cells.some((cell) => cell.trial_id === trial && cell.suite === suiteName)));
  if (evidence.request.task_revision !== release.task_revision || !sixCells) return { state: "not_reproduced", known_condition: false };
  const unexpected = cells.filter((cell) => !cell.matches_expectation);
  if (unexpected.length === 0) return { state: "verified", known_condition: false };
  const revenue = new Set(revenueTestIds(suite));
  const known =
    revenueKnownLimit(runDateMs).applies &&
    revenue.size === 2 &&
    unexpected.every((cell) => cell.suite === "original" && cell.state === "fail" && cell.executed_count === cell.expected_count && cell.failing.length === revenue.size && cell.failing.every((item) => revenue.has(item.id)));
  return known ? { state: "verified", known_condition: true } : { state: "not_reproduced", known_condition: false };
}
