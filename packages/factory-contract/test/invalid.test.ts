import { describe, expect, it } from "vitest";
import type { DefName } from "../src/generated.ts";
import { ContractError, assertContract, isDefName, parseContract, validateContract } from "../src/validate.ts";
import type { JsonObject } from "./support.ts";
import { asArray, at, contractFixture, internalFixture, variant } from "./support.ts";

/** The instance path of an error code such as `schema:/events/3/data:required:reason`. */
function pathOf(code: string): string[] {
  const path = code.split(":")[1] ?? "";
  return path.split("/").filter((segment) => segment !== "");
}

/** True when one path is a prefix of the other. */
function related(a: readonly string[], b: readonly string[]): boolean {
  const length = Math.min(a.length, b.length);
  return a.slice(0, length).every((segment, index) => segment === b[index]);
}

/**
 * The value is refused with every expected code, and every other error sits on the path to one of
 * them or below it (the `if`, `anyOf` and branch reports of the same fault), so a variant never
 * passes on an unrelated fault.
 */
function expectRefused(def: DefName, value: JsonObject, expected: readonly string[]): void {
  const errors = validateContract(def, value);
  for (const code of expected) expect(errors).toContain(code);
  const targets = expected.map(pathOf);
  for (const error of errors) {
    expect(targets.some((target) => related(pathOf(error), target)), `${error} is not on the path of ${expected.join(", ")}`).toBe(true);
  }
}

interface Case {
  name: string;
  def: DefName;
  base: () => JsonObject;
  edit: (copy: JsonObject) => void;
  /** One fault, or the faults that one edit causes together. */
  expected: string | readonly string[];
}

const status = (file: string) => () => contractFixture(file);
const fulfilled = status("status-fulfilled.json");
const running = status("status-running.json");
const start = () => contractFixture("start-request.json");
const capabilities = () => contractFixture("capabilities.json");

