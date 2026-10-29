import { describe, expect, it } from "vitest";
import { AGENT_LABEL, EXPECTED_CELLS, type BuilderEvent, type LaneId, type LaneStage, type OtfEvent, type ProductionEvent, type RoundResult } from "../../src/otf/contract.ts";
import { projectLanes } from "../../src/otf/projection.ts";

const AT = "2026-10-29T10:00:00.000Z";
const LANES = [
  { lane_id: "lane-1" as const, model: "synthetic/model-one", model_label: "Synthetic One" },
  { lane_id: "lane-2" as const, model: "synthetic/model-two", model_label: "Synthetic Two" },
];
type EventBody = BuilderEvent | ProductionEvent;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected fixture entry.");
  return value;
}
const event = (seq: number, body: EventBody): OtfEvent => ({ seq, at: AT, ...body });
const started = (seq: number, lane_id: LaneId = "lane-1"): OtfEvent => event(seq, {
  type: "lane_started", lane_id, data: { model: "synthetic/recorded-model", model_label: "Recorded Model", agent: AGENT_LABEL },
});
const stage = (seq: number, value: LaneStage, iteration: number, lane_id: LaneId = "lane-1"): OtfEvent =>
  event(seq, { type: "lane_stage", lane_id, data: { stage: value, iteration } });
const round = (extra: Partial<RoundResult> = {}): RoundResult => ({
  iteration: 1, kind: "qualification", result: "qualified", cells: structuredClone(EXPECTED_CELLS), admission: null,
  feedback: ["Synthetic comparison complete."], goose_ms: 20, qualify_ms: 40, ...extra,
});

