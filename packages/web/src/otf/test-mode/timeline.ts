// OTF test mode: the scripted timeline of one SYNTHETIC on-the-fly job. Every model name, check
// name, file name and feedback line here is invented for local development and browser proofs; none
// of it is real bug content, and no model or machine is ever called. The timeline is pure data on
// script time (milliseconds from the job's creation, or from its claim for builder steps), so a
// caller's injected clock decides how fast it plays: the tests run it at once, the local test-mode
// world plays it compressed (fake-builder.ts).
//
// It also holds the lane stage order that test mode keeps (LANE_STAGE_NEXT) and a checker for a
// whole event stream (checkOtfSequence), which the tests run on every scenario.
import {
  AGENT_LABEL,
  EXPECTED_CELLS,
  OTF_DEFAULTS,
  type BuildJobLane,
  type BuilderEvent,
  type CellValue,
  type CopyState,
  type LaneFiles,
  type LaneId,
  type LaneMeter,
  type LaneOutcome,
  type LaneStage,
  type OtfEvent,
  type OtfOutcome,
  type ProductionEvent,
  type RoundResult,
  type SixCells,
  type StartFailureReason,
} from "../contract.ts";

export const OTF_TEST_SCENARIOS = ["delivered", "not_qualified", "builder_start_failed", "time_limit"] as const;
export type OtfTestScenario = (typeof OTF_TEST_SCENARIOS)[number];

export function isOtfTestScenario(value: unknown): value is OtfTestScenario {
  return typeof value === "string" && (OTF_TEST_SCENARIOS as readonly string[]).includes(value);
}

// Three invented lanes: invented model ids, labels and prices (USD per million tokens).
const LANE_A: BuildJobLane = { lane_id: "lane-1", model: "synthetic/lane-model-a", model_label: "Synthetic Model A", price_in_usd_per_m: "0.20", price_out_usd_per_m: "0.60" };
const LANE_B: BuildJobLane = { lane_id: "lane-2", model: "synthetic/lane-model-b", model_label: "Synthetic Model B", price_in_usd_per_m: "0.10", price_out_usd_per_m: "0.40" };
const LANE_C: BuildJobLane = { lane_id: "lane-3", model: "synthetic/lane-model-c", model_label: "Synthetic Model C", price_in_usd_per_m: "0.50", price_out_usd_per_m: "1.50" };
export const TEST_LANES: readonly BuildJobLane[] = Object.freeze([LANE_A, LANE_B, LANE_C]);

export const TEST_PRESET = "synthetic-preset-16vcpu";
export const TEST_BUILDER_REVISION = "synthetic-builder-0001";
/** The fake cold start: from the start request to the builder's first healthy claim. */
export const TEST_COLD_START_MS = 95_000;
/** lane_meter at most every 10 s per lane (contract); test mode sends one every 30 s of agent time. */
const METER_EVERY_MS = 30_000;
const METER_MIN_GAP_MS = 10_000;

/** One builder event on script time: milliseconds from the job's claim. */
export interface ScriptStep {
  at_ms: number;
  event: BuilderEvent;
}

export interface ScenarioScript {
  scenario: OtfTestScenario;
  lanes: readonly BuildJobLane[];
  /** Set when the machine never starts: the start request fails with this reason. */
  start_failure: Exclude<StartFailureReason, "timeout"> | null;
  /** From the job's creation to builder_ready, which the same healthy claim follows with job_claimed. */
  cold_start_ms: number;
  /** The builder's events, from the claim, in posting order. Empty when the machine never starts. */
  steps: ScriptStep[];
  /** The builder's result post, from the claim (from the creation when start_failure is set). */
  result: { at_ms: number; outcome: OtfOutcome; reason: string | null };
  /** The confirmed winner, for the certificate; null unless delivered. */
  winner: { lane_id: LaneId; model: string; qualified_at_ms: number; rounds_used: 1 | 2 | 3; candidate_id: string } | null;
}

// ---- invented six-cell results and feedback lines