const SHAPE_CASES: Case[] = [
  // Unknown fields
  { name: "an unknown top-level field", def: "RequestStatus", base: fulfilled, edit: (c) => { c.extra = 1; }, expected: "schema:/:additionalProperties:extra" },
  { name: "an unknown nested field", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["hosts", 0]).owner = "x"; }, expected: "schema:/hosts/0:additionalProperties:owner" },
  { name: "an unknown field in event data", def: "RequestStatus", base: running, edit: (c) => { at(c, ["events", 3, "data"]).extra = true; }, expected: "schema:/events/3/data:additionalProperties:extra" },
  { name: "an unknown field in a request body", def: "StartRequest", base: start, edit: (c) => { c.user = "synthetic-user"; }, expected: "schema:/:additionalProperties:user" },
  { name: "an unknown field in error details", def: "ErrorResponse", base: () => contractFixture("error-busy.json"), edit: (c) => { at(c, ["error", "details"]).holder = "x"; }, expected: "schema:/error/details:additionalProperties:holder" },
  // Missing fields
  { name: "a missing top-level field", def: "RequestStatus", base: fulfilled, edit: (c) => { delete c.poll_after_ms; }, expected: "schema:/:required:poll_after_ms" },
  { name: "a missing nested field", def: "StartRequest", base: start, edit: (c) => { delete at(c, ["input", "items", 0]).difficulty; }, expected: "schema:/input/items/0:required:difficulty" },
  { name: "an absent value instead of null", def: "ValidationRun", base: () => contractFixture("validation-running.json"), edit: (c) => { delete c.result; }, expected: "schema:/:required:result" },
  { name: "a missing event field", def: "RequestStatus", base: running, edit: (c) => { delete at(c, ["events", 0]).message; }, expected: "schema:/events/0:required:message" },
  // Wrong enum values
  { name: "an unknown request state", def: "RequestStatus", base: running, edit: (c) => { c.state = "paused"; }, expected: "schema:/state:enum" },
  { name: "an unknown host", def: "StartRequest", base: start, edit: (c) => { asArray(at(c, ["input"]).hosts, "hosts")[0] = "synthetic-host"; }, expected: "schema:/input/hosts/0:enum" },
  { name: "an unknown bug type", def: "StartRequest", base: start, edit: (c) => { at(c, ["input", "items", 0]).bug_type_id = "memory"; }, expected: "schema:/input/items/0/bug_type_id:enum" },
  { name: "an unknown error code", def: "ErrorResponse", base: () => contractFixture("error-not-found.json"), edit: (c) => { at(c, ["error"]).code = "gone"; }, expected: "schema:/error/code:enum" },
  { name: "an unknown event type", def: "RequestStatus", base: running, edit: (c) => { at(c, ["events", 0]).type = "request_created"; }, expected: "schema:/events/0:discriminator" },
  { name: "an unknown candidate reason", def: "RequestStatus", base: status("status-zero-result.json"), edit: (c) => { at(c, ["candidates", 0, "reason"]).code = "flaky"; }, expected: "schema:/candidates/0/reason/code:enum" },
  { name: "another contract version", def: "SessionStatus", base: () => contractFixture("session.json"), edit: (c) => { c.contract_version = "bug-request/2"; }, expected: "schema:/contract_version:enum" },
  // Bad hashes
  { name: "an uppercase hash", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["candidates", 0]).candidate_id = "E1".repeat(32); }, expected: "schema:/candidates/0/candidate_id:pattern" },
  { name: "a 63-character hash", def: "StartRequest", base: start, edit: (c) => { c.interpretation_sha256 = "1".repeat(63); }, expected: "schema:/interpretation_sha256:pattern" },
  { name: "a bad nullable hash", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["events", 18]).case_id = "not-a-hash"; }, expected: "schema:/events/18/case_id:pattern" },
  { name: "a bad package hash", def: "ValidationRun", base: () => contractFixture("validation-passed.json"), edit: (c) => { at(c, ["package_sha256"]).validator = "g".repeat(64); }, expected: "schema:/package_sha256/validator:pattern" },
  // Bad UUIDs
  { name: "an uppercase request ID", def: "StartRequest", base: start, edit: (c) => { c.request_id = "00000000-0000-4000-8000-00000000010A"; }, expected: "schema:/request_id:pattern" },
  { name: "a validation ID without hyphens", def: "ValidationStartRequest", base: () => ({ validation_id: "00000000-0000-4000-8000-000000000201" }), edit: (c) => { c.validation_id = "00000000000040008000000000000201"; }, expected: "schema:/validation_id:pattern" },
  { name: "a bad validation ID in event data", def: "RequestStatus", base: status("status-validated.json"), edit: (c) => { at(c, ["events", 36, "data"]).validation_id = "201"; }, expected: "schema:/events/36/data/validation_id:pattern" },
  // Other formats and ranges
  { name: "an item key with an underscore", def: "StartRequest", base: start, edit: (c) => { at(c, ["input", "items", 0]).item_key = "concurrency_1"; }, expected: "schema:/input/items/0/item_key:pattern" },
  { name: "a time without milliseconds", def: "RequestStatus", base: fulfilled, edit: (c) => { c.created_at = "2026-10-20T14:00:00Z"; }, expected: "schema:/created_at:pattern" },
  { name: "an impossible date", def: "RequestStatus", base: fulfilled, edit: (c) => { c.updated_at = "2026-02-30T00:00:00.000Z"; }, expected: "schema:/updated_at:format" },
  { name: "a fractional amount", def: "StartRequest", base: start, edit: (c) => { at(c, ["input"]).budget_microusd = 1.5; }, expected: "schema:/input/budget_microusd:type" },
  { name: "a quantity of zero", def: "StartRequest", base: start, edit: (c) => { at(c, ["input", "items", 0]).quantity = 0; }, expected: "schema:/input/items/0/quantity:minimum" },
  { name: "a repeated host", def: "StartRequest", base: start, edit: (c) => { at(c, ["input"]).hosts = ["umami", "umami"]; }, expected: "schema:/input/hosts:uniqueItems" },
  { name: "no items", def: "StartRequest", base: start, edit: (c) => { at(c, ["input"]).items = []; }, expected: "schema:/input/items:minItems" },
  { name: "an event numbered 0", def: "RequestStatus", base: running, edit: (c) => { at(c, ["events", 0]).seq = 0; }, expected: "schema:/events/0/seq:minimum" },
  { name: "a string count", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["funnel"]).packages_ready = "2"; }, expected: "schema:/funnel/packages_ready:type" },
  { name: "an object where an empty event data belongs", def: "RequestStatus", base: running, edit: (c) => { at(c, ["events", 0]).data = { baseline_id: "umami@ec0ff503" }; }, expected: "schema:/events/0/data:additionalProperties:baseline_id" },
  { name: "check data on a host event", def: "RequestStatus", base: running, edit: (c) => { at(c, ["events", 3]).data = { check_set: "verification", copy: "clean", outcome: "pass", runs_valid: 1, runs_total: 1 }; }, expected: "schema:/events/3/data:required:baseline_id" },
];

