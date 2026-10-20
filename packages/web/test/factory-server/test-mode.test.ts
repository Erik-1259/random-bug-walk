// Test mode (contract section 15.1) through the handlers: each scenario reaches its fixture's end
// state (outcomes, stop codes, delivery, attention, stages, counts and event order; amounts, also those
// in texts, follow the test profile's worst cases), the evidence adds up to the status, the 2 s hold, reconcile and reset,
// validation runs, hash-checked downloads, and no JSON response carries evaluator material.
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestStatus, TestEvidence, TestScenario, ValidationRun } from "@rbw/factory-contract";
import { TEST_SCENARIO_VALUES } from "@rbw/factory-contract";
import {
  getPackage,
  getRequestStatus,
  getTestEvidence,
  getValidationRun,
  postInterpretation,
  postStart,
  postStop,
  postTestReconcile,
  postTestReset,
  postValidation,
} from "../../src/factory-server/handlers.ts";
import type { FactoryServer } from "../../src/factory-server/ports.ts";
import { TEST_MODE_EVALUATOR_SENTINEL } from "../../src/factory-server/test-mode/archives.ts";
import { loadTestFixtures, SCENARIO_FIXTURE } from "../../src/factory-server/test-mode/fixtures.ts";
import { TEST_PROFILE } from "../../src/factory-server/test-mode/profile.ts";
import { testRequestRoot, TestWorld } from "../../src/factory-server/test-mode/world.ts";
import { contractBody, fixture, FIXTURES, OTHER_REQUEST_ID, PASSCODE, request, REQUEST_ID, sha256, START } from "./support.ts";

const FIXTURE_SET = loadTestFixtures(FIXTURES);
const STEP_MS = 100;
const STATUS_PATH = `/api/factory/requests/${REQUEST_ID}`;

interface World {
  world: TestWorld;
  server: FactoryServer;
  clock: { ms: number };
  /** Every JSON body the handlers answered. */
  bodies: string[];
}

function makeWorld(holdMs = 0, stepMs = STEP_MS): World {
  const clock = { ms: START };
  const world = new TestWorld({ fixtures: FIXTURE_SET, passcode: PASSCODE, clock: () => clock.ms, stepMs, holdMs });
  return { world, clock, bodies: [], server: { ports: world, requestRoot: testRequestRoot, test: world, log: () => undefined } };
}

async function keep(w: World, response: Response): Promise<Response> {
  const text = await response.clone().text();
  if ((response.headers.get("content-type") ?? "").includes("json")) w.bodies.push(text);
  return response;
}

function endState(scenario: TestScenario): RequestStatus {
  return fixture("RequestStatus", SCENARIO_FIXTURE[scenario]);
}

async function reset(w: World, scenario: TestScenario): Promise<void> {
  const response = await postTestReset(request("/api/factory/test/reset", { body: { scenario }, session: false }), w.server);
  expect(await contractBody("TestResetResponse", response)).toEqual({ contract_version: "bug-request/1", scenario });
}

async function start(w: World, scenario: TestScenario, requestId = REQUEST_ID): Promise<Response> {
  const input = endState(scenario).interpretation.input;
  const interpreted = await keep(w, await postInterpretation(request("/api/factory/interpretations", { body: input, session: false }), w.server));
  const interpretation = await contractBody("Interpretation", interpreted);
  return keep(w, await postStart(request("/api/factory/requests", { body: { request_id: requestId, input, interpretation_sha256: interpretation.interpretation_sha256 } }), w.server));
}

async function status(w: World, requestId = REQUEST_ID, after = 0): Promise<RequestStatus> {
  const response = await keep(w, await getRequestStatus(request(`/api/factory/requests/${requestId}?after=${String(after)}`), w.server, { request_id: requestId }));
  expect(response.status).toBe(200);
  return contractBody("RequestStatus", response);
}

async function evidence(w: World, requestId = REQUEST_ID): Promise<TestEvidence> {
  return contractBody("TestEvidence", await keep(w, await getTestEvidence(request(`/api/factory/test/evidence?request_id=${requestId}`, { session: false }), w.server)));
}

/** Polls until the request finishes, advancing the fake clock one step at a time; returns every status seen. */
async function runToEnd(w: World, scenario: TestScenario): Promise<RequestStatus[]> {
  const seen: RequestStatus[] = [];
  let stopped = false;
  for (let poll = 0; poll < 400; poll += 1) {
    const current = await status(w);
    seen.push(current);
    if (current.state === "finished") return seen;
    if (scenario === "cancel-midway" && !stopped && current.candidates[1]?.stage === "checking") {
      stopped = true;
      const stop = await keep(w, await postStop(request(`${STATUS_PATH}/stop`, { body: {} }), w.server, { request_id: REQUEST_ID }));
      expect(stop.status).toBe(200);
      expect((await contractBody("RequestStatus", stop)).state).toBe("stopping");
    }
    w.clock.ms += STEP_MS;
  }
  throw new Error(`synthetic: ${scenario} did not finish`);
}

/** Advances the fake timers in 100 ms steps until the promise settles; returns its value. */
async function settle<T>(pending: Promise<T>): Promise<T> {
  const state = { done: false };
  const watched = pending.finally(() => {
    state.done = true;
  });
  for (let elapsed = 0; !state.done; elapsed += 100) {
    if (elapsed > 10_000) throw new Error("synthetic: the promise did not settle within 10 s of fake time");
    await vi.advanceTimersByTimeAsync(100);
  }
  return watched;
}