type CellPair = readonly [CellValue, CellValue];
function six(over: Partial<Record<CopyState, CellPair>> = {}): SixCells {
  const pair = (state: CopyState): { original_suite: CellValue; added_checks: CellValue } => {
    const given = over[state];
    return given === undefined ? { ...EXPECTED_CELLS[state] } : { original_suite: given[0], added_checks: given[1] };
  };
  return { clean: pair("clean"), buggy: pair("buggy"), fixed: pair("fixed") };
}

function cellsQualify(cells: SixCells): boolean {
  return (["clean", "buggy", "fixed"] as const).every(
    (state) => cells[state].original_suite === EXPECTED_CELLS[state].original_suite && cells[state].added_checks === EXPECTED_CELLS[state].added_checks,
  );
}

type RoundPlan = { kind: "precheck_rejected"; feedback: string[] } | { kind: "qualification"; cells: SixCells; feedback: string[] };

const NOT_CAUGHT: RoundPlan = {
  kind: "qualification",
  cells: six({ buggy: ["pass", "pass"] }),
  feedback: [
    "Buggy copy: the added checks passed on 3 of 3 instances; they must fail there.",
    "Check synthetic-overlap-write passed on the buggy copy, so it does not detect the change.",
  ],
};
const BREAKS_SUITE: RoundPlan = {
  kind: "qualification",
  cells: six({ buggy: ["fail", "fail"] }),
  feedback: [
    "Buggy copy: the original suite failed on 2 of 3 instances; the change must leave it passing.",
    "Failing original test: synthetic-list-order.",
  ],
};
const FIX_FAILS: RoundPlan = {
  kind: "qualification",
  cells: six({ fixed: ["pass", "fail"] }),
  feedback: [
    "Fixed copy: the added checks failed on 1 of 3 instances; the reference fix must make them pass.",
    "Check synthetic-retry-window failed on the fixed copy.",
  ],
};
const PRECHECK_REJECTED: RoundPlan = {
  kind: "precheck_rejected",
  feedback: ["Precheck: no check file was found under synthetic-checks/; write at least one before qualifying."],
};
const QUALIFIES: RoundPlan = { kind: "qualification", cells: six(), feedback: ["All six cells matched the expected cells."] };

// ---- one lane's track

interface Pace {
  setup_ms: number;
  write_ms: number;
  revise_ms: number;
  precheck_ms: number;
  qualify_ms: number;
  confirm_ms: number;
}

const QUICK: Pace = { setup_ms: 35_000, write_ms: 150_000, revise_ms: 110_000, precheck_ms: 20_000, qualify_ms: 140_000, confirm_ms: 140_000 };
/** time_limit: long agent sessions, so no lane finishes its rounds before the 45-minute deadline. */
const SLOW: Pace = { ...QUICK, write_ms: 900_000, revise_ms: 800_000 };

const FIRST_FILES: readonly LaneFiles[] = [
  { change: true, checks: 0, fix: false },
  { change: true, checks: 2, fix: false },
  { change: true, checks: 2, fix: true },
];
const REVISED_FILES: readonly LaneFiles[] = [{ change: true, checks: 3, fix: true }];

interface LaneTrack {
  lane: BuildJobLane;
  steps: ScriptStep[];
  /** When the lane's confirmation round qualified; null when it never did. */
  confirmedAt: number | null;
  roundsUsed: number;
}

function microusd(lane: BuildJobLane, meter: Omit<LaneMeter, "cost_microusd">): number {
  // USD per million tokens equals micro-USD per token.
  return Math.round(meter.tokens_in * Number(lane.price_in_usd_per_m) + meter.tokens_out * Number(lane.price_out_usd_per_m));
}

