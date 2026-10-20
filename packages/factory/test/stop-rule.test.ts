// The stop rule of the request loop as one table (contract sections 8.1, 8.5 and 9): every stop source,
// observed at every point of a request, ends the candidate in flight and the request one way.
//
// - A source observed before a candidate's last check boundary (the reservation's read, before a copy,
//   or the harness's return for a match) ends that candidate there: incomplete (`stopped`), never
//   delivered; a complete verdict that is not a match keeps its reason. A failed stop or ledger read
//   ends it incomplete (`incomplete_run`), and an uncertain outcome does too, keeping its reservation
//   held. A source observed later leaves the candidate to qualify and be delivered.
// - The request's code, and the code its budget closes with: uncertain > overrun > halt (a halted
//   ledger or pool) or a failed read > a recorded stop > the deadline. A halt stops only work still to
//   do: one that no copy, qualification or next candidate would meet keeps the outcome. The deadline
//   bounds only what starts (a copy, a candidate).
//
// The request has one item of two units (or one, for the last-needed-case rows) and two entries of
// three copies each (one per state).
import { validateContract } from "@rbw/factory-contract/validate";
import type { StopCode } from "@rbw/factory-contract";
import { describe, expect, it } from "vitest";
import { OUTCOME_OF } from "../src/events.ts";
import type { RunResult } from "../src/orchestrator.ts";
import { FakeHostAdapter, syntheticEntry } from "../src/testing/catalog.ts";
import { UncertainOutcomeError, qualifyingPlan } from "../src/testing/harness.ts";
import { CREATED_AT, world } from "./orchestrator-support.ts";
import type { World } from "./orchestrator-support.ts";

const LOST = "concurrency.lost-acknowledged-change";
const LOST_CODE = "acknowledged_completion_not_counted";

type Source = "stop" | "deadline" | "halt" | "pool_halt" | "overrun" | "uncertain" | "stop_read_fails" | "ledger_read_fails";

/**
 * Where the source is first observable, always for the request's first candidate:
 * - start: before the loop's first read and checks;
 * - reservation: once its reservation resolved, before its first copy;
 * - between_copies: while its first of three copies runs (that copy's read, the boundary before copy 2);
 * - last_copy: while its third and last copy runs (that copy's read, the harness's return);
 * - packaging: while its case is packaged;
 * - package_ready: once its package_ready is appended, before case_delivered;
 * - loop_top: once it settled and its budget event is appended, before the next loop check.
 */
type Point = "start" | "reservation" | "between_copies" | "last_copy" | "packaging" | "package_ready" | "loop_top";

const SOURCES: readonly Source[] = ["stop", "deadline", "halt", "pool_halt", "overrun", "uncertain", "stop_read_fails", "ledger_read_fails"];
const POINTS: readonly Point[] = ["start", "reservation", "between_copies", "last_copy", "packaging", "package_ready", "loop_top"];

interface End {
  /** How the first candidate ended: qualified, or its reason; null when none was selected. */
  first: string | null;
  /** Copies the first candidate ran. */
  copies: number;
  /** The request's stop code, which its budget also closes with. */
  stop_code: StopCode;
  delivered: number;
  /** A second candidate was selected. */
  second: boolean;
}

interface Row {
  name: string;
  point: Point;
  sources: Source[];
  /** Units of the item; 1 makes the first candidate's case the last one needed. */
  quantity: number;
  /** "rejected": every entry's reference-fixed copy fails its verification checks, a complete verdict. */
  plan?: "rejected";
  end: End;
}

const end = (first: End["first"], copies: number, stop_code: StopCode, delivered: number, second = false): End => ({ first, copies, stop_code, delivered, second });

