import { LANE_STAGE_NEXT, nextIteration, type LaneId, type LaneOutcome, type LaneStage, type LaneView, type OtfEvent } from "./contract.ts";

const FINISHED_STAGES: Record<LaneOutcome, LaneStage> = {
  won: "won",
  lost_race: "stopped",
  not_qualified: "not_qualified",
  spend_cap: "stopped",
  time_limit: "stopped",
  error: "error",
  cancelled: "stopped",
};
const MAX_ITERATION = 3;

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

/** A legal stage move per the contract; qualifying -> won only on a job with confirm_rounds 0. */
function legalMove(from: LaneStage, to: LaneStage, confirmRounds: 0 | 1): boolean {
  if (from === "qualifying" && to === "won") return confirmRounds === 0;
  return LANE_STAGE_NEXT[from].includes(to);
}

/**
 * SPEC sections 1 and 2.2: project the complete event history, independently of the response's
 * after cursor. A stage move the contract does not allow is ignored, and the iteration follows
 * nextIteration. The selected winner stays won, so a customer stop after winner_selected still
 * reads as a delivered win.
 */
export function projectLanes(
  events: readonly OtfEvent[],
  configuredLanes: readonly { lane_id: LaneId; model: string; model_label: string }[],
  confirmRounds: 0 | 1,
): LaneView[] {
  const lanes = new Map(configuredLanes.map(lane => [lane.lane_id, emptyLane(lane)]));
  let winner: LaneId | null = null;
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === "winner_selected") {
      winner = event.data.lane_id;
      const lane = lanes.get(winner);
      if (lane !== undefined && (lane.outcome === null || lane.outcome === "won")) lane.stage = "won";
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
      case "lane_stage": {
        const stage = event.data.stage;
        if (lane.outcome !== null || stage === lane.stage || !legalMove(lane.stage, stage, confirmRounds)) break;
        lane.stage = stage;
        lane.iteration = Math.min(MAX_ITERATION, nextIteration(stage, lane.iteration));
        break;
      }
      case "lane_files":
        lane.files = { ...event.data };
        break;
      case "lane_meter":
        lane.meter = { ...event.data };
        break;
      case "round_finished":
        // Admission hosts carry round_finished.admission; it is copied through with the round.
        lane.rounds.push(structuredClone(event.data));
        break;
      case "lane_finished": {
        if (lane.outcome !== null) break;
        // The selected winner delivers even when a stop reaches its lane afterwards.
        const outcome: LaneOutcome = event.lane_id === winner ? "won" : event.data.outcome;
        lane.outcome = outcome;
        lane.stage = FINISHED_STAGES[outcome];
        break;
      }
    }
  }
  return [...lanes.values()];
}