/** One lane through its planned rounds. The job-level ending (won, lost race, deadline) is applied afterwards. */
function laneTrack(lane: BuildJobLane, index: number, pace: Pace, rounds: readonly RoundPlan[], confirm: SixCells | null): LaneTrack {
  const factor = 1 + index * 0.15;
  const steps: ScriptStep[] = [];
  const meter = { tokens_in: 0, tokens_out: 0, requests: 0 };
  let t = 2_000 + index * 500;
  const push = (at: number, event: BuilderEvent): void => {
    steps.push({ at_ms: Math.round(at), event });
  };
  const id = lane.lane_id;
  const stage = (s: LaneStage, iteration: number): void => {
    push(t, { type: "lane_stage", lane_id: id, data: { stage: s, iteration } });
  };
  // An agent session: meter ticks every 30 s and the files appearing at even fractions of it.
  const session = (ms: number, files: readonly LaneFiles[]): void => {
    const start = t;
    const timed: ScriptStep[] = [];
    for (let at = start + METER_EVERY_MS; at < start + ms; at += METER_EVERY_MS) {
      meter.tokens_in += 45_000 + 5_000 * index;
      meter.tokens_out += 1_200 + 100 * index;
      meter.requests += 3;
      timed.push({ at_ms: Math.round(at), event: { type: "lane_meter", lane_id: id, data: { ...meter, cost_microusd: microusd(lane, meter) } } });
    }
    files.forEach((data, k) => {
      timed.push({ at_ms: Math.round(start + (ms * (k + 1)) / (files.length + 1)) + 1, event: { type: "lane_files", lane_id: id, data: { ...data } } });
    });
    timed.sort((a, b) => a.at_ms - b.at_ms);
    steps.push(...timed);
    t = start + ms;
  };

  push(t, { type: "lane_started", lane_id: id, data: { model: lane.model, model_label: lane.model_label, agent: AGENT_LABEL } });
  stage("setting_up", 0);
  t += pace.setup_ms + index * 5_000;
  let confirmedAt: number | null = null;
  let roundsUsed = 0;
  for (const [k, plan] of rounds.entries()) {
    const iteration = (k + 1) as 1 | 2 | 3;
    roundsUsed = iteration;
    const sessionMs = (k === 0 ? pace.write_ms : pace.revise_ms) * factor;
    stage(k === 0 ? "writing" : "revising", iteration);
    session(sessionMs, k === 0 ? FIRST_FILES : REVISED_FILES);
    stage("prechecking", iteration);
    t += pace.precheck_ms;
    const gooseMs = Math.round(sessionMs);
    const last = iteration === OTF_DEFAULTS.max_rounds;
    if (plan.kind === "precheck_rejected") {
      push(t, { type: "round_finished", lane_id: id, data: { iteration, kind: "precheck_rejected", result: "rejected", cells: null, feedback: [...plan.feedback], goose_ms: gooseMs, qualify_ms: null } });
      if (last) break;
      continue;
    }
    stage("qualifying", iteration);
    t += pace.qualify_ms;
    const qualified = cellsQualify(plan.cells);
    const round: RoundResult = {
      iteration,
      kind: "qualification",
      result: qualified ? "qualified" : "not_qualified",
      cells: structuredClone(plan.cells),
      feedback: [...plan.feedback],
      goose_ms: gooseMs,
      qualify_ms: pace.qualify_ms,
    };
    push(t, { type: "round_finished", lane_id: id, data: round });
    if (qualified && confirm !== null) {
      stage("confirming", iteration);
      t += pace.confirm_ms;
      const repeated = cellsQualify(confirm);
      push(t, {
        type: "round_finished",
        lane_id: id,
        data: { iteration, kind: "confirmation", result: repeated ? "qualified" : "not_qualified", cells: structuredClone(confirm), feedback: repeated ? ["The confirmation round repeated all six cells."] : ["The confirmation round did not repeat the six cells."], goose_ms: null, qualify_ms: pace.confirm_ms },
      });
      if (repeated) {
        confirmedAt = t;
        stage("won", iteration);
      } else {
        stage("not_qualified", iteration);
        push(t, { type: "lane_finished", lane_id: id, data: { outcome: "not_qualified", reason: "did not repeat" } });
      }
      return { lane, steps, confirmedAt, roundsUsed };
    }
    if (last) break;
  }
  // A lane that used every round without a confirmed result ends not_qualified here.
  if (roundsUsed === rounds.length && rounds.length === OTF_DEFAULTS.max_rounds) {
    stage("not_qualified", roundsUsed);
    push(t, { type: "lane_finished", lane_id: id, data: { outcome: "not_qualified", reason: `Used all ${String(OTF_DEFAULTS.max_rounds)} rounds without a qualifying result.` } });
  }
  return { lane, steps, confirmedAt, roundsUsed };
}

// ---- lane progress and stopping

