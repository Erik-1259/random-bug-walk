import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { contractRevision, runAcceptance, runProbe, type IsolatedBackend, type Reply } from "../src/runner.ts";
import { integer, object, objects, text } from "../src/invariants.ts";
const fixture = (name: string) => object(JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8")) as unknown);

// Static transport responses prove rejection behavior, not product acceptance.
function terminalScenario(name: string) {
  const expected = fixture(`status-${name}`);
  const state = structuredClone(expected);
  const interpretation = structuredClone(object(expected.interpretation));
  const evidence = fixture("test-evidence");
  const held = state.attention !== null;
  for (const op of objects(evidence.operations)) {
    op.state = held ? "uncertain" : "reconciled";
    op.settled_microusd = held ? null : op.reserved_microusd;
  }
  Object.assign(object(state.budget), { reserved_microusd: held ? 500000 : 0, spent_microusd: held ? 0 : 500000,
    committed_microusd: 500000, remaining_microusd: integer(object(state.budget).budget_microusd) - 500000 });
  object(evidence.slot).holder_request_id = held ? expected.request_id : null;
  let id = text(expected.request_id); let starts = 0;
  const replaceId = (value: unknown) => object(JSON.parse(JSON.stringify(value).replaceAll(text(expected.request_id), id)) as unknown);
  const backend: IsolatedBackend = {
    verifyIsolation: () => Promise.resolve({ backendRevision: "a".repeat(40), contractRevision }),
    wait: () => Promise.resolve(), reconnect: () => Promise.resolve(),
    request: (method, path, payload): Promise<Reply> => {
      if (path.endsWith("/test/reset")) return Promise.resolve({ status: 204, body: null });
      if (path.endsWith("/interpretations")) return Promise.resolve({ status: 200, body: interpretation });
      if (method === "POST") { id = text(object(payload).request_id); return Promise.resolve({ status: ++starts === 1 ? 202 : 200, body: replaceId(state) }); }
      if (path.includes("/test/evidence?")) return Promise.resolve({ status: 200, body: { ...replaceId(evidence), request_id: id } });
      const page = replaceId(state); const cursor = Number(path.split("?after=")[1] ?? 0);
      page.events = objects(page.events).filter(event => integer(event.seq) > cursor);
      page.next_after = objects(page.events).at(-1)?.seq ?? cursor;
      return Promise.resolve({ status: 200, body: page });
    },
  };
  const probe = { scenario: name, input: object(object(expected.interpretation).input), outcome: text(expected.outcome),
    stopCode: text(object(expected.stop_reason).code), expectedDelivery: text(expected.delivery),
    expectedItems: objects(object(expected.interpretation).items), expectedCounts: objects(expected.items),
    expectedInterpretation: object(expected.interpretation), expectedFunnel: object(expected.funnel),
    expectedCandidates: objects(expected.candidates), expectedAttention: expected.attention === null ? null : text(object(expected.attention).code), evidence: true };
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
  Object.assign(object(s.state.budget), { reserved_microusd: 200000, spent_microusd: 300000 });
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("terminal request left held spend");
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