/** Each source alone, at each point (two units, so a next candidate is still work to do). */
const SINGLE: Record<Point, Record<Source, End>> = {
  start: {
    stop: end(null, 0, "cancelled_by_user", 0),
    deadline: end(null, 0, "time_limit", 0),
    halt: end(null, 0, "operational_error", 0),
    pool_halt: end(null, 0, "operational_error", 0),
    overrun: end(null, 0, "operational_error", 0),
    uncertain: end("incomplete_run", 0, "needs_reconciliation", 0),
    stop_read_fails: end(null, 0, "operational_error", 0),
    ledger_read_fails: end(null, 0, "operational_error", 0),
  },
  reservation: {
    stop: end("stopped", 0, "cancelled_by_user", 0),
    deadline: end("stopped", 0, "time_limit", 0),
    halt: end("stopped", 0, "operational_error", 0),
    pool_halt: end("stopped", 0, "operational_error", 0),
    overrun: end("stopped", 0, "operational_error", 0),
    uncertain: end("incomplete_run", 0, "needs_reconciliation", 0),
    stop_read_fails: end("incomplete_run", 0, "operational_error", 0),
    // A port read failing while the reservation is held and unsettled: the reservation stays held.
    ledger_read_fails: end("incomplete_run", 0, "needs_reconciliation", 0),
  },
  between_copies: {
    stop: end("stopped", 1, "cancelled_by_user", 0),
    deadline: end("stopped", 1, "time_limit", 0),
    halt: end("stopped", 1, "operational_error", 0),
    pool_halt: end("stopped", 1, "operational_error", 0),
    overrun: end("stopped", 1, "operational_error", 0),
    uncertain: end("incomplete_run", 1, "needs_reconciliation", 0),
    stop_read_fails: end("incomplete_run", 1, "operational_error", 0),
    ledger_read_fails: end("incomplete_run", 1, "operational_error", 0),
  },
  last_copy: {
    stop: end("stopped", 3, "cancelled_by_user", 0),
    // Every copy started in time: the match is delivered, and the loop's checks stop the request.
    deadline: end("qualified", 3, "time_limit", 1),
    halt: end("stopped", 3, "operational_error", 0),
    pool_halt: end("stopped", 3, "operational_error", 0),
    overrun: end("stopped", 3, "operational_error", 0),
    uncertain: end("incomplete_run", 3, "needs_reconciliation", 0),
    stop_read_fails: end("incomplete_run", 3, "operational_error", 0),
    ledger_read_fails: end("incomplete_run", 3, "operational_error", 0),
  },
  packaging: {
    stop: end("qualified", 3, "cancelled_by_user", 1),
    deadline: end("qualified", 3, "time_limit", 1),
    halt: end("qualified", 3, "operational_error", 1),
    pool_halt: end("qualified", 3, "operational_error", 1),
    overrun: end("qualified", 3, "operational_error", 1),
    uncertain: end("qualified", 3, "needs_reconciliation", 1),
    stop_read_fails: end("qualified", 3, "operational_error", 1),
    ledger_read_fails: end("qualified", 3, "operational_error", 1),
  },
  package_ready: {
    stop: end("qualified", 3, "cancelled_by_user", 1),
    deadline: end("qualified", 3, "time_limit", 1),
    halt: end("qualified", 3, "operational_error", 1),
    pool_halt: end("qualified", 3, "operational_error", 1),
    overrun: end("qualified", 3, "operational_error", 1),
    uncertain: end("qualified", 3, "needs_reconciliation", 1),
    stop_read_fails: end("qualified", 3, "operational_error", 1),
    ledger_read_fails: end("qualified", 3, "operational_error", 1),
  },
  loop_top: {
    stop: end("qualified", 3, "cancelled_by_user", 1),
    deadline: end("qualified", 3, "time_limit", 1),
    halt: end("qualified", 3, "operational_error", 1),
    pool_halt: end("qualified", 3, "operational_error", 1),
    overrun: end("qualified", 3, "operational_error", 1),
    uncertain: end("qualified", 3, "needs_reconciliation", 1, true),
    stop_read_fails: end("qualified", 3, "operational_error", 1),
    ledger_read_fails: end("qualified", 3, "operational_error", 1),
  },
};

