// Test mode (contract section 15.1, revision 3) through the handlers: each scenario reaches its fixture's end
// state (outcomes, stop codes, delivery, attention, stages, counts and event order; amounts, also those
// in texts, follow the test profile's worst cases), the evidence adds up to the status and names the
// ledger's executions and the copies' hosts, setup-failed, the pending-package window of
// two-host-fulfilled, the 2 s hold, reconcile and reset, validation runs, hash-checked downloads, and no
// JSON response carries evaluator material.
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyExecutionId, REASON_TEXT, requestRoot, validationRoot } from "@rbw/factory";
import type { HostId, RequestInput, RequestStatus, TestEvidence, TestScenario, ValidationRun } from "@rbw/factory-contract";
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
import { PENDING_PACKAGE_MS } from "../../src/factory-server/test-mode/scenarios.ts";
import { TestWorld, withItemKeys } from "../../src/factory-server/test-mode/world.ts";
import { contractBody, fixture, FIXTURES, OTHER_REQUEST_ID, PASSCODE, request, REQUEST_ID, sha256, START, VALIDATION_ID } from "./support.ts";

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
  return { world, clock, bodies: [], server: { ports: world, requestRoot, test: world, log: () => undefined } };
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

async function start(w: World, scenario: TestScenario, requestId = REQUEST_ID, input: RequestInput = endState(scenario).interpretation.input): Promise<Response> {
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

/** Contract section 8.2: a candidate has started checks once its first check_finished is recorded; only then is it explored and checking. */
function expectExploredByChecks(current: RequestStatus): void {
  const checked = new Set(current.events.flatMap((event) => (event.type === "check_finished" && event.candidate_id !== null ? [event.candidate_id] : [])));
  expect(current.funnel.candidates_explored).toBe(checked.size);
  for (const candidate of current.candidates) if (candidate.stage === "checking") expect(checked.has(candidate.candidate_id)).toBe(true);
}

/** Whether the last event is the reservation of the candidate selected just before it. */
const justReserved = (current: RequestStatus): boolean => current.events.at(-2)?.type === "candidate_selected" && current.events.at(-1)?.type === "budget_updated";

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

/** The scenarios whose run ends as an end-state fixture shows (setup-failed and uncertain-provider have none). */
const ENDING: TestScenario[] = TEST_SCENARIO_VALUES.filter((scenario) => scenario !== "uncertain-provider" && scenario !== "setup-failed" && !scenario.startsWith("validation-"));

/**
 * The evidence's ledger identities (contract revision 3): the worker runs under the request's root
 * execution with no host, every other operation has an execution of its own and a host, and each
 * provider call names the execution of the operation with its call name.
 */
function expectEvidenceIdentities(proof: TestEvidence, requestId: string): void {
  expect(proof.root_execution_id).toBe(requestRoot(requestId));
  const workers = proof.operations.filter((op) => op.kind === "worker");
  expect(workers.map((op) => [op.execution_id, op.host_id])).toEqual([[proof.root_execution_id, null]]);
  for (const op of proof.operations) if (op.kind !== "worker") expect(op.host_id, op.call_name).not.toBeNull();
  expect(new Set(proof.operations.map((op) => op.execution_id)).size).toBe(proof.operations.length);
  const executionOf = new Map(proof.operations.map((op) => [op.call_name, op.execution_id]));
  for (const call of proof.provider_calls) expect(call.execution_id, call.call_name).toBe(executionOf.get(call.call_name));
}

/** What a candidate's copies reserve on each host, from the evidence. */
function reservedByHost(proof: TestEvidence): Partial<Record<HostId, number>> {
  const sums: Partial<Record<HostId, number>> = {};
  for (const op of proof.operations) if (op.kind === "candidate_copy" && op.host_id !== null) sums[op.host_id] = (sums[op.host_id] ?? 0) + op.reserved_microusd;
  return sums;
}

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
      expectExploredByChecks(earlier);
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
    // Each copy runs on its candidate's host under the execution the shared identities give it.
    expectEvidenceIdentities(proof, REQUEST_ID);
    expect(reservedByHost(proof)).toEqual(TEST_PROFILE.candidate_microusd);
    const [taskReport, umami] = last?.candidates ?? [];
    expect([taskReport?.host_id, umami?.host_id]).toEqual(["task-report", "umami"]);
    const copies = proof.operations.filter((op) => op.kind === "candidate_copy");
    const expected = [taskReport, umami].flatMap((candidate) =>
      (["clean", "buggy", "fixed"] as const).map((state) => [candidate?.host_id, copyExecutionId({ kind: "request", root: requestRoot(REQUEST_ID), subject_id: candidate?.candidate_id ?? "", state, n: 1 })]),
    );
    expect(copies.map((op) => [op.host_id, op.execution_id])).toEqual(expected);
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
    // The skipped Umami candidate reserved nothing: every copy in the evidence is the task-report candidate's.
    const proof = await evidence(w);
    expectEvidenceIdentities(proof, REQUEST_ID);
    expect(reservedByHost(proof)).toEqual({ "task-report": TEST_PROFILE.candidate_microusd["task-report"] });
    expect(proof.operations.filter((op) => op.host_id === "umami")).toEqual([]);
    // A validation run after the finish spends from the same budget; the stop reason stays as it was.
    const caseId = last.cases[0]?.case_id ?? "";
    expect((await validate(w, caseId, "00000000-0000-4000-8000-0000000002f1")).status).toBe(202);
    w.clock.ms += 3 * STEP_MS;
    const after = await status(w);
    expect(after.budget.remaining_microusd).toBeLessThan(remaining);
    expect(after.stop_reason).toEqual(stopReason);
  });
});

