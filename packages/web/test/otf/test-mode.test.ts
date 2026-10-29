// OTF test mode: every scenario's synthetic event stream validates against the contract's schemas and
// keeps the legal stage order, and the fake builder plays the same stream through the store and power
// ports on an injected clock. Every value is invented; no machine or model is called.
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createSha256, specSha256 } from "../../src/otf/canonical.ts";
import {
  ADMISSION_EVIDENCE,
  BUILDER_EVENT_TYPES,
  CALENDAR_MARGIN_MS,
  CRITERION_HOST,
  EXPECTED_CELLS,
  OTF_DEFAULTS,
  OTF_HOST_IDS,
  PART_MAX_BYTES_BY_PART,
  PRODUCTION_EVENT_TYPES,
  START_TIMEOUT_MS,
  StartError,
  criteriaOf,
  hostCalendarOpen,
  type BuilderEventIn,
  type OtfAvailability,
  type OtfCreateJob,
  type OtfEvent,
  type OtfHostId,
  type OtfSpecCard,
} from "../../src/otf/contract.ts";
import { validateOtf } from "../../src/otf/schemas.ts";
import { createMemoryOtfStore } from "../../src/otf/store.ts";
import { OTF_TEST_GRADER_SENTINEL, OtfTestModeRefusedError, OtfTestWorld, claimHosts, otfTestMode, otfTestWorld, syntheticDelivery } from "../../src/otf/test-mode/fake-builder.ts";
import {
  OTF_TEST_JOB_SCENARIOS,
  OTF_TEST_SCENARIOS,
  REASON_TEXT,
  SCENARIO_HOST,
  TEST_CALENDAR_BLOCKED_AT,
  TEST_HOSTS,
  TEST_PRESET,
  UMAMI_CALENDAR_REASON,
  checkOtfSequence,
  scenarioEvents,
  scenarioRefusal,
  scenarioScript,
  type OtfTestJobScenario,
} from "../../src/otf/test-mode/timeline.ts";

const T0 = "2026-10-29T10:00:00.000Z";
const JOB = "00000000-0000-4000-8000-000000000004";
const SPEC: OtfSpecCard = {
  title: "Synthetic: a saved value can go missing",
  where: "An invented list component that saves values.",
  change: "Two quick saves can drop one value.",
  why_tests_miss: "The invented suite saves one value at a time.",
  checks_to_add: ["Two overlapping saves both appear in the list."],
  fix: "Apply the saves in order.",
};
const UMAMI_SPEC: OtfSpecCard = {
  title: "Synthetic: a late visit lands on the next day",
  where: "An invented daily report that groups visits by day.",
  change: "A visit just after midnight in a far time zone is counted on the wrong day.",
  why_tests_miss: "The invented suite only uses visits at noon UTC.",
  checks_to_add: ["A visit at 00:30 in a far time zone appears on its own local day."],
  fix: "Group the visits by the viewer's time zone.",
};
const host = (scenario: OtfTestJobScenario): { host_id: OtfHostId } => ({ host_id: SCENARIO_HOST[scenario] });

const types = (events: readonly OtfEvent[]): string[] => events.map((event) => event.type);
const ofLane = (events: readonly OtfEvent[], lane: string) => events.filter((event) => event.lane_id === lane);