/** A text with its dollar amounts replaced: the fixtures' amounts are illustrative, the fake ledger's differ. */
const amountless = <T extends { message: string } | null>(value: T): T => (value === null ? value : { ...value, message: value.message.replace(/\$\d+\.\d{2}/g, "$#.##") });

/** What the fixtures fix for a scenario's end state: everything but times, amounts (also in texts), hashes and the request ID. */
function shape(status: RequestStatus) {
  return {
    state: status.state,
    outcome: status.outcome,
    stop_reason: amountless(status.stop_reason),
    delivery: status.delivery,
    attention: amountless(status.attention),
    interpretation: status.interpretation,
    funnel: status.funnel,
    items: status.items,
    type_totals: status.type_totals,
    candidates_started: status.limits.candidates_started,
    candidates: status.candidates.map(({ started_at, finished_at, reason, ...rest }) => ({ ...rest, reason: amountless(reason), started: started_at !== null, finished: finished_at !== null })),
    cases: status.cases.map(({ packages, qualification, provenance, validation, ...rest }) => ({
      ...rest,
      formats: [packages.bug_case.format, packages.validator.format, packages.bug_case.filename, packages.validator.filename],
      ready: packages.bug_case.ready && packages.validator.ready,
      verdict: qualification.verdict,
      origin: provenance.origin,
      entry: provenance.entry_id,
      validated: validation !== null,
    })),
    events: status.events.map((event) => ({
      type: event.type,
      host_id: event.host_id,
      candidate_id: event.candidate_id,
      item_key: event.item_key,
      case_id: event.case_id,
      message: event.type === "budget_updated" ? "" : amountless(event).message,
      data: event.type === "budget_updated" || event.type === "package_ready" ? {} : event.data,
    })),
  };
}

