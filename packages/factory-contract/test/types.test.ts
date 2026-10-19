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
  RequestOutcome,
  RequestStatus,
  TestEvidence,
  TestOperationState,
} from "../src/index.ts";
import { DEF_NAMES, HOST_ID_VALUES } from "../src/index.ts";
import { assertContract } from "../src/validate.ts";
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

  it("types the adapter and runner interfaces over the generated shapes", async () => {
    const collected = assertContract("CollectedCopy", internalFixture("collected-copy.json"));
    const record = assertContract("CopyRecord", internalFixture("copy-record.json"));
    const roots = assertContract("CopyRoots", { app_root: "/work/synthetic/pair/buggy", evaluator_root: "/work/synthetic/pair/evaluator" });
    const runner: CopyRunner = { run: (plan) => Promise.resolve({ ...collected, copy_id: plan.copy_id }) };
    const collect: HostAdapter["collect"] = (plan, copy) =>
      Promise.resolve({ ...record, copy_id: plan.copy_id, state: plan.state, evidence_sha256: copy.results_sha256 ?? record.evidence_sha256 });
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
    expect(collectedRecord.evidence_sha256).toBe(collected.results_sha256);
    expectTypeOf<HostAdapter["availability"]>().toBeNullable();
    expectTypeOf<ReturnType<HostAdapter["interpret"]>["verification"]["observed"]>().toEqualTypeOf<
      "pass" | "fail" | "error" | "incomplete"
    >();
  });
});