export interface LaneProgress {
  iteration: number;
  stage: LaneStage | null;
  finished: boolean;
}

/** Each lane's current stage and iteration after these steps, in lane order. */
export function laneProgress(steps: readonly ScriptStep[]): Map<LaneId, LaneProgress> {
  const lanes = new Map<LaneId, LaneProgress>();
  for (const { event } of steps) {
    if (event.lane_id === null) continue;
    const lane = lanes.get(event.lane_id) ?? { iteration: 0, stage: null, finished: false };
    if (event.type === "lane_stage") {
      lane.stage = event.data.stage;
      lane.iteration = event.data.iteration;
    }
    if (event.type === "lane_finished") lane.finished = true;
    lanes.set(event.lane_id, lane);
  }
  return lanes;
}

/** Stops every lane that has not finished: lane_stage stopped, then lane_finished with this outcome. */
export function stopSteps(steps: readonly ScriptStep[], at_ms: number, outcome: LaneOutcome, reason: string): ScriptStep[] {
  const out: ScriptStep[] = [];
  for (const [lane_id, lane] of laneProgress(steps)) {
    if (lane.finished) continue;
    if (lane.stage !== "stopped") out.push({ at_ms, event: { type: "lane_stage", lane_id, data: { stage: "stopped", iteration: lane.iteration } } });
    out.push({ at_ms, event: { type: "lane_finished", lane_id, data: { outcome, reason } } });
  }
  return out;
}

/** Merges lane tracks into one posting order: by time, then lane order, then each lane's own order. */
function merge(tracks: readonly { steps: readonly ScriptStep[] }[]): ScriptStep[] {
  const keyed = tracks.flatMap((track, lane) => track.steps.map((step, k) => ({ step, lane, k })));
  keyed.sort((a, b) => a.step.at_ms - b.step.at_ms || a.lane - b.lane || a.k - b.k);
  return keyed.map((item) => item.step);
}

export const REASON_TEXT = {
  lost_race: "Another lane's bug was confirmed first.",
  deadline_lane: "The job deadline passed.",
  customer_lane: "Stopped by the customer.",
  time_limit: "The job reached its 45-minute deadline.",
  cancelled: "Stopped by the customer.",
  not_qualified: "No lane produced a bug that passed all six cells in 3 rounds.",
  capacity: "The Nebius machine could not start: no capacity for its preset.",
} as const;

// ---- the four scenarios

function deliveredScript(): ScenarioScript {
  const tracks = [
    laneTrack(LANE_A, 0, QUICK, [NOT_CAUGHT, QUALIFIES], six()),
    laneTrack(LANE_B, 1, QUICK, [BREAKS_SUITE, NOT_CAUGHT, FIX_FAILS], six()),
    laneTrack(LANE_C, 2, QUICK, [PRECHECK_REJECTED, FIX_FAILS, NOT_CAUGHT], six()),
  ];
  const confirmed = tracks.filter((track) => track.confirmedAt !== null);
  const winner = confirmed[0];
  if (winner?.confirmedAt == null) throw new Error("otf test mode: the delivered script has no confirmed lane");
  const at = winner.confirmedAt;
  // Every lane up to the confirmation, then the winner, then the others lose the race.
  const before = merge(tracks.map((track) => ({ steps: track.steps.filter((step) => step.at_ms <= at) })));
  const candidate = `cand-${winner.lane.lane_id}-r${String(winner.roundsUsed)}`;
  const won: ScriptStep[] = [
    { at_ms: at, event: { type: "winner_selected", lane_id: null, data: { lane_id: winner.lane.lane_id, candidate_id: candidate, qualified_at_iteration: winner.roundsUsed } } },
    { at_ms: at, event: { type: "lane_finished", lane_id: winner.lane.lane_id, data: { outcome: "won", reason: null } } },
  ];
  const lost = stopSteps([...before, ...won], at + 1_000, "lost_race", REASON_TEXT.lost_race);
  const steps = [...before, ...won, ...lost, { at_ms: at + 2_000, event: { type: "packaging", lane_id: null, data: {} } } satisfies ScriptStep];
  return {
    scenario: "delivered",
    lanes: TEST_LANES,
    start_failure: null,
    cold_start_ms: TEST_COLD_START_MS,
    steps,
    result: { at_ms: at + 20_000, outcome: "delivered", reason: null },
    winner: { lane_id: winner.lane.lane_id, model: winner.lane.model, qualified_at_ms: at, rounds_used: winner.roundsUsed as 1 | 2 | 3, candidate_id: candidate },
  };
}

