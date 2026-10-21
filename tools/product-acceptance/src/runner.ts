import assert from "node:assert/strict";
import { assertContract } from "@rbw/factory-contract/validate";
import type { TestEvidence } from "@rbw/factory-contract";
import { checkEvidence, checkReconciledEvidence } from "./evidence.ts";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { checkCriteriaEvents, checkFunnelHistory, checkScenarioCandidates, checkStatus, checkValidation, integer, object, objects, text } from "./invariants.ts";

export const contractRevision = "66651d67fcb09c402b25d9688ea492c0e69e1c2b";
export const scenarioIds = ["identity", "quantities", "shared-budget", "qualification", "unsupported", "stops", "continuity", "downloads"] as const;
type ScenarioId = typeof scenarioIds[number];
export interface Reply { status: number; body: unknown }
/** Local adapter interface, not a service endpoint or response shape. */
export interface IsolatedBackend {
  verifyIsolation: () => Promise<{ backendRevision: string; contractRevision: string }>;
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply>;
  reconnect: () => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
}
export interface Probe {
  scenario: string;
  input: Record<string, unknown>;
  outcome: string;
  stopCode: string;
  expectedDelivery: string;
  expectedItems: Record<string, unknown>[];
  expectedInterpretation?: Record<string, unknown>;
  expectedFunnel?: Record<string, unknown>;
  expectedCounts: Record<string, unknown>[];
  expectedCandidates?: Record<string, unknown>[];
  expectedAttention?: string | null;
  concurrent?: boolean;
  cancel?: boolean;
  validation?: "failed" | "error";
  reconcile?: boolean;
  downloads?: boolean;
  evidence?: boolean;
}
class Unavailable extends Error {}
function checkScenarioStatus(value: unknown): void {
  checkStatus(value);
  assert.equal(object(object(value).budget).overrun, false, "deterministic scenario exceeded budget");
  assertContract("RequestStatus", value);
}
function checkLaunchFailure(value: Record<string, unknown>): void {
  assert.equal(value.state, "finished", "terminal result changed after completion");
  assert.equal(object(value.stop_reason).code, "operational_error", "fresh terminal Start has a post-launch stop code");
  assert.equal(value.last_heartbeat_at, null, "fresh terminal Start has a worker heartbeat");
  assert.equal(objects(value.candidates).length, 0, "fresh terminal Start has candidate progress");
  assert.equal(objects(value.cases).length, 0, "fresh terminal Start has delivered results");
  assert.equal(object(value.limits).candidates_started, 0, "fresh terminal Start started a candidate");
  assert(Object.values(object(value.funnel)).every(count => count === 0), "fresh terminal Start has funnel progress");
  const workerWorst = integer(object(object(value.interpretation).budget).worker_worst_case_microusd);
  assert(integer(object(value.budget).committed_microusd) <= workerWorst, "fresh terminal Start charged more than the worker worst case");
  assert(objects(value.events).every(event => ["request_accepted", "budget_updated", "attention", "attention_cleared", "request_finished"].includes(text(event.type))),
    "fresh terminal Start has post-launch history");
}
function body(reply: Reply, status: number): Record<string, unknown> {
  assert.equal(reply.status, status, `unexpected HTTP status: received ${String(reply.status)}, expected ${String(status)}`);
  const result = object(reply.body);
  assert.equal(result.contract_version, "bug-request/1");
  return result;
}
function error(reply: Reply, status: number, code: string) {
  const result = assertContract("ErrorResponse", body(reply, status));
  assert.equal(result.error.code, code);
  return result.error;
}
async function resetScenario(backend: IsolatedBackend, scenario: string): Promise<void> {
  const response = body(await backend.request("POST", "/api/factory/test/reset", { scenario }), 200);
  assertContract("TestResetResponse", response);
  assert.equal(response.scenario, scenario, "reset selected a different scenario");
}

