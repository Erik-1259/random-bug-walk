export function identity(n = 1) {
  const hash = n.toString(16).padStart(64, "0");
  const uuid = "00000000-0000-4000-8000-000000000001";
  return {
    operation_id: hash, payload_hash: hash, attempt_ordinal: 1, previous_operation_id: null,
    project_id: uuid, project_policy_sha256: hash, batch_id: null, task_revision: hash,
    root_execution_id: uuid, execution_id: uuid, parent_execution_id: null,
    kind: "synthetic-operation", call_name: "synthetic-call", provider: "synthetic-provider",
    provider_replay_key: null, pool_key: "synthetic-pool", allocation_key: null,
  };
}
