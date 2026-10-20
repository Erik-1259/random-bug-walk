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
  assert.equal(reserved, status.budget.reserved_microusd, "held ledger amounts disagree with status");
  assert.equal(spent, status.budget.spent_microusd, "settled ledger amounts disagree with status");
  for (const call of creates) assert(evidence.operations.some(op => op.call_name === call.call_name), "provider create without reservation");
  if (status.attention?.code === "needs_reconciliation") {
    assert.equal(evidence.slot.holder_request_id, status.request_id, "uncertain request lost its slot");
  }
}
