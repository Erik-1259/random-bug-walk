import { describe, expect, it } from "vitest";
import { classifyTrial } from "../src/f3/classify.ts";
import type { LogTiming, TrialObservation } from "../src/f3/classify.ts";
import { FAILURE_CODE, KINDS, loadData } from "../src/f3/data.ts";
import type { KindId } from "../src/f3/data.ts";
import { validObservation } from "./support.ts";

const data = loadData();

function classify(kind: KindId, change: (observation: TrialObservation) => void = () => undefined): ReturnType<typeof classifyTrial> {
  const observation = validObservation(data, kind);
  change(observation);
  return classifyTrial(data, observation);
}

function firstCompletion(observation: TrialObservation, label: "x" | "partner" | "unknown"): TrialObservation["completions"][number] {
  const found = observation.completions.find((view) => view.label === label);
  if (found === undefined) throw new Error(`no ${label} completion`);
  return found;
}

describe("valid trials", () => {
  it.each(KINDS)("a correct app's %s trial is valid and passes", (kind) => {
    const result = classify(kind);
    expect(result).toEqual({ valid: true, outcome: "pass", invalid: [], acknowledged: data.kinds[kind].acknowledged, counted: data.kinds[kind].acknowledged });
  });

  it("a main trial whose report misses the acknowledged completion fails with the declared code", () => {
    const result = classify("main", (o) => {
      o.report = { status: 200, count: 0 };
      o.direct = { date_count: 0, x_row_present: false };
    });
    expect(result).toMatchObject({ valid: true, outcome: FAILURE_CODE, acknowledged: 1, counted: 0 });
    expect(FAILURE_CODE).toBe("acknowledged_completion_not_counted");
  });

  it("a valid-partner trial counting one of two acknowledged completions fails", () => {
    expect(classify("valid_partner", (o) => (o.report = { status: 200, count: 1 })).outcome).toBe(FAILURE_CODE);
  });

  it("grades the report, not the supporting direct read", () => {
    expect(classify("main", (o) => (o.direct = { date_count: 0, x_row_present: false })).outcome).toBe("pass");
  });

  it("a report counting more completions than were acknowledged is invalid, never a pass", () => {
    const result = classify("main", (o) => (o.report = { status: 200, count: 2 }));
    expect(result).toMatchObject({ valid: false, outcome: "invalid", invalid: ["count_exceeds_acknowledged"] });
  });
});