const RULE_CASES: Case[] = [
  // Request status (contract section 8.1)
  { name: "an outcome before finished", def: "RequestStatus", base: running, edit: (c) => { c.outcome = "cancelled"; c.stop_reason = { code: "cancelled_by_user", message: "x" }; }, expected: ["schema:/outcome:type", "schema:/stop_reason:type"] },
  { name: "a finished state without an outcome", def: "RequestStatus", base: running, edit: (c) => { c.state = "finished"; }, expected: ["schema:/outcome:type", "schema:/stop_reason:type"] },
  { name: "finished without a stop reason", def: "RequestStatus", base: fulfilled, edit: (c) => { c.stop_reason = null; }, expected: "schema:/stop_reason:type" },
  { name: "a stop code of another outcome", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["stop_reason"]).code = "time_limit"; }, expected: "schema:/stop_reason/code:const" },
  { name: "fulfilled with partial delivery", def: "RequestStatus", base: fulfilled, edit: (c) => { c.delivery = "partial"; }, expected: "schema:/delivery:const" },
  // Candidates (section 8.3)
  { name: "a rejected candidate with an invalid-stage reason", def: "RequestStatus", base: status("status-zero-result.json"), edit: (c) => { at(c, ["candidates", 0, "reason"]).code = "setup_failed"; }, expected: "schema:/candidates/0/reason/code:enum" },
  { name: "a skipped candidate without a reason", def: "RequestStatus", base: status("status-partial-budget.json"), edit: (c) => { at(c, ["candidates", 1]).reason = null; }, expected: "schema:/candidates/1/reason:type" },
  { name: "a qualified candidate with a reason", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["candidates", 0]).reason = { code: "wrong_failure", message: "x" }; }, expected: "schema:/candidates/0/reason:type" },
  { name: "a qualified candidate without a case", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["candidates", 0]).case_id = null; }, expected: "schema:/candidates/0/case_id:type" },
  { name: "an item before requested_criteria_passed", def: "RequestStatus", base: running, edit: (c) => { at(c, ["candidates", 0]).item_key = "concurrency-1"; }, expected: "schema:/candidates/0/item_key:type" },
  // Events (section 8.4)
  { name: "a skipped event with a reason of another stage", def: "RequestStatus", base: status("status-partial-budget.json"), edit: (c) => { at(c, ["events", 21, "data"]).reason = "stopped"; }, expected: "schema:/events/21/data/reason:enum" },
  { name: "a finished event with a stop code of another outcome", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["events", 34, "data"]).stop_code = "cancelled_by_user"; }, expected: "schema:/events/34/data/stop_code:const" },
  // Capabilities and interpretation (sections 4 and 6)
  { name: "a supported pair without a source", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["combinations", 1]).source = null; }, expected: "schema:/combinations/1/source:type" },
  { name: "an unsupported pair without a reason", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["combinations", 0]).reason = null; }, expected: "schema:/combinations/0/reason:type" },
  { name: "a source with no entries", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["combinations", 1, "source"]).entries = 0; }, expected: "schema:/combinations/1/source/entries:minimum" },
  { name: "a warning code marked blocking", def: "Interpretation", base: () => contractFixture("interpretation-unsupported.json"), edit: (c) => { at(c, ["items", 4, "problems", 0]).severity = "blocking"; }, expected: "schema:/items/4/problems/0/severity:const" },
  { name: "a request-level problem with an item", def: "Interpretation", base: () => contractFixture("interpretation-budget-below-minimum.json"), edit: (c) => { at(c, ["problems", 0]).item_key = "date-time-1"; }, expected: "schema:/problems/0/item_key:type" },
  { name: "startable with a blocking request problem", def: "Interpretation", base: () => contractFixture("interpretation-budget-below-minimum.json"), edit: (c) => { c.startable = true; }, expected: "schema:/problems:not" },
  { name: "not startable without a blocking problem", def: "Interpretation", base: () => contractFixture("interpretation-supported.json"), edit: (c) => { c.startable = false; }, expected: "schema:/:anyOf" },
  { name: "a supported item with a blocking problem", def: "Interpretation", base: () => contractFixture("interpretation-supported.json"), edit: (c) => { asArray(at(c, ["items", 1]).problems, "problems").push({ code: "no_matching_source", severity: "blocking", message: "x", item_key: "date-time-1" }); }, expected: "schema:/items/1/problems:not" },
  { name: "source-only difficulty not refused", def: "Interpretation", base: () => contractFixture("interpretation-unsupported.json"), edit: (c) => { at(c, ["items", 2, "difficulty"]).status = "not_required"; }, expected: "schema:/items/2/difficulty/status:const" },
  // Cases (section 10)
  { name: "a qualified case with a mismatched cell", def: "RequestStatus", base: fulfilled, edit: (c) => { Object.assign(at(c, ["cases", 0, "matrix", "verification", "buggy"]), { observed: "pass", matches_expectation: false }); }, expected: "schema:/cases/0/matrix/verification/buggy/matches_expectation:const" },
  { name: "a cell whose match disagrees with its outcomes", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "matrix", "original_suite", "clean"]).observed = "error"; }, expected: "schema:/cases/0/matrix/original_suite/clean:anyOf" },
  { name: "a buggy copy expected to pass the checks", def: "RequestStatus", base: fulfilled, edit: (c) => { Object.assign(at(c, ["cases", 1, "matrix", "verification", "buggy"]), { expected: "pass", observed: "pass" }); }, expected: "schema:/cases/1/matrix/verification/buggy/expected:const" },
  { name: "a validator part in the bug case slot", def: "RequestStatus", base: fulfilled, edit: (c) => { Object.assign(at(c, ["cases", 0, "packages", "bug_case"]), { kind: "validator", format: "rbw-validator/1" }); }, expected: "schema:/cases/0/packages/bug_case/kind:const" },
  { name: "a part with the other part's format", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "packages", "validator"]).format = "rbw-bug-case/1"; }, expected: "schema:/cases/0/packages/validator/format:const" },
  { name: "parts that are not ready together", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "packages", "validator"]).ready = false; }, expected: "schema:/cases/0/packages/validator/ready:const" },
  { name: "a live case without an item", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0]).item_key = null; }, expected: "schema:/cases/0/item_key:type" },
  { name: "a live case without a request", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "provenance"]).request_id = null; }, expected: "schema:/cases/0/provenance/request_id:type" },
  { name: "a case with another verdict", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "qualification"]).verdict = "rejected"; }, expected: "schema:/cases/0/qualification/verdict:const" },
  { name: "an example with live provenance", def: "ExampleResponse", base: () => contractFixture("example.json"), edit: (c) => { Object.assign(at(c, ["case", "provenance"]), { origin: "live_request", request_id: "00000000-0000-4000-8000-000000000101" }); at(c, ["case"]).item_key = "concurrency-1"; }, expected: "schema:/case/provenance/origin:const" },
  // Validation runs (section 11)
  { name: "a result before finished", def: "ValidationRun", base: () => contractFixture("validation-running.json"), edit: (c) => { c.result = "error"; }, expected: "schema:/result:type" },
  { name: "a passed run without a matrix", def: "ValidationRun", base: () => contractFixture("validation-passed.json"), edit: (c) => { c.matrix = null; }, expected: "schema:/matrix:type" },
  { name: "a run cell with a changed expectation", def: "ValidationRun", base: () => contractFixture("validation-failed.json"), edit: (c) => { at(c, ["matrix", "original_suite", "buggy"]).expected = "fail"; at(c, ["matrix", "original_suite", "buggy"]).matches_expectation = false; }, expected: "schema:/matrix/original_suite/buggy/expected:const" },
  // Errors (section 12)
  { name: "busy without details", def: "ErrorResponse", base: () => contractFixture("error-busy.json"), edit: (c) => { at(c, ["error"]).details = null; }, expected: "schema:/error/details:type" },
  { name: "an active busy that is not retryable", def: "ErrorResponse", base: () => contractFixture("error-busy.json"), edit: (c) => { at(c, ["error"]).retryable = false; }, expected: "schema:/error/retryable:const" },
  { name: "a reconciliation busy that is retryable", def: "ErrorResponse", base: () => contractFixture("error-busy-needs-reconciliation.json"), edit: (c) => { at(c, ["error"]).retryable = true; }, expected: "schema:/error/retryable:const" },
  { name: "an unavailable that is not retryable", def: "ErrorResponse", base: () => contractFixture("error-unavailable.json"), edit: (c) => { at(c, ["error"]).retryable = false; }, expected: "schema:/error/retryable:const" },
  { name: "details on another code", def: "ErrorResponse", base: () => contractFixture("error-not-found.json"), edit: (c) => { at(c, ["error"]).details = { reason: "active" }; }, expected: "schema:/error/details:type" },
  { name: "a stale interpretation without one", def: "ErrorResponse", base: () => contractFixture("error-interpretation-stale.json"), edit: (c) => { at(c, ["error"]).details = { reason: "active" }; }, expected: "schema:/error/details:additionalProperties:reason" },
  { name: "an unsupported request with a startable interpretation", def: "ErrorResponse", base: () => contractFixture("error-interpretation-stale.json"), edit: (c) => { at(c, ["error"]).code = "unsupported_request"; }, expected: "schema:/error/details/interpretation/startable:const" },
];