async function verify(backend: IsolatedBackend) {
  const verification = await backend.verifyIsolation();
  assert.match(verification.backendRevision, /^[a-f0-9]{40}$/);
  assert.equal(verification.contractRevision, contractRevision, "contract revision mismatch");
  return verification;
}
async function read(backend: IsolatedBackend, path: string) {
  for (const delay of [15000, 30000, 60000, null]) {
    const reply = await backend.request("GET", path);
    if (reply.status !== 503) return body(reply, 200);
    error(reply, 503, "unavailable");
    if (delay === null) throw new Unavailable("Status remained unavailable after polling backoff.");
    await backend.wait(delay);
  }
  throw new Error("unreachable polling state");
}
function checkInterpretedItems(actualItems: Record<string, unknown>[], expectedItems: Record<string, unknown>[], prefix = ""): void {
  assert.deepEqual(actualItems.map(item => text(item.item_key)).sort(), expectedItems.map(item => text(item.item_key)).sort(), `${prefix}item keys differ from pinned scenario`);
  const criteria = (item: Record<string, unknown>) => objects(item.criteria)
    .map(c => `${text(c.criterion_id)}@${text(c.version)}`).sort();
  const sources = (item: Record<string, unknown>) => objects(item.eligible_sources)
    .map(source => [text(source.host_id), text(source.source_id), integer(source.entries)]).sort();
  const meaning = (item: Record<string, unknown>) => ({
    bug_type_id: item.bug_type_id, quantity: item.quantity, description: item.description,
    difficulty: item.difficulty, status: item.status, unmatched_text: item.unmatched_text,
    problems: objects(item.problems).map(problem => [text(problem.code), text(problem.item_key), text(problem.severity)]).sort(),
  });
  for (const expected of expectedItems) {
    const actual = actualItems.find(item => item.item_key === expected.item_key); assert(actual);
    assert.deepEqual(criteria(actual), criteria(expected), `${prefix}criteria differ from pinned scenario`);
    assert.deepEqual(sources(actual), sources(expected), `${prefix}eligible sources differ from pinned scenario`);
    assert.deepEqual(meaning(actual), meaning(expected), `${prefix}item interpretation differs from pinned scenario`);
  }
}
function checkInterpretationProfile(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  const normalize = (value: Record<string, unknown>) => {
    const result = structuredClone(value);
    delete result.interpretation_sha256;
    const sort = (rows: Record<string, unknown>[], key: string) => rows.sort((a, b) => text(a[key]).localeCompare(text(b[key])));
    const problems = (value: unknown) => objects(value).map(problem => ({ ...problem, message: "" }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    result.items = sort(objects(result.items).map(item => ({ ...item,
      criteria: sort(objects(item.criteria).map(criterion => ({ ...criterion, label: "" })), "criterion_id"),
      eligible_sources: objects(item.eligible_sources).sort((a, b) => JSON.stringify([a.host_id, a.source_id]).localeCompare(JSON.stringify([b.host_id, b.source_id]))),
      problems: problems(item.problems),
    })), "item_key");
    const totals = objects(result.type_totals);
    assert.equal(new Set(totals.map(total => total.bug_type_id)).size, totals.length, "duplicate interpretation type total");
    const requested = new Set(objects(object(result.input).items).map(item => item.bug_type_id));
    result.type_totals = sort(totals.filter(total => requested.has(total.bug_type_id) || total.quantity !== 0), "bug_type_id");
    // Wording is not fixed by the contract. Semantic fields stay pinned and
    // text types are schema-checked; frozen responses retain the generated hash.
    result.hosts = sort(objects(result.hosts).map(host => ({ ...host, reason: "" })), "host_id");
    const budget = object(result.budget); budget.estimate_note = "";
    for (const field of ["worst_case_per_candidate_microusd", "worst_case_per_validation_microusd"]) budget[field] = sort(objects(budget[field]), "host_id");
    result.problems = problems(result.problems);
    return result;
  };
  assert.deepEqual(normalize(actual), normalize(expected), "interpretation profile differs from pinned scenario");
  assertContract("Interpretation", actual);
}
/** Exercise ordinary public operations through an approved isolated adapter. */
export async function runProbe(backend: IsolatedBackend, probe: Probe): Promise<void> {
  await verify(backend);
  const call = backend.request.bind(backend);
  await resetScenario(backend, probe.scenario);
  const interpretation = body(await call("POST", "/api/factory/interpretations", probe.input), 200);
  assert.equal(interpretation.startable, true);
  checkInterpretedItems(objects(interpretation.items), probe.expectedItems);
  assert.deepEqual(interpretation.input, probe.input, "input silently changed");
  if (probe.expectedInterpretation) checkInterpretationProfile(interpretation, probe.expectedInterpretation);
  else assertContract("Interpretation", interpretation);
  const requestId = randomUUID();
  const start = { request_id: requestId, input: probe.input, interpretation_sha256: interpretation.interpretation_sha256 };
  const replies = await Promise.all(Array.from({ length: probe.concurrent ? 3 : 1 }, () => call("POST", "/api/factory/requests", start)));
  assert.equal(replies.filter(r => r.status === 202).length, 1, "start accepted more or less than once");
  const deliveredCases = new Map<unknown, Record<string, unknown>>();
  const observedEvents = new Map<number, Record<string, unknown>>();
  const funnelProgress = new Map<string, number>();
  let requestTimes: { created_at: unknown; deadline_at: unknown } | undefined;
  let terminal: Record<string, unknown> | undefined;
  let launchFailure = false;
  const terminalSnapshot = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
    .filter(([field]) => !["updated_at", "events", "next_after", "poll_after_ms"].includes(field)));
  const observe = (value: Record<string, unknown>, concurrent = false) => {
    checkScenarioStatus(value);
    assert.equal(value.request_id, requestId);
    assert.deepEqual(value.interpretation, interpretation, "frozen interpretation changed");
    const limits = object(value.limits);
    assert.deepEqual({ max_wall_clock_s: limits.max_wall_clock_s, max_candidates: limits.max_candidates }, interpretation.limits, "request limits differ from pinned interpretation");
    const times = { created_at: value.created_at, deadline_at: limits.deadline_at };
    assert.equal(Date.parse(text(limits.deadline_at)) - Date.parse(text(value.created_at)), integer(limits.max_wall_clock_s) * 1000, "request deadline differs from execution window");
    if (requestTimes) assert.deepEqual(times, requestTimes, "request times changed after creation");
    else requestTimes = times;
    const current = objects(value.cases);
    if (!concurrent) for (const id of deliveredCases.keys()) {
      assert(current.some(c => c.case_id === id), "delivered case disappeared");
    }
    for (const delivered of current) {
      const previous = deliveredCases.get(delivered.case_id);
      if (previous !== undefined) assert.deepEqual(delivered, previous, "delivered case changed");
      else deliveredCases.set(delivered.case_id, structuredClone(delivered));
    }
    for (const [field, count] of Object.entries(object(value.funnel))) {
      const previous = funnelProgress.get(field) ?? 0;
      if (!concurrent) assert(integer(count) >= previous, "funnel progress decreased");
      funnelProgress.set(field, Math.max(previous, integer(count)));
    }
    let previousSeq: number | undefined;
    for (const event of objects(value.events)) {
      const seq = integer(event.seq);
      assert(seq > 0 && (previousSeq === undefined || seq === previousSeq + 1), "event gap or duplicate");
      previousSeq = seq;
      const previous = observedEvents.get(seq);
      if (previous !== undefined) assert.deepEqual(event, previous, "previous event changed");
      else observedEvents.set(seq, structuredClone(event));
    }
    // Concurrent replies need not arrive in state order. Once all have returned,
    // sequential observations must preserve any completed request already seen.
    if (terminal !== undefined && (!concurrent || value.state === "finished")) {
      assert.deepEqual(terminalSnapshot(value), terminal, "terminal result changed after completion");
    }
    if (value.state === "finished" && terminal === undefined) terminal = structuredClone(terminalSnapshot(value));
    if (launchFailure) checkLaunchFailure(value);
  };
  for (const reply of replies) {
    assert([200, 202].includes(reply.status));
    const initial = object(reply.body);
    observe(initial, true);
    if (reply.status === 202 && initial.state === "finished") {
      assert.equal(initial.outcome, "operational_error", "finished fresh Start is not an operational failure");
      launchFailure = true;
    }
  }
  // Concurrent replies may arrive out of order, and later pages may expose
  // earlier progress. A recorded startup failure must contradict neither.
  if (launchFailure) for (const reply of replies) checkLaunchFailure(object(reply.body));
  const path = `/api/factory/requests/${requestId}`;
  const repeated = body(await call("POST", "/api/factory/requests", start), 200);
  assert.equal(repeated.request_id, requestId);
  if (probe.concurrent) {
    const changed = structuredClone(start);
    const first = objects(changed.input.items)[0]; assert(first);
    first.description = first.description === null ? "synthetic-conflicting-description" : null;
    error(await call("POST", "/api/factory/requests", changed), 409, "idempotency_conflict");
  }
  let cursor = 0;
  let stopped = false;
  const snapshot = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
    .filter(([field]) => !["events", "next_after", "poll_after_ms"].includes(field)));
  let finishedSnapshot: Record<string, unknown> | undefined;
  let completeHistory = false;
  let state = repeated;
  const history: Record<string, unknown>[] = [];
  // Bound a stalled service; do not poll faster than its declared interval.
  for (let polls = 0; polls < 1000; polls++) {
    observe(state);
    if (state.state === "finished") {
      if (finishedSnapshot === undefined) finishedSnapshot = structuredClone(snapshot(state));
      else assert.deepEqual(snapshot(state), finishedSnapshot, "terminal result changed while reading history");
    }
    for (const event of objects(state.events)) {
      assert.equal(integer(event.seq), ++cursor, "event gap or duplicate");
      history.push(structuredClone(event));
    }
    assert.equal(state.next_after, cursor);
    const cancelCheckpoint = objects(state.cases).length > 0 && history.some(event => event.type === "check_finished"
      && objects(state.candidates).some(candidate => candidate.candidate_id === event.candidate_id && candidate.case_id === null));
    if (probe.cancel && !stopped && cancelCheckpoint && state.state !== "finished") {
      const stopping = body(await call("POST", `${path}/stop`, {}), 200);
      observe(stopping);
      stopped = true;
    }
    if (state.state === "finished" && objects(state.events).length === 0) { completeHistory = true; break; }
    const delay = integer(state.poll_after_ms);
    assert(delay >= 0, "unsupported polling interval");
    await backend.wait(delay);
    state = await read(backend, `${path}?after=${String(cursor)}`);
  }
  if (probe.cancel && !stopped) throw new Unavailable("cancel-midway requires its observable pause after the second candidate's first check");
  if (!completeHistory) throw new Unavailable("Request observation reached the runner poll limit.");
  for (const [seq, event] of observedEvents) assert.deepEqual(history[seq - 1], event, "previous event disappeared from history");
  checkFinishedHistory(state, history);
  checkCriteriaEvents(state, history, true);
  checkFunnelHistory(state, history);
  if (probe.expectedFunnel) assert.deepEqual(state.funnel, probe.expectedFunnel, "funnel differs from pinned scenario");
  const counts = (items: Record<string, unknown>[]) => items.map(item => ({
    item_key: text(item.item_key), requested: integer(item.requested),
    delivered: integer(item.delivered), missing: integer(item.missing),
  })).sort((a, b) => a.item_key.localeCompare(b.item_key));
  assert.deepEqual(counts(objects(state.items)), counts(probe.expectedCounts), "item counts differ from pinned scenario");
  assert.equal(state.delivery, probe.expectedDelivery, "delivery differs from pinned scenario");
  assert.equal(state.outcome, probe.outcome);
  assert.equal(object(state.stop_reason).code, probe.stopCode);
  assert.equal(state.attention === null ? null : object(state.attention).code, probe.expectedAttention ?? null, "attention differs from pinned scenario");
  if (["worker-lost", "uncertain-provider"].includes(probe.scenario)) checkAttentionHistory(state, history);
  if (probe.expectedCandidates) checkScenarioCandidates(state, probe.expectedCandidates, history);
  // No validation or reconciliation runs between these reads. Only paging and
  // polling hints may differ; accounting and the stored terminal record may not.
  const checkTerminalRead = async (page: Record<string, unknown>, phase: "reconnect" | "repeated stop") => {
    let checked = 0;
    for (;;) {
      observe(page);
      assert.deepEqual(snapshot(page), snapshot(state), `terminal result changed on ${phase}`);
      const events = objects(page.events);
      if (events.length === 0) {
        assert.equal(checked, history.length, "previous events disappeared");
        assert.equal(page.next_after, checked, `terminal history changed on ${phase}`);
        break;
      }
      for (const event of events) {
        assert(checked < history.length, `terminal history changed on ${phase}`);
        assert.deepEqual(event, history[checked++], "previous event changed");
      }
      assert.equal(page.next_after, checked, `terminal history changed on ${phase}`);
      // Read the trailing page too: an exact old-history page can hide new events.
      await backend.wait(integer(page.poll_after_ms));
      page = await read(backend, `${path}?after=${String(checked)}`);
    }
  };
  await backend.reconnect();
  await checkTerminalRead(await read(backend, `${path}?after=0`), "reconnect");
  if (probe.cancel) {
    const again = body(await call("POST", `${path}/stop`, {}), 200);
    await checkTerminalRead(again, "repeated stop");
  }
  if (probe.evidence) {
    const evidence = await runRequestEvidence(backend, state);
    if (probe.scenario === "uncertain-provider") checkUncertainAttempt(state, history, evidence, probe.expectedItems);
    if (state.attention === null) {
      assert.equal(object(state.budget).reserved_microusd, 0, "terminal request left held spend");
      assert.equal(evidence.slot.holder_request_id, null, "terminal request left the factory slot held");
      assert.equal(evidence.slot.holder_validation_id, null, "terminal request left a validation slot holder");
    }
  }
  if (probe.downloads) await runDownloads(backend, state);
  if (probe.reconcile) await runReconciliation(backend, state, history);
  if (probe.validation) await runValidation(backend, state, probe.validation, history);
}

