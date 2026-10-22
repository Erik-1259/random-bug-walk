import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { contractRevision, runAcceptance, runProbe, type IsolatedBackend, type Probe, type Reply } from "../src/runner.ts";
import { integer, object, objects, text } from "../src/invariants.ts";
const fixture = (name: string) => object(JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8")) as unknown);

// Static transport responses prove rejection behavior, not product acceptance.
function terminalScenario(name: string) {
  const expected = fixture(`status-${name}`);
  const state = structuredClone(expected);
  const interpretation = structuredClone(object(expected.interpretation));
  const evidence = fixture("test-evidence");
  const held = state.attention !== null;
  const amounts = [200000, ...objects(state.candidates).filter(candidate => candidate.stage !== "skipped")
    .flatMap(candidate => Array<number>(3).fill(candidate.host_id === "task-report" ? 100000 : 200000))];
  evidence.operations = amounts.map((amount, index) => ({ operation_id: (index + 1).toString(16).padStart(64, "0"),
    kind: index === 0 ? "worker" : "candidate_copy", call_name: `synthetic-operation-${String(index)}`,
    state: held ? "uncertain" : "reconciled", reserved_microusd: amount, settled_microusd: held ? null : amount, attempt_ordinal: 1 }));
  evidence.provider_calls = objects(evidence.operations).map(op => ({ call_name: op.call_name, provider: "sandbox", action: "create", at: state.created_at }));
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  Object.assign(object(state.budget), { reserved_microusd: held ? total : 0, spent_microusd: held ? 0 : total,
    committed_microusd: total, remaining_microusd: integer(object(state.budget).budget_microusd) - total });
  // Independently assign each event its held/settled intervals. End-state fixture
  // costs are illustrative; the named test profile charges every original fully.
  const events = objects(state.events);
  const budgetIndexes = events.flatMap((event, index) => event.type === "budget_updated" ? [index] : []);
  const workerEnd = held ? Infinity : budgetIndexes.at(-1); assert(workerEnd !== undefined);
  const intervals = objects(state.candidates).filter(candidate => candidate.stage !== "skipped").map(candidate => {
    const selected = events.findIndex(event => event.type === "candidate_selected" && event.candidate_id === candidate.candidate_id);
    const ended = events.findIndex(event => ["case_delivered", "candidate_rejected", "candidate_invalid", "candidate_incomplete"].includes(text(event.type))
      && event.candidate_id === candidate.candidate_id);
    const start = budgetIndexes.find(index => index > selected); assert(start !== undefined);
    const end = budgetIndexes.find(index => index > ended) ?? Infinity;
    return { start, end, cost: candidate.host_id === "task-report" ? 300000 : 600000 };
  });
  for (const index of budgetIndexes) {
    const event = events[index]; assert(event);
    const reserved = (index < workerEnd ? 200000 : 0) + intervals.filter(range => range.start <= index && index < range.end).reduce((sum, range) => sum + range.cost, 0);
    const spent = (index >= workerEnd ? 200000 : 0) + intervals.filter(range => range.end <= index).reduce((sum, range) => sum + range.cost, 0);
    event.data = { reserved_microusd: reserved, spent_microusd: spent, remaining_microusd: integer(object(state.budget).budget_microusd) - reserved - spent };
  }
  object(evidence.slot).holder_request_id = held ? expected.request_id : null;
  let id = text(expected.request_id); let starts = 0;
  const replaceId = (value: unknown) => object(JSON.parse(JSON.stringify(value).replaceAll(text(expected.request_id), id)) as unknown);
  const backend: IsolatedBackend = {
    verifyIsolation: () => Promise.resolve({ backendRevision: "a".repeat(40), contractRevision }),
    wait: () => Promise.resolve(), reconnect: () => Promise.resolve(),
    request: (method, path, payload): Promise<Reply> => {
      if (path.endsWith("/test/reset")) return Promise.resolve({ status: 200, body: { contract_version: "bug-request/1", scenario: object(payload).scenario } });
      if (path.endsWith("/interpretations")) return Promise.resolve({ status: 200, body: interpretation });
      if (method === "POST") {
        id = text(object(payload).request_id);
        const first = ++starts === 1;
        const body = replaceId(state);
        if (first) {
          body.state = objects(body.events).some(event => event.type === "stop_requested") ? "stopping" : "running";
          body.outcome = null; body.stop_reason = null;
          body.events = objects(body.events).slice(0, objects(body.events).findIndex(event => event.type === "request_finished"));
          const last = objects(body.events).at(-1); assert(last);
          body.next_after = last.seq; body.updated_at = last.at;
        }
        return Promise.resolve({ status: first ? 202 : 200, body });
      }
      if (path.includes("/test/evidence?")) return Promise.resolve({ status: 200, body: { ...replaceId(evidence), request_id: id } });
      const page = replaceId(state); const cursor = Number(path.split("?after=")[1] ?? 0);
      page.events = objects(page.events).filter(event => integer(event.seq) > cursor);
      page.next_after = objects(page.events).at(-1)?.seq ?? cursor;
      return Promise.resolve({ status: 200, body: page });
    },
  };
  const scenarioNames: Record<string, string> = { fulfilled: "two-host-fulfilled", exhausted: "sources-exhausted", cancelled: "cancel-midway", "operational-error": "worker-lost" };
  const probe = { scenario: scenarioNames[name] ?? name, input: object(object(expected.interpretation).input), outcome: text(expected.outcome),
    stopCode: text(object(expected.stop_reason).code), expectedDelivery: text(expected.delivery),
    expectedItems: objects(object(expected.interpretation).items), expectedCounts: objects(expected.items),
    expectedInterpretation: object(expected.interpretation), expectedFunnel: object(expected.funnel),
    expectedCandidates: objects(expected.candidates), expectedEvents: objects(expected.events), expectedAttention: expected.attention === null ? null : text(object(expected.attention).code), evidence: true };
  return { state, interpretation, evidence, backend, probe };
}
for (const name of ["fulfilled", "exhausted", "cancelled"]) it.each(["request", "validation"])(`rejects a retained %s slot after ${name}`, async holder => {
  const s = terminalScenario(name);
  object(s.evidence.slot).holder_request_id = s.state.request_id;
  if (holder === "validation") object(s.evidence.slot).holder_validation_id = "00000000-0000-4000-8000-000000000301";
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("terminal request left");
});
it("rejects stable unexpected reconciliation attention instead of accepting its held slot", async () => {
  const s = terminalScenario("fulfilled");
  s.state.attention = fixture("status-operational-error").attention;
  object(s.evidence.slot).holder_request_id = s.state.request_id;
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("attention differs from pinned scenario");
});
it("rejects held spend after ordinary completion even when status and ledger agree and the slot is free", async () => {
  const s = terminalScenario("fulfilled");
  const worker = objects(s.evidence.operations).find(op => op.kind === "worker"); assert(worker);
  worker.state = "uncertain"; worker.settled_microusd = null;
  Object.assign(object(s.state.budget), { reserved_microusd: 200000, spent_microusd: integer(object(s.state.budget).committed_microusd) - 200000 });
  const finalBudget = objects(s.state.events).findLast(event => event.type === "budget_updated"); assert(finalBudget);
  finalBudget.data = Object.fromEntries(["reserved_microusd", "spent_microusd", "remaining_microusd"].map(field => [field, object(s.state.budget)[field]]));
  // Isolate the final ledger guard from the separate named history profile.
  const probe: Probe = { ...s.probe }; delete probe.expectedEvents;
  await expect(runProbe(s.backend, probe)).rejects.toThrow("terminal request left held spend");
});
for (const name of ["wrong-failure", "zero-result", "duplicate-defect", "partial-budget", "cancelled", "operational-error"]) {
  it(`accepts the pinned ${name} candidate outcome and linked event`, async () => {
    const s = terminalScenario(name); await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
  });
  it.each(["missing-candidate", "wrong-reason", "missing-event", "wrong-event-reason"])(`rejects %s in ${name} despite unchanged delivery`, async change => {
    const s = terminalScenario(name);
    const candidate = objects(s.state.candidates).find(c => c.reason !== null); assert(candidate);
    const event = objects(s.state.events).find(e => e.candidate_id === candidate.candidate_id && e.type === `candidate_${text(candidate.stage)}`); assert(event);
    const reason = text(object(candidate.reason).code);
    const alternatives: Record<string, string> = { wrong_failure: "original_suite_caught_bug", original_suite_caught_bug: "wrong_failure",
      duplicate_defect: "no_budget_for_candidate", no_budget_for_candidate: "duplicate_defect", stopped: "incomplete_run", incomplete_run: "stopped" };
    const wrongReason = alternatives[reason]; assert(wrongReason);
    if (change === "missing-candidate") s.state.candidates = objects(s.state.candidates).filter(c => c !== candidate);
    if (change === "wrong-reason") { object(candidate.reason).code = wrongReason; object(event.data).reason = wrongReason; }
    if (change === "wrong-event-reason") object(event.data).reason = wrongReason;
    if (change === "missing-event") {
      s.state.events = objects(s.state.events).filter(e => e !== event).map((e, index) => ({ ...e, seq: index + 1 }));
      s.state.next_after = objects(s.state.events).length;
    }
    await expect(runProbe(s.backend, s.probe)).rejects.toThrow();
  });
}
it("rejects a supposedly duplicate entry with a different defect identity", async () => {
  const s = terminalScenario("duplicate-defect");
  const duplicate = objects(s.state.candidates).find(c => c.stage === "skipped"); assert(duplicate);
  duplicate.defect_id = "ac".repeat(32);
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("candidate defect relationship");
});
it("accepts different opaque candidate and defect IDs while retaining their relationships", async () => {
  const s = terminalScenario("duplicate-defect");
  const candidates = objects(s.state.candidates); const first = candidates[0]; assert(first);
  const changed = JSON.stringify(s.state).replaceAll(text(first.defect_id), "ad".repeat(32)).replaceAll(text(first.candidate_id), "ae".repeat(32));
  Object.assign(s.state, object(JSON.parse(changed) as unknown));
  await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
});
it("reports the missing unequal-quantity control explicitly", async () => {
  const report = await runAcceptance();
  const result = report.scenarios.find(s => s.id === "quantities"); assert(result);
  expect(result.status).toBe("unavailable");
  expect(result.dependencies.some(dependency => dependency.includes("unequal requested quantities"))).toBe(true);
});

const profileChanges: [string, (value: Record<string, unknown>) => void][] = [
  ["interpreter identity", value => { object(value.interpreter).interpreter_id = "synthetic-other"; }],
  ["interpreter version", value => { object(value.interpreter).version = "2"; }],
  ["catalog version", value => { object(value.interpreter).criteria_catalog_version = "2"; }],
  ["qualification route", value => { object(value.qualification_route).route_id = "synthetic-other"; }],
  ["route version", value => { object(value.qualification_route).version = "2"; }],
  ["host usage", value => { const host = objects(value.hosts)[0]; assert(host); host.used = false; host.reason = "synthetic-unused"; }],
  ["type quantities", value => { const total = objects(value.type_totals)[0]; assert(total); total.quantity = 2; }],
  ["worker price", value => { object(value.budget).worker_worst_case_microusd = 100000; }],
  ["candidate price", value => { const price = objects(object(value.budget).worst_case_per_candidate_microusd)[0]; assert(price); price.microusd = 100000; }],
  ["validation price", value => { const price = objects(object(value.budget).worst_case_per_validation_microusd)[0]; assert(price); price.microusd = 100000; }],
  ["wall clock limit", value => { object(value.limits).max_wall_clock_s = 1; }],
  ["candidate limit", value => { object(value.limits).max_candidates = 1; }],
  ["request problems", value => { value.problems = [{ code: "budget_below_minimum", severity: "blocking", item_key: null, message: "synthetic problem" }]; }],
  ["criterion matched text", value => { const item = objects(value.items)[0]; assert(item); const criterion = objects(item.criteria)[0]; assert(criterion); criterion.matched_text = "synthetic unrelated text"; }],
];
for (const [name, mutate] of profileChanges) it(`rejects consistently incorrect pinned ${name}`, async () => {
  const s = terminalScenario("fulfilled");
  mutate(s.interpretation); s.state.interpretation = structuredClone(s.interpretation);
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("interpretation profile differs");
});
it("rejects incorrect request limits even when they remain frozen", async () => {
  const s = terminalScenario("fulfilled"); object(s.state.limits).max_candidates = 1;
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("request limits differ");
});
it("rejects a deadline inconsistent with the pinned execution window", async () => {
  const s = terminalScenario("fulfilled");
  object(s.state.limits).deadline_at = new Date(Date.parse(text(s.state.created_at)) + 1000).toISOString();
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("request deadline");
});
it("accepts generated interpretation hashes and unordered profile sets", async () => {
  const s = terminalScenario("fulfilled");
  s.interpretation.interpretation_sha256 = "ab".repeat(32);
  for (const key of ["hosts", "type_totals"]) s.interpretation[key] = objects(s.interpretation[key]).reverse();
  for (const key of ["worst_case_per_candidate_microusd", "worst_case_per_validation_microusd"]) object(s.interpretation.budget)[key] = objects(object(s.interpretation.budget)[key]).reverse();
  s.state.interpretation = structuredClone(s.interpretation);
  await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
});
it("allows descriptive interpretation text without changing pinned meaning", async () => {
  const s = terminalScenario("exhausted");
  object(s.interpretation.budget).estimate_note = "synthetic estimate note";
  for (const host of objects(s.interpretation.hosts)) host.reason = "synthetic host note";
  for (const item of objects(s.interpretation.items)) {
    for (const criterion of objects(item.criteria)) criterion.label = "synthetic criterion label";
    for (const problem of objects(item.problems)) problem.message = "synthetic problem note";
  }
  s.state.interpretation = structuredClone(s.interpretation);
  await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
});
it("allows an unrequested known type with zero interpretation quantity", async () => {
  const s = terminalScenario("zero-result");
  s.interpretation.type_totals = [...objects(s.interpretation.type_totals), { bug_type_id: "concurrency", quantity: 0 }];
  s.state.interpretation = structuredClone(s.interpretation);
  await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
});
for (const field of ["candidates_explored", "behavior_checks_passed", "requested_criteria_passed"]) {
  it(`rejects consistently inflated terminal ${field}`, async () => {
    const s = terminalScenario("wrong-failure"); object(s.state.funnel)[field] = 2;
    await expect(runProbe(s.backend, s.probe)).rejects.toThrow("funnel");
  });
}
it("rejects plausible nonzero funnel counts that differ from the pinned scenario", async () => {
  const s = terminalScenario("cancelled"); object(s.state.funnel).candidates_explored = 1;
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("funnel differs from pinned scenario");
});
it("rejects a missing behavior event despite correct pinned funnel counts", async () => {
  const s = terminalScenario("wrong-failure");
  s.state.events = objects(s.state.events).filter(e => e.type !== "behavior_checks_passed").map((e, index) => ({ ...e, seq: index + 1 }));
  s.state.next_after = objects(s.state.events).length;
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("funnel history");
});

// Synthetic transport setup for the documented first-create uncertainty sequence;
// this is not a published complete uncertain-provider end-state fixture.
function uncertainControl() {
  const s = terminalScenario("operational-error");
  const probe: Probe = { ...s.probe, scenario: "uncertain-provider", stopCode: "needs_reconciliation" };
  delete probe.expectedCandidates; delete probe.expectedFunnel; delete probe.expectedEvents;
  object(s.state.stop_reason).code = "needs_reconciliation";
  s.state.funnel = { candidates_explored: 0, behavior_checks_passed: 0, requested_criteria_passed: 0, packages_ready: 0 };
  s.state.events = objects(s.state.events).filter(event => event.type !== "check_finished"
    && !(event.type === "attention" && object(event.data).code === "worker_unresponsive"));
  for (const event of objects(s.state.events)) if (event.type === "request_finished") object(event.data).stop_code = "needs_reconciliation";
  const worker = objects(s.evidence.operations).find(op => op.kind === "worker"); assert(worker);
  worker.state = "terminal"; worker.settled_microusd = worker.reserved_microusd;
  const copies = objects(s.evidence.operations).filter(op => op.kind === "candidate_copy");
  for (const op of copies.slice(1)) { op.state = "terminal"; op.settled_microusd = 0; }
  s.evidence.provider_calls = objects(s.evidence.provider_calls).filter(call => call.call_name === worker.call_name || call.call_name === copies[0]?.call_name);
  const normalize = () => {
    s.state.events = objects(s.state.events).map((event, index) => ({ ...event, seq: index + 1 }));
    s.state.next_after = objects(s.state.events).length;
    const ops = objects(s.evidence.operations);
    const reserved = ops.filter(op => op.settled_microusd === null).reduce((sum, op) => sum + integer(op.reserved_microusd), 0);
    const spent = ops.reduce((sum, op) => sum + (op.settled_microusd === null ? 0 : integer(op.settled_microusd)), 0);
    Object.assign(object(s.state.budget), { reserved_microusd: reserved, spent_microusd: spent, committed_microusd: reserved + spent,
      remaining_microusd: integer(object(s.state.budget).budget_microusd) - reserved - spent });
  };
  normalize();
  // The pinned control reserves three copies, releases the two never launched,
  // then settles its worker while the first copy remains uncertain.
  const history = objects(s.state.events);
  const incomplete = history.find(event => event.type === "candidate_incomplete"); assert(incomplete);
  const sample = history.find(event => event.type === "budget_updated"); assert(sample);
  const budget = integer(object(s.state.budget).budget_microusd);
  const update = (held: number, spent: number) => ({ ...sample, data: {
    reserved_microusd: held, spent_microusd: spent, remaining_microusd: budget - held - spent,
  } });
  replaceHistory(s, history.flatMap(event => event === incomplete ? [event, update(300000, 0), update(100000, 200000)] : [event]));
  return { ...s, probe, worker, copies, normalize };
}
it("accepts the first uncertain candidate create with unused originals retained", async () => {
  const s = uncertainControl(); await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
});
it.each([1, 4])("accepts uncertain budget history paged by %s events", async size => {
  const s = uncertainControl(); pageScenario(s, size);
  await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
});
for (const paged of [false, true]) {
  it.each([0, 1, 2, 3])(`rejects missing uncertain budget update %s with paged=${String(paged)}`, async index => {
    const s = uncertainControl(); const history = objects(s.state.events);
    const budgets = history.filter(event => event.type === "budget_updated"); const removed = budgets[index]; assert(removed);
    replaceHistory(s, history.filter(event => event !== removed));
    if (paged) pageScenario(s, 1);
    await expect(runProbe(s.backend, s.probe)).rejects.toThrow("uncertain-provider budget");
  });
}
it.each([0, 1, 2, 3])("rejects discounted uncertain budget update %s despite a correct ledger", async index => {
  const s = uncertainControl(); const event = objects(s.state.events).filter(event => event.type === "budget_updated")[index]; assert(event);
  const data = object(event.data);
  data.reserved_microusd = integer(data.reserved_microusd) - 1;
  data.remaining_microusd = integer(data.remaining_microusd) + 1;
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("uncertain-provider budget");
});
it.each(["all-missing", "duplicate", "worker-late", "candidate-early", "release-early", "settlements-reversed"])(
  "rejects uncertain budget history %s despite correct terminal accounting", async change => {
    const s = uncertainControl(); let history = objects(s.state.events);
    const budgets = history.filter(event => event.type === "budget_updated");
    const [worker, candidate, released, settled] = budgets; assert(worker && candidate && released && settled);
    if (change === "all-missing") history = history.filter(event => event.type !== "budget_updated");
    if (change === "duplicate") history = history.flatMap(event => event === candidate ? [event, structuredClone(event)] : [event]);
    if (change === "worker-late") history = history.filter(event => event !== worker).flatMap(event => event.type === "worker_started" ? [event, worker] : [event]);
    if (change === "candidate-early") history = history.filter(event => event !== candidate).flatMap(event => event.type === "candidate_selected" ? [candidate, event] : [event]);
    if (change === "release-early") history = history.filter(event => event !== released).flatMap(event => event.type === "candidate_incomplete" ? [released, event] : [event]);
    if (change === "settlements-reversed") history = history.map(event => event === released ? settled : event === settled ? released : event);
    replaceHistory(s, history); pageScenario(s, 1);
    await expect(runProbe(s.backend, s.probe)).rejects.toThrow("uncertain-provider budget");
  });
it("accepts uncertain budget settlements after request completion before reconciliation", async () => {
  const s = uncertainControl(); const history = objects(s.state.events);
  const settlements = history.filter(event => event.type === "budget_updated").slice(2);
  replaceHistory(s, [...history.filter(event => !settlements.includes(event)), ...settlements]);
  pageScenario(s, 1);
  await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
});
it("rejects uncertain-provider on an internally consistent unrelated source", async () => {
  const s = uncertainControl();
  const candidate = objects(s.state.candidates)[0]; assert(candidate);
  candidate.source_id = "synthetic-unrelated-source";
  for (const event of objects(s.state.events)) if (event.type === "candidate_selected") object(event.data).source_id = candidate.source_id;
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("uncertain-provider");
});
it.each(["worker-only", "uncertain-worker", "missing-selection", "wrong-selection", "missing-worker-start", "replacement-create"])("rejects uncertain-provider %s despite consistent accounting", async change => {
  const s = uncertainControl();
  const first = s.copies[0]; const second = s.copies[1]; assert(first && second);
  if (change === "worker-only") {
    s.state.candidates = []; object(s.state.limits).candidates_started = 0;
    s.state.events = objects(s.state.events).filter(event => event.candidate_id === null);
    s.evidence.operations = [s.worker];
    s.evidence.provider_calls = objects(s.evidence.provider_calls).filter(call => call.call_name === s.worker.call_name);
    s.worker.state = "uncertain"; s.worker.settled_microusd = null;
  }
  if (change === "uncertain-worker") {
    first.state = "terminal"; first.settled_microusd = first.reserved_microusd;
    s.worker.state = "uncertain"; s.worker.settled_microusd = null;
  }
  if (change === "missing-selection") s.state.events = objects(s.state.events).filter(event => event.type !== "candidate_selected");
  if (change === "wrong-selection") for (const event of objects(s.state.events)) if (event.type === "candidate_selected") event.candidate_id = "ef".repeat(32);
  if (change === "missing-worker-start") s.state.events = objects(s.state.events).filter(event => event.type !== "worker_started");
  if (change === "replacement-create") {
    second.state = "uncertain"; second.settled_microusd = null;
    s.evidence.provider_calls = [...objects(s.evidence.provider_calls), { call_name: second.call_name, provider: "sandbox", action: "create", at: s.state.created_at }];
  }
  s.normalize();
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("uncertain-provider");
});
for (const scenario of ["worker-lost", "uncertain-provider"]) {
  it.each(["missing", "wrong-code", "already-cleared", "wrong-clear"])(`rejects ${scenario} %s attention history before reconciliation`, async change => {
    const s = scenario === "worker-lost" ? terminalScenario("operational-error") : uncertainControl();
    const history = objects(s.state.events);
    const attention = history.find(event => event.type === "attention" && object(event.data).code === "needs_reconciliation"); assert(attention);
    if (change === "missing") s.state.events = history.filter(event => event !== attention);
    if (change === "wrong-code") object(attention.data).code = "worker_unresponsive";
    if (change === "already-cleared") s.state.events = [...history, { ...attention, type: "attention_cleared" }];
    if (change === "wrong-clear") {
      const clear = { ...attention, type: "attention_cleared", data: { code: "worker_unresponsive" } };
      s.state.events = [...history, clear, { ...attention }];
    }
    s.state.events = objects(s.state.events).map((event, index) => ({ ...event, seq: index + 1 }));
    s.state.next_after = objects(s.state.events).length;
    await expect(runProbe(s.backend, s.probe)).rejects.toThrow("attention history");
  });
  it(`accepts ${scenario} attention recorded after completion before reconciliation`, async () => {
    const s = scenario === "worker-lost" ? terminalScenario("operational-error") : uncertainControl();
    const history = objects(s.state.events);
    const attention = history.find(event => event.type === "attention" && object(event.data).code === "needs_reconciliation"); assert(attention);
    s.state.events = [...history.filter(event => event !== attention), attention].map((event, index) => ({ ...event, seq: index + 1 }));
    s.state.next_after = objects(s.state.events).length;
    await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
  });
}
it.each(["rejected", "invalid", "stopped", "missing-event", "wrong-event-candidate", "wrong-event-host", "wrong-event-reason", "duplicate-event"])("rejects uncertain candidate %s correspondence", async change => {
  const s = uncertainControl(); const candidate = objects(s.state.candidates)[0]; assert(candidate);
  const event = objects(s.state.events).find(event => event.type === "candidate_incomplete"); assert(event);
  if (["rejected", "invalid", "stopped"].includes(change)) {
    const code = change === "rejected" ? "wrong_failure" : change === "invalid" ? "setup_failed" : "stopped";
    candidate.stage = change === "stopped" ? "incomplete" : change;
    object(candidate.reason).code = code; event.type = `candidate_${text(candidate.stage)}`; object(event.data).reason = code;
  }
  if (change === "missing-event") s.state.events = objects(s.state.events).filter(current => current !== event);
  if (change === "wrong-event-candidate") event.candidate_id = "ef".repeat(32);
  if (change === "wrong-event-host") event.host_id = "umami";
  if (change === "wrong-event-reason") object(event.data).reason = "stopped";
  if (change === "duplicate-event") s.state.events = objects(s.state.events).flatMap(current => current === event ? [event, structuredClone(event)] : [current]);
  s.normalize();
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow();
});

for (const name of ["fulfilled", "exhausted", "cancelled", "operational-error"]) {
  it(`rejects missing request_finished in complete ${name} history`, async () => {
    const s = terminalScenario(name);
    s.state.events = objects(s.state.events).filter(event => event.type !== "request_finished")
      .map((event, index) => ({ ...event, seq: index + 1 }));
    s.state.next_after = objects(s.state.events).length;
    await expect(runProbe(s.backend, s.probe)).rejects.toThrow("request_finished");
  });
}
function pageScenario(s: { backend: IsolatedBackend }, size: number): void {
  const request = s.backend.request.bind(s.backend);
  s.backend.request = async (...args) => {
    const reply = await request(...args);
    const value = object(reply.body);
    if ("events" in value) {
      value.events = objects(value.events).slice(0, size);
      value.next_after = objects(value.events).at(-1)?.seq ?? value.next_after;
    }
    return reply;
  };
}
it("drains terminal history before requiring request_finished on a later page", async () => {
  const s = terminalScenario("fulfilled"); pageScenario(s, 7);
  await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
});
it("rejects duplicate request_finished events on separate terminal pages", async () => {
  const s = terminalScenario("fulfilled");
  const finished = objects(s.state.events).find(event => event.type === "request_finished"); assert(finished);
  s.state.events = [...objects(s.state.events), { ...finished, seq: objects(s.state.events).length + 1 }];
  s.state.next_after = objects(s.state.events).length;
  pageScenario(s, 1);
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("request_finished");
});
for (const name of ["fulfilled", "operational-error"]) {
  it.each(["validation", "validation_copy"])(`rejects phantom %s evidence before any validation in ${name}`, async kind => {
    const s = terminalScenario(name);
    const operation = { operation_id: "ef".repeat(32), kind, call_name: "synthetic-phantom-validation", state: "reconciled",
      reserved_microusd: 1000, settled_microusd: 1000, attempt_ordinal: 1 };
    s.evidence.operations = [...objects(s.evidence.operations), operation];
    s.evidence.provider_calls = [...objects(s.evidence.provider_calls), {
      call_name: operation.call_name, provider: "sandbox", action: "create", at: s.state.created_at,
    }];
    const budget = object(s.state.budget);
    budget.spent_microusd = integer(budget.spent_microusd) + 1000;
    budget.committed_microusd = integer(budget.committed_microusd) + 1000;
    budget.remaining_microusd = integer(budget.remaining_microusd) - 1000;
    const finalBudget = objects(s.state.events).findLast(event => event.type === "budget_updated"); assert(finalBudget);
    finalBudget.data = Object.fromEntries(["reserved_microusd", "spent_microusd", "remaining_microusd"].map(field => [field, budget[field]]));
    // Keep this independently consistent ledger defect focused on its own guard.
    const probe: Probe = { ...s.probe }; delete probe.expectedEvents;
    await expect(runProbe(s.backend, probe)).rejects.toThrow("before validation");
  });
}

it("rejects request progress after request_finished in complete history", async () => {
  const s = terminalScenario("fulfilled");
  const history = objects(s.state.events);
  const finished = history.find(event => event.type === "request_finished"); assert(finished);
  const progress = history.findLast(event => event.type === "case_delivered"); assert(progress);
  s.state.events = history.filter(event => event !== finished).flatMap(event => event === progress ? [finished, event] : [event])
    .map((event, index) => ({ ...event, seq: index + 1 }));
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("after request_finished");
});

it("rejects updated_at changing while draining terminal history", async () => {
  const s = terminalScenario("fulfilled");
  const request = s.backend.request.bind(s.backend);
  let changed = false;
  s.backend.request = async (...args) => {
    if (!changed && args[0] === "GET" && args[1].includes("?after=")) {
      changed = true;
      s.state.updated_at = new Date(Date.parse(text(s.state.updated_at)) + 1000).toISOString();
    }
    return request(...args);
  };
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("terminal result changed after completion");
});

it.each(["first-case", "other-case", "started", "finished"])("rejects pre-existing validation %s in a fresh paged request", async change => {
  const s = terminalScenario("fulfilled");
  const c = objects(s.state.cases)[change === "other-case" ? 1 : 0]; assert(c);
  const run = fixture("validation-failed"); run.case_id = c.case_id;
  run.package_sha256 = { bug_case: object(object(c.packages).bug_case).sha256, validator: object(object(c.packages).validator).sha256 };
  if (change.endsWith("case")) c.validation = run;
  else {
    const history = objects(s.state.events); const last = history.at(-1); assert(last);
    s.state.events = [...history, { ...last, seq: history.length + 1, type: `validation_${change}`,
      candidate_id: null, host_id: c.host_id, case_id: c.case_id, item_key: c.item_key,
      data: change === "started" ? { validation_id: run.validation_id } : { validation_id: run.validation_id, result: "failed" } }];
    s.state.next_after = history.length + 1;
  }
  // Start from an empty queued snapshot so a phantom validation first appears
  // with the completed case, without an unrelated case-retention violation.
  const request = s.backend.request.bind(s.backend);
  s.backend.request = async (...args) => {
    const reply = await request(...args);
    if (reply.status === 202) {
      const value = object(reply.body);
      const queued = fixture("status-queued");
      const replaced = object(JSON.parse(JSON.stringify(queued).replaceAll(text(queued.request_id), text(value.request_id))) as unknown);
      replaced.interpretation = value.interpretation;
      return { ...reply, body: replaced };
    }
    return reply;
  };
  pageScenario(s, 7);
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("before validation");
});

it.each(["missing-warning", "cleared-warning", "duplicate-warning", "late-warning", "early-warning", "early-loss"])("rejects worker-loss %s transition history", async change => {
  const s = terminalScenario("operational-error");
  const history = objects(s.state.events);
  const warning = history.find(event => event.type === "attention" && object(event.data).code === "worker_unresponsive"); assert(warning);
  const lost = history.find(event => event.type === "attention" && object(event.data).code === "needs_reconciliation"); assert(lost);
  const incomplete = history.find(event => event.type === "candidate_incomplete"); assert(incomplete);
  if (change === "missing-warning") s.state.events = history.filter(event => event !== warning);
  if (change === "cleared-warning") s.state.events = history.flatMap(event => event === warning ? [event, { ...event, type: "attention_cleared" }] : [event]);
  if (change === "duplicate-warning") s.state.events = history.flatMap(event => event === warning ? [event, structuredClone(event)] : [event]);
  if (change === "late-warning") s.state.events = history.filter(event => event !== warning).flatMap(event => event === incomplete ? [event, warning] : [event]);
  if (change === "early-warning") warning.at = new Date(Date.parse(text(s.state.last_heartbeat_at)) + 59_000).toISOString();
  if (change === "early-loss") lost.at = new Date(Date.parse(text(s.state.last_heartbeat_at)) + 179_000).toISOString();
  s.state.events = objects(s.state.events).map((event, index) => ({ ...event, seq: index + 1 })); s.state.next_after = objects(s.state.events).length;
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("worker-lost");
});
it("rejects completed check progress after an uncertain first create", async () => {
  const s = uncertainControl();
  const check = objects(fixture("status-operational-error").events).find(event => event.type === "check_finished"); assert(check);
  s.state.events = objects(s.state.events).flatMap(event => event.type === "candidate_incomplete" ? [check, event] : [event]);
  object(s.state.funnel).candidates_explored = 1;
  s.normalize();
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("uncertain-provider");
});

function replaceHistory(s: { state: Record<string, unknown> }, events: Record<string, unknown>[]): void {
  s.state.events = events.map((event, index) => ({ ...event, seq: index + 1 }));
  s.state.next_after = events.length;
}
it.each(["worker_started", "host_preparing", "host_ready", "candidate_selected", "check_finished", "package_ready", "case_delivered"])(
  "rejects missing %s history despite a correct fulfilled result and ledger", async type => {
    const s = terminalScenario("fulfilled");
    replaceHistory(s, objects(s.state.events).filter(event => event.type !== type));
    await expect(runProbe(s.backend, s.probe)).rejects.toThrow("transition");
  });
it.each(["zero-result", "wrong-failure", "cancelled", "operational-error"])("rejects missing checks behind the pinned %s outcome", async name => {
  const s = terminalScenario(name);
  const check = objects(s.state.events).find(event => event.type === "check_finished"); assert(check);
  replaceHistory(s, objects(s.state.events).filter(event => event !== check));
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("transition");
});
it.each(["exhausted", "duplicate-defect", "zero-result", "wrong-failure"])("rejects missing source exhaustion in %s", async name => {
  const s = terminalScenario(name);
  replaceHistory(s, objects(s.state.events).filter(event => event.type !== "source_exhausted"));
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("transition");
});
it.each(["copy", "outcome", "runs_valid", "runs_total"])("rejects an incorrect pinned check %s despite a qualified case", async field => {
  const s = terminalScenario("fulfilled");
  const event = objects(s.state.events).find(event => event.type === "check_finished"); assert(event);
  object(event.data)[field] = field === "copy" ? "buggy" : field === "outcome" ? "fail" : 2;
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("transition");
});
it.each(["source_id", "entry_id"])("rejects a candidate selection with the wrong %s", async field => {
  const s = terminalScenario("fulfilled");
  const event = objects(s.state.events).find(event => event.type === "candidate_selected"); assert(event);
  object(event.data)[field] = "synthetic-unrelated-entry";
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("transition");
});
it("rejects source exhaustion for an unrelated source", async () => {
  const s = terminalScenario("exhausted");
  const event = objects(s.state.events).find(event => event.type === "source_exhausted"); assert(event);
  object(event.data).source_id = "synthetic-unrelated-source";
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("transition");
});
it.each(["bug_case_sha256", "validator_sha256"])("rejects package_ready with an unrelated %s", async field => {
  const s = terminalScenario("fulfilled");
  const event = objects(s.state.events).find(event => event.type === "package_ready"); assert(event);
  object(event.data)[field] = "ab".repeat(32);
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("transition");
});
it.each(["checks", "behavior", "host-ready", "source-exhausted"])("rejects reordered %s transitions", async change => {
  const s = terminalScenario(change === "source-exhausted" ? "exhausted" : "fulfilled");
  const history = objects(s.state.events);
  const firstType = change === "checks" ? "check_finished" : change === "behavior" ? "behavior_checks_passed"
    : change === "host-ready" ? "host_ready" : "source_exhausted";
  const lastType = change === "checks" ? "check_finished" : change === "behavior" ? "check_finished" : "candidate_selected";
  const first = history.find(event => event.type === firstType); assert(first);
  const last = history.find(event => event.type === lastType && event !== first); assert(last);
  replaceHistory(s, history.map(event => event === first ? last : event === last ? first : event));
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("transition");
});
it("rejects duplicated selection events for one candidate", async () => {
  const s = terminalScenario("duplicate-defect");
  replaceHistory(s, objects(s.state.events).flatMap(event => event.type === "candidate_selected" ? [event, structuredClone(event)] : [event]));
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("transition");
});
it("accepts independent host preparation interleaving and generated package hashes", async () => {
  const s = terminalScenario("fulfilled");
  const history = objects(s.state.events);
  const preparing = history.filter(event => event.type === "host_preparing");
  const ready = history.filter(event => event.type === "host_ready");
  const first = preparing[0]; assert(first);
  const reordered = [...preparing, ...ready].sort((a, b) => text(a.host_id).localeCompare(text(b.host_id)));
  replaceHistory(s, history.flatMap(event => event === first ? reordered : [...preparing, ...ready].includes(event) ? [] : [event]));
  for (const c of objects(s.state.cases)) {
    const event = objects(s.state.events).find(event => event.type === "package_ready" && event.case_id === c.case_id); assert(event);
    object(object(c.packages).bug_case).sha256 = "ab".repeat(32);
    object(event.data).bug_case_sha256 = "ab".repeat(32);
  }
  await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
});
it.each(["missing", "late", "unbalanced", "wrong-final"])("rejects %s budget transitions despite a correct terminal ledger", async change => {
  const s = terminalScenario("fulfilled");
  const history = objects(s.state.events);
  const first = history.find(event => event.type === "budget_updated"); assert(first);
  const last = history.findLast(event => event.type === "budget_updated"); assert(last);
  if (change === "missing") replaceHistory(s, history.filter(event => event !== first));
  if (change === "late") {
    const selected = history.find(event => event.type === "candidate_selected"); assert(selected);
    replaceHistory(s, history.filter(event => event !== first).flatMap(event => event === selected ? [event, first] : [event]));
  }
  if (change === "unbalanced") object(first.data).remaining_microusd = 1;
  if (change === "wrong-final") {
    object(last.data).spent_microusd = integer(object(last.data).spent_microusd) - 1;
    object(last.data).remaining_microusd = integer(object(last.data).remaining_microusd) + 1;
  }
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("transition");
});
it.each(["omitted-reservation", "discounted-reservation", "omitted-settlement", "discounted-settlement", "premature-worker-settlement"])(
  "rejects %s in an intermediate budget event despite correct final totals", async change => {
    const s = terminalScenario("fulfilled");
    const budgets = objects(s.state.events).filter(event => event.type === "budget_updated");
    const event = budgets[change.endsWith("settlement") && change !== "premature-worker-settlement" ? 2 : 1]; assert(event);
    const data = object(event.data);
    if (change === "omitted-reservation") data.reserved_microusd = 200000;
    if (change === "discounted-reservation") data.reserved_microusd = 499999;
    if (change === "omitted-settlement") { data.reserved_microusd = 500000; data.spent_microusd = 0; }
    if (change === "discounted-settlement") data.spent_microusd = 299999;
    if (change === "premature-worker-settlement") { data.reserved_microusd = 300000; data.spent_microusd = 200000; }
    data.remaining_microusd = integer(object(s.state.budget).budget_microusd) - integer(data.reserved_microusd) - integer(data.spent_microusd);
    await expect(runProbe(s.backend, s.probe)).rejects.toThrow("transition");
  });
it("rejects ordinary attention history that disagrees with the terminal null attention", async () => {
  const s = terminalScenario("fulfilled");
  const history = objects(s.state.events); const last = history.at(-1); assert(last);
  replaceHistory(s, [...history, { ...last, type: "attention", data: { code: "needs_reconciliation" } }]);
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("attention history");
});
it("accepts ordinary attention history with a matching warning and recovery", async () => {
  const s = terminalScenario("fulfilled");
  const history = objects(s.state.events); const last = history.at(-1); assert(last);
  replaceHistory(s, [...history, { ...last, type: "attention", data: { code: "worker_unresponsive" } },
    { ...last, type: "attention_cleared", data: { code: "worker_unresponsive" } }]);
  await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
});
