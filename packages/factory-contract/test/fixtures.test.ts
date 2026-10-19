import { describe, expect, it } from "vitest";
import type { DefName } from "../src/generated.ts";
import { validateContract } from "../src/validate.ts";
import { CONTRACT_FIXTURES, INTERNAL_FIXTURES, jsonFiles, readJson } from "./support.ts";

/** Every contract fixture and the definition it is a body of (fixtures README). */
const CONTRACT_FIXTURE_DEFS: Record<string, DefName> = {
  "capabilities.json": "Capabilities",
  "error-budget-unavailable.json": "ErrorResponse",
  "error-busy-needs-reconciliation.json": "ErrorResponse",
  "error-busy.json": "ErrorResponse",
  "error-idempotency-conflict.json": "ErrorResponse",
  "error-interpretation-stale.json": "ErrorResponse",
  "error-invalid-request.json": "ErrorResponse",
  "error-not-found.json": "ErrorResponse",
  "error-passcode-incorrect.json": "ErrorResponse",
  "error-unauthorized.json": "ErrorResponse",
  "error-unavailable.json": "ErrorResponse",
  "error-unsupported-request.json": "ErrorResponse",
  "example.json": "ExampleResponse",
  "interpretation-budget-below-item.json": "Interpretation",
  "interpretation-budget-below-minimum.json": "Interpretation",
  "interpretation-supported.json": "Interpretation",
  "interpretation-unsupported.json": "Interpretation",
  "session-signed-out.json": "SessionStatus",
  "session.json": "SessionStatus",
  "start-request.json": "StartRequest",
  "status-cancelled.json": "RequestStatus",
  "status-duplicate-defect.json": "RequestStatus",
  "status-exhausted.json": "RequestStatus",
  "status-fulfilled.json": "RequestStatus",
  "status-operational-error.json": "RequestStatus",
  "status-partial-budget.json": "RequestStatus",
  "status-queued.json": "RequestStatus",
  "status-running.json": "RequestStatus",
  "status-validated.json": "RequestStatus",
  "status-wrong-failure.json": "RequestStatus",
  "status-zero-result.json": "RequestStatus",
  "test-evidence.json": "TestEvidence",
  "validation-error.json": "ValidationRun",
  "validation-failed.json": "ValidationRun",
  "validation-passed.json": "ValidationRun",
  "validation-running.json": "ValidationRun",
};

/** Synthetic examples of the internal shapes, which have no contract fixture. */
const INTERNAL_FIXTURE_DEFS: Record<string, DefName> = {
  "baseline-identity.json": "BaselineIdentity",
  "bug-case-inputs.json": "BugCaseInputs",
  "catalog-entry.json": "CatalogEntry",
  "copy-plan.json": "CopyPlan",
  "copy-record.json": "CopyRecord",
  "protocol.json": "Protocol",
  "qualification-record-accepted.json": "QualificationRecord",
  "qualification-record-rejected.json": "QualificationRecord",
  "unpacked-pair.json": "UnpackedPair",
  "validator-inputs.json": "ValidatorInputs",
};

describe("contract fixtures", () => {
  it("maps every fixture file to exactly one definition", () => {
    expect(Object.keys(CONTRACT_FIXTURE_DEFS).sort()).toEqual(jsonFiles(CONTRACT_FIXTURES));
  });

  it.each(Object.entries(CONTRACT_FIXTURE_DEFS))("%s is a valid %s", (file, def) => {
    expect(validateContract(def, readJson(CONTRACT_FIXTURES, file))).toEqual([]);
  });
});

describe("internal shape examples", () => {
  it("maps every example file to exactly one definition", () => {
    expect(Object.keys(INTERNAL_FIXTURE_DEFS).sort()).toEqual(jsonFiles(INTERNAL_FIXTURES));
  });

  it.each(Object.entries(INTERNAL_FIXTURE_DEFS))("%s is a valid %s", (file, def) => {
    expect(validateContract(def, readJson(INTERNAL_FIXTURES, file))).toEqual([]);
  });
});