/** An input under other item keys, in item order: the request form's item-1 to item-n by default. */
function keyed(input: RequestInput, keys: readonly string[] = input.items.map((_item, index) => `item-${String(index + 1)}`)): { input: RequestInput; map: Map<string, string> } {
  const map = new Map(input.items.map((item, index) => [item.item_key, keys[index] ?? item.item_key]));
  return { input: { ...input, items: input.items.map((item) => ({ ...item, item_key: map.get(item.item_key) ?? item.item_key })) }, map };
}

/** A key as a whole key in a body, as test mode rewrites it: not part of a longer key or word. */
const wholeKey = (key: string): RegExp => new RegExp(`(?<![\\w-])${key}(?![\\w-])`);

async function interpretation(w: World, input: RequestInput) {
  return contractBody("Interpretation", await keep(w, await postInterpretation(request("/api/factory/interpretations", { body: input, session: false }), w.server)));
}

describe("item keys of the request form", () => {
  it("rewrites every item_key field and whole fixture keys in message texts at once, so swapped keys stay swapped", () => {
    const swap = new Map([
      ["concurrency-1", "date-time-1"],
      ["date-time-1", "concurrency-1"],
    ]);
    const value = {
      item_key: "concurrency-1",
      events: [
        { item_key: "date-time-1", message: "Item concurrency-1, then date-time-1." },
        { item_key: null, message: "concurrency-10, x-concurrency-1 and concurrency-1-b stay; concurrency-1 does not." },
      ],
      description: "concurrency-1 outside a message stays",
      item: { item_key: "concurrency-any" },
    };
    expect(withItemKeys(value, swap)).toEqual({
      item_key: "date-time-1",
      events: [
        { item_key: "concurrency-1", message: "Item date-time-1, then concurrency-1." },
        { item_key: null, message: "concurrency-10, x-concurrency-1 and concurrency-1-b stay; date-time-1 does not." },
      ],
      description: "concurrency-1 outside a message stays",
      item: { item_key: "concurrency-any" },
    });
    expect(value.item_key).toBe("concurrency-1");
  });

  it.each(ENDING)("%s with form item keys", async (scenario) => {
    const w = makeWorld();
    await reset(w, scenario);
    const end = endState(scenario);
    const { input, map } = keyed(end.interpretation.input);
    const keys = [...map.values()];
    const answer = await interpretation(w, input);
    expect(answer.input.items.map((item) => item.item_key)).toEqual(keys);
    expect(answer.items.map((item) => item.item_key)).toEqual(keys);
    expect(answer.interpretation_sha256).not.toBe(end.interpretation.interpretation_sha256);
    expect(await interpretation(w, input)).toEqual(answer);
    expect(answer).toEqual({ ...withItemKeys(end.interpretation, map), interpretation_sha256: answer.interpretation_sha256 });

    const started = await start(w, scenario, REQUEST_ID, input);
    expect(started.status).toBe(202);
    const last = (await runToEnd(w, scenario)).at(-1);
    if (last === undefined) throw new Error("synthetic: no status");
    const expected = withItemKeys(end, map);
    expect(shape(last)).toEqual(shape({ ...expected, interpretation: answer }));
    expect(last.items.map((item) => [item.item_key, item.delivered, item.case_ids.length])).toEqual(end.items.map((item) => [map.get(item.item_key), item.delivered, item.case_ids.length]));
    expect(last.type_totals).toEqual(end.type_totals);
    for (const item of last.cases) expect(keys).toContain(item.item_key);

    const delivered = last.cases[0];
    if (delivered !== undefined) {
      expect((await validate(w, delivered.case_id, VALIDATION_ID)).status).toBe(202);
      w.clock.ms += 3 * STEP_MS;
      const runs = (await status(w)).events.filter((event) => event.type === "validation_started" || event.type === "validation_finished");
      expect(runs.map((event) => event.item_key)).toEqual([delivered.item_key, delivered.item_key]);
    }
    for (const body of w.bodies) for (const key of map.keys()) expect(body, key).not.toMatch(wholeKey(key));
  });

  it("refuses other requirements, a hash computed for other keys, and the same request ID with other keys", async () => {
    const w = makeWorld();
    await reset(w, "two-host-fulfilled");
    const end = endState("two-host-fulfilled");
    const { input } = keyed(end.interpretation.input);
    const refusal = async (response: Response): Promise<[number, string]> => [response.status, (await contractBody("ErrorResponse", response)).error.code];
    const interpret = (body: unknown) => postInterpretation(request("/api/factory/interpretations", { body, session: false }), w.server);
    const begin = (body: unknown, sha: string) => postStart(request("/api/factory/requests", { body: { request_id: REQUEST_ID, input: body, interpretation_sha256: sha } }), w.server);

    // Items are positional: the same items in another order are other requirements.
    expect(await refusal(await interpret({ ...input, items: [...input.items].reverse() }))).toEqual([400, "invalid_request"]);
    const repeated = await interpret(keyed(input, ["item-1", "item-1"]).input);
    expect(await contractBody("ErrorResponse", repeated)).toMatchObject({ error: { code: "invalid_request", message: "The item key item-1 is used twice." } });

    // The fixture's hash, or the hash for other form keys, is stale for these keys.
    const stale = await begin(input, end.interpretation.interpretation_sha256);
    expect(await contractBody("ErrorResponse", stale.clone())).toMatchObject({ error: { code: "interpretation_stale" } });
    expect(JSON.stringify(await stale.json())).not.toMatch(wholeKey("concurrency-1"));
    const other = await interpretation(w, keyed(input, ["item-a", "item-b"]).input);
    expect(await refusal(await begin(input, other.interpretation_sha256))).toEqual([409, "interpretation_stale"]);

    // A swap of the fixture's own keys is a rewrite too, with its own hash.
    const swapped = await interpretation(w, keyed(end.interpretation.input, ["date-time-1", "concurrency-1"]).input);
    expect(swapped.items.map((item) => [item.item_key, item.bug_type_id])).toEqual([
      ["date-time-1", "concurrency"],
      ["concurrency-1", "date_time"],
    ]);
    expect(swapped.interpretation_sha256).not.toBe(end.interpretation.interpretation_sha256);

    const answer = await interpretation(w, input);
    expect((await begin(input, answer.interpretation_sha256)).status).toBe(202);
    expect((await begin(input, answer.interpretation_sha256)).status).toBe(200);
    expect(await refusal(await begin(end.interpretation.input, end.interpretation.interpretation_sha256))).toEqual([409, "idempotency_conflict"]);
  });

  it("refuses another scenario's input under form keys with unavailable and releases the slot, and answers an unsupported one unsupported_request", async () => {
    const w = makeWorld();
    await reset(w, "zero-result");
    const refused = await start(w, "two-host-fulfilled", REQUEST_ID, keyed(endState("two-host-fulfilled").interpretation.input).input);
    expect(refused.status).toBe(503);
    expect((await contractBody("ErrorResponse", refused)).error.message).toContain("zero-result");
    expect((await start(w, "zero-result", OTHER_REQUEST_ID, keyed(endState("zero-result").interpretation.input).input)).status).toBe(202);

    const unsupported = fixture("Interpretation", "interpretation-unsupported.json");
    const { input, map } = keyed(unsupported.input);
    const answer = await interpretation(w, input);
    expect(answer.startable).toBe(false);
    expect(answer).toEqual({ ...withItemKeys(unsupported, map), interpretation_sha256: answer.interpretation_sha256 });
    const response = await keep(w, await postStart(request("/api/factory/requests", { body: { request_id: REQUEST_ID, input, interpretation_sha256: answer.interpretation_sha256 } }), w.server));
    expect(response.status).toBe(422);
    expect((await contractBody("ErrorResponse", response)).error.code).toBe("unsupported_request");
    for (const body of w.bodies.slice(-2)) for (const key of map.keys()) expect(body, key).not.toMatch(wholeKey(key));
  });

  it("refuses fixtures that interpret the same requirements under other item keys differently", () => {
    const dir = mkdtempSync(join(tmpdir(), "rbw-test-mode-fixtures-"));
    cpSync(FIXTURES, dir, { recursive: true });
    const supported = fixture("Interpretation", "interpretation-supported.json");
    const renamed = withItemKeys(supported, new Map([["concurrency-1", "other-1"], ["date-time-1", "other-2"]]));
    writeFileSync(join(dir, "interpretation-supported.json"), JSON.stringify({ ...renamed, interpretation_sha256: "2".repeat(64) }));
    expect(() => loadTestFixtures(dir)).toThrow("test mode: two fixtures interpret one input differently");
  });
});