describe("the scenario timelines", () => {
  it.each(OTF_TEST_JOB_SCENARIOS)("%s: every event validates as OtfEvent and the order is legal", (scenario) => {
    const events = scenarioEvents(scenario, T0);
    expect(events.length).toBeGreaterThan(2);
    for (const event of events) expect(validateOtf("OtfEvent", event), `${String(event.seq)} ${event.type}`).toEqual([]);
    expect(checkOtfSequence(events, host(scenario))).toEqual([]);
    // task-report rounds never carry an admission result.
    if (SCENARIO_HOST[scenario] === "task-report") expect(events.every((event) => event.type !== "round_finished" || event.data.admission === null)).toBe(true);
    const known: readonly string[] = [...PRODUCTION_EVENT_TYPES, ...BUILDER_EVENT_TYPES];
    expect(events.every((event) => known.includes(event.type))).toBe(true);
    // The builder posts only builder event types, and each validates as posted.
    scenarioScript(scenario).steps.forEach((step, k) => {
      const posted: BuilderEventIn = { ...step.event, builder_seq: k + 1, at: T0 };
      expect(validateOtf("BuilderEventIn", posted)).toEqual([]);
    });
  });

  it("is deterministic", () => {
    for (const scenario of OTF_TEST_JOB_SCENARIOS) expect(scenarioEvents(scenario, T0)).toEqual(scenarioEvents(scenario, T0));
  });

  it("delivered: a fake cold start, three lanes, a failed then passing round, a confirmation, a winner and two lost races", () => {
    const events = scenarioEvents("delivered", T0);
    expect(types(events).slice(0, 3)).toEqual(["builder_starting", "builder_ready", "job_claimed"]);
    expect(events[0]).toMatchObject({ data: { preset: TEST_PRESET, requested_at: T0 } });
    expect(events[1]).toMatchObject({ data: { cold_start_ms: 95_000 } });
    const labels = events.flatMap((event) => (event.type === "lane_started" ? [event.data.model_label] : []));
    expect(new Set(labels).size).toBe(3);
    for (const lane of ["lane-1", "lane-2", "lane-3"]) {
      const own = types(ofLane(events, lane));
      expect(own).toContain("lane_files");
      expect(own).toContain("lane_meter");
    }
    const rounds = ofLane(events, "lane-1").flatMap((event) => (event.type === "round_finished" ? [event.data] : []));
    expect(rounds.map((round) => [round.iteration, round.kind, round.result])).toEqual([
      [1, "qualification", "not_qualified"],
      [2, "qualification", "qualified"],
      [2, "confirmation", "qualified"],
    ]);
    expect(rounds[0]?.feedback.length).toBeGreaterThan(0);
    expect(rounds[1]?.cells).toEqual(EXPECTED_CELLS);
    const finished = events.flatMap((event) => (event.type === "lane_finished" ? [[event.lane_id, event.data.outcome]] : []));
    expect(finished).toEqual([
      ["lane-1", "won"],
      ["lane-2", "lost_race"],
      ["lane-3", "lost_race"],
    ]);
    expect(types(events).slice(-2)).toEqual(["packaging", "job_finished"]);
    expect(events.at(-1)).toMatchObject({ data: { outcome: "delivered", reason: null } });
    expect(events.find((event) => event.type === "winner_selected")).toMatchObject({ data: { lane_id: "lane-1", qualified_at_iteration: 2 } });
  });

  it("not_qualified: every lane uses its 3 rounds and fails", () => {
    const events = scenarioEvents("not_qualified", T0);
    for (const lane of ["lane-1", "lane-2", "lane-3"]) {
      const rounds = ofLane(events, lane).flatMap((event) => (event.type === "round_finished" ? [event.data] : []));
      expect(rounds.map((round) => round.iteration)).toEqual([1, 2, 3]);
      expect(rounds.every((round) => round.result !== "qualified")).toBe(true);
      expect(ofLane(events, lane).at(-1)).toMatchObject({ type: "lane_finished", data: { outcome: "not_qualified" } });
    }
    expect(types(events)).not.toContain("winner_selected");
    expect(events.at(-1)).toMatchObject({ type: "job_finished", data: { outcome: "not_qualified", reason: REASON_TEXT.not_qualified } });
  });

  it("builder_start_failed: the start request fails for capacity and no lane runs", () => {
    const events = scenarioEvents("builder_start_failed", T0);
    expect(types(events)).toEqual(["builder_starting", "builder_start_failed", "job_finished"]);
    expect(events[1]).toMatchObject({ data: { reason: "capacity" } });
    expect(events[2]).toMatchObject({ data: { outcome: "builder_start_failed" } });
  });

  it("time_limit: the lanes are still revising at the 45-minute deadline and stop there with time_limit", () => {
    const events = scenarioEvents("time_limit", T0);
    const claimed = Date.parse(events.find((event) => event.type === "job_claimed")?.at ?? "");
    const finishedLanes = events.filter((event) => event.type === "lane_finished");
    expect(finishedLanes).toHaveLength(3);
    for (const event of finishedLanes) {
      expect(event).toMatchObject({ data: { outcome: "time_limit", reason: REASON_TEXT.deadline_lane } });
      expect(Date.parse(event.at) - claimed).toBe(45 * 60_000);
    }
    expect(events.at(-1)).toMatchObject({ type: "job_finished", data: { outcome: "time_limit", reason: "The job reached its 45-minute deadline." } });
  });

  it("umami_delivered: two lanes, an ADM-04 rejection in round 1, a round-2 win with no confirmation round", () => {
    const events = scenarioEvents("umami_delivered", T0);
    expect(types(events).slice(0, 3)).toEqual(["builder_starting", "builder_ready", "job_claimed"]);
    expect(events.filter((event) => event.type === "lane_started")).toHaveLength(2);
    const rounds = ofLane(events, "lane-1").flatMap((event) => (event.type === "round_finished" ? [event.data] : []));
    expect(rounds.map((round) => [round.iteration, round.kind, round.result])).toEqual([
      [1, "qualification", "not_qualified"],
      [2, "qualification", "qualified"],
    ]);
    expect(rounds[0]?.admission).toEqual({ decisions: { adm_02: "pass", adm_03: "pass", adm_04: "reject", adm_05: "not_run", adm_06: "not_run" }, comparison: "not_run", alternative_fix: "not_run" });
    expect(rounds[1]?.admission).toEqual({ decisions: { adm_02: "pass", adm_03: "pass", adm_04: "pass", adm_05: "pass", adm_06: "pass" }, comparison: "blind_spot_demonstrated", alternative_fix: "pass" });
    expect(rounds[1]?.cells).toEqual(EXPECTED_CELLS);
    // No confirmation round: the lane goes from qualifying straight to won.
    const stages = ofLane(events, "lane-1").flatMap((event) => (event.type === "lane_stage" ? [event.data.stage] : []));
    expect(stages.slice(-2)).toEqual(["qualifying", "won"]);
    expect(stages).not.toContain("confirming");
    expect(events.some((event) => event.type === "round_finished" && event.data.kind === "confirmation")).toBe(false);
    // A precheck rejection carries no cells and no admission result; every other Umami round carries both.
    const lane2 = ofLane(events, "lane-2").flatMap((event) => (event.type === "round_finished" ? [event.data] : []));
    expect(lane2[0]).toMatchObject({ kind: "precheck_rejected", cells: null, admission: null });
    expect(lane2.slice(1).every((round) => round.cells !== null && round.admission !== null)).toBe(true);
    const finished = events.flatMap((event) => (event.type === "lane_finished" ? [[event.lane_id, event.data.outcome, event.data.reason]] : []));
    expect(finished).toEqual([
      ["lane-1", "won", null],
      ["lane-2", "lost_race", REASON_TEXT.lost_race_qualified],
    ]);
    expect(events.find((event) => event.type === "winner_selected")).toMatchObject({ data: { lane_id: "lane-1", qualified_at_iteration: 2 } });
    expect(types(events).slice(-2)).toEqual(["packaging", "job_finished"]);
    // The round feedback is invented and never names a real file.
    for (const round of [...rounds, ...lane2]) for (const line of round.feedback) expect(line).not.toMatch(/\.(?:ts|js|tsx|sql)\b/);
    // The whole job fits well inside Umami's 60-minute deadline.
    const claimed = Date.parse(events.find((event) => event.type === "job_claimed")?.at ?? "");
    expect(Date.parse(events.at(-1)?.at ?? "") - claimed).toBeLessThan(60 * 60_000 - 11 * 60_000);
  });

  it("checkOtfSequence finds an illegal stage move, a gap and a missing finish", () => {
    const events = scenarioEvents("delivered", T0);
    const writing = events.findIndex((event) => event.type === "lane_stage" && event.data.stage === "writing");
    const skipped = events.map((event, index) => (index === writing && event.type === "lane_stage" ? { ...event, data: { ...event.data, stage: "qualifying" as const } } : event));
    expect(checkOtfSequence(skipped, { host_id: "task-report" }).some((problem) => problem.includes("setting_up -> qualifying"))).toBe(true);
    expect(checkOtfSequence(events.filter((_, index) => index !== 5), { host_id: "task-report" }).some((problem) => problem.includes("gap-free"))).toBe(true);
    expect(checkOtfSequence(events.slice(0, -1), { host_id: "task-report" })).toContain("the stream has no job_finished");
  });

  it("checkOtfSequence allows qualifying -> won only with confirm_rounds 0, and admission only on an admission host", () => {
    const umami = scenarioEvents("umami_delivered", T0);
    expect(checkOtfSequence(umami, { host_id: "umami" })).toEqual([]);
    expect(checkOtfSequence(umami, { host_id: "umami", confirm_rounds: 1 }).some((problem) => problem.includes("qualifying -> won"))).toBe(true);
    // The same stream read as task-report: the move is refused and admission results are out of place.
    const asTaskReport = checkOtfSequence(umami, { host_id: "task-report" });
    expect(asTaskReport.some((problem) => problem.includes("qualifying -> won"))).toBe(true);
    expect(asTaskReport.some((problem) => problem.includes("admission must be set exactly"))).toBe(true);
    // A confirmation round on a confirm_rounds 0 host is refused.
    const delivered = scenarioEvents("delivered", T0);
    expect(checkOtfSequence(delivered, { host_id: "task-report", confirm_rounds: 0 }).some((problem) => problem.includes("-> confirming"))).toBe(true);
    // Umami runs at most two lanes.
    expect(checkOtfSequence(delivered, { host_id: "umami" }).some((problem) => problem.includes("more than 2 lanes"))).toBe(true);
  });
});