/** Section 8.4 applies to the complete history, not each cursor page. */
function checkFinishedHistory(state: Record<string, unknown>, history: Record<string, unknown>[]): void {
  const finished = history.filter(event => event.type === "request_finished");
  assert.equal(finished.length, 1, "complete history needs exactly one request_finished");
  const event = finished[0]; assert(event);
  assert.deepEqual(event.data, { outcome: state.outcome, stop_code: object(state.stop_reason).code }, "request_finished differs from terminal result");
  const permitted = ["budget_updated", "attention", "attention_cleared", "validation_started", "validation_finished"];
  assert(history.filter(current => integer(current.seq) > integer(event.seq)).every(current => permitted.includes(text(current.type))),
    "request progress after request_finished");
}

/** Section 8.1 records each attention change, including replacements and clears. */
function checkAttentionHistory(state: Record<string, unknown>, history: Record<string, unknown>[]): void {
  let active: string | null = null;
  for (const event of history) {
    if (event.type === "attention") active = text(object(event.data).code);
    else if (event.type === "attention_cleared") {
      assert.equal(object(event.data).code, active, "attention history cleared a different active code");
      active = null;
    }
  }
  assert.equal(active, state.attention === null ? null : object(state.attention).code, "attention history does not match current status");
}

/** Section 15.1 requires a candidate create, not just worker uncertainty. */
function checkUncertainAttempt(state: Record<string, unknown>, history: Record<string, unknown>[], evidence: TestEvidence, expectedItems: Record<string, unknown>[]): void {
  const candidates = objects(state.candidates);
  assert.equal(candidates.length, 1, "uncertain-provider must attempt the first candidate only");
  const candidate = candidates[0]; assert(candidate);
  // The control supplies this partial outcome rule without a complete fixture.
  // Reuse the linked event checks while leaving generated identities opaque.
  checkScenarioCandidates(state, [{ ...candidate, stage: "incomplete", reason: { code: "incomplete_run" }, item_key: null, case_id: null }], history);
  assert(expectedItems.some(item => item.bug_type_id === candidate.bug_type_id && objects(item.eligible_sources)
    .some(source => source.host_id === candidate.host_id && source.source_id === candidate.source_id)),
  "uncertain-provider attempted a source outside the pinned input");
  assert.equal(object(state.limits).candidates_started, 1, "uncertain-provider must start one candidate");
  const started = history.filter(event => event.type === "worker_started");
  const selected = history.filter(event => event.type === "candidate_selected");
  assert.equal(started.length, 1, "uncertain-provider must start its worker");
  assert.equal(selected.length, 1, "uncertain-provider must select its first candidate");
  const start = started[0]; const selection = selected[0]; assert(start && selection);
  assert(integer(start.seq) < integer(selection.seq), "uncertain-provider selected before worker start");
  assert.equal(selection.candidate_id, candidate.candidate_id, "uncertain-provider selected a different candidate");
  assert.equal(selection.host_id, candidate.host_id, "uncertain-provider selected a different host");
  for (const field of ["source_id", "entry_id"]) {
    assert.equal(object(selection.data)[field], candidate[field], `uncertain-provider selected a different ${field}`);
  }
  const worker = evidence.operations.find(op => op.kind === "worker"); assert(worker);
  assert.equal(worker.settled_microusd, worker.reserved_microusd, "uncertain-provider left its worker uncertain");
  // The pinned service reserves all three copies but only attempts the first.
  // Keep opaque call names and allow the unused originals to settle at zero.
  const creates = evidence.provider_calls.filter(call => call.action === "create").map(call => call.call_name);
  const launched = evidence.operations.filter(op => op.kind === "candidate_copy" && creates.includes(op.call_name));
  assert.equal(launched.length, 1, "uncertain-provider must have one candidate create attempt");
  const attempt = launched[0]; assert(attempt);
  assert.equal(attempt.state, "uncertain", "uncertain-provider did not retain candidate uncertainty");
  assert.equal(attempt.settled_microusd, null, "uncertain-provider prematurely settled its candidate create");
}