/** Two sources at the same point (precedence), and the last-needed-case variants. */
const COMBINED: Omit<Row, "name">[] = [
  { point: "start", sources: ["overrun", "stop"], quantity: 2, end: end(null, 0, "operational_error", 0) },
  // The stop ends the loop before a candidate would meet the halt: the halt stopped no work.
  { point: "start", sources: ["halt", "stop"], quantity: 2, end: end(null, 0, "cancelled_by_user", 0) },
  { point: "reservation", sources: ["halt", "stop"], quantity: 2, end: end("stopped", 0, "operational_error", 0) },
  { point: "reservation", sources: ["overrun", "stop"], quantity: 2, end: end("stopped", 0, "operational_error", 0) },
  { point: "between_copies", sources: ["halt", "stop"], quantity: 2, end: end("stopped", 1, "operational_error", 0) },
  { point: "between_copies", sources: ["pool_halt", "deadline"], quantity: 2, end: end("stopped", 1, "operational_error", 0) },
  { point: "between_copies", sources: ["overrun", "stop"], quantity: 2, end: end("stopped", 1, "operational_error", 0) },
  { point: "between_copies", sources: ["stop", "deadline"], quantity: 2, end: end("stopped", 1, "cancelled_by_user", 0) },
  // The overrun stops copy 2, and the harness's return then has an uncertain outcome.
  { point: "between_copies", sources: ["overrun", "uncertain"], quantity: 2, end: end("incomplete_run", 1, "needs_reconciliation", 0) },
  { point: "last_copy", sources: ["halt", "stop"], quantity: 2, end: end("stopped", 3, "operational_error", 0) },
  { point: "last_copy", sources: ["pool_halt", "deadline"], quantity: 2, end: end("stopped", 3, "operational_error", 0) },
  // A complete rejection keeps its reason; the halt meets the next candidate's check, unless the stop ends the loop first.
  { point: "last_copy", sources: ["halt"], quantity: 2, plan: "rejected", end: end("checks_failed_fixed", 3, "operational_error", 0) },
  { point: "last_copy", sources: ["halt", "stop"], quantity: 2, plan: "rejected", end: end("checks_failed_fixed", 3, "cancelled_by_user", 0) },
  { point: "last_copy", sources: ["overrun", "stop"], quantity: 2, end: end("stopped", 3, "operational_error", 0) },
  { point: "last_copy", sources: ["stop", "deadline"], quantity: 2, end: end("stopped", 3, "cancelled_by_user", 0) },
  { point: "last_copy", sources: ["overrun", "uncertain"], quantity: 2, end: end("incomplete_run", 3, "needs_reconciliation", 0) },
  // After qualification, a halt and a stop: the stop ends the loop before the next candidate meets the halt.
  { point: "packaging", sources: ["halt", "stop"], quantity: 2, end: end("qualified", 3, "cancelled_by_user", 1) },
  { point: "packaging", sources: ["overrun", "stop"], quantity: 2, end: end("qualified", 3, "operational_error", 1) },
  { point: "loop_top", sources: ["halt", "deadline"], quantity: 2, end: end("qualified", 3, "time_limit", 1) },
  // The first candidate's case is the last one needed.
  { point: "last_copy", sources: ["halt"], quantity: 1, end: end("stopped", 3, "operational_error", 0) },
  { point: "last_copy", sources: ["pool_halt"], quantity: 1, end: end("stopped", 3, "operational_error", 0) },
  { point: "last_copy", sources: ["overrun"], quantity: 1, end: end("stopped", 3, "operational_error", 0) },
  { point: "last_copy", sources: ["deadline"], quantity: 1, end: end("qualified", 3, "fulfilled", 1) },
  { point: "packaging", sources: ["halt"], quantity: 1, end: end("qualified", 3, "fulfilled", 1) },
  { point: "package_ready", sources: ["deadline"], quantity: 1, end: end("qualified", 3, "fulfilled", 1) },
  { point: "loop_top", sources: ["stop"], quantity: 1, end: end("qualified", 3, "cancelled_by_user", 1) },
  { point: "loop_top", sources: ["halt"], quantity: 1, end: end("qualified", 3, "fulfilled", 1) },
];

function rowName(row: Omit<Row, "name">): string {
  const first = row.end.first === null ? "no candidate" : row.end.first === "qualified" ? "the case delivered" : `the candidate ${row.end.first}`;
  const variant = [row.quantity === 1 ? "last needed case" : null, row.plan === "rejected" ? "a complete rejection" : null].filter((part) => part !== null);
  return `${row.sources.join(" + ")} at ${row.point}${variant.length === 0 ? "" : ` (${variant.join(", ")})`}: ${first}, ${row.end.stop_code}`;
}

const ROWS: Row[] = [
  ...POINTS.flatMap((point) => SOURCES.map((source) => ({ point, sources: [source], quantity: 2, end: SINGLE[point][source] }))),
  ...COMBINED,
].map((row) => ({ ...row, name: rowName(row) }));

