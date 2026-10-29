// OTF test mode: every scenario's synthetic event stream validates against the contract's schemas and
// keeps the legal stage order, and the fake builder plays the same stream through the store and power
// ports on an injected clock. Every value is invented; no machine or model is called.
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createSha256, specSha256 } from "../../src/otf/canonical.ts";
import {
  BUILDER_EVENT_TYPES,
  EXPECTED_CELLS,
  PART_MAX_BYTES,
  PRODUCTION_EVENT_TYPES,
  StartError,
  type BuilderEventIn,
  type OtfCreateJob,
  type OtfEvent,
  type OtfSpecCard,
} from "../../src/otf/contract.ts";
import { validateOtf } from "../../src/otf/schemas.ts";
import { MemoryOtfStore, OTF_TEST_GRADER_SENTINEL, OtfTestModeRefusedError, OtfTestWorld, otfTestMode, otfTestWorld, syntheticDelivery } from "../../src/otf/test-mode/fake-builder.ts";
import { OTF_TEST_SCENARIOS, REASON_TEXT, TEST_PRESET, checkOtfSequence, scenarioEvents, scenarioScript, type OtfTestScenario } from "../../src/otf/test-mode/timeline.ts";

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

const types = (events: readonly OtfEvent[]): string[] => events.map((event) => event.type);
const ofLane = (events: readonly OtfEvent[], lane: string) => events.filter((event) => event.lane_id === lane);

