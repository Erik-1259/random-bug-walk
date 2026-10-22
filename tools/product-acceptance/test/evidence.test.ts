import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { RequestStatus, TestEvidence } from "@rbw/factory-contract";
import { checkEvidence } from "../src/evidence.ts";
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
}
function first<T>(values: T[]): T { const value = values[0]; assert(value); return value; }
function sample() { return { evidence: fixture("test-evidence") as TestEvidence, status: fixture("status-operational-error") as RequestStatus }; }
it("reconciles the published held ledger evidence with the request", () => {
  const { evidence, status } = sample(); expect(() => { checkEvidence(evidence, status); }).not.toThrow();
});
for (const [name, mutate] of [
  ["wrong request", (e: TestEvidence) => { e.request_id = "synthetic-other"; }],
  ["duplicate reservation", (e: TestEvidence) => { e.operations.push(structuredClone(first(e.operations))); }],
  ["duplicate provider create", (e: TestEvidence) => { e.provider_calls.push(structuredClone(first(e.provider_calls))); }],
  ["missing reservation", (e: TestEvidence) => { e.operations.pop(); }],
  ["wrong holder", (e: TestEvidence) => { e.slot.holder_request_id = null; }],
  ["extra worker", (e: TestEvidence) => { const op = structuredClone(first(e.operations)); op.operation_id = "ab".repeat(32); e.operations.push(op); }],
] as const) it(`rejects ${name}`, () => {
  const { evidence, status } = sample(); mutate(evidence); expect(() => { checkEvidence(evidence, status); }).toThrow();
});
it("uses settled costs rather than original reservations after reconciliation", () => {
  const { evidence, status } = sample();
  for (const op of evidence.operations) { op.state = "reconciled"; op.settled_microusd = op.reserved_microusd; }
  evidence.slot.holder_request_id = null;
  status.attention = null;
  status.budget.reserved_microusd = 0;
  status.budget.spent_microusd = 500000;
  expect(() => { checkEvidence(evidence, status); }).not.toThrow();
});
it("reads evidence through the public test control after isolation verification", async () => {
  const { runEvidence, contractRevision } = await import("../src/runner.ts");
  const { evidence, status } = sample();
  const calls: string[] = [];
  await runEvidence({
    verifyIsolation: () => { calls.push("verify"); return Promise.resolve({ backendRevision: "a".repeat(40), contractRevision }); },
    request: (method, path) => { calls.push(`${method} ${path}`); return Promise.resolve({ status: 200, body: evidence }); },
    reconnect: () => Promise.resolve(), wait: () => Promise.resolve(),
  }, status);
  expect(calls).toEqual(["verify", `GET /api/factory/test/evidence?request_id=${status.request_id}`]);
});

it.each(["zeroed-original", "discounted-settlement", "wrong-worker-worst-case"])("rejects internally consistent %s deterministic evidence", change => {
  const { evidence, status } = sample();
  for (const op of evidence.operations) {
    op.state = "reconciled";
    op.settled_microusd = op.reserved_microusd;
    if (change === "zeroed-original") op.reserved_microusd = 0;
    if (change === "discounted-settlement") op.settled_microusd /= 2;
    if (change === "wrong-worker-worst-case" && op.kind === "worker") {
      op.reserved_microusd /= 2; op.settled_microusd = op.reserved_microusd;
    }
  }
  evidence.slot.holder_request_id = null;
  status.attention = null;
  status.budget.reserved_microusd = 0;
  status.budget.spent_microusd = evidence.operations.reduce((sum, op) => sum + (op.settled_microusd ?? 0), 0);
  status.budget.committed_microusd = status.budget.spent_microusd;
  status.budget.remaining_microusd = status.budget.budget_microusd - status.budget.committed_microusd;
  expect(() => { checkEvidence(evidence, status); }).toThrow();
});
it.each(["held", "settled"])("rejects zero original candidate reservations with internally consistent %s accounting", state => {
  const { evidence, status } = sample();
  for (const op of evidence.operations) {
    if (op.kind === "candidate_copy") op.reserved_microusd = 0;
    if (state === "settled") { op.state = "reconciled"; op.settled_microusd = op.reserved_microusd; }
  }
  status.budget.reserved_microusd = state === "held" ? 200000 : 0;
  status.budget.spent_microusd = state === "settled" ? 200000 : 0;
  status.budget.committed_microusd = 200000;
  status.budget.remaining_microusd = status.budget.budget_microusd - 200000;
  if (state === "settled") { evidence.slot.holder_request_id = null; status.attention = null; }
  expect(() => { checkEvidence(evidence, status); }).toThrow("candidate copy has no original reservation");
});
it.each(["unused-released", "unused-charged", "launched-discounted"])("checks deterministic settlement for %s operations", change => {
  const { evidence, status } = sample();
  assert(status.stop_reason); status.stop_reason.code = "needs_reconciliation";
  const candidate = first(evidence.operations.filter(op => op.kind === "candidate_copy"));
  evidence.provider_calls = evidence.provider_calls.filter(call => call.call_name === "worker" || call.call_name === candidate.call_name);
  for (const op of evidence.operations) {
    op.state = "reconciled";
    const launched = evidence.provider_calls.some(call => call.action === "create" && call.call_name === op.call_name);
    op.settled_microusd = launched || change === "unused-charged" ? op.reserved_microusd : 0;
    if (change === "launched-discounted" && op.call_name === candidate.call_name) op.settled_microusd /= 2;
  }
  evidence.slot.holder_request_id = null;
  status.attention = null;
  status.budget.reserved_microusd = 0;
  status.budget.spent_microusd = evidence.operations.reduce((sum, op) => sum + (op.settled_microusd ?? 0), 0);
  status.budget.committed_microusd = status.budget.spent_microusd;
  status.budget.remaining_microusd = status.budget.budget_microusd - status.budget.committed_microusd;
  if (change === "unused-released") expect(() => { checkEvidence(evidence, status); }).not.toThrow();
  else expect(() => { checkEvidence(evidence, status); }).toThrow();
});
it.each(["held", "settled"])("rejects two operations sharing one provider call with consistent %s accounting", state => {
  const { evidence, status } = sample();
  const duplicate = structuredClone(first(evidence.operations.filter(op => op.kind === "candidate_copy")));
  duplicate.operation_id = "ef".repeat(32);
  evidence.operations.push(duplicate);
  if (state === "settled") {
    for (const op of evidence.operations) { op.state = "reconciled"; op.settled_microusd = op.reserved_microusd; }
    evidence.slot.holder_request_id = null;
    status.attention = null;
  }
  const total = evidence.operations.reduce((sum, op) => sum + op.reserved_microusd, 0);
  status.budget.reserved_microusd = state === "held" ? total : 0;
  status.budget.spent_microusd = state === "settled" ? total : 0;
  status.budget.committed_microusd = total;
  status.budget.remaining_microusd = status.budget.budget_microusd - total;
  expect(new Set(evidence.operations.map(op => op.operation_id)).size).toBe(evidence.operations.length);
  expect(evidence.provider_calls.filter(call => call.action === "create" && call.call_name === duplicate.call_name)).toHaveLength(1);
  expect(() => { checkEvidence(evidence, status); }).toThrow("duplicate operation call in deterministic scenario");
});