/** Exercise one named deterministic validation scenario after request completion. */
export async function runValidation(backend: IsolatedBackend, state: Record<string, unknown>, expectedResult: "failed" | "error", history = objects(state.events)): Promise<void> {
  await verify(backend);
  assertContract("RequestStatus", state);
  checkScenarioStatus(state);
  assert.equal(state.state, "finished");
  assert.equal(state.attention, null);
  const previousBudget = object(state.budget);
  assert.equal(previousBudget.reserved_microusd, 0);
  const priorEvidence = structuredClone(await runRequestEvidence(backend, state));
  const path = `/api/factory/requests/${text(state.request_id)}`;
  const c = objects(state.cases)[0]; assert(c, "validation scenario delivered no case");
  // Section 15.1 fixes these named scenarios' costs independently of the service.
  // General null-cost errors remain valid in checkValidation; these fake runs settle.
  const cost = c.host_id === "task-report" ? 200_000 : c.host_id === "umami" ? 300_000 : undefined;
  assert(cost !== undefined, "unknown validation host");
  const validationId = randomUUID();
  const validationPath = `${path}/cases/${text(c.case_id)}/validations`;
  let validation = body(await backend.request("POST", validationPath, { validation_id: validationId }), 202);
  for (let polls = 0; polls < 1000; polls++) {
    assertContract("ValidationRun", validation);
    checkValidation(validation);
    assert.equal(validation.validation_id, validationId);
    assert.equal(validation.case_id, c.case_id);
    assert.deepEqual(validation.package_sha256, {
      bug_case: object(object(c.packages).bug_case).sha256,
      validator: object(object(c.packages).validator).sha256,
    });
    if (validation.state === "finished") break;
    const delay = integer(validation.poll_after_ms); assert(delay >= 0);
    await backend.wait(delay);
    validation = await read(backend, `${validationPath}/${validationId}`);
  }
  if (validation.state !== "finished") throw new Unavailable("Validation observation reached the runner poll limit.");
  assert.equal(validation.result, expectedResult);
  assert.equal(validation.cost_microusd, cost, "validation cost differs from pinned test worst case");
  const withoutPoll = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "poll_after_ms"));
  const immutable = (value: Record<string, unknown>) => ({
    ...Object.fromEntries(Object.entries(value).filter(([key]) => !["budget", "attention", "updated_at", "events", "next_after", "poll_after_ms", "cases"].includes(key))),
    cases: objects(value.cases).map(delivered => delivered.case_id === c.case_id ? { ...delivered, validation: null } : delivered),
  });
  const spent = integer(previousBudget.spent_microusd);
  const remaining = integer(previousBudget.remaining_microusd) - cost;
  const observed = new Map(history.map(event => [integer(event.seq), event]));
  const previousEnd = Math.max(integer(state.next_after), ...observed.keys());
  const completedHistory: Record<string, unknown>[] = [];
  let cursor = 0;
  let after = await read(backend, path);
  let complete = false;
  for (let pages = 0; pages < 1000; pages++) {
    assertContract("RequestStatus", after);
    checkScenarioStatus(after);
    assert.equal(after.attention, null, "settled validation left attention");
    assert.equal(object(after.budget).reserved_microusd, 0, "completed validation left held spend");
    assert.equal(object(after.budget).spent_microusd, spent + cost, "validation spend was not charged once");
    assert.deepEqual(immutable(after), immutable(state), "validation changed completed request results");
    const delivered: Record<string, unknown> | undefined = objects(after.cases).find(item => item.case_id === c.case_id); assert(delivered);
    assert.deepEqual(withoutPoll(object(delivered.validation)), withoutPoll(validation), "case validation differs from completed run");
    const events = objects(after.events);
    for (const event of events) {
      assert.equal(integer(event.seq), ++cursor, "validation history has an event gap or duplicate");
      const previous = observed.get(cursor);
      if (previous !== undefined) assert.deepEqual(event, previous, "validation changed prior event");
      completedHistory.push(event);
    }
    assert.equal(after.next_after, cursor);
    if (events.length === 0) { complete = true; break; }
    await backend.wait(integer(after.poll_after_ms));
    after = await read(backend, `${path}?after=${String(cursor)}`);
  }
  if (!complete) throw new Unavailable("Validation history reached the runner page limit.");
  checkFinishedHistory(after, completedHistory);
  for (const [seq, event] of observed) assert.deepEqual(completedHistory[seq - 1], event, "validation lost prior event");
  const added = completedHistory.filter(event => integer(event.seq) > previousEnd);
  // The named settled controls reserve once, run once, then settle once.
  assert.deepEqual(added.map(event => event.type), ["budget_updated", "validation_started", "validation_finished", "budget_updated"],
    "validation transition sequence differs from pinned control");
  const transition = (type: string) => {
    const events = added.filter(event => event.type === type);
    assert.equal(events.length, 1, `validation history needs one ${type}`);
    const event = events[0]; assert(event);
    assert.equal(object(event.data).validation_id, validationId);
    assert.equal(event.case_id, c.case_id); assert.equal(event.item_key, c.item_key); assert.equal(event.host_id, c.host_id);
    return event;
  };
  const started = transition("validation_started");
  const finished = transition("validation_finished");
  assert(integer(started.seq) < integer(finished.seq), "validation finished before it started");
  assert.equal(object(finished.data).result, expectedResult);
  const reserved = added[0]; const settled = added[3]; assert(reserved && settled);
  assert.deepEqual(reserved.data, { reserved_microusd: cost, spent_microusd: spent, remaining_microusd: remaining }, "validation reservation event differs from pinned amount");
  assert.deepEqual(settled.data, { reserved_microusd: 0, spent_microusd: spent + cost, remaining_microusd: remaining }, "validation settlement event differs from pinned amount");
  const evidence = await runEvidence(backend, after);
  assert.equal(evidence.slot.holder_request_id, null, "completed validation left the factory slot held");
  assert.equal(evidence.slot.holder_validation_id, null, "completed validation left a validation slot holder");
  for (const op of priorEvidence.operations) assert.deepEqual(evidence.operations.find(current => current.operation_id === op.operation_id), op, "validation changed prior ledger operation");
  for (const call of priorEvidence.provider_calls) assert(evidence.provider_calls.some(current => isDeepStrictEqual(current, call)), "validation changed prior provider call");
  const oldIds = new Set(priorEvidence.operations.map(op => op.operation_id));
  const operations = evidence.operations.filter(op => !oldIds.has(op.operation_id));
  assert(operations.length > 0 && operations.every(op => ["validation", "validation_copy"].includes(op.kind)), "validation evidence has missing or unrelated operations");
  assert.equal(operations.reduce((sum, op) => sum + op.reserved_microusd, 0), cost, "validation reservation differs from pinned worst case");
  assert.equal(operations.reduce((sum, op) => sum + (op.settled_microusd ?? 0), 0), cost, "validation settlement differs from completed cost");
}
/** Fresh named scenarios have not requested validation before this boundary. */
async function runRequestEvidence(backend: IsolatedBackend, status: unknown): Promise<TestEvidence> {
  const evidence = await runEvidence(backend, status);
  assert(evidence.operations.every(op => op.kind === "worker" || op.kind === "candidate_copy"),
    "unexpected ledger operation before validation");
  return evidence;
}

