import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TestEvidence, TestOperation } from "@rbw/factory-contract";
import { expect, it } from "vitest";
import * as evidenceChecks from "../src/evidence.ts";

function snapshots() {
  const before = JSON.parse(readFileSync(new URL("../fixtures/test-evidence.json", import.meta.url), "utf8")) as TestEvidence;
  const after = structuredClone(before);
  for (const operation of after.operations) {
    operation.state = "reconciled";
    operation.settled_microusd = operation.reserved_microusd;
  }
  after.slot.holder_request_id = null;
  return { before, after };
}
function candidate(evidence: TestEvidence): TestOperation {
  const operation = evidence.operations.find(op => op.kind === "candidate_copy"); assert(operation); return operation;
}

it("preserves every operation and provider call while settling held amounts", () => {
  const { before, after } = snapshots();
  expect(() => { evidenceChecks.checkReconciledEvidence(before, after); }).not.toThrow();
});

it("permits evidence ordering and cleanup stops without new provider creates", () => {
  const { before, after } = snapshots();
  after.operations.reverse(); after.provider_calls.reverse();
  const call = after.provider_calls[0]; assert(call);
  after.provider_calls.push({ ...call, action: "stop", at: "2026-10-20T20:00:00.000Z" });
  expect(() => { evidenceChecks.checkReconciledEvidence(before, after); }).not.toThrow();
});

it.each(["operation_id", "call_name", "kind", "attempt_ordinal"] as const)("rejects rewritten %s during reconciliation", field => {
  const { before, after } = snapshots();
  const op = candidate(after);
  if (field === "operation_id") op.operation_id = "ae".repeat(32);
  if (field === "call_name") op.call_name = "synthetic-replaced-call";
  if (field === "kind") op.kind = "validation_copy";
  if (field === "attempt_ordinal") op.attempt_ordinal = 2;
  expect(() => { evidenceChecks.checkReconciledEvidence(before, after); }).toThrow(/reconciliation/);
});

it("rejects redistributed originals even when total held-to-settled spend agrees", () => {
  const { before, after } = snapshots();
  const copies = after.operations.filter(op => op.kind === "candidate_copy");
  const first = copies[0]; const second = copies[1]; assert(first && second);
  first.reserved_microusd += 50_000; first.settled_microusd = first.reserved_microusd;
  second.reserved_microusd -= 50_000; second.settled_microusd = second.reserved_microusd;
  expect(after.operations.reduce((sum, op) => sum + (op.settled_microusd ?? 0), 0))
    .toBe(before.operations.reduce((sum, op) => sum + op.reserved_microusd, 0));
  expect(() => { evidenceChecks.checkReconciledEvidence(before, after); }).toThrow(/reconciliation/);
});

it.each(["missing", "extra", "duplicate"])("rejects %s operations after reconciliation", change => {
  const { before, after } = snapshots();
  if (change === "missing") after.operations.pop();
  else {
    const added = structuredClone(candidate(after));
    if (change === "extra") { added.operation_id = "af".repeat(32); added.call_name = "synthetic-extra-call"; }
    after.operations.push(added);
  }
  expect(() => { evidenceChecks.checkReconciledEvidence(before, after); }).toThrow(/reconciliation/);
});

it.each(["still-held", "not-reconciled", "redistributed-settlement"])("rejects %s reconciliation rows", change => {
  const { before, after } = snapshots();
  const op = candidate(after);
  if (change === "still-held") { op.state = "uncertain"; op.settled_microusd = null; }
  if (change === "not-reconciled") op.state = "terminal";
  if (change === "redistributed-settlement") {
    const other = after.operations.find(row => row.operation_id !== op.operation_id); assert(other);
    op.settled_microusd = op.reserved_microusd - 50_000;
    other.settled_microusd = other.reserved_microusd + 50_000;
  }
  expect(() => { evidenceChecks.checkReconciledEvidence(before, after); }).toThrow(/reconciliation/);
});

it.each(["unchanged", "changed-cost", "changed-state"])("preserves an already-settled operation: %s", change => {
  const { before, after } = snapshots();
  const prior = candidate(before);
  prior.state = "terminal"; prior.settled_microusd = prior.reserved_microusd;
  const current = candidate(after); Object.assign(current, prior);
  if (change === "changed-cost") current.settled_microusd = 0;
  if (change === "changed-state") current.state = "reconciled";
  const check = () => { evidenceChecks.checkReconciledEvidence(before, after); };
  if (change === "unchanged") expect(check).not.toThrow();
  else expect(check).toThrow(/reconciliation/);
});

it.each(["missing-create", "rewritten-time", "new-create", "missing-stop", "unknown-stop"])("rejects %s provider evidence across reconciliation", change => {
  const { before, after } = snapshots();
  const call = after.provider_calls[0]; assert(call);
  if (change === "missing-create") after.provider_calls.shift();
  if (change === "rewritten-time") call.at = "2026-10-20T20:00:00.000Z";
  if (change === "new-create") after.provider_calls.push({ ...call, call_name: "synthetic-new-create" });
  if (change === "missing-stop") before.provider_calls.push({ ...call, action: "stop" });
  if (change === "unknown-stop") after.provider_calls.push({ ...call, action: "stop", call_name: "synthetic-unknown-operation" });
  expect(() => { evidenceChecks.checkReconciledEvidence(before, after); }).toThrow(/reconciliation/);
});

it("rejects evidence for a different request", () => {
  const { before, after } = snapshots(); after.request_id = "00000000-0000-4000-8000-000000000999";
  expect(() => { evidenceChecks.checkReconciledEvidence(before, after); }).toThrow(/reconciliation/);
});