function notQualifiedScript(): ScenarioScript {
  const tracks = [
    laneTrack(LANE_A, 0, QUICK, [NOT_CAUGHT, BREAKS_SUITE, FIX_FAILS], null),
    laneTrack(LANE_B, 1, QUICK, [PRECHECK_REJECTED, NOT_CAUGHT, NOT_CAUGHT], null),
    laneTrack(LANE_C, 2, QUICK, [FIX_FAILS, NOT_CAUGHT, BREAKS_SUITE], null),
  ];
  const steps = merge(tracks);
  const end = Math.max(...steps.map((step) => step.at_ms));
  return {
    scenario: "not_qualified",
    lanes: TEST_LANES,
    start_failure: null,
    cold_start_ms: TEST_COLD_START_MS,
    steps,
    result: { at_ms: end + 3_000, outcome: "not_qualified", reason: REASON_TEXT.not_qualified },
    winner: null,
  };
}

function timeLimitScript(): ScenarioScript {
  const deadline = OTF_DEFAULTS.deadline_ms;
  const tracks = [
    laneTrack(LANE_A, 0, SLOW, [NOT_CAUGHT, FIX_FAILS, NOT_CAUGHT], null),
    laneTrack(LANE_B, 1, SLOW, [BREAKS_SUITE, NOT_CAUGHT, NOT_CAUGHT], null),
    laneTrack(LANE_C, 2, SLOW, [PRECHECK_REJECTED, NOT_CAUGHT, FIX_FAILS], null),
  ];
  const before = merge(tracks.map((track) => ({ steps: track.steps.filter((step) => step.at_ms < deadline) })));
  if (before.some((step) => step.event.type === "lane_finished")) throw new Error("otf test mode: a time_limit lane finished before the deadline");
  return {
    scenario: "time_limit",
    lanes: TEST_LANES,
    start_failure: null,
    cold_start_ms: TEST_COLD_START_MS,
    steps: [...before, ...stopSteps(before, deadline, "cancelled", REASON_TEXT.deadline_lane)],
    result: { at_ms: deadline + 2_000, outcome: "time_limit", reason: REASON_TEXT.time_limit },
    winner: null,
  };
}

function startFailedScript(): ScenarioScript {
  return {
    scenario: "builder_start_failed",
    lanes: TEST_LANES,
    start_failure: "capacity",
    cold_start_ms: 0,
    steps: [],
    result: { at_ms: 0, outcome: "builder_start_failed", reason: REASON_TEXT.capacity },
    winner: null,
  };
}

/** The script of one scenario. Deterministic: the same scenario always gives the same script. */
export function scenarioScript(scenario: OtfTestScenario): ScenarioScript {
  switch (scenario) {
    case "delivered":
      return deliveredScript();
    case "not_qualified":
      return notQualifiedScript();
    case "time_limit":
      return timeLimitScript();
    case "builder_start_failed":
      return startFailedScript();
  }
}

/** The last lane_meter of each lane among these steps. */
export function lastMeters(steps: readonly ScriptStep[]): Map<LaneId, LaneMeter> {
  const meters = new Map<LaneId, LaneMeter>();
  for (const { event } of steps) if (event.type === "lane_meter") meters.set(event.lane_id, { ...event.data });
  return meters;
}

// ---- the whole stream, as the customer's status would carry it

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The full event stream of one job created at `created_at` with the builder stopped, on script time
 * (one script millisecond per real millisecond): production's own events and the builder's, with
 * public seq from 1, as production would store them. The reference sequence the fake builder plays.
 */