/** Schema validation narrows transport data; independent assertions decide accounting correctness. */
export async function runEvidence(backend: IsolatedBackend, status: unknown): Promise<TestEvidence> {
  await verify(backend);
  const request = assertContract("RequestStatus", status);
  const evidence = await read(backend, `/api/factory/test/evidence?request_id=${request.request_id}`);
  const checked = assertContract("TestEvidence", evidence);
  checkEvidence(checked, request);
  return checked;
}

export async function runDownloads(backend: IsolatedBackend, status: Record<string, unknown>): Promise<void> {
  await verify(backend);
  checkScenarioStatus(status);
  for (const c of objects(status.cases)) {
    const parts = object(c.packages);
    for (const kind of ["bug_case", "validator"]) {
      const part = object(parts[kind]);
      const response = await backend.request("GET", text(part.download_path));
      assert.equal(response.status, 200);
      assert(response.body instanceof Uint8Array, "archive response is not bytes");
      assert.equal(createHash("sha256").update(response.body).digest("hex"), part.sha256, "archive hash mismatch");
      assert.equal(response.body.byteLength, part.size_bytes, "archive size mismatch");
    }
  }
}

export async function runReconciliation(backend: IsolatedBackend, before: Record<string, unknown>, history = objects(before.events)): Promise<void> {
  await verify(backend);
  checkScenarioStatus(before);
  assert.equal(before.state, "finished");
  assert.equal(object(before.attention).code, "needs_reconciliation");
  checkAttentionHistory(before, history);
  const priorEvidence = structuredClone(await runRequestEvidence(backend, before));
  assert.equal(priorEvidence.slot.holder_validation_id, null, "request reconciliation has a validation holder");
  const interpretation = object(before.interpretation);
  const busy = await backend.request("POST", "/api/factory/requests", {
    request_id: randomUUID(), input: interpretation.input, interpretation_sha256: interpretation.interpretation_sha256,
  });
  error(busy, 409, "busy");
  const refusal = object(object(busy.body).error);
  assert.equal(refusal.retryable, false);
  assert.equal(object(refusal.details).reason, "needs_reconciliation");
  const result = body(await backend.request("POST", "/api/factory/test/reconcile", { request_id: before.request_id }), 200);
  // Reconciliation changes accounting and attention, never completed work. Its
  // deterministic control settles every held amount at the original worst case.
  const snapshot = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
    .filter(([field]) => !["budget", "attention", "updated_at", "events", "next_after", "poll_after_ms"].includes(field)));
  const previousBudget = object(before.budget);
  const expectedSpent = integer(previousBudget.spent_microusd) + integer(previousBudget.reserved_microusd);
  const checkReconciled = (value: Record<string, unknown>) => {
    assertContract("RequestStatus", value);
    checkScenarioStatus(value);
    assert.equal(value.attention, null, "reconciliation did not clear attention");
    assert.equal(object(value.budget).reserved_microusd, 0, "reconciliation left held spend");
    assert.equal(object(value.budget).spent_microusd, expectedSpent, "reconciliation lost held spend");
    assert.deepEqual(snapshot(value), snapshot(before), "reconciliation changed terminal result");
  };
  checkReconciled(result);
  const witnessed = new Map(history.map(event => [integer(event.seq), event]));
  const previousEnd = Math.max(integer(before.next_after), ...witnessed.keys());
  const returned = objects(result.events);
  assert(returned.length > 0, "reconciliation response lost history");
  for (const [index, event] of returned.entries()) {
    assert.equal(integer(event.seq), index + 1, "reconciliation response has an event gap or duplicate");
    const previous = witnessed.get(integer(event.seq));
    if (previous !== undefined) assert.deepEqual(event, previous, "reconciliation changed prior event");
    witnessed.set(integer(event.seq), event);
  }
  assert.equal(result.next_after, returned.length);
  const completedHistory: Record<string, unknown>[] = [];
  let cursor = 0;
  let after = await read(backend, `/api/factory/requests/${text(before.request_id)}`);
  let complete = false;
  for (let pages = 0; pages < 1000; pages++) {
    checkReconciled(after);
    const events = objects(after.events);
    for (const event of events) {
      assert.equal(integer(event.seq), ++cursor, "reconciliation history has an event gap or duplicate");
      const previous = witnessed.get(cursor);
      if (previous !== undefined) assert.deepEqual(event, previous, "reconciliation changed prior event");
      completedHistory.push(event);
    }
    assert.equal(after.next_after, cursor);
    if (events.length === 0) { complete = true; break; }
    await backend.wait(integer(after.poll_after_ms));
    after = await read(backend, `/api/factory/requests/${text(before.request_id)}?after=${String(cursor)}`);
  }
  if (!complete) throw new Unavailable("Reconciliation history reached the runner page limit.");
  checkFinishedHistory(after, completedHistory);
  for (const [seq, event] of witnessed) assert.deepEqual(completedHistory[seq - 1], event, "reconciliation lost witnessed history");
  let held = integer(previousBudget.reserved_microusd);
  let updates = 0;
  let cleared = false;
  for (const event of completedHistory.filter(event => integer(event.seq) > previousEnd)) {
    assert(!cleared, "reconciliation changed accounting after clearing attention");
    if (event.type === "budget_updated") {
      const data = object(event.data);
      const remainingHeld = integer(data.reserved_microusd);
      assert(remainingHeld >= 0 && remainingHeld <= held, "reconciliation event increased held spend");
      assert.deepEqual(data, {
        reserved_microusd: remainingHeld, spent_microusd: expectedSpent - remainingHeld,
        remaining_microusd: previousBudget.remaining_microusd,
      }, "reconciliation budget event lost held spend");
      held = remainingHeld;
      updates++;
    } else {
      assert.equal(event.type, "attention_cleared", "unexpected reconciliation transition");
      assert(updates > 0 && held === 0, "reconciliation cleared attention before settling held spend");
      assert.deepEqual(event.data, { code: object(before.attention).code }, "reconciliation cleared the wrong attention");
      cleared = true;
    }
  }
  assert(cleared, "reconciliation omitted new settlement or attention transitions");
  const evidence = await runEvidence(backend, after);
  checkReconciledEvidence(priorEvidence, evidence);
  assert.equal(evidence.slot.holder_request_id, null, "reconciliation left the factory slot held");
  assert.equal(evidence.slot.holder_validation_id, null, "reconciliation left a validation slot holder");

}