describe("the Umami calendar block", () => {
  it("creates no job: production answers host_unavailable with the calendar copy", () => {
    expect(OTF_TEST_SCENARIOS).toContain("umami_calendar_blocked");
    expect(OTF_TEST_JOB_SCENARIOS as readonly string[]).not.toContain("umami_calendar_blocked");
    expect(scenarioRefusal("umami_calendar_blocked")).toEqual({ code: "host_unavailable", host_id: "umami", unavailable_reason: "calendar", message: "Umami is unavailable on UTC days 2–5." });
    for (const scenario of OTF_TEST_JOB_SCENARIOS) expect(scenarioRefusal(scenario)).toBeNull();
  });

  it("the world's clock starts on UTC day 3, where Umami's create window is closed and task-report's is open", async () => {
    let now = Date.parse(T0);
    const world = new OtfTestWorld({ scenario: "umami_calendar_blocked", clock: () => now, speed: 1 });
    expect(world.now().toISOString()).toBe(TEST_CALENDAR_BLOCKED_AT);
    expect(world.refusal?.message).toBe(UMAMI_CALENDAR_REASON);
    const at = world.now().getTime();
    const window = (h: OtfHostId): number => at + START_TIMEOUT_MS + TEST_HOSTS[h].profile.deadline_ms + CALENDAR_MARGIN_MS;
    expect(hostCalendarOpen("umami", at, window("umami"))).toBe(false);
    expect(hostCalendarOpen("task-report", at, window("task-report"))).toBe(true);
    // The clock still runs at the injected clock's pace.
    now += 5_000;
    expect(world.now().getTime() - at).toBe(5_000);
    // A Umami job created anyway (a create that skipped the calendar check) is never claimed or played.
    const body = await umamiJob(world.now().toISOString());
    await world.store.createJob({ ...body, state: "queued" });
    await world.power.start();
    now += 600_000;
    expect((await world.store.getJob(JOB))?.state).toBe("queued");
    expect(await world.store.listEvents(JOB, 0)).toEqual([]);
    expect(await world.store.lastBuilderSeen()).toMatchObject({ ready_hosts: ["umami"] });
  });

  it("umami_delivered moves the world's clock past a blocked day, so it plays on any date", () => {
    const blocked = Date.parse("2026-11-02T09:00:00.000Z");
    const world = new OtfTestWorld({ scenario: "umami_delivered", clock: () => blocked, speed: 1 });
    expect(world.now().toISOString()).toBe("2026-11-06T09:00:00.000Z");
    const open = new OtfTestWorld({ scenario: "umami_delivered", clock: () => Date.parse(T0), speed: 1 });
    expect(open.now().toISOString()).toBe(T0);
    const taskReport = new OtfTestWorld({ scenario: "delivered", clock: () => blocked, speed: 1 });
    expect(taskReport.now().getTime()).toBe(blocked);
  });
});

