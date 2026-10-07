// Spec §6.1's four serial-run checks, written once and run against PGlite by the unit tests and
// against the Postgres in DATABASE_URL by the integration tests.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { Docker } from "@rbw/local-runner";
import { runJob } from "../../src/controller.ts";
import { FakeDocker, failed } from "../../../local-runner/test/support/fakes.ts";
import { jobInputs } from "./harness.ts";
import type { LedgerCall, World, WorldOptions } from "./harness.ts";

export type MakeWorld = (options?: WorldOptions) => Promise<World>;

function written(calls: readonly LedgerCall[]): string[] {
  return calls.filter((call) => !call.method.endsWith("Status")).map((call) => call.method);
}

async function holder(w: World): Promise<string | null> {
  const status = await w.spend.slotStatus({ slot_key: "development" });
  if (!status.ok) throw new Error("synthetic: no slot status");
  return status.holder;
}

async function replayCreatesNoSecondJob(world: MakeWorld): Promise<void> {
  const w = await world();
  const inputs = jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"] });
  const first = await runJob(inputs, w.deps);
  expect(first.status).toBe("complete");
  const calls = w.ledgerCalls.length;
  const sdkCalls = w.sdk.calls.length;
  const before = await w.spend.poolStatus({ pool_key: "development" });
  const again = await runJob(inputs, w.deps);
  expect(again.replay).toBe(true);
  expect(again.summary).toEqual(first.summary);
  expect(again.exitCode).toBe(first.exitCode);
  expect(written(w.ledgerCalls.slice(calls))).toEqual([]);
  expect(w.sdk.calls.length).toBe(sdkCalls);
  expect(await w.spend.poolStatus({ pool_key: "development" })).toEqual(before);
}

async function uncertainLaunchHoldsSlotAndReservation(world: MakeWorld): Promise<void> {
  const w = await world({ sandbox: { afterStop: ["stopping"] } });
  const inputs = jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"] });
  const outcome = await runJob(inputs, w.deps);
  expect(outcome.status).toBe("needs_reconciliation");
  const [copy] = outcome.summary.copies;
  expect(copy).toMatchObject({ launch: "uncertain", ledger_state: "uncertain", stop_confirmed: false });
  expect(copy?.child_resource_id).toMatch(/-kit-check-clean-01$/);
  expect(await holder(w)).toBe(outcome.summary.job.root_execution_id);
  const status = await w.spend.slotStatus({ slot_key: "development" });
  expect(status.ok && status.release_blockers.child_resources.map((child) => child.resource_id)).toEqual([copy?.child_resource_id]);
  expect(await w.spend.operationStatus({ operation_id: copy?.operation_id ?? "" })).toMatchObject({ state: "uncertain", open_microusd: 147_682n });
  const again = await runJob(inputs, w.deps);
  expect(again).toMatchObject({ replay: true, status: "needs_reconciliation" });
  expect(await holder(w)).toBe(outcome.summary.job.root_execution_id);
}

/** The copy container's removal fails, so its termination is not confirmed. */
function removalFails(inner: Docker): Docker {
  return new FakeDocker((args, options) => (args[0] === "rm" && String(args.at(-1)).endsWith("-kit-check-clean-01") ? failed(1) : inner.run(args, options)));
}