export async function runUnsupported(backend: IsolatedBackend): Promise<void> {
  await verify(backend);
  const call = backend.request.bind(backend);
  await resetScenario(backend, "two-host-fulfilled");
  const fixture: unknown = JSON.parse(readFileSync(new URL("../fixtures/interpretation-unsupported.json", import.meta.url), "utf8"));
  const input = object(object(fixture).input);
  const interpretation = body(await call("POST", "/api/factory/interpretations", input), 200);
  assert.equal(interpretation.startable, false);
  assert.deepEqual(interpretation.input, input, "unsupported requirements silently changed");
  checkInterpretedItems(objects(interpretation.items), objects(object(fixture).items), "unsupported item: ");
  checkInterpretationProfile(interpretation, object(fixture));
  const refusal = error(await call("POST", "/api/factory/requests", {
    request_id: randomUUID(), input, interpretation_sha256: interpretation.interpretation_sha256,
  }), 422, "unsupported_request");
  assert.deepEqual(object(refusal.details).interpretation, interpretation, "refusal interpretation changed");
  const invalidHost = structuredClone(input); invalidHost.hosts = ["synthetic-unsupported-host"];
  const invalidType = structuredClone(input);
  const item = objects(invalidType.items)[0]; assert(item); item.bug_type_id = "synthetic-unsupported-type";
  for (const invalid of [invalidHost, invalidType]) error(await call("POST", "/api/factory/interpretations", invalid), 400, "invalid_request");
}