describe("the test-mode host config", () => {
  /** An availability body as production would build it from the world's hosts, here with Umami on its calendar block. */
  function availability(): OtfAvailability {
    const offered = (h: OtfHostId): boolean => h !== "umami";
    return {
      enabled: true,
      builder: "stopped",
      active_jobs: 0,
      queued_jobs: 0,
      max_queued: OTF_DEFAULTS.max_queued,
      behaviors: OTF_HOST_IDS.filter(offered).flatMap((h) => criteriaOf(h).map((criterion_id) => ({ criterion_id, host_id: h, label: `Synthetic behavior ${criterion_id}`, example_phrases: ["an invented phrase"] }))),
      hosts: OTF_HOST_IDS.map((h) => ({
        host_id: h,
        label: TEST_HOSTS[h].label,
        offered: offered(h),
        unavailable_reason: offered(h) ? null : "calendar",
        active_jobs: 0,
        queued_jobs: 0,
        max_active: TEST_HOSTS[h].profile.max_active,
        lanes: TEST_HOSTS[h].lanes.map((lane) => ({ lane_id: lane.lane_id, model_label: lane.model_label })),
        deadline_min: TEST_HOSTS[h].profile.deadline_ms / 60_000,
        typical: TEST_HOSTS[h].typical,
      })),
      cold_start_min: null,
      spend_left_microusd: 40_000_000,
    };
  }

  it("enables every host with its profile's lanes and no measured typical time", () => {
    expect(Object.keys(TEST_HOSTS).sort()).toEqual([...OTF_HOST_IDS].sort());
    for (const h of OTF_HOST_IDS) {
      expect(TEST_HOSTS[h]).toMatchObject({ host_id: h, enabled: true, typical: null });
      expect(TEST_HOSTS[h].lanes).toHaveLength(TEST_HOSTS[h].profile.lanes_per_job);
    }
    expect(new OtfTestWorld({ clock: () => Date.parse(T0) }).hosts).toBe(TEST_HOSTS);
    const body = availability();
    expect(validateOtf("OtfAvailability", body)).toEqual([]);
    expect(body.hosts.find((h) => h.host_id === "umami")).toMatchObject({ offered: false, unavailable_reason: "calendar", typical: null, deadline_min: 60 });
    expect(body.behaviors.every((behavior) => CRITERION_HOST[behavior.criterion_id] === behavior.host_id)).toBe(true);
  });

  it("claims as a builder with only the scenario's host ready", () => {
    const hosts = claimHosts(["umami"], 60);
    expect(hosts.umami).toEqual({ build: true, validate: true, maxActiveBuilds: 1, deadlineMs: 60_000 });
    expect(hosts["task-report"]).toEqual({ build: false, validate: false, maxActiveBuilds: 2, deadlineMs: 45_000 });
    expect(claimHosts(["umami"], 1, false).umami.build).toBe(false);
  });
});

