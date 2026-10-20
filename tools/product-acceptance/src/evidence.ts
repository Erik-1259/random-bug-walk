import assert from "node:assert/strict";
import type { RequestStatus, TestEvidence } from "@rbw/factory-contract";

/** Independent accounting checks on the test endpoint, not proof from status alone. */
export function checkEvidence(evidence: TestEvidence, status: RequestStatus): void {
  assert.equal(evidence.request_id, status.request_id);
  const ids = evidence.operations.map(op => op.operation_id);
  assert.equal(new Set(ids).size, ids.length, "duplicate ledger operation");
  const operationCalls = evidence.operations.map(op => op.call_name);
  assert.equal(new Set(operationCalls).size, operationCalls.length, "duplicate operation call in deterministic scenario");
  assert.equal(evidence.operations.filter(op => op.kind === "worker").length, 1, "request must have one worker reservation");
  const creates = evidence.provider_calls.filter(call => call.action === "create");
  const calls = creates.map(call => call.call_name);
  assert.equal(new Set(calls).size, calls.length, "duplicate provider create in deterministic scenario");
  let reserved = 0;
  let spent = 0;
  for (const op of evidence.operations) {
    assert(Number.isSafeInteger(op.reserved_microusd) && op.reserved_microusd >= 0);
    if (op.kind === "candidate_copy") assert(op.reserved_microusd > 0, "candidate copy has no original reservation");
    if (op.kind === "worker") assert.equal(op.reserved_microusd, 200_000, "worker reservation differs from pinned test worst case");
    if (op.settled_microusd === null) {
      assert.notEqual(op.state, "reconciled", "reconciled operation has no settlement");
      reserved += op.reserved_microusd;
    } else {
      assert(Number.isSafeInteger(op.settled_microusd) && op.settled_microusd >= 0);
      const launched = calls.includes(op.call_name);
      assert.equal(op.settled_microusd, launched ? op.reserved_microusd : 0,
        launched ? "deterministic settlement differs from original worst case" : "never-launched reservation was charged");
      spent += op.settled_microusd;
    }
  }
  if (status.state === "finished") {
    // These named controls reserve a host's full candidate worst case before
    // execution. Skipped entries do not execute. Evidence has no structured
    // copy-to-candidate link, so this proves totals and launch bounds only.
    const executed = status.candidates.filter(candidate => candidate.stage !== "skipped");
    const expectedOriginal = executed.reduce((sum, candidate) => {
      assert(status.interpretation.input.hosts.includes(candidate.host_id), "unselected candidate host in execution evidence");
      const worst = { "task-report": 300_000, umami: 600_000 }[candidate.host_id];
      return sum + worst;
    }, 0);
    const copies = evidence.operations.filter(op => op.kind === "candidate_copy");
    assert.equal(copies.reduce((sum, op) => sum + op.reserved_microusd, 0), expectedOriginal,
      "candidate originals differ from executed host worst cases");
    const launched = copies.filter(op => calls.includes(op.call_name));
    assert(launched.length >= executed.length, "candidate execution has missing provider creates");
    if (executed.length > 0) {
      const worker = evidence.operations.find(op => op.kind === "worker"); assert(worker);
      assert(calls.includes(worker.call_name), "executed candidates have no worker create");
    }
    // The uncertain-provider control may release never-launched copies at zero.
    // Its terminal stop code survives reconciliation, while attention clears.
    if (status.stop_reason?.code !== "needs_reconciliation") {
      assert.equal(launched.length, copies.length, "ordinary candidate execution has unlaunched copies");
    }
  }
  assert.equal(reserved, status.budget.reserved_microusd, "held ledger amounts disagree with status");
  assert.equal(spent, status.budget.spent_microusd, "settled ledger amounts disagree with status");
  for (const call of evidence.provider_calls) assert(evidence.operations.some(op => op.call_name === call.call_name), "provider call without reservation");
  if (status.attention?.code === "needs_reconciliation") {
    assert.equal(evidence.slot.holder_request_id, status.request_id, "uncertain request lost its slot");
  }
}

/** The named reconciliation control settles held rows without creating new work. */
export function checkReconciledEvidence(before: TestEvidence, after: TestEvidence): void {
  assert.equal(after.contract_version, before.contract_version, "reconciliation changed evidence contract");
  assert.equal(after.request_id, before.request_id, "reconciliation changed evidence request");
  const ids = (evidence: TestEvidence) => evidence.operations.map(op => op.operation_id).sort();
  assert.deepEqual(ids(after), ids(before), "reconciliation changed operation identities");
  assert.equal(new Set(ids(after)).size, after.operations.length, "reconciliation duplicated an operation");
  for (const prior of before.operations) {
    const current = after.operations.find(op => op.operation_id === prior.operation_id); assert(current);
    const expected = prior.settled_microusd === null
      ? { ...prior, state: "reconciled", settled_microusd: prior.reserved_microusd }
      : prior;
    assert.deepEqual(current, expected, "reconciliation changed operation metadata or settlement");
  }
  const callKey = (call: TestEvidence["provider_calls"][number]) => JSON.stringify([call.call_name, call.provider, call.action, call.at]);
  const creates = (evidence: TestEvidence) => evidence.provider_calls.filter(call => call.action === "create").map(callKey).sort();
  assert.deepEqual(creates(after), creates(before), "reconciliation changed provider creates");
  // Call order is not specified. Retain every existing record; cleanup may add
  // stop calls for known operations, but it cannot erase earlier evidence.
  const remaining = after.provider_calls.map(callKey);
  for (const call of before.provider_calls) {
    const index = remaining.indexOf(callKey(call));
    assert(index >= 0, "reconciliation lost prior provider evidence");
    remaining.splice(index, 1);
  }
  for (const call of after.provider_calls) {
    assert(after.operations.some(op => op.call_name === call.call_name), "reconciliation recorded a provider call without an operation");
  }
}