async function reconciliationKeepsResult(world: MakeWorld): Promise<void> {
  // On Docker, so the copy's record set is the real driver's and imports as a complete trial.
  const w = await world({ docker: removalFails });
  const inputs = jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"], backend: "docker", sandboxImage: null });
  const outcome = await runJob(inputs, w.deps);
  expect(outcome.status).toBe("needs_reconciliation");
  const [copy] = outcome.summary.copies;
  expect(copy).toMatchObject({ status: "complete", launch: "uncertain", ledger_state: "uncertain" });
  const result = { trial_id: "clean-01", status: "complete", added_verdict: "match", original_failed: 0 };
  expect(outcome.summary.import.trials.find((trial) => trial.trial_id === "clean-01")).toMatchObject(result);
  const evidenceBefore = readFileSync(join(outcome.jobDir, "evidence.json"));
  const operationId = copy?.operation_id ?? "";
  const evidence = [{ key: "synthetic/provider-listing.json", sha256: "c".repeat(64) }];
  const reconciled = await w.spend.reconcile({
    schema_version: 1,
    operation_id: operationId,
    previous_state: "uncertain",
    evidence,
    provider_resource_ids: [copy?.child_resource_id ?? ""],
    recorded_at: "2026-10-06T10:00:00Z",
    actor_role: "operator",
    decision: "accept_complete",
    retained_microusd: 50_000,
    released_microusd: 97_682,
    reason: "synthetic: the provider listing shows the sandbox stopped after the copy completed",
  });
  expect(reconciled).toMatchObject({ ok: true, state: "reconciled" });
  const released = await w.spend.releaseSlot({
    slot_key: "development",
    root_execution_id: outcome.summary.job.root_execution_id,
    actor_role: "operator",
    evidence,
    reason: "synthetic: every child is confirmed terminal",
  });
  expect(released.ok).toBe(true);
  const again = await runJob(inputs, w.deps);
  expect(again.replay).toBe(true);
  expect(again.summary.copies[0]).toMatchObject({ trial_id: "clean-01", status: "complete" });
  expect(again.summary.import).toEqual(outcome.summary.import);
  expect(again.summary.import.trials.find((trial) => trial.trial_id === "clean-01")).toMatchObject(result);
  expect(readFileSync(join(outcome.jobDir, "evidence.json"))).toEqual(evidenceBefore);
  expect(existsSync(join(outcome.jobDir, "records", "results", "clean-01"))).toBe(true);
  expect(await w.spend.operationStatus({ operation_id: operationId })).toMatchObject({ state: "reconciled", settled_microusd: 50_000n });
  expect(w.kit.created.filter((name) => name.endsWith("-kit-check-clean-01"))).toHaveLength(1);
}

async function releaseOnlyAfterConfirmedStop(world: MakeWorld): Promise<void> {
  const unconfirmed = await world({ sandbox: { afterStop: ["stopping"] } });
  await runJob(jobInputs(unconfirmed, { kind: "kit_check", name: "kit-check", trials: ["clean-01"] }), unconfirmed.deps);
  expect(written(unconfirmed.ledgerCalls)).not.toContain("confirmChild");
  expect(written(unconfirmed.ledgerCalls)).not.toContain("releaseSlot");
  expect(await holder(unconfirmed)).not.toBeNull();

  const confirmed = await world({ sandbox: { afterStop: ["stopping", "stopped"] } });
  await runJob(jobInputs(confirmed, { kind: "kit_check", name: "kit-check", trials: ["clean-01"] }), confirmed.deps);
  const names = written(confirmed.ledgerCalls);
  expect(names.indexOf("confirmChild")).toBeGreaterThan(-1);
  expect(names.indexOf("confirmChild")).toBeLessThan(names.indexOf("releaseSlot"));
  expect(names.at(-1)).toBe("releaseSlot");
  const confirm = confirmed.ledgerCalls.find((call) => call.method === "confirmChild");
  expect(confirm?.sdkCalls).toBe(confirmed.sdk.calls.length);
  expect(await holder(confirmed)).toBeNull();
}

export const SERIAL_CHECKS: Record<string, (world: MakeWorld) => Promise<void>> = {
  "replaying the same job request creates no second job and returns the existing one": replayCreatesNoSecondJob,
  "an uncertain launch holds its slot and its reservation, also on replay": uncertainLaunchHoldsSlotAndReservation,
  "manual reconciliation of a completed copy keeps its result": reconciliationKeepsResult,
  "stop releases the slot only after termination is confirmed": releaseOnlyAfterConfirmedStop,
};