describe("the invented delivery", () => {
  it("holds a certificate and parts that pass every result check", async () => {
    const script = scenarioScript("delivered");
    const spec_sha256 = await specSha256(SPEC);
    const delivery = syntheticDelivery({ job_id: JOB, criterion_id: "concurrency.lost-acknowledged-change", spec_sha256, builder_id: "synthetic-builder-1", claimed_at_ms: Date.parse(T0), speed: 1, script });
    expect(validateOtf("OtfCertificate", delivery.certificate)).toEqual([]);
    expect(validateOtf("ResultPost", delivery.post)).toEqual([]);
    expect(delivery.certificate.spec_sha256).toBe(spec_sha256);
    expect(delivery.certificate.implementer).toMatchObject({ lane_id: "lane-1", rounds_used: 2 });
    expect(delivery.certificate.host_id).toBe("task-report");
    expect(delivery.certificate.qualification).toEqual({ cells: EXPECTED_CELLS, confirmation_cells: EXPECTED_CELLS, admission: null, result: "qualified" });
    expect(delivery.certificate.harness.tier).toBe("B");
    const byPart = new Map(delivery.parts.map((part) => [part.part, part]));
    expect(delivery.certificate.bundles).toEqual({ agent_sha256: byPart.get("agent")?.sha256, grader_sha256: byPart.get("grader")?.sha256 });
    expect([...byPart.values()].map((part) => part.filename)).toEqual(["rbw-otf-agent-00000000.tar.gz", "rbw-otf-grader-00000000.tar.gz", "rbw-otf-certificate-00000000.json"]);
    for (const part of delivery.parts) {
      expect(part.size).toBe(part.bytes.length);
      expect(part.size).toBeLessThanOrEqual(PART_MAX_BYTES_BY_PART[part.part]);
      if (part.media_type === "application/gzip") {
        expect([part.bytes[0], part.bytes[1]]).toEqual([0x1f, 0x8b]);
        expect(gunzipSync(part.bytes).toString("latin1").includes(OTF_TEST_GRADER_SENTINEL)).toBe(part.part === "grader");
      }
    }
    expect(JSON.stringify(delivery.certificate)).not.toContain(OTF_TEST_GRADER_SENTINEL);
  });

  it("builds the Umami certificate variant: admission tier, no confirmation cells, a qualified admission result", async () => {
    const script = scenarioScript("umami_delivered");
    const spec_sha256 = await specSha256(UMAMI_SPEC);
    const delivery = syntheticDelivery({ job_id: JOB, criterion_id: "date_time.time-zone-grouping", spec_sha256, builder_id: "synthetic-builder-1", claimed_at_ms: Date.parse(T0), speed: 1, script });
    expect(validateOtf("OtfCertificate", delivery.certificate)).toEqual([]);
    expect(validateOtf("ResultPost", delivery.post)).toEqual([]);
    const certificate = delivery.certificate;
    if (certificate.host_id !== "umami") throw new Error("expected the Umami variant");
    expect(certificate.qualification).toEqual({
      cells: EXPECTED_CELLS,
      confirmation_cells: null,
      admission: { decisions: { adm_02: "pass", adm_03: "pass", adm_04: "pass", adm_05: "pass", adm_06: "pass" }, comparison: "blind_spot_demonstrated", alternative_fix: "pass" },
      result: "qualified",
    });
    expect(certificate.harness).toMatchObject({ tier: "admission", repetitions: 20, evidence: ADMISSION_EVIDENCE, copies: { kit_check_clean: 5, observe_planted: 1, clean: 1, planted: 5, fixed: 5, partial: 1, stub: 1 } });
    expect(certificate.implementer).toMatchObject({ lane_id: "lane-1", rounds_used: 2 });
    expect(certificate.spend.lanes).toBe(2);
    // The same certificate with the task-report host fails the schema (one variant per host).
    expect(validateOtf("OtfCertificate", { ...certificate, host_id: "task-report" })).not.toEqual([]);
    const grader = delivery.parts.find((part) => part.part === "grader");
    expect(gunzipSync(grader?.bytes ?? new Uint8Array()).toString("latin1")).toContain(OTF_TEST_GRADER_SENTINEL);
  });
});