interface Run {
  w: World;
  result: RunResult;
  copies: number;
  fired: boolean;
}

/** Runs the request with the row's sources fired once, at the row's point. */
async function runRow(row: Row): Promise<Run> {
  const registry = [new FakeHostAdapter({ host_id: "task-report", entries: [1, 2].map((n) => syntheticEntry({ host_id: "task-report", bug_type_id: "concurrency", n, criteria: [LOST] })) })];
  const states = qualifyingPlan([LOST_CODE]);
  const w = world({
    input: { hosts: ["task-report"], items: [{ item_key: "concurrency-1", bug_type_id: "concurrency", quantity: row.quantity, description: null, difficulty: "source_inferable_allowed" }], budget_microusd: 1_500_000 },
    registry,
    plan: () => ({ states: row.plan === "rejected" ? { ...states, fixed: { original_suite: "pass", verification: "fail" } } : states }),
  });
  const deadline = Date.parse(CREATED_AT) + w.deps.request.interpretation.limits.max_wall_clock_s * 1000;
  // Faults that last once fired: the next provider operation (a reserve, a copy, the harness's
  // return, a settlement) has an uncertain outcome, or every stop or ledger read fails.
  const faults = { uncertain: false, stopRead: false, ledgerRead: false };
  let fired = false;
  const fire = (at: Point): void => {
    if (at !== row.point || fired) return;
    fired = true;
    for (const source of row.sources) {
      if (source === "stop") w.stop.requested = true;
      if (source === "deadline") w.clock.now = deadline;
      if (source === "halt") w.ledger.halted = true;
      if (source === "pool_halt") w.ledger.poolHalted = true;
      // A provider reported far more than the worst case.
      if (source === "overrun") w.ledger.spent += 2_000_000;
      if (source === "uncertain") faults.uncertain = true;
      if (source === "stop_read_fails") faults.stopRead = true;
      if (source === "ledger_read_fails") faults.ledgerRead = true;
    }
  };

  w.deps.stopRequested = () => (faults.stopRead ? Promise.reject(new Error("connection reset")) : Promise.resolve(w.stop.requested));
  const ledger = w.ledger;
  let reservations = 0;
  w.deps.ledger = {
    status: () => (faults.ledgerRead ? Promise.reject(new Error("connection reset")) : ledger.status()),
    reserveCandidate: async (input) => {
      if (faults.uncertain) throw new Error("the reserve call timed out");
      const outcome = await ledger.reserveCandidate(input);
      reservations += 1;
      if (reservations === 1) fire("reservation");
      return outcome;
    },
    settleCandidate: (input) => (faults.uncertain ? Promise.reject(new Error("the settle call timed out")) : ledger.settleCandidate(input)),
    settleWorker: (input) => ledger.settleWorker(input),
  };
  const qualify = w.deps.qualify;
  let harnessRuns = 0;
  let copies = 0;
  w.deps.qualify = async (input) => {
    harnessRuns += 1;
    const first = harnessRuns === 1;
    const result = await qualify({
      ...input,
      beforeCopy: async (plan) => {
        const answer = await input.beforeCopy(plan);
        if (answer === "continue" && faults.uncertain) throw new UncertainOutcomeError();
        return answer;
      },
      onCopy: async (record) => {
        if (first) {
          copies += 1;
          if (copies === 1) fire("between_copies");
          if (copies === 3) fire("last_copy");
        }
        await input.onCopy(record);
      },
    });
    if (faults.uncertain) throw new UncertainOutcomeError();
    return result;
  };
  const packageCase = w.deps.packageCase;
  let packaged = 0;
  w.deps.packageCase = (input) => {
    packaged += 1;
    if (packaged === 1) fire("packaging");
    return packageCase(input);
  };
  const sink = w.deps.events;
  let firstCandidate: string | null = null;
  w.deps.events = {
    append: async (event) => {
      await sink.append(event);
      if (event.type === "candidate_selected") firstCandidate ??= event.candidate_id;
      if (event.type === "package_ready" && event.candidate_id === firstCandidate) fire("package_ready");
      if (firstCandidate !== null && event.event_key === `cand:${firstCandidate}:settled`) fire("loop_top");
    },
  };

  fire("start");
  const result = await w.run();
  return { w, result, copies, fired };
}

