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
      if (path.endsWith("/interpretations")) return Promise.resolve({ status: 200, body: expected.interpretation });
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
    expectedCandidates: objects(expected.candidates), expectedAttention: expected.attention === null ? null : text(object(expected.attention).code), evidence: true };
  return { state, evidence, backend, probe };
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