/** A create body as the customer route stores it, for the Umami criterion. */
async function umamiJob(created: string) {
  const body: OtfCreateJob = { client_key: "00000000-0000-4000-8000-000000000005", host_id: "umami", criterion_id: "date_time.time-zone-grouping", sentence: "A late visit lands on the next day.", spec: UMAMI_SPEC, spec_sha256: await specSha256(UMAMI_SPEC) };
  return { job_id: JOB, client_key: body.client_key, create_sha256: await createSha256(body), created_at: created, host_id: body.host_id, criterion_id: body.criterion_id, sentence: body.sentence, spec: body.spec, spec_sha256: body.spec_sha256, catalog_request_id: null };
}

/** A clock the test moves, a world on it at speed 1, and a create as the customer route would do it. */
async function playJob(scenario: OtfTestJobScenario, options: { stopAtMs?: number; jumpAfterClaimMs?: number } = {}) {
  let now = Date.parse(T0);
  const world = new OtfTestWorld({ scenario, clock: () => now, speed: 1 });
  const created = new Date(now).toISOString();
  let newJob;
  if (SCENARIO_HOST[scenario] === "umami") {
    newJob = await umamiJob(created);
  } else {
    const body: OtfCreateJob = { client_key: "00000000-0000-4000-8000-000000000003", host_id: "task-report", criterion_id: "concurrency.lost-acknowledged-change", sentence: "Two quick saves lose one.", spec: SPEC, spec_sha256: await specSha256(SPEC) };
    newJob = { job_id: JOB, client_key: body.client_key, create_sha256: await createSha256(body), created_at: created, host_id: body.host_id, criterion_id: body.criterion_id, sentence: body.sentence, spec: body.spec, spec_sha256: body.spec_sha256, catalog_request_id: null };
  }
  const result = await world.store.createJob({ ...newJob, state: "starting_builder" });
  expect(result.kind).toBe("created");
  await world.store.appendJobEvent(JOB, { type: "builder_starting", lane_id: null, data: { preset: TEST_PRESET, requested_at: created } }, created);
  let failure: unknown = null;
  try {
    await world.power.start();
  } catch (error) {
    failure = error;
    if (!(error instanceof StartError)) throw error;
    await world.store.appendJobEvent(JOB, { type: "builder_start_failed", lane_id: null, data: { reason: error.reason } }, created);
    await world.store.updateJob(JOB, ["starting_builder"], { state: "finished", outcome: "builder_start_failed", reason: REASON_TEXT.capacity, finished_at: created });
    await world.store.appendJobEvent(JOB, { type: "job_finished", lane_id: null, data: { outcome: "builder_start_failed", reason: REASON_TEXT.capacity } }, created);
  }
  let jumped = false;
  for (let tick = 0; tick < 4 * 3600; tick += 1) {
    const current = await world.store.getJob(JOB);
    if (current?.state === "finished") break;
    if (options.jumpAfterClaimMs !== undefined && !jumped && current?.state === "building") {
      // The clock jumps (a browser that stopped polling): the next read sees it all at once.
      jumped = true;
      now += options.jumpAfterClaimMs;
      continue;
    }
    if (options.stopAtMs !== undefined && now - Date.parse(T0) === options.stopAtMs) {
      await world.store.updateJob(JOB, ["building"], { stop_requested_at: new Date(now).toISOString(), stop_reason: "customer" });
    }
    now += 1_000;
  }
  const job = await world.store.getJob(JOB);
  const events = await world.store.listEvents(JOB, 0);
  const tick = (ms: number): void => {
    now += ms;
  };
  return { world, job, events, failure, tick };
}

