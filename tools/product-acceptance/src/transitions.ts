import assert from "node:assert/strict";
import { integer, object, objects, text } from "./invariants.ts";

type Row = Record<string, unknown>;
const candidateTypes = ["candidate_selected", "check_finished", "behavior_checks_passed", "requested_criteria_passed",
  "candidate_rejected", "candidate_invalid", "candidate_incomplete", "candidate_skipped", "package_ready", "case_delivered"];
const hostTypes = ["host_preparing", "host_ready"];
const catalogKey = (candidate: Row) => JSON.stringify([candidate.host_id, candidate.source_id, candidate.entry_id]);

/** Named controls fix check outcomes; identities, wording and host preparation interleaving stay free. */
export function checkScenarioTransitions(state: Row, expectedCandidates: Row[], expectedEvents: Row[], history: Row[]): void {
  const candidates = objects(state.candidates);
  const cases = objects(state.cases);
  const candidateEvents = history.filter(event => candidateTypes.includes(text(event.type)));
  for (const event of candidateEvents) {
    assert(candidates.some(candidate => candidate.candidate_id === event.candidate_id), "transition names an unknown candidate");
  }
  const normalize = (events: Row[], rows: Row[]) => events.map(event => {
    let candidate: string | null = null;
    let delivered: string | null = null;
    if (event.candidate_id !== null) {
      const row = rows.find(row => row.candidate_id === event.candidate_id); assert(row, "transition has an unknown candidate");
      candidate = catalogKey(row);
    }
    if (event.case_id !== null) {
      const row = rows.find(row => row.case_id === event.case_id); assert(row, "transition has an unknown case");
      delivered = catalogKey(row);
    }
    const data = structuredClone(object(event.data));
    if (event.type === "requested_criteria_passed") {
      assert(Array.isArray(data.criterion_ids)); data.criterion_ids = data.criterion_ids.map(value => text(value)).sort();
    }
    return { type: event.type, host: event.host_id, candidate, item: event.item_key, case: delivered,
      data: event.type === "package_ready" ? {} : data };
  });
  for (const expected of expectedCandidates) {
    const candidate = candidates.find(candidate => catalogKey(candidate) === catalogKey(expected)); assert(candidate);
    const actual = candidateEvents.filter(event => event.candidate_id === candidate.candidate_id);
    const wanted = expectedEvents.filter(event => candidateTypes.includes(text(event.type)) && event.candidate_id === expected.candidate_id);
    assert.deepEqual(normalize(actual, candidates), normalize(wanted, expectedCandidates), "candidate transition sequence differs from pinned scenario");
  }
  for (const event of candidateEvents.filter(event => event.type === "package_ready")) {
    const delivered = cases.find(c => c.case_id === event.case_id); assert(delivered, "package transition has no delivered case");
    const packages = object(delivered.packages);
    assert.deepEqual(event.data, { bug_case_sha256: object(packages.bug_case).sha256, validator_sha256: object(packages.validator).sha256 },
      "package transition hashes differ from delivered packages");
  }
  const workers = history.filter(event => event.type === "worker_started");
  assert.equal(workers.length, 1, "transition history needs one worker start");
  const worker = workers[0]; assert(worker);
  const hostEvents = history.filter(event => hostTypes.includes(text(event.type)));
  const wantedHosts = expectedEvents.filter(event => hostTypes.includes(text(event.type)));
  const hosts = new Set([...hostEvents, ...wantedHosts].map(event => event.host_id));
  for (const host of hosts) {
    const actual = hostEvents.filter(event => event.host_id === host);
    const wanted = wantedHosts.filter(event => event.host_id === host);
    assert.deepEqual(normalize(actual, candidates), normalize(wanted, expectedCandidates), "host transition sequence differs from pinned scenario");
  }
  for (const event of [...hostEvents, ...candidateEvents]) {
    assert(integer(event.seq) > integer(worker.seq), "transition precedes worker start");
    if (event.type === "candidate_selected") {
      const ready = hostEvents.find(host => host.type === "host_ready" && host.host_id === event.host_id);
      assert(ready && integer(ready.seq) < integer(event.seq), "candidate transition precedes host readiness");
    }
  }
  const exhausted = history.filter(event => event.type === "source_exhausted");
  const wantedExhausted = expectedEvents.filter(event => event.type === "source_exhausted");
  const sorted = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();
  assert.deepEqual(sorted(normalize(exhausted, candidates)), sorted(normalize(wantedExhausted, expectedCandidates)),
    "source exhaustion transition differs from pinned scenario");
  for (const event of exhausted) {
    for (const candidate of candidates.filter(candidate => candidate.host_id === event.host_id && candidate.source_id === object(event.data).source_id)) {
      const last = candidateEvents.findLast(current => current.candidate_id === candidate.candidate_id); assert(last);
      assert(integer(last.seq) < integer(event.seq), "source exhaustion transition precedes candidate completion");
    }
  }
  checkBudgetTransitions(state, expectedCandidates, expectedEvents, history);
}

