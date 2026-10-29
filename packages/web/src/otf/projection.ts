import type { LaneId, LaneOutcome, LaneStage, LaneView, OtfEvent } from "./contract.ts";

const FINISHED_STAGES: Record<LaneOutcome, LaneStage> = {
  won: "won",
  lost_race: "stopped",
  not_qualified: "not_qualified",
  spend_cap: "stopped",
  error: "error",
  cancelled: "stopped",
};

function emptyLane(lane: { lane_id: LaneId; model: string; model_label: string }): LaneView {
  return {
    ...lane,
    stage: "queued",
    iteration: 0,
    files: { change: false, checks: 0, fix: false },
    meter: { tokens_in: 0, tokens_out: 0, requests: 0, cost_microusd: 0 },
    rounds: [],
    outcome: null,
  };
}

/** SPEC §1/§2.2: project the complete event history, independently of the response's after cursor. */
export function projectLanes(
  events: readonly OtfEvent[],
  configuredLanes: readonly { lane_id: LaneId; model: string; model_label: string }[],
): LaneView[] {
  const lanes = new Map(configuredLanes.map(lane => [lane.lane_id, emptyLane(lane)]));
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === "winner_selected") {
      const lane = lanes.get(event.data.lane_id);
      // Selection identifies a candidate; confirmation and lane_finished determine its outcome.
      if (lane?.outcome === null) lane.stage = "confirming";
      continue;
    }
    if (event.lane_id === null) continue;
    let lane = lanes.get(event.lane_id);
    if (event.type === "lane_started") {
      if (!lane) {
        lane = emptyLane({ lane_id: event.lane_id, model: event.data.model, model_label: event.data.model_label });
        lanes.set(event.lane_id, lane);
      }
      lane.model = event.data.model;
      lane.model_label = event.data.model_label;
      if (lane.stage === "queued") lane.stage = "setting_up";
    }
    if (!lane) continue;
    switch (event.type) {
      case "lane_started":
        break;
      case "lane_stage":
        lane.stage = event.data.stage;
        lane.iteration = event.data.iteration;
        break;
      case "lane_files":
        lane.files = { ...event.data };
        break;
      case "lane_meter":
        lane.meter = { ...event.data };
        break;
      case "round_finished":
        lane.rounds.push(structuredClone(event.data));
        lane.iteration = event.data.iteration;
        if (event.data.kind === "qualification" && event.data.result === "qualified" && lane.outcome === null) lane.stage = "confirming";
        break;
      case "lane_finished":
        lane.outcome = event.data.outcome;
        lane.stage = FINISHED_STAGES[event.data.outcome];
        break;
    }
  }
  return [...lanes.values()];
}