const INTERNAL_CASES: Case[] = [
  { name: "a short app commit", def: "BaselineIdentity", base: () => internalFixture("baseline-identity.json"), edit: (c) => { c.app_commit = "ca4a71f"; }, expected: "schema:/app_commit:pattern" },
  { name: "an absolute plant path", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { at(c, ["plant", "targets", 0]).path = "/etc/synthetic"; }, expected: "schema:/plant/targets/0/path:pattern" },
  { name: "a plant with no target", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { at(c, ["plant"]).targets = []; }, expected: "schema:/plant/targets:minItems" },
  { name: "an unknown repair kind", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { at(c, ["reference_repair"]).kind = "rewrite"; }, expected: "schema:/reference_repair/kind:enum" },
  { name: "an assessed difficulty", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { at(c, ["difficulty"]).status = "assessed"; }, expected: "schema:/difficulty/status:enum" },
  { name: "a catalog entry without presentation text", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { delete c.presentation; }, expected: "schema:/:required:presentation" },
  { name: "an unpinned kit image", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { at(c, ["environment"]).kit_image_digest = null; }, expected: "schema:/environment/kit_image_digest:type" },
  { name: "a protocol state with no valid runs", def: "Protocol", base: () => internalFixture("protocol.json"), edit: (c) => { at(c, ["per_state", "buggy"]).min_valid_runs = 0; }, expected: "schema:/per_state/buggy/min_valid_runs:minimum" },
  { name: "a protocol without a copy state", def: "Protocol", base: () => internalFixture("protocol.json"), edit: (c) => { delete at(c, ["per_state"]).fixed; }, expected: "schema:/per_state:required:fixed" },
  { name: "a file set entry outside its root", def: "BugCaseInputs", base: () => internalFixture("bug-case-inputs.json"), edit: (c) => { at(c, ["source", "files", 0]).path = "../outside.ts"; }, expected: "schema:/source/files/0/path:pattern" },
  { name: "validator inputs expecting the buggy copy to pass the checks", def: "ValidatorInputs", base: () => internalFixture("validator-inputs.json"), edit: (c) => { at(c, ["expected", "verification"]).buggy = "pass"; }, expected: "schema:/expected/verification/buggy:const" },
  { name: "an unpacked pair without the fixed tree", def: "UnpackedPair", base: () => internalFixture("unpacked-pair.json"), edit: (c) => { delete at(c, ["states"]).fixed; }, expected: "schema:/states:required:fixed" },
  { name: "a copy with network access", def: "CopyPlan", base: () => internalFixture("copy-plan.json"), edit: (c) => { at(c, ["limits"]).network = "host"; }, expected: "schema:/limits/network:const" },
  { name: "a tag in place of a digest", def: "CopyPlan", base: () => internalFixture("copy-plan.json"), edit: (c) => { at(c, ["image"]).digest = "latest"; }, expected: "schema:/image/digest:pattern" },
  { name: "an empty command", def: "CopyPlan", base: () => internalFixture("copy-plan.json"), edit: (c) => { c.command = []; }, expected: "schema:/command:minItems" },
  { name: "an unknown architecture", def: "CopyRecord", base: () => internalFixture("copy-record.json"), edit: (c) => { c.architecture = "riscv64"; }, expected: "schema:/architecture:enum" },
  { name: "a suite observation without its counts", def: "CopyRecord", base: () => internalFixture("copy-record.json"), edit: (c) => { delete at(c, ["original_suite"]).executed; }, expected: "schema:/original_suite:required:executed" },
  { name: "an unknown field in a cell observation", def: "CopyRecord", base: () => internalFixture("copy-record.json"), edit: (c) => { at(c, ["verification"]).expected = "fail"; }, expected: "schema:/verification:additionalProperties:expected" },
  { name: "an accepted record with a reason", def: "QualificationRecord", base: () => internalFixture("qualification-record-accepted.json"), edit: (c) => { c.reason_code = "wrong_failure"; }, expected: "schema:/reason_code:type" },
  { name: "an accepted record with a mismatched cell", def: "QualificationRecord", base: () => internalFixture("qualification-record-accepted.json"), edit: (c) => { Object.assign(at(c, ["cells", "verification", "buggy"]), { observed: "pass", matches_expectation: false }); }, expected: "schema:/cells/verification/buggy/matches_expectation:const" },
  { name: "a rejected record with an invalid-stage reason", def: "QualificationRecord", base: () => internalFixture("qualification-record-rejected.json"), edit: (c) => { c.reason_code = "setup_failed"; }, expected: "schema:/reason_code:enum" },
  { name: "a rejected record without a reason", def: "QualificationRecord", base: () => internalFixture("qualification-record-rejected.json"), edit: (c) => { c.reason_code = null; }, expected: "schema:/reason_code:enum" },
  { name: "another route version", def: "QualificationRecord", base: () => internalFixture("qualification-record-accepted.json"), edit: (c) => { at(c, ["route"]).version = "2"; }, expected: "schema:/route/version:const" },
  { name: "another harness", def: "QualificationRecord", base: () => internalFixture("qualification-record-accepted.json"), edit: (c) => { at(c, ["export_verification", "harness"]).name = "synthetic-harness"; }, expected: "schema:/export_verification/harness/name:const" },
];