describe("setup-failed (contract section 15.1, revision 3)", () => {
  it.each([
    ["the fixture's item keys", false],
    ["the request form's item keys", true],
  ] as const)("with %s: the Umami clean copy cannot be prepared, its buggy and fixed copies still run, and the candidate is invalid", async (_keys, form) => {
    const w = makeWorld();
    await reset(w, "setup-failed");
    // The scenario sends the input of status-zero-result.json.
    const fixtureInput = endState("zero-result").interpretation.input;
    const { input, map } = form ? keyed(fixtureInput) : { input: fixtureInput, map: new Map<string, string>() };
    const started = await start(w, "setup-failed", REQUEST_ID, input);
    expect(started.status).toBe(202);
    const seen = await runToEnd(w, "setup-failed");
    const last = seen.at(-1);
    if (last === undefined) throw new Error("synthetic: no status");
    for (const earlier of seen) {
      expect(earlier.events).toEqual(last.events.slice(0, earlier.events.length));
      expectBudgetArithmetic(earlier);
      expectExploredByChecks(earlier);
    }
    expect([last.state, last.outcome, last.stop_reason?.code, last.delivery, last.attention]).toEqual(["finished", "sources_exhausted", "sources_exhausted", "none", null]);
    expect(last.candidates.map((candidate) => [candidate.host_id, candidate.entry_id, candidate.stage, candidate.reason, candidate.item_key, candidate.case_id])).toEqual([
      ["umami", "synthetic-umami-date-time-01", "invalid", { code: "setup_failed", message: REASON_TEXT.setup_failed }, null, null],
    ]);
    expect(last.funnel).toEqual({ candidates_explored: 1, behavior_checks_passed: 0, requested_criteria_passed: 0, packages_ready: 0 });
    expect(last.cases).toEqual([]);
    expect(last.items.map((item) => [item.item_key, item.delivered, item.missing])).toEqual(input.items.map((item) => [item.item_key, 0, item.quantity]));
    // The factory core's own sequence for this plan: the harness runs every state, so all six checks
    // finish (the clean copy's two observed error) before the candidate is invalid.
    expect(last.events.map((event) => event.type)).toEqual([
      "request_accepted", "budget_updated", "worker_started", "host_preparing", "host_ready", "candidate_selected", "budget_updated",
      "check_finished", "check_finished", "check_finished", "check_finished", "check_finished", "check_finished",
      "candidate_invalid", "budget_updated", "source_exhausted", "budget_updated", "request_finished",
    ]);
    const candidateId = last.candidates[0]?.candidate_id;
    expect(last.events.flatMap((event) => (event.type === "check_finished" ? [[event.host_id, event.candidate_id === candidateId, event.data, event.message]] : []))).toEqual([
      ["umami", true, { check_set: "original_suite", copy: "clean", outcome: "error", runs_valid: 0, runs_total: 3 }, "Original suite on the clean copy: error (0 of 3 runs valid)."],
      ["umami", true, { check_set: "verification", copy: "clean", outcome: "error", runs_valid: 0, runs_total: 3 }, "Verification checks on the clean copy: error (0 of 3 runs valid)."],
      ["umami", true, { check_set: "original_suite", copy: "buggy", outcome: "pass", runs_valid: 3, runs_total: 3 }, "Original suite on the buggy copy: pass (3 of 3 runs valid)."],
      ["umami", true, { check_set: "verification", copy: "buggy", outcome: "fail", runs_valid: 3, runs_total: 3 }, "Verification checks on the buggy copy: fail (3 of 3 runs valid)."],
      ["umami", true, { check_set: "original_suite", copy: "fixed", outcome: "pass", runs_valid: 3, runs_total: 3 }, "Original suite on the reference-fixed copy: pass (3 of 3 runs valid)."],
      ["umami", true, { check_set: "verification", copy: "fixed", outcome: "pass", runs_valid: 3, runs_total: 3 }, "Verification checks on the reference-fixed copy: pass (3 of 3 runs valid)."],
    ]);

    // Every copy was created and settles at its worst case, like any other copy.
    const proof = await evidence(w);
    expectEvidenceIdentities(proof, REQUEST_ID);
    const share = TEST_PROFILE.candidate_microusd.umami / 3;
    expect(proof.operations.map((op) => [op.kind, op.call_name, op.host_id, op.state, op.reserved_microusd, op.settled_microusd])).toEqual([
      ["worker", "worker", null, "terminal", TEST_PROFILE.worker_microusd, TEST_PROFILE.worker_microusd],
      ["candidate_copy", "candidate-01-clean", "umami", "terminal", share, share],
      ["candidate_copy", "candidate-01-buggy", "umami", "terminal", share, share],
      ["candidate_copy", "candidate-01-fixed", "umami", "terminal", share, share],
    ]);
    expect(proof.provider_calls.map((call) => [call.call_name, call.action])).toEqual([
      ["worker", "create"],
      ["candidate-01-clean", "create"],
      ["candidate-01-buggy", "create"],
      ["candidate-01-fixed", "create"],
    ]);
    expect(proof.slot).toEqual({ slot_key: "factory", holder_request_id: null, holder_validation_id: null });
    expect(last.budget).toMatchObject({ reserved_microusd: 0, spent_microusd: TEST_PROFILE.worker_microusd + TEST_PROFILE.candidate_microusd.umami, overrun: false });
    for (const body of w.bodies) for (const key of map.keys()) expect(body, key).not.toMatch(wholeKey(key));
  });
});

