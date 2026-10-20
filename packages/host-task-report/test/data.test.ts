import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRequestLog } from "../src/f3/applog.ts";
import { DATA_FILE, DataError, INVALID_CODES, KINDS, loadData, parseData, trialDate, trialInstant } from "../src/f3/data.ts";
import { sha256Hex } from "../src/hash.ts";
import { compareSuiteRun, parseReportValue } from "../src/suite/report.ts";

const data = loadData();
const raw = (): Record<string, unknown> => JSON.parse(readFileSync(DATA_FILE, "utf8")) as Record<string, unknown>;

describe("data/f3.v1.json", () => {
  it("is pinned by its .sha256 file", () => {
    const pin = readFileSync(`${DATA_FILE}.sha256`, "utf8").split(/\s+/)[0];
    expect(sha256Hex(readFileSync(DATA_FILE))).toBe(pin);
    expect(data.sha256).toBe(pin);
  });

  it("holds the frozen design: 150/150 ms gaps, gates of 1 and 9 rows on a pool of 10, and 100 ms log margins", () => {
    expect(data.timing).toMatchObject({ gap_send_ms: 150, post_d_ms: 150, saturation_bound_ms: 3000, settle_bound_ms: 1500, idle_recheck_wait_ms: 12_000, late_reread_wait_ms: 11_000 });
    expect(data.gate).toMatchObject({ l1_rows: 1, l2_rows: 9, lock_type: "transactionid" });
    expect(data.environment).toMatchObject({ db_pool_max: 10, fillers: 10, report_time_zone: "UTC" });
    expect(data.app_log).toEqual({ event: "request", send_order_margin_ms: 100, freed_end_margin_ms: 100 });
    expect(data.kinds.main).toEqual({ forced: true, sends: ["x", "unknown"], acknowledged: 1 });
    expect(data.kinds.dx_order.sends).toEqual(["unknown", "x"]);
    expect(data.expected.buggy.main).toBe("acknowledged_completion_not_counted");
    expect(data.expected.clean.main).toBe("pass");
    expect(data.expected.fixed.main).toBe("pass");
    for (const kind of KINDS.filter((name) => name !== "main")) expect(data.expected.buggy[kind]).toBe("pass");
  });

  it("gives every trial of every kind its own far-future UTC date", () => {
    const dates = KINDS.flatMap((kind) => Array.from({ length: data.dates.max_index }, (_, i) => trialDate(data, kind, i + 1)));
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates.every((date) => date >= "2091-01-01" && date < "2096-01-01")).toBe(true);
    expect(trialInstant(data, "2091-01-01")).toBe("2091-01-01T12:00:00.000Z");
    expect(() => trialDate(data, "main", data.dates.max_index + 1)).toThrow(DataError);
  });

  it("refuses a file whose codes, kinds or expected vectors differ from the code", () => {
    const codes = raw();
    codes.invalid_codes = [...INVALID_CODES].reverse();
    expect(() => parseData(codes, "x")).toThrow(DataError);
    const kinds = raw();
    (kinds.kinds as { main: { acknowledged: number } }).main.acknowledged = 2;
    expect(() => parseData(kinds, "x")).toThrow(/acknowledged/);
    const expected = raw();
    (expected.expected as { buggy: { main: string } }).buggy.main = "fail";
    expect(() => parseData(expected, "x")).toThrow(DataError);
    const gates = raw();
    (gates.gate as Record<string, number>).l2_rows = 8;
    expect(() => parseData(gates, "x")).toThrow(DataError);
  });
});

describe("parseRequestLog", () => {
  it("reads start and end of request lines by request ID, skipping other lines", () => {
    const text = [
      "> taskapp start",
      JSON.stringify({ ts: "2030-01-01T00:00:01.000Z", level: "info", event: "listening" }),
      JSON.stringify({ ts: "2030-01-01T00:00:02.500Z", level: "info", event: "request", request_id: "r1", status: 201, duration_ms: 320 }),
      "{not json",
      JSON.stringify({ ts: "2030-01-01T00:00:02.600Z", level: "info", event: "request", request_id: "r2", status: 404, duration_ms: 160 }),
    ].join("\n");
    const timings = parseRequestLog(text, "request");
    expect([...timings.keys()]).toEqual(["r1", "r2"]);
    expect(timings.get("r1")).toEqual({ start_ms: Date.parse("2030-01-01T00:00:02.180Z"), end_ms: Date.parse("2030-01-01T00:00:02.500Z"), status: 201 });
  });
});

describe("original-suite comparison", () => {
  const expected = [
    { id: "a", file: "test/a.spec.ts", title_path: ["a"] },
    { id: "b", file: "test/a.spec.ts", title_path: ["b"] },
  ];
  const report = (statuses: Record<string, [string, string]>): unknown => ({
    config: { rootDir: "/suite/test" },
    suites: [{ title: "a.spec.ts", specs: Object.entries(statuses).map(([id, [status, result]]) => ({ id, file: "a.spec.ts", title: id, tests: [{ status, results: [{ status: result, duration: 3 }] }] })) }],
  });

  it("passes only when every expected test ran and passed", () => {
    expect(compareSuiteRun(expected, parseReportValue(report({ a: ["expected", "passed"], b: ["expected", "passed"] }), "/suite")).verdict).toBe("passed");
    expect(compareSuiteRun(expected, parseReportValue(report({ a: ["expected", "passed"], b: ["unexpected", "failed"] }), "/suite"))).toMatchObject({ verdict: "failed", failed: ["b"] });
    expect(compareSuiteRun(expected, parseReportValue(report({ a: ["expected", "passed"] }), "/suite"))).toMatchObject({ verdict: "invalid", missing: ["b"] });
    expect(compareSuiteRun(expected, null).verdict).toBe("invalid");
  });

  it("reads spec files relative to the suite root", () => {
    expect(parseReportValue(report({ a: ["expected", "passed"] }), "/suite").tests[0]?.file).toBe("test/a.spec.ts");
  });
});