describe.each([
  ["shapes", SHAPE_CASES],
  ["contract rules", RULE_CASES],
  ["internal shapes", INTERNAL_CASES],
])("refuses invalid %s", (_group, cases) => {
  it.each(cases.map((item) => [item.name, item] as const))("%s", (_name, item) => {
    const base = item.base();
    expect(validateContract(item.def, base)).toEqual([]);
    expectRefused(item.def, variant(base, item.edit), typeof item.expected === "string" ? [item.expected] : item.expected);
  });
});

describe("validation helpers", () => {
  it("narrows a valid value and throws ContractError with the codes otherwise", () => {
    const session = assertContract("SessionStatus", contractFixture("session.json"));
    expect(session.signed_in).toBe(true);
    expect(() => assertContract("SessionStatus", { contract_version: "bug-request/1" })).toThrow(ContractError);
    try {
      assertContract("SessionStatus", { contract_version: "bug-request/1" });
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).errors).toEqual(["schema:/:required:signed_in"]);
    }
  });

  it("parses JSON text and reports text that is not JSON", () => {
    expect(parseContract("StopRequest", "{}")).toEqual({});
    expect(() => parseContract("StopRequest", '{"force": true}')).toThrow(/additionalProperties/);
    expect(() => parseContract("StopRequest", "{")).toThrow(ContractError);
    try {
      parseContract("StopRequest", "{");
    } catch (error) {
      expect((error as ContractError).errors).toEqual(["json"]);
    }
  });

  it("knows the definition names", () => {
    expect(isDefName("RequestStatus")).toBe(true);
    expect(isDefName("Request")).toBe(false);
  });
});