export function scenarioEvents(scenario: OtfTestScenario, created_at: string): OtfEvent[] {
  const script = scenarioScript(scenario);
  const created = Date.parse(created_at);
  const timed: { at: number; event: ProductionEvent | BuilderEvent }[] = [];
  timed.push({ at: created, event: { type: "builder_starting", lane_id: null, data: { preset: TEST_PRESET, requested_at: iso(created) } } });
  if (script.start_failure !== null) {
    timed.push({ at: created + script.result.at_ms, event: { type: "builder_start_failed", lane_id: null, data: { reason: script.start_failure } } });
  } else {
    // One healthy claim moves the job to queued (builder_ready) and hands it out (job_claimed).
    const claim = created + script.cold_start_ms;
    timed.push({ at: claim, event: { type: "builder_ready", lane_id: null, data: { cold_start_ms: script.cold_start_ms } } });
    timed.push({ at: claim, event: { type: "job_claimed", lane_id: null, data: { builder_revision: TEST_BUILDER_REVISION } } });
    for (const step of script.steps) timed.push({ at: claim + step.at_ms, event: step.event });
  }
  const finishedAt = script.start_failure !== null ? created + script.result.at_ms : created + script.cold_start_ms + script.result.at_ms;
  timed.push({ at: finishedAt, event: { type: "job_finished", lane_id: null, data: { outcome: script.result.outcome, reason: script.result.reason } } });
  return timed.map(({ at, event }, index) => ({ seq: index + 1, at: iso(at), ...structuredClone(event) }));
}

// ---- the legal order

/** The lane stage moves test mode keeps; a terminal stage has none. */
export const LANE_STAGE_NEXT: Readonly<Record<LaneStage, readonly LaneStage[]>> = Object.freeze({
  queued: ["setting_up", "stopped", "error"],
  setting_up: ["writing", "stopped", "error"],
  writing: ["prechecking", "stopped", "error"],
  // A precheck rejection sends the lane to revising, or ends it when it was the last round.
  prechecking: ["qualifying", "revising", "not_qualified", "stopped", "error"],
  qualifying: ["confirming", "revising", "not_qualified", "stopped", "error"],
  revising: ["prechecking", "stopped", "error"],
  // A confirmation that does not repeat ends the lane not_qualified ("did not repeat").
  confirming: ["won", "not_qualified", "stopped", "error"],
  won: [],
  stopped: [],
  not_qualified: [],
  error: [],
});

/** Which lane outcomes each terminal stage may end with. */
const OUTCOME_FOR_STAGE: Readonly<Partial<Record<LaneStage, readonly LaneOutcome[]>>> = {
  won: ["won"],
  stopped: ["lost_race", "cancelled", "spend_cap"],
  not_qualified: ["not_qualified"],
  error: ["error"],
};

/**
 * The problems in one job's event stream (empty when it is legal): seq gap-free from 1, times in
 * order, job_finished once and last, every lane's stages along LANE_STAGE_NEXT with its iteration
 * moving only on revising, rounds only where a round runs, meters at most every 10 s, files only
 * growing, and a delivered job with a winner and packaging before it finished.
 */