describe("the pending-package window of two-host-fulfilled (contract section 15.1, revision 3)", () => {
  it("lists, counts, serves and validates the first case only once case_delivered follows its package_ready 5 s later", async () => {
    const w = makeWorld();
    await reset(w, "two-host-fulfilled");
    await start(w, "two-host-fulfilled");
    let current = await status(w);
    for (let poll = 0; !current.events.some((event) => event.type === "package_ready"); poll += 1) {
      if (poll > 100) throw new Error("synthetic: no package_ready");
      w.clock.ms += STEP_MS;
      current = await status(w);
    }
    const ready = current.events.find((event) => event.type === "package_ready");
    if (ready?.type !== "package_ready" || ready.case_id === null) throw new Error("synthetic: no announced case");
    const caseId = ready.case_id;
    expect([ready.host_id, caseId]).toEqual(["task-report", "ca".repeat(32)]);
    const readyMs = Date.parse(ready.at);
    expect(PENDING_PACKAGE_MS).toBe(5000);
    const part = (name: "bug-case" | "validator") => getPackage(request(`${STATUS_PATH}/cases/${caseId}/packages/${name}`), w.server, { request_id: REQUEST_ID, case_id: caseId, part: name });
    const validationIds = ["00000000-0000-4000-8000-0000000002a1", "00000000-0000-4000-8000-0000000002a2", "00000000-0000-4000-8000-0000000002a3"];
    // In the window, from the read that first returned package_ready up to 1 ms before its end.
    const probes = [w.clock.ms, readyMs + 2500, readyMs + PENDING_PACKAGE_MS - 1];
    for (const [index, at] of probes.entries()) {
      w.clock.ms = at;
      const pending = await status(w);
      expect(pending.events.at(-1)?.type, String(at - readyMs)).toBe("package_ready");
      expect(pending.cases).toEqual([]);
      expect(pending.funnel.packages_ready).toBe(0);
      expect(pending.candidates[0]?.stage).toBe("packaging");
      expect((await part("bug-case")).status).toBe(404);
      expect((await part("validator")).status).toBe(404);
      const refused = await validate(w, caseId, validationIds[index] ?? "");
      expect(await contractBody("ErrorResponse", refused)).toMatchObject({ error: { code: "not_found" } });
      expect((await evidence(w)).operations.filter((op) => op.kind === "validation")).toEqual([]);
    }
    // At its end the case is delivered, and both parts are served with the SHA-256 that package_ready announced.
    w.clock.ms = readyMs + PENDING_PACKAGE_MS;
    const delivered = await status(w);
    const event = delivered.events.find((item) => item.type === "case_delivered");
    expect(event === undefined ? null : [event.case_id, Date.parse(event.at) - readyMs]).toEqual([caseId, PENDING_PACKAGE_MS]);
    expect(delivered.cases.map((item) => item.case_id)).toEqual([caseId]);
    expect(delivered.funnel.packages_ready).toBe(1);
    const announced = ready.data;
    for (const [name, sha] of [["bug-case", announced.bug_case_sha256], ["validator", announced.validator_sha256]] as const) {
      const response = await part(name);
      expect(response.status).toBe(200);
      expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha);
    }
    // The request still holds the slot, so a validation POST now passes the case check and meets busy.
    expect(await contractBody("ErrorResponse", await validate(w, caseId, "00000000-0000-4000-8000-0000000002a4"))).toMatchObject({ error: { code: "busy" } });
    const last = (await runToEnd(w, "two-host-fulfilled")).at(-1);
    expect(shape(last ?? delivered)).toEqual(shape(endState("two-host-fulfilled")));
    // Only the first case waits: the Umami case follows its package_ready one step later.
    const umamiReady = last?.events.findLast((item) => item.type === "package_ready");
    const umamiDelivered = last?.events.findLast((item) => item.type === "case_delivered");
    expect(Date.parse(umamiDelivered?.at ?? "") - Date.parse(umamiReady?.at ?? "")).toBe(STEP_MS);
  });

  it("does not hold the other scenarios that replay status-fulfilled.json", async () => {
    for (const scenario of ["validation-failed", "validation-error"] as const) {
      const { last } = await finishedFulfilled(scenario);
      const ready = last.events.find((item) => item.type === "package_ready");
      const delivered = last.events.find((item) => item.type === "case_delivered");
      expect(Date.parse(delivered?.at ?? "") - Date.parse(ready?.at ?? ""), scenario).toBe(STEP_MS);
    }
  });

  it("ends the held candidate incomplete when a stop lands in the window, and delivers nothing", async () => {
    const w = makeWorld();
    await reset(w, "two-host-fulfilled");
    await start(w, "two-host-fulfilled");
    let current = await status(w);
    while (!current.events.some((event) => event.type === "package_ready")) {
      w.clock.ms += STEP_MS;
      current = await status(w);
    }
    w.clock.ms += 2 * STEP_MS;
    expect((await postStop(request(`${STATUS_PATH}/stop`, { body: {} }), w.server, { request_id: REQUEST_ID })).status).toBe(200);
    const last = (await runToEnd(w, "two-host-fulfilled")).at(-1);
    expect([last?.outcome, last?.stop_reason?.code, last?.delivery]).toEqual(["cancelled", "cancelled_by_user", "none"]);
    expect(last?.candidates.map((candidate) => [candidate.stage, candidate.reason?.code])).toEqual([["incomplete", "stopped"]]);
    expect(last?.events.some((event) => event.type === "case_delivered")).toBe(false);
    expect(last?.budget.reserved_microusd).toBe(0);
    expect((await evidence(w)).slot.holder_request_id).toBeNull();
  });
});

