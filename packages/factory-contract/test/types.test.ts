import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CandidateEndedData,
  CatalogEntry,
  CheckFinishedData,
  CopyPlan,
  CopyRecord,
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
  });

  it("types the adapter and runner interfaces over the generated shapes", async () => {
    const record = assertContract("CopyRecord", internalFixture("copy-record.json"));
    const runner: CopyRunner = { run: (plan: CopyPlan) => Promise.resolve({ ...record, copy_id: plan.copy_id }) };
    const plan = assertContract("CopyPlan", internalFixture("copy-plan.json"));
    const result = await runner.run(plan);
    expectTypeOf(result).toEqualTypeOf<CopyRecord>();
    expect(result.copy_id).toBe(plan.copy_id);
    expectTypeOf<HostAdapter["availability"]>().toBeNullable();
    expectTypeOf<ReturnType<HostAdapter["interpret"]>["verification"]["observed"]>().toEqualTypeOf<
      "pass" | "fail" | "error" | "incomplete"
    >();
  });
});