describe("the scenario timelines", () => {
  it.each(OTF_TEST_SCENARIOS)("%s: every event validates as OtfEvent and the order is legal", (scenario) => {
    const events = scenarioEvents(scenario, T0);
    expect(events.length).toBeGreaterThan(2);
    for (const event of events) expect(validateOtf("OtfEvent", event), `${String(event.seq)} ${event.type}`).toEqual([]);
    expect(checkOtfSequence(events)).toEqual([]);
    const known: readonly string[] = [...PRODUCTION_EVENT_TYPES, ...BUILDER_EVENT_TYPES];
    expect(events.every((event) => known.includes(event.type))).toBe(true);
    // The builder posts only builder event types, and each validates as posted.
    scenarioScript(scenario).steps.forEach((step, k) => {
      const posted: BuilderEventIn = { ...step.event, builder_seq: k + 1, at: T0 };
      expect(validateOtf("BuilderEventIn", posted)).toEqual([]);
    });
  });

  it("is deterministic", () => {
    for (const scenario of OTF_TEST_SCENARIOS) expect(scenarioEvents(scenario, T0)).toEqual(scenarioEvents(scenario, T0));
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

  it("time_limit: the lanes are still revising at the 45-minute deadline and stop there", () => {
    const events = scenarioEvents("time_limit", T0);
    const claimed = Date.parse(events.find((event) => event.type === "job_claimed")?.at ?? "");
    const finishedLanes = events.filter((event) => event.type === "lane_finished");
    expect(finishedLanes).toHaveLength(3);
    for (const event of finishedLanes) {
      expect(event).toMatchObject({ data: { outcome: "cancelled", reason: REASON_TEXT.deadline_lane } });
      expect(Date.parse(event.at) - claimed).toBe(45 * 60_000);
    }
    expect(events.at(-1)).toMatchObject({ type: "job_finished", data: { outcome: "time_limit" } });
  });

  it("checkOtfSequence finds an illegal stage move, a gap and a missing finish", () => {
    const events = scenarioEvents("delivered", T0);
    const writing = events.findIndex((event) => event.type === "lane_stage" && event.data.stage === "writing");
    const skipped = events.map((event, index) => (index === writing && event.type === "lane_stage" ? { ...event, data: { ...event.data, stage: "qualifying" as const } } : event));
    expect(checkOtfSequence(skipped).some((problem) => problem.includes("setting_up -> qualifying"))).toBe(true);
    expect(checkOtfSequence(events.filter((_, index) => index !== 5)).some((problem) => problem.includes("gap-free"))).toBe(true);
    expect(checkOtfSequence(events.slice(0, -1))).toContain("the stream has no job_finished");
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
    expect(delivery.certificate.qualification).toEqual({ cells: EXPECTED_CELLS, confirmation_cells: EXPECTED_CELLS, result: "qualified" });
    const byPart = new Map(delivery.parts.map((part) => [part.part, part]));
    expect(delivery.certificate.bundles).toEqual({ agent_sha256: byPart.get("agent")?.sha256, grader_sha256: byPart.get("grader")?.sha256 });
    expect([...byPart.values()].map((part) => part.filename)).toEqual(["rbw-otf-agent-00000000.tar.gz", "rbw-otf-grader-00000000.tar.gz", "rbw-otf-certificate-00000000.json"]);
    for (const part of delivery.parts) {
      expect(part.size).toBe(part.bytes.length);
      expect(part.size).toBeLessThanOrEqual(PART_MAX_BYTES);
      if (part.media_type === "application/gzip") {
        expect([part.bytes[0], part.bytes[1]]).toEqual([0x1f, 0x8b]);
        expect(gunzipSync(part.bytes).toString("latin1").includes(OTF_TEST_GRADER_SENTINEL)).toBe(part.part === "grader");
      }
    }
    expect(JSON.stringify(delivery.certificate)).not.toContain(OTF_TEST_GRADER_SENTINEL);
  });
});

/** A clock the test moves, a world on it at speed 1, and a create as the customer route would do it. */
async function playJob(scenario: OtfTestScenario, options: { stopAtMs?: number; jumpAfterClaimMs?: number } = {}) {
  let now = Date.parse(T0);
  const world = new OtfTestWorld({ scenario, clock: () => now, speed: 1 });
  const body: OtfCreateJob = { client_key: "00000000-0000-4000-8000-000000000003", criterion_id: "concurrency.lost-acknowledged-change", sentence: "Two quick saves lose one.", spec: SPEC, spec_sha256: await specSha256(SPEC) };
  const created = new Date(now).toISOString();
  const result = await world.store.createJob({ job_id: JOB, client_key: body.client_key, create_sha256: await createSha256(body), created_at: created, criterion_id: body.criterion_id, sentence: body.sentence, spec: body.spec, spec_sha256: body.spec_sha256, state: "starting_builder", catalog_request_id: null });
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
  return { world, job, events, failure };
}

describe("the fake builder through the store and power ports", () => {
  it.each(OTF_TEST_SCENARIOS)("%s: plays exactly the scenario's stream", async (scenario) => {
    const { job, events, world, failure } = await playJob(scenario);
    expect(job?.state).toBe("finished");
    expect(events).toEqual(scenarioEvents(scenario, T0));
    expect(checkOtfSequence(events)).toEqual([]);
    expect(job?.outcome).toBe(events.at(-1)?.type === "job_finished" ? (events.at(-1) as Extract<OtfEvent, { type: "job_finished" }>).data.outcome : null);
    const artifacts = await world.store.listArtifacts(JOB);
    if (scenario === "delivered") {
      expect(artifacts.map((artifact) => artifact.part)).toEqual(["agent", "grader", "certificate"]);
      expect(job?.certificate?.received?.sha256_verified).toBe(true);
      expect(validateOtf("OtfCertificate", job?.certificate)).toEqual([]);
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
      expect(await world.store.lastBuilderSeen()).toMatchObject({ builder_id: "synthetic-builder-1" });
    }
  });

  it.each(["delivered", "not_qualified"] as const)("%s: a clock jump past the deadline after the claim keeps the stream and the outcome", async (scenario) => {
    const { job, events } = await playJob(scenario, { jumpAfterClaimMs: 3 * 3_600_000 });
    expect(events).toEqual(scenarioEvents(scenario, T0));
    expect(job?.outcome).toBe(scenario);
    expect(checkOtfSequence(events)).toEqual([]);
  });

  it("a customer stop ends every lane cancelled and the job cancelled", async () => {
    const { job, events } = await playJob("delivered", { stopAtMs: 300_000 });
    expect(job?.outcome).toBe("cancelled");
    expect(checkOtfSequence(events)).toEqual([]);
    const lanes = events.flatMap((event) => (event.type === "lane_finished" ? [event.data.outcome] : []));
    expect(lanes).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(types(events)).not.toContain("winner_selected");
    for (const event of events) expect(validateOtf("OtfEvent", event)).toEqual([]);
  });

  it("the memory store skips a byte-identical repeat and refuses a changed repeat or a gap", async () => {
    const store = new MemoryOtfStore(T0);
    const body = { job_id: JOB, client_key: "00000000-0000-4000-8000-000000000003", create_sha256: "b".repeat(64), created_at: T0, criterion_id: "concurrency.lost-acknowledged-change" as const, sentence: "Two quick saves lose one.", spec: SPEC, spec_sha256: "a".repeat(64), state: "queued" as const, catalog_request_id: null };
    await store.createJob(body);
    expect((await store.createJob(body)).kind).toBe("replayed");
    expect((await store.createJob({ ...body, create_sha256: "c".repeat(64) })).kind).toBe("conflict");
    await store.claimNext("synthetic-builder-1", T0, { maxActiveBuilds: 2, deadlineMs: 60_000, build: true, validate: true });
    const first: BuilderEventIn = { type: "packaging", lane_id: null, data: {}, builder_seq: 1, at: T0 };
    expect(await store.appendBuilderEvents(JOB, "synthetic-builder-1", [first], T0)).toEqual({ kind: "ok", accepted_through: 1 });
    expect(await store.appendBuilderEvents(JOB, "synthetic-builder-1", [first], T0)).toEqual({ kind: "ok", accepted_through: 1 });
    expect(await store.appendBuilderEvents(JOB, "synthetic-builder-1", [{ ...first, at: "2026-10-29T10:00:01.000Z" }], T0)).toMatchObject({ kind: "conflict", builder_seq: 1 });
    expect(await store.appendBuilderEvents(JOB, "synthetic-builder-1", [{ ...first, builder_seq: 3 }], T0)).toMatchObject({ kind: "conflict", builder_seq: 3 });
    expect(await store.appendBuilderEvents(JOB, "another-builder", [], T0)).toEqual({ kind: "wrong_builder" });
    expect(await store.listEvents(JOB, 0)).toHaveLength(1);
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
  });
});