function fixtureStatus(name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
  return object(value);
}
function probes(): { groups: ScenarioId[]; probe: Probe }[] {
  const plans: [string, string, string, string, ScenarioId[]][] = [
    ["two-host-fulfilled", "fulfilled", "fulfilled", "fulfilled", ["identity", "shared-budget", "continuity", "downloads"]],
    ["partial-budget", "partial-budget", "stopped_at_limit", "budget_exhausted", ["shared-budget", "stops"]],
    ["sources-exhausted", "exhausted", "sources_exhausted", "sources_exhausted", ["quantities", "stops"]],
    ["duplicate-defect", "duplicate-defect", "sources_exhausted", "sources_exhausted", ["qualification"]],
    ["wrong-failure", "wrong-failure", "sources_exhausted", "sources_exhausted", ["qualification"]],
    ["zero-result", "zero-result", "sources_exhausted", "sources_exhausted", ["qualification", "stops"]],
    ["worker-lost", "operational-error", "operational_error", "worker_lost", ["stops", "continuity"]],
    ["uncertain-provider", "operational-error", "operational_error", "needs_reconciliation", ["stops", "continuity"]],
    ["cancel-midway", "cancelled", "cancelled", "cancelled_by_user", ["stops"]],
    ["validation-failed", "fulfilled", "fulfilled", "fulfilled", ["downloads"]],
    ["validation-error", "fulfilled", "fulfilled", "fulfilled", ["downloads"]],
  ];
  return plans.map(([scenario, fixture, outcome, stopCode, groups]) => {
    const expected = fixtureStatus(`status-${fixture}`);
    const interpretation = object(expected.interpretation);
    const input = object(interpretation.input);
    return { groups, probe: {
    scenario, input, outcome, stopCode, expectedDelivery: text(expected.delivery), expectedItems: objects(interpretation.items), expectedCounts: objects(expected.items),
    expectedInterpretation: interpretation,
    expectedAttention: expected.attention === null ? null : text(object(expected.attention).code),
    // The uncertain-provider control specifies no candidate end-state fixture.
    ...(scenario === "uncertain-provider" ? {} : { expectedCandidates: objects(expected.candidates), expectedFunnel: object(expected.funnel) }),
    concurrent: scenario === "two-host-fulfilled", cancel: scenario === "cancel-midway",
    reconcile: scenario === "worker-lost" || scenario === "uncertain-provider",
    downloads: scenario === "two-host-fulfilled", evidence: true,
    ...(scenario === "validation-failed" ? { validation: "failed" as const } : scenario === "validation-error" ? { validation: "error" as const } : {}),
  } }; });
}
interface Result { id: ScenarioId; status: "passed" | "failed" | "unavailable"; checks: string[]; dependencies: string[] }
const gaps: Record<ScenarioId, string[]> = {
  identity: ["Durable request/job identities are not exposed by TestEvidence; worker reservations alone do not prove durable job uniqueness."],
  quantities: ["A published startable scenario with unequal requested quantities and pinned per-item delivered/missing counts is unavailable; named multi-item inputs request 1/1."],
  "shared-budget": ["TestEvidence does not associate copy operations with hosts; cross-host reservation attribution remains unavailable."],
  qualification: ["A deterministic setup_failed candidate control is not named in revision 2."],
  unsupported: [],
  stops: [],
  continuity: [],
  downloads: ["Pending-package access needs a documented deterministic window and case ID. Synthetic test-mode archives do not establish real package privacy or replay."],
};
function failure(error: unknown): string {
  return error instanceof assert.AssertionError
    ? error.message.split("\n")[0] ?? "assertion failed"
    : "assertion or transport failure";
}
export async function runAcceptance(backend?: IsolatedBackend) {
  const results: Result[] = scenarioIds.map(id => ({ id, status: "unavailable", checks: [], dependencies: [...gaps[id]] }));
  let backendRevision: string | null = null;
  let verified = false;
  if (backend) {
    try {
      const verification = await verify(backend);
      backendRevision = verification.backendRevision; verified = true;
    } catch {
      for (const result of results) result.dependencies.push("Backend isolation verification failed; no API operations attempted.");
    }
  }
  if (backend && verified) {
    const unsupported = results.find(r => r.id === "unsupported"); assert(unsupported);
    try { await runUnsupported(backend); unsupported.checks.push("unsupported-interpretation-and-start"); }
    catch (error) { unsupported.status = "failed"; unsupported.checks.push(`unsupported: ${failure(error)}`); }
    for (const { groups, probe } of probes()) {
      try {
        await runProbe(backend, probe);
        for (const result of results.filter(r => groups.includes(r.id))) result.checks.push(probe.scenario);
      } catch (error) {
        for (const result of results.filter(r => groups.includes(r.id))) {
          if (error instanceof Unavailable) result.dependencies.push(error.message);
          else { result.status = "failed"; result.checks.push(`${probe.scenario}: ${failure(error)}`); }
        }
      }
    }
    for (const result of results) if (result.status !== "failed") {
      result.status = result.dependencies.length === 0 && result.checks.length > 0 ? "passed" : "unavailable";
    }
  } else for (const result of results) result.dependencies.push("No verified isolated backend was selected.");
  const summary = { passed: 0, failed: 0, unavailable: 0 };
  for (const result of results) summary[result.status]++;
  return { schema_version: 1, suite: "request-api-acceptance", contract_revision: contractRevision,
    backend_revision: backendRevision, isolated_target_verified: verified, acceptance_executed: verified,
    summary, scenarios: results, exit_code: summary.failed > 0 ? 1 : summary.unavailable > 0 ? 2 : 0 };
}
