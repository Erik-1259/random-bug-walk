import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RequestStatus, TestEvidence, TestOperation } from "@rbw/factory-contract";
import { expect, it } from "vitest";
import { checkEvidence } from "../src/evidence.ts";

function scenario(name: string, uncertainProvider = false) {
  const status = JSON.parse(readFileSync(new URL(`../fixtures/status-${name}.json`, import.meta.url), "utf8")) as RequestStatus;
  if (uncertainProvider) { assert(status.stop_reason); status.stop_reason.code = "needs_reconciliation"; }
  const held = status.attention !== null;
  const operations: TestOperation[] = [{ operation_id: "01".repeat(32), kind: "worker", call_name: "synthetic-worker",
    state: held && !uncertainProvider ? "uncertain" : "terminal", reserved_microusd: 200_000,
    settled_microusd: held && !uncertainProvider ? null : 200_000, attempt_ordinal: 1 }];
  for (const candidate of status.candidates.filter(candidate => candidate.stage !== "skipped")) {
    const worst = candidate.host_id === "task-report" ? 300_000 : 600_000;
    for (let copy = 0; copy < 3; copy++) {
      const ordinal = operations.length + 1;
      const unused = uncertainProvider && copy > 0;
      operations.push({ operation_id: ordinal.toString(16).padStart(64, "0"), kind: "candidate_copy",
        call_name: `synthetic-opaque-call-${String(ordinal)}`, state: held && !unused ? "uncertain" : "terminal",
        reserved_microusd: worst / 3, settled_microusd: unused ? 0 : held ? null : worst / 3, attempt_ordinal: 1 });
    }
  }
  const evidence: TestEvidence = { contract_version: "bug-request/1", request_id: status.request_id, operations,
    slot: { slot_key: "factory", holder_request_id: held ? status.request_id : null, holder_validation_id: null },
    provider_calls: operations.filter(operation => operation.settled_microusd !== 0)
      .map(operation => ({ call_name: operation.call_name, provider: "sandbox", action: "create", at: status.created_at })),
  };
  account(evidence, status);
  return { evidence, status };
}
function account(evidence: TestEvidence, status: RequestStatus) {
  const held = evidence.operations.filter(op => op.settled_microusd === null).reduce((sum, op) => sum + op.reserved_microusd, 0);
  const spent = evidence.operations.reduce((sum, op) => sum + (op.settled_microusd ?? 0), 0);
  Object.assign(status.budget, { reserved_microusd: held, spent_microusd: spent, committed_microusd: held + spent,
    remaining_microusd: status.budget.budget_microusd - held - spent, overrun: held + spent > status.budget.budget_microusd });
}
function remove(evidence: TestEvidence, operation: TestOperation) {
  evidence.operations = evidence.operations.filter(op => op.operation_id !== operation.operation_id);
  evidence.provider_calls = evidence.provider_calls.filter(call => call.call_name !== operation.call_name);
}

