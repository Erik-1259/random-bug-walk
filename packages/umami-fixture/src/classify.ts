import { loadFixture, type FailureCode, type FixtureCheck, type Observed } from "./fixture.ts";
import type { HttpResult } from "./http.ts";
import { isRecord, parseJsonBody } from "./json.ts";

export interface Classification {
  observed: Observed;
  failure_code: FailureCode | null;
  /** Human-readable summary for the assertion message: statuses, labels and counts only. */
  detail: string;
}

function invalid(detail: string): Classification {
  return { observed: "setup_fail", failure_code: "unrelated_failure", detail };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Grades one pageviews response for one check, in this order:
 * 1. invalid (setup_fail, unrelated_failure): not HTTP 200, a body that is not JSON, a missing or
 *    non-array pageviews, a missing sessions property, or an item whose y is not a nonnegative
 *    integer of number type. Strings are never coerced.
 * 2. bucket_labels_mismatch: the labels are not exactly the fixture's bucket labels, in order.
 * 3. local_day_counts_mismatch: the labels are right but a count differs.
 * 4. pass.
 * Sessions must be present but their counts are not graded.
 */
export function classify(response: HttpResult, check: FixtureCheck, bucketLabels: readonly string[] = loadFixture().bucket_labels): Classification {
  if (response.status !== 200) {
    return invalid(`HTTP ${String(response.status)}`);
  }
  const parsed = parseJsonBody(response.body);
  if (!parsed.ok) {
    return invalid(parsed.reason);
  }
  const body = parsed.value;
  if (!isRecord(body)) {
    return invalid("body is not a JSON object");
  }
  const pageviews = body.pageviews;
  if (!Array.isArray(pageviews)) {
    return invalid("pageviews is missing or not an array");
  }
  if (!("sessions" in body)) {
    return invalid("sessions is missing");
  }
  const labels: unknown[] = [];
  const counts: number[] = [];
  for (const item of pageviews as unknown[]) {
    if (!isRecord(item) || !isCount(item.y)) {
      return invalid("a pageviews item has no nonnegative integer y");
    }
    labels.push(item.x);
    counts.push(item.y);
  }
  const observed = `labels ${JSON.stringify(labels)} counts ${JSON.stringify(counts)}`;
  const labelsMatch = labels.length === bucketLabels.length && labels.every((label, index) => label === bucketLabels[index]);
  if (!labelsMatch) {
    return { observed: "assertion_fail", failure_code: "bucket_labels_mismatch", detail: `${observed}; expected labels ${JSON.stringify(bucketLabels)}` };
  }
  const countsMatch = counts.length === check.expected.length && counts.every((count, index) => count === check.expected[index]);
  if (!countsMatch) {
    return { observed: "assertion_fail", failure_code: "local_day_counts_mismatch", detail: `${observed}; expected counts ${JSON.stringify(check.expected)}` };
  }
  return { observed: "pass", failure_code: null, detail: observed };
}
