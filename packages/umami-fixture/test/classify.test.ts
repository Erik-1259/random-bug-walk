import { describe, expect, it } from "vitest";
import { classify, loadFixture, type FixtureCheck } from "../src/index.ts";

const fixture = loadFixture();
const [utc, la, auckland, kolkata] = fixture.checks as [FixtureCheck, FixtureCheck, FixtureCheck, FixtureCheck];
const labels = fixture.bucket_labels;

function response(status: number, body: unknown): { status: number; body: Uint8Array } {
  return { status, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) };
}

function stats(points: unknown[]): unknown {
  return { pageviews: points, sessions: points };
}

function series(counts: readonly number[], at: readonly string[] = labels): { x: unknown; y: unknown }[] {
  return at.map((x, index) => ({ x, y: counts[index] }));
}

const INVALID = { observed: "setup_fail", failure_code: "unrelated_failure" };
const COUNTS = { observed: "assertion_fail", failure_code: "local_day_counts_mismatch" };
const LABELS = { observed: "assertion_fail", failure_code: "bucket_labels_mismatch" };

function outcome(result: ReturnType<typeof classify>): { observed: string; failure_code: string | null } {
  return { observed: result.observed, failure_code: result.failure_code };
}

describe("classify", () => {
  it.each(fixture.checks)("passes $check_id on its expected response", (check) => {
    expect(outcome(classify(response(200, stats(series(check.expected))), check))).toEqual({ observed: "pass", failure_code: null });
  });

  it("gives local_day_counts_mismatch for Los Angeles answered with the UTC counts 2, 8, 2", () => {
    expect(outcome(classify(response(200, stats(series([2, 8, 2]))), la))).toEqual(COUNTS);
  });

  it.each([la, auckland, kolkata])("gives bucket_labels_mismatch for the one-bucket stub in $timezone", (check) => {
    const stub = stats([{ x: "2026-03-08T00:00:00Z", y: 12 }]);
    expect(outcome(classify(response(200, stub), check))).toEqual(LABELS);
  });

  const labelCases: [string, { x: unknown; y: unknown }[]][] = [
    ["an extra label", [...series(utc.expected), { x: "2026-03-10T00:00:00Z", y: 0 }]],
    ["a missing label", series([2, 8], labels.slice(0, 2))],
    ["a duplicated label", series([2, 8, 2], [labels[0] ?? "", labels[1] ?? "", labels[1] ?? ""])],
    ["reordered labels", series([2, 2, 8], [labels[0] ?? "", labels[2] ?? "", labels[1] ?? ""])],
    ["a differently formatted label", series(utc.expected, ["2026-03-07 00:00:00", labels[1] ?? "", labels[2] ?? ""])],
    ["a non-string label", series(utc.expected, [1772841600000, labels[1] ?? "", labels[2] ?? ""] as string[])],
    ["no buckets at all", []],
  ];
  it.each(labelCases)("gives bucket_labels_mismatch for %s", (_name, points) => {
    expect(outcome(classify(response(200, stats(points)), utc))).toEqual(LABELS);
  });

  it("gives local_day_counts_mismatch for correct labels with a total of 11", () => {
    expect(outcome(classify(response(200, stats(series([2, 7, 2]))), utc))).toEqual(COUNTS);
  });

  it("gives local_day_counts_mismatch for correct labels with a total of 12 in the wrong days", () => {
    expect(outcome(classify(response(200, stats(series([1, 6, 5]))), kolkata))).toEqual(COUNTS);
  });

  const invalidCases: [string, { status: number; body: Uint8Array }][] = [
    ["HTTP 401", response(401, stats(series(utc.expected)))],
    ["HTTP 500", response(500, stats(series(utc.expected)))],
    ["a non-JSON body", response(200, "<html>synthetic error page</html>")],
    ["an empty body", response(200, "")],
    ["a body that is not UTF-8", { status: 200, body: Uint8Array.from([0xff, 0xfe, 0x7b]) }],
    ["a JSON array body", response(200, [])],
    ["a missing pageviews", response(200, { sessions: [] })],
    ["a non-array pageviews", response(200, { pageviews: {}, sessions: [] })],
    ["a missing sessions", response(200, { pageviews: series(utc.expected) })],
    ["a string y", response(200, stats(series(utc.expected).map((point) => ({ ...point, y: String(point.y) }))))],
    ["a negative y", response(200, stats(series([2, -8, 2])))],
    ["a fractional y", response(200, stats(series([2, 8.5, 2])))],
    ["a missing y", response(200, stats(labels.map((x) => ({ x }))))],
    ["a null item", response(200, { pageviews: [null], sessions: [] })],
  ];
  it.each(invalidCases)("treats %s as invalid, never as an intended code", (_name, invalid) => {
    for (const check of fixture.checks) {
      expect(outcome(classify(invalid, check))).toEqual(INVALID);
    }
  });

  it("checks validity before labels: a stub-shaped response with a string count is invalid", () => {
    const stub = stats([{ x: "2026-03-08T00:00:00Z", y: "12" }]);
    expect(outcome(classify(response(200, stub), la))).toEqual(INVALID);
  });

  it("does not grade sessions counts", () => {
    const body = { pageviews: series(la.expected), sessions: series([0, 0, 0]) };
    expect(outcome(classify(response(200, body), la))).toEqual({ observed: "pass", failure_code: null });
  });

  it("reports the observed counts for a mismatch", () => {
    const result = classify(response(200, stats(series([2, 8, 2]))), auckland);
    expect(result.detail).toContain("[2,8,2]");
    expect(result.detail).toContain("[1,6,5]");
  });
});