it.each(["fulfilled", "zero-result", "duplicate-defect", "partial-budget", "cancelled", "operational-error"])("accounts for executed and skipped candidates in %s", name => {
  const { evidence, status } = scenario(name);
  expect(() => { checkEvidence(evidence, status); }).not.toThrow();
});
it.each(["all", "one", "host", "discounted", "extra"])("rejects %s candidate reservations with mutually consistent totals", change => {
  const { evidence, status } = scenario("fulfilled");
  const copies = evidence.operations.filter(op => op.kind === "candidate_copy");
  const first = copies[0]; assert(first);
  if (change === "all") for (const op of copies) remove(evidence, op);
  if (change === "one") remove(evidence, first);
  if (change === "host") for (const op of copies.slice(3)) remove(evidence, op);
  if (change === "discounted") for (const op of copies) { op.reserved_microusd /= 2; op.settled_microusd = op.reserved_microusd; }
  if (change === "extra") {
    const extra = { ...first, operation_id: "ab".repeat(32), call_name: "synthetic-extra-copy" };
    evidence.operations.push(extra);
    evidence.provider_calls.push({ call_name: extra.call_name, provider: "sandbox", action: "create", at: status.created_at });
  }
  account(evidence, status);
  expect(() => { checkEvidence(evidence, status); }).toThrow(/candidate/);
});
it.each(["all", "one"])("rejects %s unlaunched candidate copies after ordinary execution", change => {
  const { evidence, status } = scenario("fulfilled");
  const copies = evidence.operations.filter(op => op.kind === "candidate_copy");
  for (const op of change === "one" ? copies.slice(0, 1) : copies) {
    evidence.provider_calls = evidence.provider_calls.filter(call => call.call_name !== op.call_name);
    op.settled_microusd = 0;
  }
  account(evidence, status);
  expect(() => { checkEvidence(evidence, status); }).toThrow(/candidate/);
});
it("requires worker launch evidence when candidates executed", () => {
  const { evidence, status } = scenario("fulfilled");
  const worker = evidence.operations.find(op => op.kind === "worker"); assert(worker);
  evidence.provider_calls = evidence.provider_calls.filter(call => call.call_name !== worker.call_name);
  worker.settled_microusd = 0; account(evidence, status);
  expect(() => { checkEvidence(evidence, status); }).toThrow(/worker/);
});
it.each([false, true])("preserves unused uncertain-provider originals after reconciliation=%s", reconciled => {
  const { evidence, status } = scenario("operational-error", true);
  if (reconciled) {
    for (const op of evidence.operations.filter(op => op.settled_microusd === null)) { op.state = "reconciled"; op.settled_microusd = op.reserved_microusd; }
    status.attention = null; evidence.slot.holder_request_id = null; account(evidence, status);
  }
  expect(() => { checkEvidence(evidence, status); }).not.toThrow();
});
it.each(["unused-original", "only-create"])("rejects missing uncertain-provider %s despite consistent accounting", change => {
  const { evidence, status } = scenario("operational-error", true);
  if (change === "unused-original") {
    const unused = evidence.operations.find(op => op.kind === "candidate_copy" && op.settled_microusd === 0); assert(unused); remove(evidence, unused);
  } else {
    evidence.provider_calls = evidence.provider_calls.filter(call => evidence.operations.some(op => op.kind === "worker" && op.call_name === call.call_name));
    for (const op of evidence.operations.filter(op => op.kind === "candidate_copy")) { op.state = "terminal"; op.settled_microusd = 0; }
  }
  account(evidence, status);
  expect(() => { checkEvidence(evidence, status); }).toThrow(/candidate/);
});
it("does not infer structured candidate associations from opaque call names", () => {
  const { evidence, status } = scenario("fulfilled");
  for (const [index, op] of evidence.operations.entries()) {
    const call = evidence.provider_calls.find(call => call.call_name === op.call_name); assert(call);
    op.call_name = `synthetic-renamed-${String(index)}`; call.call_name = op.call_name;
  }
  expect(() => { checkEvidence(evidence, status); }).not.toThrow();
});
it("rejects a provider stop without a recorded operation", () => {
  const { evidence, status } = scenario("fulfilled");
  evidence.provider_calls.push({ call_name: "synthetic-unreserved-stop", provider: "sandbox", action: "stop", at: status.created_at });
  expect(() => { checkEvidence(evidence, status); }).toThrow(/provider call/);
});
it("rejects an unselected candidate host with matching higher reservations", () => {
  const { evidence, status } = scenario("operational-error", true);
  for (const candidate of status.candidates) candidate.host_id = "umami";
  for (const op of evidence.operations.filter(op => op.kind === "candidate_copy")) op.reserved_microusd *= 2;
  account(evidence, status);
  expect(() => { checkEvidence(evidence, status); }).toThrow(/unselected candidate host/);
});

it.each(["fulfilled", "zero-result", "duplicate-defect", "partial-budget", "cancelled", "operational-error"])("rejects collapsed copy identities in %s with unchanged original totals", name => {
  const { evidence, status } = scenario(name);
  const copies = evidence.operations.filter(op => op.kind === "candidate_copy").slice(0, 3);
  const first = copies[0]; assert(first);
  first.reserved_microusd = copies.reduce((sum, op) => sum + op.reserved_microusd, 0);
  if (first.settled_microusd !== null) first.settled_microusd = first.reserved_microusd;
  for (const op of copies.slice(1)) remove(evidence, op);
  account(evidence, status);
  expect(() => { checkEvidence(evidence, status); }).toThrow("candidate copy count differs from executed candidates");
});
it.each([false, true])("rejects collapsed uncertain-provider copies after reconciliation=%s", reconciled => {
  const { evidence, status } = scenario("operational-error", true);
  const copies = evidence.operations.filter(op => op.kind === "candidate_copy");
  const launched = copies.find(op => op.settled_microusd === null); assert(launched);
  launched.reserved_microusd = copies.reduce((sum, op) => sum + op.reserved_microusd, 0);
  for (const op of copies.filter(op => op !== launched)) remove(evidence, op);
  if (reconciled) {
    launched.state = "reconciled"; launched.settled_microusd = launched.reserved_microusd;
    status.attention = null; evidence.slot.holder_request_id = null;
  }
  account(evidence, status);
  expect(() => { checkEvidence(evidence, status); }).toThrow("candidate copy count differs from executed candidates");
});
it("rejects extra copy identities with conserved original reservations and settlements", () => {
  const { evidence, status } = scenario("fulfilled");
  const first = evidence.operations.find(op => op.kind === "candidate_copy"); assert(first);
  first.reserved_microusd /= 2; first.settled_microusd = first.reserved_microusd;
  const extra = { ...first, operation_id: "bc".repeat(32), call_name: "synthetic-split-copy" };
  evidence.operations.push(extra);
  evidence.provider_calls.push({ call_name: extra.call_name, provider: "sandbox", action: "create", at: status.created_at });
  account(evidence, status);
  expect(() => { checkEvidence(evidence, status); }).toThrow("candidate copy count differs from executed candidates");
});
it.each(["operation_id", "call_name"] as const)("rejects repeated candidate %s with the full row count", field => {
  const { evidence, status } = scenario("fulfilled");
  const copies = evidence.operations.filter(op => op.kind === "candidate_copy");
  const first = copies[0]; const second = copies[1]; assert(first && second);
  second[field] = first[field];
  expect(() => { checkEvidence(evidence, status); }).toThrow(/duplicate (ledger operation|operation call)/);
});