function expectBudgetArithmetic(current: RequestStatus): void {
  const { budget } = current;
  expect(budget.committed_microusd).toBe(budget.reserved_microusd + budget.spent_microusd);
  expect(budget.remaining_microusd).toBe(budget.budget_microusd - budget.committed_microusd);
  for (const event of current.events) {
    if (event.type === "budget_updated") expect(event.data.remaining_microusd).toBe(budget.budget_microusd - event.data.reserved_microusd - event.data.spent_microusd);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

const ENDING: TestScenario[] = TEST_SCENARIO_VALUES.filter((scenario) => scenario !== "uncertain-provider" && !scenario.startsWith("validation-"));

describe("scenarios", () => {
  it.each(ENDING)("%s reaches its fixture's end state, with events that only grow", async (scenario) => {
    const w = makeWorld();
    await reset(w, scenario);
    const started = await start(w, scenario);
    expect(started.status).toBe(202);
    const first = await contractBody("RequestStatus", started);
    expect(first.state).toBe("queued");
    expect(first.events.map((event) => event.type)).toEqual(["request_accepted", "budget_updated"]);
    const seen = await runToEnd(w, scenario);
    const last = seen.at(-1);
    if (last === undefined) throw new Error("synthetic: no status");
    expect(shape(last)).toEqual(shape(endState(scenario)));
    for (const earlier of seen) {
      expect(earlier.events).toEqual(last.events.slice(0, earlier.events.length));
      expectBudgetArithmetic(earlier);
    }
    expect(last.request_id).toBe(REQUEST_ID);
    for (const item of last.cases) expect(item.provenance.request_id).toBe(REQUEST_ID);
  });

  it("settles every fake operation at exactly its worst case, and the evidence adds up to the status", async () => {
    const w = makeWorld();
    await reset(w, "two-host-fulfilled");
    await start(w, "two-host-fulfilled");
    const last = (await runToEnd(w, "two-host-fulfilled")).at(-1);
    const proof = await evidence(w);
    const worst = TEST_PROFILE.worker_microusd + TEST_PROFILE.candidate_microusd["task-report"] + TEST_PROFILE.candidate_microusd.umami;
    expect(last?.budget).toMatchObject({ reserved_microusd: 0, spent_microusd: worst, overrun: false });
    expect(proof.operations.map((op) => [op.kind, op.call_name, op.state])).toEqual([
      ["worker", "worker", "terminal"],
      ["candidate_copy", "candidate-01-clean", "terminal"],
      ["candidate_copy", "candidate-01-buggy", "terminal"],
      ["candidate_copy", "candidate-01-fixed", "terminal"],
      ["candidate_copy", "candidate-02-clean", "terminal"],
      ["candidate_copy", "candidate-02-buggy", "terminal"],
      ["candidate_copy", "candidate-02-fixed", "terminal"],
    ]);
    expect(proof.operations.reduce((sum, op) => sum + (op.settled_microusd ?? 0), 0)).toBe(last?.budget.spent_microusd);
    // An operation's reserved_microusd is its original reservation in every state (contract section 15.1);
    // none still holds it, so the request reserves nothing.
    expect(proof.operations.map((op) => op.reserved_microusd)).toEqual([TEST_PROFILE.worker_microusd, 100_000, 100_000, 100_000, 200_000, 200_000, 200_000]);
    expect(proof.operations.filter((op) => op.settled_microusd === null)).toEqual([]);
    expect(proof.slot).toEqual({ slot_key: "factory", holder_request_id: null, holder_validation_id: null });
    expect(proof.provider_calls.map((call) => [call.call_name, call.action])).toEqual(proof.operations.map((op) => [op.call_name, "create"]));
  });

  it("partial-budget skips the Umami candidate on the profile's worst cases, and its texts name the fake ledger's amounts", async () => {
    const { w, last } = await finishedFulfilled("partial-budget");
    const remaining = 1_000_000 - TEST_PROFILE.worker_microusd - TEST_PROFILE.candidate_microusd["task-report"];
    expect(last.budget.remaining_microusd).toBe(remaining);
    expect(remaining).toBeLessThan(TEST_PROFILE.candidate_microusd.umami);
    // The fixture's $0.59 is illustrative: the skip and the stop name the fake ledger's $0.50 and the $0.60 worst case.
    const skipAt = last.events.findIndex((event) => event.type === "candidate_skipped");
    const before = last.events.slice(0, skipAt).findLast((event) => event.type === "budget_updated");
    expect(before?.type === "budget_updated" ? before.data.remaining_microusd : null).toBe(remaining);
    const skipText = "Skipped: the remaining budget of $0.50 cannot cover this candidate's worst case of $0.60 on Umami.";
    expect(last.events[skipAt]?.message).toBe(skipText);
    expect(last.candidates[1]?.reason).toEqual({ code: "no_budget_for_candidate", message: skipText });
    const stopReason = { code: "budget_exhausted", message: "The remaining budget of $0.50 cannot cover another candidate's worst case. 1 of 2 requested cases was delivered." };
    expect(last.stop_reason).toEqual(stopReason);
    // A validation run after the finish spends from the same budget; the stop reason stays as it was.
    const caseId = last.cases[0]?.case_id ?? "";
    expect((await validate(w, caseId, "00000000-0000-4000-8000-0000000002f1")).status).toBe(202);
    w.clock.ms += 3 * STEP_MS;
    const after = await status(w);
    expect(after.budget.remaining_microusd).toBeLessThan(remaining);
    expect(after.stop_reason).toEqual(stopReason);
  });
});

describe("funnel (contract section 8.2)", () => {
  it("counts a candidate as explored once its checks start, so one selected and then skipped never counts", async () => {
    const w = makeWorld();
    await reset(w, "partial-budget");
    await start(w, "partial-budget");
    const seen = await runToEnd(w, "partial-budget");
    const selected = seen.filter((current) => current.candidates[1]?.stage === "selected");
    expect(selected.length).toBeGreaterThan(0);
    for (const current of selected) expect(current.funnel.candidates_explored).toBe(1);
    expect(seen.at(-1)?.funnel.candidates_explored).toBe(1);
  });

  it("does not count a candidate stopped between its selection and its reservation", async () => {
    const w = makeWorld();
    await reset(w, "two-host-fulfilled");
    await start(w, "two-host-fulfilled");
    let current = await status(w);
    for (let poll = 0; current.events.at(-1)?.type !== "candidate_selected"; poll += 1) {
      if (poll > 100) throw new Error("synthetic: no candidate was selected");
      w.clock.ms += STEP_MS;
      current = await status(w);
    }
    expect(current.funnel.candidates_explored).toBe(0);
    expect((await postStop(request(`${STATUS_PATH}/stop`, { body: {} }), w.server, { request_id: REQUEST_ID })).status).toBe(200);
    const last = (await runToEnd(w, "two-host-fulfilled")).at(-1);
    expect(last?.candidates.map((candidate) => [candidate.stage, candidate.reason?.code])).toEqual([["incomplete", "stopped"]]);
    expect(last?.funnel.candidates_explored).toBe(0);
    expect((await evidence(w)).operations.map((op) => op.kind)).toEqual(["worker"]);
  });
});

describe("worker-lost and reconciliation", () => {
  it("finishes worker_lost from a status poll, keeps the operations uncertain and the slot held, as test-evidence.json shows", async () => {
    const w = makeWorld();
    await reset(w, "worker-lost");
    await start(w, "worker-lost");
    const last = (await runToEnd(w, "worker-lost")).at(-1);
    expect(last?.stop_reason?.code).toBe("worker_lost");
    expect(last?.budget).toMatchObject({ reserved_microusd: 500_000, spent_microusd: 0 });
    // The fixture's attention text is kept: the $0.50 it names held is what the fake ledger holds.
    expect(last?.attention?.message).toContain("Their $0.50 of reservations stays held");
    const proof = await evidence(w);
    const expected = fixture("TestEvidence", "test-evidence.json");
    const strip = (item: TestEvidence) => ({
      operations: item.operations.map((op) => [op.kind, op.call_name, op.state, op.reserved_microusd, op.settled_microusd, op.attempt_ordinal]),
      slot: [item.slot.holder_request_id === null ? null : "held by the request", item.slot.holder_validation_id],
      provider_calls: item.provider_calls.map((call) => [call.call_name, call.provider, call.action]),
    });
    expect(strip(proof)).toEqual(strip(expected));
    expect(proof.slot.holder_request_id).toBe(REQUEST_ID);
    // The request's reserved amount sums only the operations still holding theirs: here all of them.
    expect(proof.operations.filter((op) => op.settled_microusd === null).reduce((sum, op) => sum + op.reserved_microusd, 0)).toBe(last?.budget.reserved_microusd);

    const blocked = await start(w, "worker-lost", OTHER_REQUEST_ID);
    expect(blocked.status).toBe(409);
    const refusal = await contractBody("ErrorResponse", blocked);
    const busyFixture = fixture("ErrorResponse", "error-busy-needs-reconciliation.json");
    expect([refusal.error.code, refusal.error.retryable, refusal.error.details]).toEqual([busyFixture.error.code, busyFixture.error.retryable, busyFixture.error.details]);

    const reconciled = await postTestReconcile(request("/api/factory/test/reconcile", { body: { request_id: REQUEST_ID }, session: false }), w.server);
    const after = await contractBody("RequestStatus", reconciled);
    expect(after.attention).toBeNull();
    expect([after.outcome, after.stop_reason?.code, after.delivery]).toEqual(["operational_error", "worker_lost", "none"]);
    expect(after.budget).toMatchObject({ reserved_microusd: 0, spent_microusd: 500_000 });
    expect(after.events.slice(-2).map((event) => event.type)).toEqual(["budget_updated", "attention_cleared"]);
    const settled = await evidence(w);
    // Reconciled operations keep their original reservations and hold nothing.
    expect(settled.operations.map((op) => [op.state, op.reserved_microusd, op.settled_microusd])).toEqual([
      ["reconciled", TEST_PROFILE.worker_microusd, TEST_PROFILE.worker_microusd],
      ["reconciled", 100_000, 100_000],
      ["reconciled", 100_000, 100_000],
      ["reconciled", 100_000, 100_000],
    ]);
    expect(settled.slot.holder_request_id).toBeNull();
    expect((await start(w, "worker-lost", OTHER_REQUEST_ID)).status).toBe(202);
  });

  it("finishes a lost worker that nobody polls once another start meets its slot: busy needs_reconciliation, not active", async () => {
    const w = makeWorld();
    await reset(w, "worker-lost");
    expect((await start(w, "worker-lost")).status).toBe(202);
    // Nobody reads the request while its worker stalls and the clock passes the lost-worker threshold.
    w.clock.ms += 1000 * STEP_MS;
    const blocked = await start(w, "worker-lost", OTHER_REQUEST_ID);
    expect(blocked.status).toBe(409);
    const refusal = await contractBody("ErrorResponse", blocked);
    const busyFixture = fixture("ErrorResponse", "error-busy-needs-reconciliation.json");
    expect([refusal.error.code, refusal.error.retryable, refusal.error.details]).toEqual([busyFixture.error.code, busyFixture.error.retryable, busyFixture.error.details]);
    const finished = await status(w);
    expect(shape(finished)).toEqual(shape(endState("worker-lost")));
    expect((await evidence(w)).slot.holder_request_id).toBe(REQUEST_ID);
  });

  it("appends no attention from the status port alone; only the status route's attention and lost-worker ports append it", async () => {
    const w = makeWorld();
    await reset(w, "worker-lost");
    await start(w, "worker-lost");
    w.clock.ms += 1000 * STEP_MS;
    const first = await w.world.status(REQUEST_ID, 0);
    const second = await w.world.status(REQUEST_ID, 0);
    expect(first?.state).not.toBe("finished");
    expect(second?.events).toEqual(first?.events);
    expect(second?.events.some((event) => event.type === "attention")).toBe(false);
    // The status route asks for the lost-worker finish, which appends worker_unresponsive first.
    const finished = await status(w);
    expect(finished.events.flatMap((event) => (event.type === "attention" ? [event.data.code] : []))).toEqual(["worker_unresponsive", "needs_reconciliation"]);
  });

  it("uncertain-provider stops needs_reconciliation with the uncertain copy held and no replacement create", async () => {
    const w = makeWorld();
    await reset(w, "uncertain-provider");
    await start(w, "uncertain-provider");
    const last = (await runToEnd(w, "uncertain-provider")).at(-1);
    expect([last?.outcome, last?.stop_reason?.code, last?.delivery, last?.attention?.code]).toEqual(["operational_error", "needs_reconciliation", "none", "needs_reconciliation"]);
    expect(last?.candidates.map((candidate) => [candidate.stage, candidate.reason?.code])).toEqual([["incomplete", "incomplete_run"]]);
    const proof = await evidence(w);
    expect(proof.operations.map((op) => [op.kind, op.state, op.reserved_microusd, op.settled_microusd])).toEqual([
      ["worker", "terminal", TEST_PROFILE.worker_microusd, TEST_PROFILE.worker_microusd],
      ["candidate_copy", "uncertain", 100_000, null],
      ["candidate_copy", "terminal", 100_000, 0],
      ["candidate_copy", "terminal", 100_000, 0],
    ]);
    // Only the uncertain copy still holds its reservation, so it alone makes up the request's reserved amount.
    expect(proof.operations.filter((op) => op.settled_microusd === null).reduce((sum, op) => sum + op.reserved_microusd, 0)).toBe(last?.budget.reserved_microusd);
    expect(proof.provider_calls.map((call) => call.call_name)).toEqual(["worker", "candidate-01-clean"]);
    expect(proof.slot.holder_request_id).toBe(REQUEST_ID);
    expect(last?.budget).toMatchObject({ reserved_microusd: 100_000, spent_microusd: TEST_PROFILE.worker_microusd });
  });
});

describe("worker attention", () => {
  it("raises worker_unresponsive from 60 s without a heartbeat and clears it once one arrives, through the status route", async () => {
    // One script step every 120 s: the worker's first heartbeat (worker_started) comes 120 s after the start.
    const w = makeWorld(0, 120_000);
    await reset(w, "two-host-fulfilled");
    expect((await start(w, "two-host-fulfilled")).status).toBe(202);
    w.clock.ms = START + 59_999;
    const quiet = await status(w);
    expect(quiet.attention).toBeNull();
    w.clock.ms = START + 60_000;
    const raised = await status(w);
    expect(raised.attention?.code).toBe("worker_unresponsive");
    expect(raised.events.slice(quiet.events.length)).toMatchObject([{ type: "attention", data: { code: "worker_unresponsive" } }]);
    expect((await status(w)).events).toEqual(raised.events);
    w.clock.ms = START + 120_000;
    const cleared = await status(w);
    expect(cleared.attention).toBeNull();
    expect(cleared.events.slice(raised.events.length).map((event) => [event.type, event.data])).toEqual([
      ["worker_started", {}],
      ["attention_cleared", { code: "worker_unresponsive" }],
    ]);
  });
});

describe("controls", () => {
  it("holds every start for 2 s inside its ID lock, so concurrent duplicates overlap deterministically", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const w = makeWorld(2000);
    await reset(w, "two-host-fulfilled");
    const input = endState("two-host-fulfilled").interpretation.input;
    const body = { request_id: REQUEST_ID, input, interpretation_sha256: endState("two-host-fulfilled").interpretation.interpretation_sha256 };
    const done: number[] = [];
    const first = postStart(request("/api/factory/requests", { body }), w.server).then((response) => {
      done.push(response.status);
      return response;
    });
    const second = postStart(request("/api/factory/requests", { body }), w.server).then((response) => {
      done.push(response.status);
      return response;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toEqual([202]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toEqual([202]);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toEqual([202, 200]);
    await Promise.all([first, second]);
    const proof = await evidence(w);
    expect(proof.provider_calls.filter((call) => call.call_name === "worker")).toHaveLength(1);
    expect(proof.operations.filter((op) => op.kind === "worker")).toHaveLength(1);
  });

  it("refuses a start outside the limits or with a repeated item key with invalid_request before the ID lock, also for an existing request ID", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const w = makeWorld(2000);
    await reset(w, "two-host-fulfilled");
    const accepted = start(w, "two-host-fulfilled");
    await vi.advanceTimersByTimeAsync(2000);
    expect((await accepted).status).toBe(202);
    const { input, interpretation_sha256 } = endState("two-host-fulfilled").interpretation;
    const { limits } = TEST_PROFILE;
    const [first, ...rest] = input.items;
    if (first === undefined) throw new Error("synthetic: no item");
    const firstWith = (change: Partial<typeof first>) => ({ ...input, items: [{ ...first, ...change }, ...rest] });
    const refused = [
      { ...input, items: [...input.items, { ...first }] },
      firstWith({ quantity: limits.max_quantity_per_item + 1 }),
      firstWith({ description: "x".repeat(limits.max_description_chars + 1) }),
      firstWith({ description: "an unpaired \uD800 surrogate" }),
      { ...input, budget_microusd: limits.max_budget_microusd + 1 },
    ];
    for (const body of refused) {
      let answered = false;
      const pending = postStart(request("/api/factory/requests", { body: { request_id: REQUEST_ID, input: body, interpretation_sha256 } }), w.server).then((response) => {
        answered = true;
        return response;
      });
      // The 2 s hold is inside the lock: an answer before it means the lock was never entered.
      await vi.advanceTimersByTimeAsync(1999);
      expect(answered).toBe(true);
      const response = await pending;
      expect(response.status).toBe(400);
      expect((await contractBody("ErrorResponse", response)).error.code).toBe("invalid_request");
    }
    expect((await evidence(w)).operations.filter((op) => op.kind === "worker")).toHaveLength(1);
  });

  it("holds every validation start for 2 s too", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const w = makeWorld(2000);
    await reset(w, "two-host-fulfilled");
    const started = start(w, "two-host-fulfilled");
    await vi.advanceTimersByTimeAsync(2000);
    expect((await started).status).toBe(202);
    const caseId = (await runToEnd(w, "two-host-fulfilled")).at(-1)?.cases[0]?.case_id ?? "";
    let answered = false;
    const pending = validate(w, caseId, "00000000-0000-4000-8000-0000000002b1").then((response) => {
      answered = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(202);
  });

  it("reset discards every record and releases the slot; it refuses an unknown scenario", async () => {
    const w = makeWorld();
    await reset(w, "two-host-fulfilled");
    await start(w, "two-host-fulfilled");
    expect((await evidence(w)).slot.holder_request_id).toBe(REQUEST_ID);
    await reset(w, "zero-result");
    const missing = await getRequestStatus(request(STATUS_PATH), w.server, { request_id: REQUEST_ID });
    expect(missing.status).toBe(404);
    expect((await getTestEvidence(request(`/api/factory/test/evidence?request_id=${REQUEST_ID}`, { session: false }), w.server)).status).toBe(404);
    expect(w.world.selected).toBe("zero-result");
    expect((await start(w, "zero-result")).status).toBe(202);
    const bad = await postTestReset(request("/api/factory/test/reset", { body: { scenario: "synthetic-none" }, session: false }), w.server);
    expect(bad.status).toBe(400);
  });

  it("reset during a start's 2 s hold leaves nothing of that start in the emptied world", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const w = makeWorld(2000);
    await reset(w, "two-host-fulfilled");
    const held = start(w, "two-host-fulfilled");
    await vi.advanceTimersByTimeAsync(1000);
    await settle(reset(w, "two-host-fulfilled"));
    await settle(held);
    expect((await getRequestStatus(request(STATUS_PATH), w.server, { request_id: REQUEST_ID })).status).toBe(404);
    expect((await getTestEvidence(request(`/api/factory/test/evidence?request_id=${REQUEST_ID}`, { session: false }), w.server)).status).toBe(404);
    const next = await settle(start(w, "two-host-fulfilled", OTHER_REQUEST_ID));
    expect(next.status).toBe(202);
    expect((await evidence(w, OTHER_REQUEST_ID)).slot.holder_request_id).toBe(OTHER_REQUEST_ID);
  });

  it("reset during a validation start's hold leaves no run of it in the next world, also for a queued duplicate", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const w = makeWorld(2000);
    await reset(w, "two-host-fulfilled");
    expect((await settle(start(w, "two-host-fulfilled"))).status).toBe(202);
    const caseId = (await runToEnd(w, "two-host-fulfilled")).at(-1)?.cases[0]?.case_id ?? "";
    const validationId = "00000000-0000-4000-8000-0000000002f1";
    // The duplicate waits behind the first in the validation ID's lock and is held 2 s after it.
    const held = [validate(w, caseId, validationId), validate(w, caseId, validationId)];
    await vi.advanceTimersByTimeAsync(1000);
    await settle(reset(w, "two-host-fulfilled"));
    // The same request ID delivers the same case in the next world.
    expect((await settle(start(w, "two-host-fulfilled"))).status).toBe(202);
    await runToEnd(w, "two-host-fulfilled");
    await settle(Promise.all(held));
    const run = await getValidationRun(request(`${STATUS_PATH}/cases/${caseId}/validations/${validationId}`), w.server, { request_id: REQUEST_ID, case_id: caseId, validation_id: validationId });
    expect(run.status).toBe(404);
    const proof = await evidence(w);
    expect(proof.operations.filter((op) => op.kind === "validation")).toEqual([]);
    expect(proof.slot).toEqual({ slot_key: "factory", holder_request_id: null, holder_validation_id: null });
  });

  it("refuses a start whose input is not the selected scenario's, and releases the slot", async () => {
    const w = makeWorld();
    await reset(w, "zero-result");
    const refused = await start(w, "two-host-fulfilled");
    expect(refused.status).toBe(503);
    expect((await contractBody("ErrorResponse", refused)).error.message).toContain("zero-result");
    expect((await start(w, "zero-result")).status).toBe(202);
  });

  it("interprets only the fixtures' inputs, after normalizing descriptions, and refuses input outside the limits", async () => {
    const w = makeWorld();
    const supported = fixture("Interpretation", "interpretation-supported.json");
    const padded = { ...supported.input, items: supported.input.items.map((item) => ({ ...item, description: item.description === null ? "   " : `  ${item.description}\n` })) };
    const answer = await contractBody("Interpretation", await postInterpretation(request("/api/factory/interpretations", { body: padded, session: false }), w.server));
    expect(answer).toEqual(supported);
    for (const body of [{ ...supported.input, budget_microusd: TEST_PROFILE.limits.max_budget_microusd + 1 }, { ...supported.input, budget_microusd: 1_234_567 }]) {
      const refused = await postInterpretation(request("/api/factory/interpretations", { body, session: false }), w.server);
      expect(refused.status).toBe(400);
    }
  });

  it("counts a description's length in Unicode code points after trimming (contract sections 4 and 5)", async () => {
    const w = makeWorld();
    const { input } = fixture("Interpretation", "interpretation-supported.json");
    const limit = TEST_PROFILE.limits.max_description_chars;
    const refusal = async (description: string): Promise<string> => {
      const body = { ...input, items: input.items.map((item, index) => (index === 0 ? { ...item, description } : item)) };
      const response = await postInterpretation(request("/api/factory/interpretations", { body, session: false }), w.server);
      expect(response.status).toBe(400);
      return (await contractBody("ErrorResponse", response)).error.message;
    };
    // An emoji is one code point and two UTF-16 code units: the limit's worth of them fits, one more does not.
    const atLimit = `  ${"\u{1F600}".repeat(limit)}\n`;
    expect(atLimit.trim().length).toBe(2 * limit);
    expect(await refusal(atLimit)).toBe("Test mode interprets only the inputs of the contract fixtures.");
    expect(await refusal("\u{1F600}".repeat(limit + 1))).toContain(`at most ${String(limit)} characters`);
  });

  it("answers the stop of a request that finished with its status and records nothing", async () => {
    const w = makeWorld();
    await reset(w, "zero-result");
    await start(w, "zero-result");
    const last = (await runToEnd(w, "zero-result")).at(-1);
    const stop = await contractBody("RequestStatus", await postStop(request(`${STATUS_PATH}/stop`, { body: {} }), w.server, { request_id: REQUEST_ID }));
    expect(stop.events).toEqual(last?.events);
  });

  it.each([
    ["after a candidate's end and before its settlement", (current: RequestStatus) => current.events.at(-1)?.type === "case_delivered"],
    ["after the worker settled and before request_finished", (current: RequestStatus) => current.events.length === endState("two-host-fulfilled").events.length - 1],
  ])("settles everything once when a stop lands %s", async (_when, ready) => {
    const w = makeWorld();
    await reset(w, "two-host-fulfilled");
    await start(w, "two-host-fulfilled");
    let current = await status(w);
    while (!ready(current)) {
      w.clock.ms += STEP_MS;
      current = await status(w);
    }
    await postStop(request(`${STATUS_PATH}/stop`, { body: {} }), w.server, { request_id: REQUEST_ID });
    const last = (await runToEnd(w, "two-host-fulfilled")).at(-1);
    expect(last?.outcome).toBe("cancelled");
    expect(last?.budget.reserved_microusd).toBe(0);
    const proof = await evidence(w);
    expect(proof.operations.every((op) => op.state === "terminal" && op.settled_microusd !== null)).toBe(true);
    // Every budget_updated event marks a change.
    const budgets = (last?.events ?? []).filter((event) => event.type === "budget_updated").map((event) => JSON.stringify(event.data));
    expect(budgets.filter((data, index) => index > 0 && data === budgets[index - 1])).toEqual([]);
    expect(proof.slot.holder_request_id).toBeNull();
  });

  it("reconcile of a finished request leaves the slot with its running validation run", async () => {
    const { w, last } = await finishedFulfilled("two-host-fulfilled");
    const validation = "00000000-0000-4000-8000-0000000002e1";
    expect((await validate(w, last.cases[0]?.case_id ?? "", validation)).status).toBe(202);
    await postTestReconcile(request("/api/factory/test/reconcile", { body: { request_id: REQUEST_ID }, session: false }), w.server);
    expect((await evidence(w)).slot).toEqual({ slot_key: "factory", holder_request_id: REQUEST_ID, holder_validation_id: validation });
    const second = await validate(w, last.cases[1]?.case_id ?? "", "00000000-0000-4000-8000-0000000002e2");
    expect(await contractBody("ErrorResponse", second)).toMatchObject({ error: { code: "busy" } });
  });

  it("stops any running scenario at the next step: the candidate in flight becomes incomplete, outcome cancelled", async () => {
    const w = makeWorld();
    await reset(w, "two-host-fulfilled");
    await start(w, "two-host-fulfilled");
    for (;;) {
      const current = await status(w);
      if (current.candidates[0]?.stage === "checking") break;
      w.clock.ms += STEP_MS;
    }
    const stopped = await contractBody("RequestStatus", await postStop(request(`${STATUS_PATH}/stop`, { body: {} }), w.server, { request_id: REQUEST_ID }));
    expect(stopped.state).toBe("stopping");
    const last = (await runToEnd(w, "two-host-fulfilled")).at(-1);
    expect([last?.outcome, last?.stop_reason?.code, last?.delivery]).toEqual(["cancelled", "cancelled_by_user", "none"]);
    expect(last?.candidates.map((candidate) => [candidate.stage, candidate.reason?.code])).toEqual([["incomplete", "stopped"]]);
    expect(last?.budget.reserved_microusd).toBe(0);
    expect((await evidence(w)).slot.holder_request_id).toBeNull();
  });
});

async function finishedFulfilled(scenario: TestScenario): Promise<{ w: World; last: RequestStatus }> {
  const w = makeWorld();
  await reset(w, scenario);
  await start(w, scenario);
  const last = (await runToEnd(w, scenario)).at(-1);
  if (last === undefined) throw new Error("synthetic: no status");
  return { w, last };
}

async function validate(w: World, caseId: string, validationId: string, requestId = REQUEST_ID): Promise<Response> {
  return keep(w, await postValidation(request(`/api/factory/requests/${requestId}/cases/${caseId}/validations`, { body: { validation_id: validationId } }), w.server, { request_id: requestId, case_id: caseId }));
}

async function readRun(w: World, caseId: string, validationId: string): Promise<ValidationRun> {
  const response = await keep(w, await getValidationRun(request(`${STATUS_PATH}/cases/${caseId}/validations/${validationId}`), w.server, { request_id: REQUEST_ID, case_id: caseId, validation_id: validationId }));
  return contractBody("ValidationRun", response);
}

describe("validation runs in test mode", () => {
  const VALIDATION = "00000000-0000-4000-8000-0000000002b1";
  const SECOND = "00000000-0000-4000-8000-0000000002b2";

  it.each([
    ["two-host-fulfilled", "passed"],
    ["validation-failed", "failed"],
    ["validation-error", "error"],
  ] as const)("%s: a run reserves its worst case, holds the slot and finishes %s", async (scenario, result) => {
    const { w, last } = await finishedFulfilled(scenario);
    const caseRecord = last.cases[0];
    if (caseRecord === undefined) throw new Error("synthetic: no case");
    const accepted = await validate(w, caseRecord.case_id, VALIDATION);
    expect(accepted.status).toBe(202);
    const running = await contractBody("ValidationRun", accepted);
    expect(running).toMatchObject({ state: "running", result: null, cost_microusd: null, package_sha256: { bug_case: caseRecord.packages.bug_case.sha256, validator: caseRecord.packages.validator.sha256 } });
    expect((await validate(w, caseRecord.case_id, VALIDATION)).status).toBe(200);
    const held = await evidence(w);
    expect(held.slot).toEqual({ slot_key: "factory", holder_request_id: REQUEST_ID, holder_validation_id: VALIDATION });
    expect(held.operations.at(-1)).toMatchObject({ kind: "validation", call_name: "validation-01", state: "running", settled_microusd: null });
    const otherCase = last.cases[1]?.case_id ?? "";
    const busy = await validate(w, otherCase, SECOND);
    expect(await contractBody("ErrorResponse", busy)).toMatchObject({ error: { code: "busy", details: { reason: "active" } } });
    expect((await getValidationRun(request(`${STATUS_PATH}/cases/${otherCase}/validations/${SECOND}`), w.server, { request_id: REQUEST_ID, case_id: otherCase, validation_id: SECOND })).status).toBe(404);
    w.clock.ms += 3 * STEP_MS;
    const finished = await readRun(w, caseRecord.case_id, VALIDATION);
    const worst = TEST_PROFILE.validation_microusd[caseRecord.host_id];
    expect(finished).toMatchObject({ state: "finished", result, cost_microusd: worst });
    const after = await status(w);
    expect(after.events.slice(last.events.length).map((event) => event.type)).toEqual(["budget_updated", "validation_started", "validation_finished", "budget_updated"]);
    expect(after.cases[0]?.validation).toEqual(finished);
    expect(after.budget.spent_microusd).toBe((last.budget.spent_microusd) + worst);
    expect([after.outcome, after.stop_reason, after.delivery]).toEqual([last.outcome, last.stop_reason, last.delivery]);
    expectBudgetArithmetic(after);
    expect((await validate(w, otherCase, SECOND)).status).toBe(202);
  });

  it("keeps a run's cost as recorded when it completed: null after uncertain spend, which a reconcile settles in the request's budget, not on the run", async () => {
    const { w, last } = await finishedFulfilled("validation-error");
    const caseRecord = last.cases[0];
    if (caseRecord === undefined) throw new Error("synthetic: no case");
    expect((await validate(w, caseRecord.case_id, VALIDATION)).status).toBe(202);
    // No scenario makes a run's spend uncertain, so the test marks its operation's outcome uncertain while it runs.
    const internals = w.world as unknown as { ops: { kind: string; state: string }[] };
    const op = internals.ops.findLast((item) => item.kind === "validation");
    if (op === undefined) throw new Error("synthetic: no validation operation");
    op.state = "uncertain";
    w.clock.ms += 3 * STEP_MS;
    const finished = await readRun(w, caseRecord.case_id, VALIDATION);
    expect(finished).toMatchObject({ state: "finished", result: "error" });
    expect(finished.cost_microusd).toBeNull();
    const worst = TEST_PROFILE.validation_microusd[caseRecord.host_id];
    const before = await status(w);
    expect(before.budget.reserved_microusd).toBe(worst);
    expect(before.events.at(-1)).toMatchObject({ type: "budget_updated", message: "The validation run's spend is uncertain, so its $0.20 reservation stays held until reconciliation." });
    await postTestReconcile(request("/api/factory/test/reconcile", { body: { request_id: REQUEST_ID }, session: false }), w.server);
    const after = await status(w);
    expect(after.budget).toMatchObject({ reserved_microusd: 0, spent_microusd: before.budget.spent_microusd + worst });
    expect(after.events.at(-1)?.type).toBe("budget_updated");
    // null is never read as 0, and the reconciled amount never becomes the run's cost.
    expect((await readRun(w, caseRecord.case_id, VALIDATION)).cost_microusd).toBeNull();
    expect(after.cases[0]?.validation?.cost_microusd).toBeNull();
  });

  it("answers busy while the request itself holds the slot, and budget_unavailable once the budget's room is spent", async () => {
    const { w, last } = await finishedFulfilled("partial-budget");
    const caseId = last.cases[0]?.case_id ?? "";
    const ids = ["00000000-0000-4000-8000-0000000002c1", "00000000-0000-4000-8000-0000000002c2", "00000000-0000-4000-8000-0000000002c3"];
    for (const id of ids.slice(0, 2)) {
      expect((await validate(w, caseId, id)).status).toBe(202);
      w.clock.ms += 3 * STEP_MS;
      expect((await readRun(w, caseId, id)).state).toBe("finished");
    }
    const refused = await validate(w, caseId, ids[2] ?? "");
    expect(await contractBody("ErrorResponse", refused)).toMatchObject({ error: { code: "budget_unavailable" } });
    expect((await getValidationRun(request(`${STATUS_PATH}/cases/${caseId}/validations/${ids[2] ?? ""}`), w.server, { request_id: REQUEST_ID, case_id: caseId, validation_id: ids[2] ?? "" })).status).toBe(404);

    const active = makeWorld();
    await reset(active, "cancel-midway");
    await start(active, "cancel-midway");
    let current = await status(active);
    while (current.cases.length === 0) {
      active.clock.ms += STEP_MS;
      current = await status(active);
    }
    const busy = await validate(active, current.cases[0]?.case_id ?? "", ids[0] ?? "");
    expect(await contractBody("ErrorResponse", busy)).toMatchObject({ error: { code: "busy", retryable: true, details: { reason: "active" } } });
  });
});

describe("downloads and the payload rule in test mode", () => {
  it("serves both parts with the announced SHA-256; only the validator part holds evaluator material, and no JSON body does", async () => {
    const { w, last } = await finishedFulfilled("two-host-fulfilled");
    await validate(w, last.cases[0]?.case_id ?? "", "00000000-0000-4000-8000-0000000002d1");
    w.clock.ms += 3 * STEP_MS;
    await status(w);
    for (const item of last.cases) {
      for (const [part, announced] of [["bug-case", item.packages.bug_case], ["validator", item.packages.validator]] as const) {
        const response = await getPackage(request(announced.download_path ?? ""), w.server, { request_id: REQUEST_ID, case_id: item.case_id, part });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${announced.filename}"`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(sha256(bytes)).toBe(announced.sha256);
        expect(bytes.length).toBe(announced.size_bytes);
        expect(gunzipSync(bytes).toString("latin1").includes(TEST_MODE_EVALUATOR_SENTINEL)).toBe(part === "validator");
      }
    }
    await evidence(w);
    expect(w.bodies.length).toBeGreaterThan(20);
    for (const body of w.bodies) expect(body).not.toContain(TEST_MODE_EVALUATOR_SENTINEL);
    const packageReady = last.events.filter((event) => event.type === "package_ready");
    expect(packageReady.map((event) => event.data)).toEqual(last.cases.map((item) => ({ bug_case_sha256: item.packages.bug_case.sha256, validator_sha256: item.packages.validator.sha256 })));
  });

  it("answers not_found for a part of a case that this request did not deliver", async () => {
    const { w, last } = await finishedFulfilled("sources-exhausted");
    const other = endState("two-host-fulfilled").cases[1]?.case_id ?? "";
    expect(last.cases.some((item) => item.case_id === other)).toBe(false);
    const response = await getPackage(request(`${STATUS_PATH}/cases/${other}/packages/bug-case`), w.server, { request_id: REQUEST_ID, case_id: other, part: "bug-case" });
    expect(response.status).toBe(404);
  });
});