/** The named scripts fix reservation/settlement positions, not the fixtures' illustrative costs. */
function checkBudgetTransitions(state: Row, expectedCandidates: Row[], expectedEvents: Row[], history: Row[]): void {
  const markers = [...candidateTypes, "request_accepted", "worker_started", "budget_updated", "request_finished"];
  const project = (events: Row[], candidates: Row[]) => events.filter(event => markers.includes(text(event.type))).map(event => {
    const candidate = event.candidate_id === null ? null : candidates.find(candidate => candidate.candidate_id === event.candidate_id);
    assert(candidate !== undefined, "budget transition has an unknown candidate");
    return [event.type, candidate === null ? null : catalogKey(candidate)];
  });
  assert.deepEqual(project(history, objects(state.candidates)), project(expectedEvents, expectedCandidates),
    "budget transition positions differ from pinned scenario");
  const budget = object(state.budget);
  const events = history.filter(event => event.type === "budget_updated");
  const expectedBudgets: Row[] = [];
  let held = 0; let spent = 0; let reserve = 0; let settle = 0;
  // Only the pinned marker positions drive this profile. Candidate originals
  // cost their host's known worst case; a skipped entry never reserves or settles.
  for (const event of expectedEvents) {
    if (event.type === "candidate_selected" || ["case_delivered", "candidate_rejected", "candidate_invalid", "candidate_incomplete"].includes(text(event.type))) {
      const candidate = expectedCandidates.find(candidate => candidate.candidate_id === event.candidate_id); assert(candidate);
      const cost = candidate.stage === "skipped" ? 0 : candidate.host_id === "task-report" ? 300000 : 600000;
      if (event.type === "candidate_selected") reserve = cost;
      else settle = cost;
    }
    if (event.type !== "budget_updated") continue;
    if (expectedBudgets.length === 0) held = 200000;
    else if (settle > 0) { held -= settle; spent += settle; settle = 0; }
    else if (reserve > 0) { held += reserve; reserve = 0; }
    else { held -= 200000; spent += 200000; }
    expectedBudgets.push({ reserved_microusd: held, spent_microusd: spent, remaining_microusd: integer(budget.budget_microusd) - held - spent });
  }
  assert.deepEqual(events.map(event => event.data), expectedBudgets, "budget transition amounts differ from pinned worst cases");
  for (const event of events) {
    const data = object(event.data);
    const amounts = [data.reserved_microusd, data.spent_microusd, data.remaining_microusd].map(integer);
    assert(amounts.every(amount => amount >= 0), "budget transition has a negative amount");
    assert.equal(amounts.reduce((sum, amount) => sum + amount, 0), budget.budget_microusd, "budget transition does not conserve request budget");
  }
  const first = events[0]; const last = events.at(-1); assert(first && last, "budget transitions are missing");
  assert.deepEqual(first.data, { reserved_microusd: 200000, spent_microusd: 0, remaining_microusd: integer(budget.budget_microusd) - 200000 },
    "initial budget transition differs from worker reservation");
  assert.deepEqual(last.data, Object.fromEntries(["reserved_microusd", "spent_microusd", "remaining_microusd"].map(field => [field, budget[field]])),
    "final budget transition differs from request accounting");
}