describe("runRequest: every stop source at every point", () => {
  it("covers every source at every point", () => {
    const single = new Set(ROWS.filter((row) => row.sources.length === 1 && row.quantity === 2).map((row) => `${row.point}:${row.sources[0] ?? ""}`));
    expect(single.size).toBe(POINTS.length * SOURCES.length);
  });

  for (const row of ROWS) {
    it(row.name, async () => {
      const { w, result, copies, fired } = await runRow(row);
      expect(fired).toBe(true);
      const events = w.events.events;
      const status = w.status();
      expect(validateContract("RequestStatus", status)).toEqual([]);
      const [first, second] = status.candidates;
      const firstEnd = first === undefined ? null : first.stage === "qualified" ? "qualified" : (first.reason?.code ?? first.stage);
      // The budget closes with the code the request finished with.
      expect({ first: firstEnd, copies, stop_code: result.stop_code, delivered: result.delivered, second: second !== undefined, closed_with: w.ledger.closedWith }).toEqual({ ...row.end, closed_with: row.end.stop_code });
      // One finish with that code; reconciliation only when an outcome was uncertain.
      expect(events.filter((event) => event.type === "request_finished").map((event) => event.data)).toEqual([{ outcome: OUTCOME_OF[row.end.stop_code], stop_code: row.end.stop_code }]);
      expect(result.needs_reconciliation).toBe(row.end.stop_code === "needs_reconciliation");
      expect(status.attention?.code ?? null).toBe(row.end.stop_code === "needs_reconciliation" ? "needs_reconciliation" : null);
      // Only a qualified candidate is delivered; one stopped before qualification never passes its checks.
      expect(events.filter((event) => event.type === "case_delivered")).toHaveLength(row.end.delivered);
      expect(status.items[0]?.delivered).toBe(row.end.delivered);
      if (first !== undefined && row.end.first !== "qualified") {
        const passed = events.filter((event) => event.candidate_id === first.candidate_id && (event.type === "behavior_checks_passed" || event.type === "package_ready"));
        expect(passed).toEqual([]);
        expect(w.log).not.toContain("package");
      }
    });
  }

  const reservationStops: [string, (w: World) => void][] = [
    ["a halted ledger", (w) => {
      w.ledger.halted = true;
    }],
    ["a halted pool", (w) => {
      w.ledger.poolHalted = true;
    }],
    ["an overrun", (w) => {
      w.ledger.spent += 2_000_000;
    }],
  ];

  it.each(reservationStops)("ends the candidate stopped without running export verification when the reservation's read finds %s, whatever the harness would check first", async (_name, mutate) => {
    // A harness that ends on a failed integrity check before its first copy check, as the real one may.
    const registry = [new FakeHostAdapter({ host_id: "task-report", entries: [syntheticEntry({ host_id: "task-report", bug_type_id: "concurrency", n: 1, criteria: [LOST] })] })];
    const w = world({ input: { hosts: ["task-report"], items: [{ item_key: "concurrency-1", bug_type_id: "concurrency", quantity: 1, description: null, difficulty: "source_inferable_allowed" }], budget_microusd: 1_500_000 }, registry });
    const ledger = w.ledger;
    w.deps.ledger = {
      status: () => ledger.status(),
      reserveCandidate: async (input) => {
        const outcome = await ledger.reserveCandidate(input);
        mutate(w);
        return outcome;
      },
      settleCandidate: (input) => ledger.settleCandidate(input),
      settleWorker: (input) => ledger.settleWorker(input),
    };
    const qualify = w.deps.qualify;
    let verified = 0;
    w.deps.qualify = async (input) => {
      verified += 1;
      const result = await qualify({ ...input, beforeCopy: () => Promise.resolve("stop") });
      return { ...result, stopped: false, integrity: "failed", matrix: null, records: [] };
    };
    const result = await w.run();
    expect(verified).toBe(0);
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "operational_error", needs_reconciliation: false, delivered: 0 });
    expect(w.status().candidates.map((c) => [c.stage, c.reason?.code])).toEqual([["incomplete", "stopped"]]);
    expect(w.ledger.calls.map((call) => call.call)).toEqual(["reserveCandidate", "settleCandidate", "settleWorker"]);
    expect(w.ledger.closedWith).toBe("operational_error");
  });
});