describe("projectLanes", () => {
  it("starts configured lanes queued with independent empty progress", () => {
    const projected = projectLanes([], LANES, 1);
    expect(projected).toEqual(LANES.map(lane => ({
      ...lane, stage: "queued", iteration: 0, files: { change: false, checks: 0, fix: false },
      meter: { tokens_in: 0, tokens_out: 0, requests: 0, cost_microusd: 0 }, rounds: [], outcome: null,
    })));
    required(projected[0]).files.change = true;
    expect(required(projected[1]).files.change).toBe(false);
    expect(required(projectLanes([], LANES, 1)[0]).files.change).toBe(false);
  });

  it("replays by public sequence while preserving earlier progress and configured order", () => {
    const events = [
      stage(7, "qualifying", 2), stage(5, "revising", 2),
      started(1),
      event(3, { type: "lane_files", lane_id: "lane-1", data: { change: true, checks: 2, fix: true } }),
      stage(6, "prechecking", 2), stage(4, "prechecking", 1),
      stage(2, "writing", 1),
    ];
    const before = structuredClone(events);
    const projected = projectLanes(events, LANES, 1);
    expect(projected.map(lane => lane.lane_id)).toEqual(["lane-1", "lane-2"]);
    expect(projected[0]).toMatchObject({ model: "synthetic/recorded-model", stage: "qualifying", iteration: 2, files: { change: true, checks: 2, fix: true } });
    expect(events).toEqual(before);
  });

  it("uses the latest cumulative meter and file snapshots without double counting", () => {
    const events = [
      started(1),
      event(2, { type: "lane_meter", lane_id: "lane-1", data: { tokens_in: 10, tokens_out: 4, requests: 1, cost_microusd: 12 } }),
      event(3, { type: "lane_meter", lane_id: "lane-1", data: { tokens_in: 25, tokens_out: 9, requests: 2, cost_microusd: 30 } }),
      event(4, { type: "lane_files", lane_id: "lane-1", data: { change: true, checks: 3, fix: true } }),
      event(5, { type: "lane_files", lane_id: "lane-1", data: { change: true, checks: 2, fix: false } }),
    ];
    const lane = required(projectLanes(events, LANES, 1)[0]);
    expect(lane.meter).toEqual({ tokens_in: 25, tokens_out: 9, requests: 2, cost_microusd: 30 });
    expect(lane.files).toEqual({ change: true, checks: 2, fix: false });
    expect(projectLanes(events, LANES, 1)[0]).toEqual(lane);
  });

  it("shows a qualifying candidate as confirming without winning or stopping other lanes", () => {
    const events = [started(1), started(2, "lane-2"),
      event(3, { type: "lane_stage", lane_id: "lane-2", data: { stage: "writing", iteration: 1 } }),
      stage(4, "writing", 1), stage(5, "prechecking", 1), stage(6, "qualifying", 1),
      event(7, { type: "round_finished", lane_id: "lane-1", data: round() }),
      stage(8, "confirming", 1),
    ];
    const projected = projectLanes(events, LANES, 1);
    expect(projected[0]).toMatchObject({ stage: "confirming", outcome: null, iteration: 1 });
    expect(projected[1]).toMatchObject({ stage: "writing", outcome: null });
  });

  it("keeps rejected, qualification and failed confirmation evidence separately", () => {
    const rounds = [
      round({ kind: "precheck_rejected", result: "rejected", cells: null, feedback: ["Synthetic precheck refusal."] }),
      round({ iteration: 2 }),
      round({ iteration: 2, kind: "confirmation", result: "not_qualified", feedback: ["Synthetic result did not repeat."] }),
    ];
    const events = [started(1), stage(2, "writing", 1), stage(3, "prechecking", 1),
      event(4, { type: "round_finished", lane_id: "lane-1", data: required(rounds[0]) }),
      stage(5, "revising", 2), stage(6, "prechecking", 2), stage(7, "qualifying", 2),
      event(8, { type: "round_finished", lane_id: "lane-1", data: required(rounds[1]) }),
      stage(9, "confirming", 2),
      event(10, { type: "round_finished", lane_id: "lane-1", data: required(rounds[2]) }),
      stage(11, "not_qualified", 2),
      event(12, { type: "lane_finished", lane_id: "lane-1", data: { outcome: "not_qualified", reason: "did not repeat" } }),
    ];
    const lane = required(projectLanes(events, LANES, 1)[0]);
    expect(lane.rounds).toEqual(rounds);
    expect(lane).toMatchObject({ stage: "not_qualified", iteration: 2, outcome: "not_qualified" });
    required(required(lane.rounds[1]).cells).buggy.added_checks = "error";
    required(lane.rounds[0]).feedback.push("Local mutation.");
    expect(required(required(rounds[1]).cells).buggy.added_checks).toBe("fail");
    expect(required(rounds[0]).feedback).toHaveLength(1);
  });

  it("uses explicit lane outcomes for a confirmed winner and losing lanes", () => {
    const events = [started(1), started(2, "lane-2"),
      event(3, { type: "round_finished", lane_id: "lane-1", data: round({ kind: "confirmation" }) }),
      event(4, { type: "lane_finished", lane_id: "lane-1", data: { outcome: "won", reason: null } }),
      event(5, { type: "lane_finished", lane_id: "lane-2", data: { outcome: "lost_race", reason: null } }),
      event(6, { type: "packaging", lane_id: null, data: {} }),
      event(7, { type: "job_finished", lane_id: null, data: { outcome: "delivered", reason: null } }),
    ];
    const projected = projectLanes(events, LANES, 1);
    expect(projected[0]).toMatchObject({ stage: "won", outcome: "won" });
    expect(projected[1]).toMatchObject({ stage: "stopped", outcome: "lost_race" });
  });

  it("distinguishes infrastructure errors from cancellation and spend stops", () => {
    const events = [
      event(1, { type: "lane_finished", lane_id: "lane-1", data: { outcome: "error", reason: "Synthetic setup failure." } }),
      event(2, { type: "lane_finished", lane_id: "lane-2", data: { outcome: "cancelled", reason: null } }),
    ];
    expect(projectLanes(events, LANES, 1).map(({ stage, outcome }) => ({ stage, outcome }))).toEqual([
      { stage: "error", outcome: "error" }, { stage: "stopped", outcome: "cancelled" },
    ]);
    expect(projectLanes([event(1, { type: "lane_finished", lane_id: "lane-1", data: { outcome: "spend_cap", reason: null } })], LANES, 1)[0])
      .toMatchObject({ stage: "stopped", outcome: "spend_cap" });
  });

  it("retains a recorded lane identity even when it is absent from current configuration", () => {
    const events = [started(1, "lane-4"), event(2, { type: "lane_stage", lane_id: "lane-4", data: { stage: "writing", iteration: 1 } })];
    expect(projectLanes(events, LANES, 1)[2]).toMatchObject({ lane_id: "lane-4", model: "synthetic/recorded-model", model_label: "Recorded Model", stage: "writing" });
  });

  it("preserves the last lane evidence when production finishes a lost builder job", () => {
    const events = [started(1), stage(2, "writing", 1), stage(3, "prechecking", 1), stage(4, "revising", 2), stage(5, "prechecking", 2), stage(6, "qualifying", 2),
      event(7, { type: "job_finished", lane_id: null, data: { outcome: "builder_lost", reason: "Builder heartbeat expired." } }),
    ];
    expect(projectLanes(events, LANES, 1)[0]).toMatchObject({ stage: "qualifying", iteration: 2, outcome: null });
  });
  const toQualifying = (lane_id: LaneId = "lane-1"): OtfEvent[] => [
    started(1, lane_id), stage(2, "writing", 1, lane_id), stage(3, "prechecking", 1, lane_id), stage(4, "qualifying", 1, lane_id),
  ];

  it("allows qualifying -> won only when the job runs no confirmation round", () => {
    const events = [...toQualifying(), stage(5, "won", 1)];
    expect(projectLanes(events, LANES, 1)[0]).toMatchObject({ stage: "qualifying" });
    expect(projectLanes(events, LANES, 0)[0]).toMatchObject({ stage: "won", iteration: 1 });
  });

  it("ignores moves the contract does not allow and follows nextIteration", () => {
    const events = [started(1), stage(2, "qualifying", 1), stage(3, "writing", 3), stage(4, "revising", 3)];
    expect(projectLanes(events, LANES, 1)[0]).toMatchObject({ stage: "writing", iteration: 1 });
    const finished = [...toQualifying(), event(5, { type: "lane_finished", lane_id: "lane-1", data: { outcome: "error", reason: null } }), stage(6, "revising", 2)];
    expect(projectLanes(finished, LANES, 1)[0]).toMatchObject({ stage: "error", outcome: "error", iteration: 1 });
  });

  it("copies an admission round's result through", () => {
    const admission = {
      decisions: { adm_02: "pass", adm_03: "pass", adm_04: "reject", adm_05: "not_run", adm_06: "not_run" },
      comparison: "not_run", alternative_fix: "not_run",
    } as const;
    const data = round({ result: "not_qualified", admission: structuredClone(admission) });
    const lane = required(projectLanes([...toQualifying(), event(5, { type: "round_finished", lane_id: "lane-1", data })], LANES, 0)[0]);
    expect(required(lane.rounds[0]).admission).toEqual(admission);
  });

  it("shows a time_limit lane as stopped", () => {
    const events = [...toQualifying(), stage(5, "stopped", 1), event(6, { type: "lane_finished", lane_id: "lane-1", data: { outcome: "time_limit", reason: null } })];
    expect(projectLanes(events, LANES, 0)[0]).toMatchObject({ stage: "stopped", outcome: "time_limit" });
  });

  it("keeps the selected winner won when a customer stop arrives after winner_selected", () => {
    const events = [...toQualifying(), started(5, "lane-2"),
      stage(6, "won", 1),
      event(7, { type: "winner_selected", lane_id: null, data: { lane_id: "lane-1", candidate_id: "synthetic-candidate", qualified_at_iteration: 1 } }),
      stage(8, "stopped", 1),
      event(9, { type: "lane_finished", lane_id: "lane-1", data: { outcome: "cancelled", reason: null } }),
      stage(10, "stopped", 0, "lane-2"),
      event(11, { type: "lane_finished", lane_id: "lane-2", data: { outcome: "cancelled", reason: null } }),
    ];
    const projected = projectLanes(events, LANES, 0);
    expect(projected[0]).toMatchObject({ stage: "won", outcome: "won" });
    expect(projected[1]).toMatchObject({ stage: "stopped", outcome: "cancelled" });
  });
});
