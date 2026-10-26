import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CandidateEndedData,
  CatalogEntry,
  CheckFinishedData,
  CollectedCopy,
  CopyPlan,
  CopyRecord,
  CopyRoots,
  CopyRunner,
  Criterion,
  EmptyObject,
  Event,
  HostAdapter,
  HostId,
  RequestOutcome,
  RequestStatus,
  TestEvidence,
  TestOperationState,
  TestScenario,
} from "../src/index.ts";
import { DEF_NAMES, HOST_ID_VALUES, TEST_SCENARIO_VALUES } from "../src/index.ts";
import { assertContract, validateContract } from "../src/validate.ts";
import { contractFixture, internalFixture } from "./support.ts";

/** Reads an event's data through the type discriminant, as a client would. */
function describeEvent(event: Event): string {
  switch (event.type) {
    case "check_finished":
      expectTypeOf(event.data).toEqualTypeOf<CheckFinishedData>();
      return `${event.data.check_set}/${event.data.copy}: ${event.data.outcome}`;
    case "candidate_rejected":
    case "candidate_skipped":
      expectTypeOf(event.data).toEqualTypeOf<CandidateEndedData>();
      return event.data.reason;
    case "request_accepted":
      expectTypeOf(event.data).toEqualTypeOf<EmptyObject>();
      return "accepted";
    default:
      return event.type;
  }
}

describe("generated types", () => {
  it("narrows events by type", () => {
    const status = assertContract("RequestStatus", contractFixture("status-zero-result.json"));
    expectTypeOf(status).toEqualTypeOf<RequestStatus>();
    expectTypeOf(status.outcome).toEqualTypeOf<RequestOutcome | null>();
    const described = status.events.map(describeEvent);
    expect(described).toContain("accepted");
    expect(described).toContain("original_suite/buggy: fail");
    expect(described).toContain("original_suite_caught_bug");
  });

  it("exports the value lists and definition names at run time", () => {
    expect(HOST_ID_VALUES).toEqual(["umami", "task-report"]);
    expectTypeOf(HOST_ID_VALUES).toEqualTypeOf<readonly ["umami", "task-report"]>();
    expect(DEF_NAMES).toContain("QualificationRecord");
  });

  it("publishes failure codes on criteria, not on catalog entries, and types the test evidence", () => {
    expectTypeOf<Criterion["failure_code"]>().toEqualTypeOf<string>();
    expectTypeOf<CatalogEntry>().not.toHaveProperty("failure_code");
    const evidence = assertContract("TestEvidence", contractFixture("test-evidence.json"));
    expectTypeOf(evidence.operations[0]?.state).toEqualTypeOf<TestOperationState | undefined>();
    expectTypeOf(evidence).toEqualTypeOf<TestEvidence>();
    expect(evidence.operations.map((operation) => operation.state)).toEqual(["uncertain", "uncertain", "uncertain", "uncertain"]);
    expectTypeOf(evidence.slot.holder_validation_id).toEqualTypeOf<string | null>();
  });

  it("types the revision-3 test controls: execution identities, copy hosts and the setup-failed scenario", () => {
    const evidence = assertContract("TestEvidence", contractFixture("test-evidence.json"));
    expectTypeOf(evidence.root_execution_id).toEqualTypeOf<string>();
    expectTypeOf<TestEvidence["operations"][number]["execution_id"]>().toEqualTypeOf<string>();
    expectTypeOf<TestEvidence["operations"][number]["host_id"]>().toEqualTypeOf<HostId | null>();
    expectTypeOf<TestEvidence["provider_calls"][number]["execution_id"]>().toEqualTypeOf<string>();
    // The fixture's worker runs under the root execution with no host, and each provider call names its operation's execution.
    expect(evidence.operations.map((operation) => [operation.kind, operation.host_id])).toEqual([["worker", null], ["candidate_copy", "task-report"], ["candidate_copy", "task-report"], ["candidate_copy", "task-report"]]);
    expect(evidence.operations[0]?.execution_id).toBe(evidence.root_execution_id);
    expect(new Set(evidence.operations.map((operation) => operation.execution_id)).size).toBe(evidence.operations.length);
    const executionOf = new Map(evidence.operations.map((operation) => [operation.call_name, operation.execution_id]));
    for (const call of evidence.provider_calls) expect(call.execution_id, call.call_name).toBe(executionOf.get(call.call_name));
    expect(TEST_SCENARIO_VALUES).toHaveLength(12);
    expect(TEST_SCENARIO_VALUES.at(-1)).toBe("setup-failed");
    expectTypeOf<Extract<TestScenario, "setup-failed">>().toEqualTypeOf<"setup-failed">();
  });

  it("types the adapter and runner interfaces over the generated shapes", async () => {
    const collected = assertContract("CollectedCopy", internalFixture("collected-copy.json"));
    const setupFailed = assertContract("CollectedCopy", internalFixture("collected-copy-setup-failed.json"));
    const record = assertContract("CopyRecord", internalFixture("copy-record.json"));
    const notRun = assertContract("CopyRecord", internalFixture("copy-record-setup-failed.json"));
    const roots = assertContract("CopyRoots", { app_root: "/work/synthetic/pair/buggy", evaluator_root: "/work/synthetic/pair/evaluator" });
    const runner: CopyRunner = { run: (plan) => Promise.resolve({ ...collected, copy_id: plan.copy_id }) };
    // The collect convention: the evidence is the collected results hash, and a copy that did not run becomes
    // an invalid (setup_failed) or incomplete (timed_out) record.
    const collect: HostAdapter["collect"] = (plan, copy) =>
      Promise.resolve({
        ...(copy.outcome === "ran" ? record : notRun),
        copy_id: plan.copy_id,
        state: plan.state,
        status: copy.outcome === "ran" ? "complete" : copy.outcome === "setup_failed" ? "invalid" : "incomplete",
        evidence_sha256: copy.results_sha256,
      });
    const plan = assertContract("CopyPlan", internalFixture("copy-plan.json"));
    expectTypeOf(plan.destinations.results).toEqualTypeOf<string>();
    expectTypeOf<Parameters<CopyRunner["run"]>>().toEqualTypeOf<[CopyPlan, CopyRoots]>();
    expectTypeOf<Parameters<HostAdapter["collect"]>>().toEqualTypeOf<[CopyPlan, CollectedCopy]>();
    expectTypeOf<CollectedCopy["outcome"]>().toEqualTypeOf<"ran" | "setup_failed" | "timed_out">();
    const result = await runner.run(plan, roots);
    expectTypeOf(result).toEqualTypeOf<CollectedCopy>();
    expect(result.copy_id).toBe(plan.copy_id);
    const collectedRecord = await collect(plan, result);
    expectTypeOf(collectedRecord).toEqualTypeOf<CopyRecord>();
    expect(validateContract("CopyRecord", collectedRecord)).toEqual([]);
    expect(collectedRecord.evidence_sha256).toBe(collected.results_sha256);
    const failedRecord = await collect({ ...plan, copy_id: setupFailed.copy_id, state: "clean" }, setupFailed);
    expect(validateContract("CopyRecord", failedRecord)).toEqual([]);
    expect(failedRecord).toMatchObject({ copy_id: setupFailed.copy_id, status: "invalid", evidence_sha256: null });
    expectTypeOf<CopyRecord["evidence_sha256"]>().toEqualTypeOf<string | null>();
    expectTypeOf<HostAdapter["availability"]>().toBeNullable();
    expectTypeOf<ReturnType<HostAdapter["interpret"]>["verification"]["observed"]>().toEqualTypeOf<
      "pass" | "fail" | "error" | "incomplete"
    >();
  });
});