describe("invalid trials are never a pass or a detection", () => {
  const cases: [string, KindId, (o: TrialObservation) => void, string][] = [
    ["an internal error", "main", (o) => o.errors.push("Error"), "probe_error"],
    ["a backend left idle in a transaction", "main", (o) => (o.idle = { initial: 1, final: 1, waited_ms: 12_000 }), "idle_transaction_present"],
    ["a failed setup", "main", (o) => (o.setup_ok = false), "setup_failed"],
    ["a date that already has completions", "main", (o) => (o.precount = 1), "precount_not_zero"],
    ["a failed gate", "main", (o) => (o.gate_ok = false), "gate_failed"],
    ["a pool that is not full (L2 short)", "main", (o) => (o.s1 = { l1: 1, l2: 8, lock_types: ["transactionid"], backends: { app_backends: 9, lock_waiting: 9, idle_in_transaction: 0 } }), "p1_not_saturated"],
    ["backends that are not all lock-waiting", "main", (o) => (o.s1 = { l1: 1, l2: 9, lock_types: ["transactionid"], backends: { app_backends: 10, lock_waiting: 9, idle_in_transaction: 0 } }), "p1_not_saturated"],
    ["no transactionid lock wait", "main", (o) => (o.s1 = { l1: 1, l2: 9, lock_types: ["tuple"], backends: { app_backends: 10, lock_waiting: 10, idle_in_transaction: 0 } }), "p1_not_saturated"],
    ["a completion settled before the release", "main", (o) => (o.s2 = { l1: 1, l2: 9, backends: { app_backends: 10, lock_waiting: 10, idle_in_transaction: 0 }, settled: 1 }), "p2_not_queued"],
    ["a gate that lost a waiter before the release", "main", (o) => (o.s2 = { l1: 0, l2: 9, backends: { app_backends: 10, lock_waiting: 9, idle_in_transaction: 0 }, settled: 0 }), "p2_not_queued"],
    ["completions not settled while L2 held", "main", (o) => (o.s3 = { l2: 9, all_settled: false }), "p3_window_not_held"],
    ["L2 released early", "main", (o) => (o.s3 = { l2: 8, all_settled: true }), "p3_window_not_held"],
    ["a request that never settled", "main", (o) => (firstCompletion(o, "x").settled = false), "requests_not_settled"],
    ["a transport error", "main", (o) => Object.assign(firstCompletion(o, "x"), { status: null, transport_error: true, body: null }), "transport_error"],
    ["a 404 that is not not_found", "main", (o) => (firstCompletion(o, "unknown").error_code = "validation_failed"), "unexpected_status"],
    ["a 201 for another instant", "main", (o) => (firstCompletion(o, "x").body = { id: "c", task_id: "t", completed_at: "2091-01-02T12:00:00.000Z" }), "unexpected_status"],
    ["a PATCH that did not answer 200", "main", (o) => ((o.patches[3] as { status: number | null }).status = 404), "unexpected_status"],
    ["a failed report", "main", (o) => (o.report = { status: 400, count: null }), "report_failed"],
    ["missing app log lines", "main", (o) => (o.app_log = {}), "app_log_missing"],
    ["D arriving less than the margin after X", "main", (o) => ((o.app_log["req-unknown"] as { start_ms: number }).start_ms -= 100), "app_log_order"],
    ["D arriving less than the margin before the freed PATCH ended", "main", (o) => ((o.app_log["req-patch-1"] as { end_ms: number }).end_ms -= 120), "app_log_order"],
    ["X arriving after D in a DX trial", "dx_order", (o) => ((o.app_log["req-x"] as { start_ms: number }).start_ms -= 200), "app_log_order"],
    ["a gate on a sequential trial", "sequential", (o) => (o.gate_ok = true), "probe_error"],
    ["a trial that stopped before its sends", "main", (o) => (o.completions = []), "probe_error"],
  ];

  it.each(cases)("%s", (_name, kind, change, code) => {
    const counted = classify(kind, change);
    const failing = classify(kind, (o) => {
      change(o);
      if (o.report !== null && o.report.status === 200) o.report = { status: 200, count: 0 };
    });
    for (const result of [counted, failing]) {
      expect(result.valid).toBe(false);
      expect(result.outcome).toBe("invalid");
      expect(result.invalid).toContain(code);
    }
  });

  it("a 5xx is invalid, never a detection", () => {
    const result = classify("main", (o) => {
      Object.assign(firstCompletion(o, "x"), { status: 503, error_code: "database_unavailable", body: null });
      o.report = { status: 200, count: 0 };
    });
    expect(result.outcome).toBe("invalid");
    expect(result.invalid).toEqual(expect.arrayContaining(["server_error"]));
  });

  it("reports only the first precondition that failed", () => {
    const result = classify("main", (o) => {
      o.s1 = null;
      o.s2 = null;
      o.s3 = null;
      o.completions = [];
      o.report = { status: 200, count: 0 };
    });
    expect(result.invalid).toEqual(["p1_not_saturated"]);
  });

  it("lists codes in the data file's order", () => {
    const result = classify("main", (o) => {
      o.precount = 3;
      o.errors.push("Error");
    });
    expect(result.invalid).toEqual(["probe_error", "precount_not_zero"]);
  });
});

describe("app-log margins", () => {
  const sendMargin = data.app_log.send_order_margin_ms;
  const freedMargin = data.app_log.freed_end_margin_ms;

  function logLine(o: TrialObservation, id: string | null | undefined): LogTiming {
    const found = id === null || id === undefined ? undefined : o.app_log[id];
    if (found === undefined) throw new Error(`no log line for ${String(id)}`);
    return found;
  }

  it("are 100 ms for the send order and for the freed PATCH's end", () => {
    expect([sendMargin, freedMargin]).toEqual([100, 100]);
  });

  const sendPairs: [KindId, string, string][] = [
    ["main", "req-x", "req-unknown"],
    ["valid_partner", "req-x", "req-partner"],
    ["dx_order", "req-unknown", "req-x"],
  ];

  it.each(sendPairs)("%s: a send may start exactly the margin after the one before it, not 1 ms less", (kind, first, second) => {
    const at = (gap: number): ReturnType<typeof classifyTrial> =>
      classify(kind, (o) => {
        logLine(o, second).start_ms = logLine(o, first).start_ms + gap;
      });
    expect(at(sendMargin)).toMatchObject({ valid: true, outcome: "pass", invalid: [] });
    expect(at(sendMargin - 1)).toMatchObject({ valid: false, outcome: "invalid", invalid: ["app_log_order"] });
  });

  const forced = KINDS.filter((kind) => data.kinds[kind].forced);

  it.each(forced)("%s: the last send may start exactly the margin before the freed PATCH ends, not 1 ms later", (kind) => {
    const at = (gap: number): ReturnType<typeof classifyTrial> =>
      classify(kind, (o) => {
        logLine(o, "req-patch-1").end_ms = logLine(o, o.completions.at(-1)?.request_id).start_ms + gap;
      });
    expect(at(freedMargin)).toMatchObject({ valid: true, outcome: "pass", invalid: [] });
    expect(at(freedMargin - 1)).toMatchObject({ valid: false, outcome: "invalid", invalid: ["app_log_order"] });
  });
});