describe("the fake builder through the store and power ports", () => {
  it.each(OTF_TEST_JOB_SCENARIOS)("%s: plays exactly the scenario's stream", async (scenario) => {
    const { job, events, world, failure } = await playJob(scenario);
    expect(job?.state).toBe("finished");
    expect(job?.host_id).toBe(SCENARIO_HOST[scenario]);
    expect(events).toEqual(scenarioEvents(scenario, T0));
    expect(checkOtfSequence(events, host(scenario))).toEqual([]);
    expect(job?.outcome).toBe(events.at(-1)?.type === "job_finished" ? (events.at(-1) as Extract<OtfEvent, { type: "job_finished" }>).data.outcome : null);
    const artifacts = await world.store.listArtifacts(JOB);
    if (scenario === "delivered" || scenario === "umami_delivered") {
      // The production store lists parts by name, as Postgres orders them.
      expect(artifacts.map((artifact) => artifact.part)).toEqual(["agent", "certificate", "grader"]);
      expect(job?.certificate?.received?.sha256_verified).toBe(true);
      expect(job?.certificate?.host_id).toBe(SCENARIO_HOST[scenario]);
      expect(validateOtf("OtfCertificate", job?.certificate)).toEqual([]);
      // The deadline is the host's own, from the claim.
      const claimed = Date.parse(events.find((event) => event.type === "job_claimed")?.at ?? "");
      expect(Date.parse(job?.deadline_at ?? "") - claimed).toBe(TEST_HOSTS[SCENARIO_HOST[scenario]].profile.deadline_ms);
      expect(job?.winner_lane).toBe("lane-1");
      expect(job?.model_microusd).toBe(job?.certificate?.spend.model_microusd);
      expect(job?.model_microusd).toBeGreaterThan(0);
    } else {
      expect(artifacts).toEqual([]);
    }
    if (scenario === "builder_start_failed") {
      expect(failure).toBeInstanceOf(StartError);
      expect(world.fakes.power.calls).toEqual(["start"]);
      expect(await world.store.lastBuilderSeen()).toBeNull();
    } else {
      expect(failure).toBeNull();
      expect(await world.store.lastBuilderSeen()).toMatchObject({ builder_id: "synthetic-builder-1", ready_hosts: [SCENARIO_HOST[scenario]] });
    }
  });

  it.each(["delivered", "not_qualified", "umami_delivered"] as const)("%s: a clock jump past the deadline after the claim keeps the stream and the outcome", async (scenario) => {
    const { job, events } = await playJob(scenario, { jumpAfterClaimMs: 3 * 3_600_000 });
    expect(events).toEqual(scenarioEvents(scenario, T0));
    expect(job?.outcome).toBe(scenario === "umami_delivered" ? "delivered" : scenario);
    expect(checkOtfSequence(events, host(scenario))).toEqual([]);
  });

  it("a customer stop ends every lane cancelled and the job cancelled", async () => {
    const { job, events } = await playJob("delivered", { stopAtMs: 300_000 });
    expect(job?.outcome).toBe("cancelled");
    expect(checkOtfSequence(events, { host_id: "task-report" })).toEqual([]);
    const lanes = events.flatMap((event) => (event.type === "lane_finished" ? [event.data.outcome] : []));
    expect(lanes).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(types(events)).not.toContain("winner_selected");
    for (const event of events) expect(validateOtf("OtfEvent", event)).toEqual([]);
  });

  it("the memory store skips a byte-identical repeat and refuses a changed repeat or a gap", async () => {
    const store = createMemoryOtfStore({ now: () => new Date(T0) });
    const body = { job_id: JOB, client_key: "00000000-0000-4000-8000-000000000003", create_sha256: "b".repeat(64), created_at: T0, host_id: "task-report" as const, criterion_id: "concurrency.lost-acknowledged-change" as const, sentence: "Two quick saves lose one.", spec: SPEC, spec_sha256: "a".repeat(64), state: "queued" as const, catalog_request_id: null };
    await store.createJob(body);
    expect((await store.createJob(body)).kind).toBe("replayed");
    expect((await store.createJob({ ...body, create_sha256: "c".repeat(64) })).kind).toBe("conflict");
    await store.claimNext("synthetic-builder-1", T0, { hosts: claimHosts(["task-report"], 1) });
    const first: BuilderEventIn = { type: "packaging", lane_id: null, data: {}, builder_seq: 1, at: T0 };
    expect(await store.appendBuilderEvents(JOB, "synthetic-builder-1", [first], T0)).toEqual({ kind: "ok", accepted_through: 1 });
    expect(await store.appendBuilderEvents(JOB, "synthetic-builder-1", [first], T0)).toEqual({ kind: "ok", accepted_through: 1 });
    expect(await store.appendBuilderEvents(JOB, "synthetic-builder-1", [{ ...first, at: "2026-10-29T10:00:01.000Z" }], T0)).toMatchObject({ kind: "conflict", builder_seq: 1 });
    expect(await store.appendBuilderEvents(JOB, "synthetic-builder-1", [{ ...first, builder_seq: 3 }], T0)).toMatchObject({ kind: "conflict", builder_seq: 3 });
    expect(await store.appendBuilderEvents(JOB, "another-builder", [], T0)).toEqual({ kind: "wrong_builder" });
    expect(await store.listEvents(JOB, 0)).toHaveLength(1);
  });

  it("the memory store claims per host: a saturated Umami never blocks a queued task-report build", async () => {
    const store = createMemoryOtfStore({ now: () => new Date(T0) });
    const id = (n: number): string => `00000000-0000-4000-8000-00000000000${String(n)}`;
    const base = { create_sha256: "b".repeat(64), sentence: "An invented sentence.", spec: SPEC, spec_sha256: "a".repeat(64), state: "queued" as const, catalog_request_id: null };
    const at = (s: number): string => new Date(Date.parse(T0) + s * 1_000).toISOString();
    await store.createJob({ ...base, job_id: id(1), client_key: id(1), created_at: at(1), host_id: "umami", criterion_id: "date_time.time-zone-grouping" });
    await store.createJob({ ...base, job_id: id(2), client_key: id(2), created_at: at(2), host_id: "umami", criterion_id: "date_time.time-zone-grouping" });
    await store.createJob({ ...base, job_id: id(3), client_key: id(3), created_at: at(3), host_id: "task-report", criterion_id: "concurrency.lost-acknowledged-change" });
    const hosts = claimHosts(["task-report", "umami"], 1);
    const first = await store.claimNext("synthetic-builder-1", T0, { hosts });
    expect(first).toMatchObject({ kind: "build", job: { job_id: id(1), host_id: "umami", deadline_at: "2026-10-29T11:00:00.000Z" } });
    // Umami is at its one active build; the older queued Umami job waits and task-report's is claimed.
    const second = await store.claimNext("synthetic-builder-1", T0, { hosts });
    expect(second).toMatchObject({ kind: "build", job: { job_id: id(3), host_id: "task-report", deadline_at: "2026-10-29T10:45:00.000Z" } });
    expect(await store.claimNext("synthetic-builder-1", T0, { hosts })).toBeNull();
    // A host the builder is not ready for gets no claim, not even a validation.
    await store.createValidation(id(1), id(6), T0);
    expect(await store.claimNext("synthetic-builder-1", T0, { hosts: claimHosts(["task-report"], 1) })).toBeNull();
    expect(await store.claimNext("synthetic-builder-1", T0, { hosts })).toMatchObject({ kind: "validate", validation: { validation_id: id(6), state: "running", admission: null } });
  });

  it.each([
    ["delivered", null],
    ["umami_delivered", { decisions: { adm_02: "pass", adm_03: "pass", adm_04: "pass", adm_05: "pass", adm_06: "pass" }, comparison: "blind_spot_demonstrated", alternative_fix: "pass" }],
  ] as const)("%s: a validation passes with the host's admission result", async (scenario, admission) => {
    const { world, tick } = await playJob(scenario);
    const validation = "00000000-0000-4000-8000-000000000007";
    await world.store.createValidation(JOB, validation, world.now().toISOString());
    // The builder is still running after the delivery: it claims the validation and finishes it 180 s later.
    expect(await world.store.getValidation(validation)).toMatchObject({ state: "running", admission: null });
    tick(180_000);
    expect(await world.store.getValidation(validation)).toMatchObject({ state: "passed", cells: EXPECTED_CELLS, admission });
  });

  it("is selected only as the factory's test mode, and refused on a Vercel deployment", () => {
    expect(otfTestMode({ RBW_FACTORY_TEST_MODE: "1" })).toBe("test");
    expect(otfTestMode({ RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV: "development" })).toBe("test");
    expect(otfTestMode({ RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV: "preview" })).toBe("refused");
    expect(otfTestMode({ RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV: "production" })).toBe("refused");
    expect(otfTestMode({})).toBe("off");
    for (const env of [{}, { RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV: "preview" }, { RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV: "production" }]) {
      expect(() => otfTestWorld(env)).toThrow(OtfTestModeRefusedError);
    }
    const world = otfTestWorld({ RBW_FACTORY_TEST_MODE: "1" });
    expect(otfTestWorld({ RBW_FACTORY_TEST_MODE: "1" })).toBe(world);
    world.reset("not_qualified");
    expect(world.scenario).toBe("not_qualified");
    world.reset("umami_calendar_blocked");
    expect(world.refusal?.code).toBe("host_unavailable");
    world.reset("delivered");
    expect(world.refusal).toBeNull();
  });
});