export function checkOtfSequence(events: readonly OtfEvent[]): string[] {
  const problems: string[] = [];
  interface Lane {
    stage: LaneStage | null;
    iteration: number;
    finished: boolean;
    meterAt: number | null;
    files: LaneFiles | null;
    rounds: number;
  }
  const lanes = new Map<LaneId, Lane>();
  let lastAt = -Infinity;
  let winner: LaneId | null = null;
  let packaging = false;
  let finished: OtfOutcome | null = null;
  for (const [index, event] of events.entries()) {
    const where = `seq ${String(event.seq)} (${event.type})`;
    if (event.seq !== index + 1) problems.push(`${where}: seq is not gap-free from 1`);
    const at = Date.parse(event.at);
    if (at < lastAt) problems.push(`${where}: time goes backwards`);
    lastAt = at;
    if (finished !== null) problems.push(`${where}: after job_finished`);
    if (event.lane_id === null) {
      if (event.type === "winner_selected") {
        if (winner !== null) problems.push(`${where}: a second winner`);
        winner = event.data.lane_id;
        if (lanes.get(winner)?.stage !== "won") problems.push(`${where}: the winner's lane is not at won`);
      }
      if (event.type === "packaging") {
        if (winner === null) problems.push(`${where}: packaging without a winner`);
        packaging = true;
      }
      if (event.type === "job_finished") finished = event.data.outcome;
      continue;
    }
    const id = event.lane_id;
    if (event.type === "lane_started") {
      if (lanes.has(id)) problems.push(`${where}: ${id} started twice`);
      lanes.set(id, { stage: null, iteration: 0, finished: false, meterAt: null, files: null, rounds: 0 });
      continue;
    }
    const lane = lanes.get(id);
    if (lane === undefined) {
      problems.push(`${where}: ${id} has events before lane_started`);
      continue;
    }
    if (lane.finished) problems.push(`${where}: ${id} has events after lane_finished`);
    switch (event.type) {
      case "lane_stage": {
        const next = event.data.stage;
        const allowed: readonly LaneStage[] = lane.stage === null ? ["queued", "setting_up"] : LANE_STAGE_NEXT[lane.stage];
        if (!allowed.includes(next)) problems.push(`${where}: ${id} moved ${lane.stage ?? "(start)"} -> ${next}`);
        const expectIteration = next === "revising" ? lane.iteration + 1 : next === "writing" ? 1 : lane.iteration;
        if (event.data.iteration !== expectIteration) problems.push(`${where}: ${id} iteration ${String(event.data.iteration)}, expected ${String(expectIteration)}`);
        if (event.data.iteration > OTF_DEFAULTS.max_rounds) problems.push(`${where}: ${id} is past its last round`);
        lane.stage = next;
        lane.iteration = event.data.iteration;
        break;
      }
      case "lane_meter":
        if (lane.meterAt !== null && at - lane.meterAt < METER_MIN_GAP_MS) problems.push(`${where}: ${id} meter less than 10 s after the last`);
        lane.meterAt = at;
        break;
      case "lane_files":
        if (lane.files !== null && (event.data.checks < lane.files.checks || (lane.files.change && !event.data.change) || (lane.files.fix && !event.data.fix))) {
          problems.push(`${where}: ${id} files went backwards`);
        }
        if (lane.stage !== "writing" && lane.stage !== "revising") problems.push(`${where}: ${id} wrote files outside writing or revising`);
        lane.files = { ...event.data };
        break;
      case "round_finished": {
        const round = event.data;
        const stageFor = round.kind === "precheck_rejected" ? "prechecking" : round.kind === "qualification" ? "qualifying" : "confirming";
        if (lane.stage !== stageFor) problems.push(`${where}: ${id} ${round.kind} round while ${lane.stage ?? "(no stage)"}`);
        if (round.iteration !== lane.iteration) problems.push(`${where}: ${id} round iteration ${String(round.iteration)} at lane iteration ${String(lane.iteration)}`);
        if ((round.kind === "precheck_rejected") !== (round.cells === null)) problems.push(`${where}: ${id} cells must be null exactly for a precheck rejection`);
        if (round.kind === "qualification" && round.cells !== null && (round.result === "qualified") !== cellsQualify(round.cells)) problems.push(`${where}: ${id} result does not match its cells`);
        if (round.kind !== "confirmation") lane.rounds += 1;
        if (lane.rounds > OTF_DEFAULTS.max_rounds) problems.push(`${where}: ${id} used more than ${String(OTF_DEFAULTS.max_rounds)} rounds`);
        break;
      }
      case "lane_finished": {
        const terminal = lane.stage === null ? undefined : OUTCOME_FOR_STAGE[lane.stage];
        if (terminal?.includes(event.data.outcome) !== true) problems.push(`${where}: ${id} finished ${event.data.outcome} from stage ${lane.stage ?? "(none)"}`);
        if (event.data.outcome === "lost_race" && winner === null) problems.push(`${where}: ${id} lost the race before a winner was selected`);
        lane.finished = true;
        break;
      }
    }
  }
  if (finished === null) problems.push("the stream has no job_finished");
  if (finished === "delivered" && (winner === null || !packaging)) problems.push("delivered without winner_selected and packaging");
  if (finished !== null && finished !== "delivered" && winner !== null) problems.push(`finished ${finished} with a winner`);
  if (finished !== null) for (const [id, lane] of lanes) if (!lane.finished) problems.push(`${id} never finished`);
  return problems;
}