describe("funnel (contract section 8.2)", () => {
  it("counts a candidate as explored from its first check_finished, so one reserved but unchecked, or selected and then skipped, never counts", async () => {
    const w = makeWorld();
    await reset(w, "partial-budget");
    await start(w, "partial-budget");
    const seen = await runToEnd(w, "partial-budget");
    // The first candidate's reservation is recorded before its first check finishes: it stays selected and unexplored.
    const reserved = seen.filter(justReserved);
    expect(reserved.length).toBeGreaterThan(0);
    for (const current of reserved) {
      expect(current.candidates[0]?.stage).toBe("selected");
      expect(current.funnel.candidates_explored).toBe(0);
    }
    const checking = seen.filter((current) => current.candidates[0]?.stage === "checking");
    expect(checking.length).toBeGreaterThan(0);
    for (const current of checking) expect(current.funnel.candidates_explored).toBe(1);
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

  it("does not count a candidate stopped between its reservation and its first check_finished", async () => {
    const w = makeWorld();
    await reset(w, "two-host-fulfilled");
    await start(w, "two-host-fulfilled");
    let current = await status(w);
    for (let poll = 0; !justReserved(current); poll += 1) {
      if (poll > 100) throw new Error("synthetic: no candidate was reserved");
      w.clock.ms += STEP_MS;
      current = await status(w);
    }
    expect(current.candidates.map((candidate) => candidate.stage)).toEqual(["selected"]);
    expect(current.funnel.candidates_explored).toBe(0);
    expect((await postStop(request(`${STATUS_PATH}/stop`, { body: {} }), w.server, { request_id: REQUEST_ID })).status).toBe(200);
    const last = (await runToEnd(w, "two-host-fulfilled")).at(-1);
    expect(last?.events.filter((event) => event.type === "check_finished")).toEqual([]);
    expect(last?.candidates.map((candidate) => [candidate.stage, candidate.reason?.code])).toEqual([["incomplete", "stopped"]]);
    expect(last?.funnel.candidates_explored).toBe(0);
    expect(last?.limits.candidates_started).toBe(1);
    expect((await evidence(w)).operations.map((op) => op.kind)).toEqual(["worker", "candidate_copy", "candidate_copy", "candidate_copy"]);
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
    // The identities differ (synthetic in the fixture, derived here); how they relate does not.
    const strip = (item: TestEvidence) => {
      const executionOf = new Map(item.operations.map((op) => [op.call_name, op.execution_id]));
      return {
        operations: item.operations.map((op) => [op.kind, op.call_name, op.host_id, op.execution_id === item.root_execution_id, op.state, op.reserved_microusd, op.settled_microusd, op.attempt_ordinal]),
        executions: new Set(item.operations.map((op) => op.execution_id)).size,
        slot: [item.slot.holder_request_id === null ? null : "held by the request", item.slot.holder_validation_id],
        provider_calls: item.provider_calls.map((call) => [call.call_name, call.provider, call.action, call.execution_id === executionOf.get(call.call_name)]),
      };
    };
    expect(strip(proof)).toEqual(strip(expected));
    expectEvidenceIdentities(proof, REQUEST_ID);
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
    // Its copy's create was uncertain, so no check finished: the candidate never counts as explored.
    expect(last?.funnel.candidates_explored).toBe(0);
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
    // One worker under the request's root execution, the same on every read; each create names its operation's execution.
    expect(proof.root_execution_id).toBe(requestRoot(REQUEST_ID));
    expect(proof.operations.find((op) => op.kind === "worker")?.execution_id).toBe(proof.root_execution_id);
    w.clock.ms += 20 * STEP_MS;
    const later = await evidence(w);
    expect(later.operations.length).toBeGreaterThan(proof.operations.length);
    expect(later.root_execution_id).toBe(proof.root_execution_id);
    const identity = (op: TestEvidence["operations"][number]) => [op.operation_id, op.kind, op.call_name, op.execution_id, op.host_id];
    expect(later.operations.slice(0, proof.operations.length).map(identity)).toEqual(proof.operations.map(identity));
    const creates = later.provider_calls.filter((call) => call.action === "create");
    expect(new Set(creates.map((call) => call.execution_id)).size).toBe(creates.length);
    for (const call of creates) expect(later.operations.filter((op) => op.execution_id === call.execution_id).map((op) => op.call_name)).toEqual([call.call_name]);
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
    expect(held.operations.at(-1)).toMatchObject({ kind: "validation", call_name: "validation-01", execution_id: validationRoot(VALIDATION), host_id: caseRecord.host_id, state: "running", settled_microusd: null });
    expect(held.provider_calls.at(-1)).toMatchObject({ call_name: "validation-01", execution_id: validationRoot(VALIDATION), action: "create" });
    expectEvidenceIdentities(held, REQUEST_ID);
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
