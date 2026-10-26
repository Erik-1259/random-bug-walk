import { describe, expect, it } from "vitest";
import type { DefName } from "../src/generated.ts";
import { BUG_TYPE_ID_VALUES, DIFFICULTY_OPTION_ID_VALUES, HOST_ID_VALUES, TEST_OPERATION_STATE_VALUES } from "../src/generated.ts";
import { ContractError, assertContract, isDefName, parseContract, validateContract } from "../src/validate.ts";
import type { Json, JsonObject } from "./support.ts";
import { asArray, asObject, at, contractFixture, internalFixture, variant } from "./support.ts";

/** The instance path of an error code such as `schema:/events/3/data:required:reason`. */
function pathOf(code: string): string[] {
  const path = code.split(":")[1] ?? "";
  return path.split("/").filter((segment) => segment !== "");
}

/** True when `ancestor` is `path` or one of its ancestors. */
function contains(ancestor: readonly string[], path: readonly string[]): boolean {
  return ancestor.length <= path.length && ancestor.every((segment, index) => segment === path[index]);
}

/** Reports that Ajv adds on the way to a fault: the rule or union that failed, not a fault of its own. */
const ENCLOSING = new Set(["if", "anyOf", "oneOf", "contains", "not"]);

/**
 * The value is refused with every expected code, and every other error is an enclosing report on
 * the path above one of them, or the `type` report of a nullable field's null branch on that path,
 * so a variant never passes on an unrelated fault.
 */
function expectRefused(def: DefName, value: JsonObject, expected: readonly string[]): void {
  const errors = validateContract(def, value);
  for (const code of expected) expect(errors).toContain(code);
  const targets = expected.map(pathOf);
  for (const error of errors) {
    if (expected.includes(error)) continue;
    const path = pathOf(error);
    const keyword = error.split(":")[2] ?? "";
    const enclosing = (ENCLOSING.has(keyword) || keyword === "type") && targets.some((target) => contains(path, target));
    expect(enclosing, `${error} is not an enclosing report of ${expected.join(", ")}`).toBe(true);
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
const interpretation = (file: string) => () => contractFixture(file);
const evidence = () => contractFixture("test-evidence.json");
const reconcile = () => ({ request_id: "00000000-0000-4000-8000-000000000105" });
const plan = () => internalFixture("copy-plan.json");
const collected = () => internalFixture("collected-copy.json");
const roots = () => ({ app_root: "/work/synthetic/pair/buggy", evaluator_root: "/work/synthetic/pair/evaluator" });

/** The fields that identify an entry of a capabilities list, such as `{ host_id: "umami" }`. */
type EntryKey = Readonly<Record<string, string>>;

/**
 * Refusals for a capabilities list that holds exactly one entry per key: for each key, a list that
 * lacks it, and a list that holds it twice in place of the next key. The second copy goes last, so
 * Ajv, which stops counting at the copy over the limit, checks every item.
 */
function onceEachCases(field: string, keys: readonly EntryKey[]): Case[] {
  const names = Object.keys(keys[0] ?? {});
  const listed = asArray(capabilities()[field], field).map((item): EntryKey => {
    const entry = asObject(item, field);
    return Object.fromEntries(names.map((name) => {
      const value = entry[name];
      if (typeof value !== "string") throw new Error(`an entry of ${field} without its ${name}`);
      return [name, value];
    }));
  });
  const label = (key: EntryKey): string => names.map((name) => key[name]).join(" x ");
  const listedAt = (key: EntryKey): number => listed.findIndex((entry) => names.every((name) => entry[name] === key[name]));
  /** The reports of the clause for `key` when `list` fails it: the clause, and each listed entry's field that differs. */
  const clause = (list: readonly EntryKey[], key: EntryKey): string[] => [`schema:/${field}:contains`, ...list.flatMap((entry, index) =>
    names.filter((name) => entry[name] !== key[name]).map((name) => `schema:/${field}/${String(index)}/${name}:const`))];
  return keys.flatMap((key, n): Case[] => {
    const index = listedAt(key);
    if (index < 0) throw new Error(`capabilities.json does not list ${label(key)} in ${field}`);
    const next = keys[(n + 1) % keys.length] ?? key;
    const nextIndex = listedAt(next);
    const twice = [...listed.filter((_, i) => i !== nextIndex), key];
    return [
      { name: `${field} without ${label(key)}`, def: "Capabilities", base: capabilities, edit: (c) => { asArray(c[field], field).splice(index, 1); }, expected: [`schema:/${field}:minItems`, ...clause(listed.filter((_, i) => i !== index), key)] },
      { name: `${field} with ${label(key)} twice`, def: "Capabilities", base: capabilities, edit: (c) => { const list = asArray(c[field], field); const copy = structuredClone(list[index] ?? null); list.splice(nextIndex, 1); list.push(copy); }, expected: [...clause(twice, key), ...clause(twice, next)] },
    ];
  });
}

/**
 * Clients build the request form from capabilities and never hard-code hosts or types (section 4), so
 * the lists hold exactly one entry per value of their enumeration: each host, each bug type, each
 * (host, bug type) pair (section 4.2) and each difficulty option (section 4.4).
 */
const ONCE_EACH_CASES: Case[] = [
  ...onceEachCases("hosts", HOST_ID_VALUES.map((id) => ({ host_id: id }))),
  ...onceEachCases("bug_types", BUG_TYPE_ID_VALUES.map((id) => ({ bug_type_id: id }))),
  ...onceEachCases("combinations", HOST_ID_VALUES.flatMap((host) => BUG_TYPE_ID_VALUES.map((type) => ({ host_id: host, bug_type_id: type })))),
  ...onceEachCases("difficulty_options", DIFFICULTY_OPTION_ID_VALUES.map((id) => ({ option_id: id }))),
];

const SHAPE_CASES: Case[] = [
  // Unknown fields
  { name: "an unknown top-level field", def: "RequestStatus", base: fulfilled, edit: (c) => { c.extra = 1; }, expected: "schema:/:additionalProperties:extra" },
  { name: "an unknown nested field", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["hosts", 0]).owner = "x"; }, expected: "schema:/hosts/0:additionalProperties:owner" },
  { name: "an unknown field in event data", def: "RequestStatus", base: running, edit: (c) => { at(c, ["events", 3, "data"]).extra = true; }, expected: "schema:/events/3/data:additionalProperties:extra" },
  { name: "an unknown field in a request body", def: "StartRequest", base: start, edit: (c) => { c.user = "synthetic-user"; }, expected: "schema:/:additionalProperties:user" },
  { name: "an unknown field in error details", def: "ErrorResponse", base: () => contractFixture("error-busy.json"), edit: (c) => { at(c, ["error", "details"]).holder = "x"; }, expected: ["schema:/error/details:additionalProperties:holder", "schema:/error/details:additionalProperties:reason", "schema:/error/details:required:interpretation"] },
  { name: "an unknown field in test evidence", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["slot"]).holder_case_id = null; }, expected: "schema:/slot:additionalProperties:holder_case_id" },
  // Missing fields
  { name: "a criterion without its failure code", def: "Capabilities", base: capabilities, edit: (c) => { delete at(c, ["bug_types", 0, "criteria", 0]).failure_code; }, expected: "schema:/bug_types/0/criteria/0:required:failure_code" },
  { name: "a reset answer without its scenario", def: "TestResetResponse", base: () => ({ contract_version: "bug-request/1", scenario: "worker-lost" }), edit: (c) => { delete c.scenario; }, expected: "schema:/:required:scenario" },
  { name: "a reconcile request without its request ID", def: "TestReconcileRequest", base: reconcile, edit: (c) => { delete c.request_id; }, expected: "schema:/:required:request_id" },
  { name: "a slot without its validation holder", def: "TestEvidence", base: evidence, edit: (c) => { delete at(c, ["slot"]).holder_validation_id; }, expected: "schema:/slot:required:holder_validation_id" },
  { name: "test evidence without its root execution", def: "TestEvidence", base: evidence, edit: (c) => { delete c.root_execution_id; }, expected: "schema:/:required:root_execution_id" },
  { name: "an operation without its execution ID", def: "TestEvidence", base: evidence, edit: (c) => { delete at(c, ["operations", 1]).execution_id; }, expected: "schema:/operations/1:required:execution_id" },
  { name: "an operation without its host", def: "TestEvidence", base: evidence, edit: (c) => { delete at(c, ["operations", 1]).host_id; }, expected: "schema:/operations/1:required:host_id" },
  { name: "a provider call without its execution ID", def: "TestEvidence", base: evidence, edit: (c) => { delete at(c, ["provider_calls", 1]).execution_id; }, expected: "schema:/provider_calls/1:required:execution_id" },
  { name: "a missing top-level field", def: "RequestStatus", base: fulfilled, edit: (c) => { delete c.poll_after_ms; }, expected: "schema:/:required:poll_after_ms" },
  { name: "a missing nested field", def: "StartRequest", base: start, edit: (c) => { delete at(c, ["input", "items", 0]).difficulty; }, expected: "schema:/input/items/0:required:difficulty" },
  { name: "an absent value instead of null", def: "ValidationRun", base: () => contractFixture("validation-running.json"), edit: (c) => { delete c.result; }, expected: "schema:/:required:result" },
  { name: "a missing event field", def: "RequestStatus", base: running, edit: (c) => { delete at(c, ["events", 0]).message; }, expected: "schema:/events/0:required:message" },
  // Wrong enum values
  { name: "an unknown request state", def: "RequestStatus", base: running, edit: (c) => { c.state = "paused"; }, expected: "schema:/state:enum" },
  { name: "an unknown host", def: "StartRequest", base: start, edit: (c) => { asArray(at(c, ["input"]).hosts, "hosts")[0] = "synthetic-host"; }, expected: "schema:/input/hosts/0:enum" },
  { name: "an unknown bug type", def: "StartRequest", base: start, edit: (c) => { at(c, ["input", "items", 0]).bug_type_id = "memory"; }, expected: "schema:/input/items/0/bug_type_id:enum" },
  { name: "an unknown error code", def: "ErrorResponse", base: () => contractFixture("error-not-found.json"), edit: (c) => { at(c, ["error"]).code = "gone"; }, expected: "schema:/error/code:enum" },
  { name: "an unknown event type", def: "RequestStatus", base: running, edit: (c) => { at(c, ["events", 0]).type = "request_created"; }, expected: ["schema:/events/0:discriminator", "schema:/events/0/type:const"] },
  { name: "an unknown candidate reason", def: "RequestStatus", base: status("status-zero-result.json"), edit: (c) => { at(c, ["candidates", 0, "reason"]).code = "flaky"; }, expected: "schema:/candidates/0/reason/code:enum" },
  { name: "the removed not_ready error code", def: "ErrorResponse", base: () => contractFixture("error-not-found.json"), edit: (c) => { at(c, ["error"]).code = "not_ready"; }, expected: "schema:/error/code:enum" },
  { name: "an unknown test scenario", def: "TestResetRequest", base: () => ({ scenario: "worker-lost" }), edit: (c) => { c.scenario = "synthetic-scenario"; }, expected: "schema:/scenario:enum" },
  { name: "an unknown ledger operation state", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["operations", 0]).state = "settling"; }, expected: "schema:/operations/0/state:enum" },
  { name: "the removed settled operation state", def: "TestEvidence", base: evidence, edit: (c) => { Object.assign(at(c, ["operations", 0]), { state: "settled", settled_microusd: 200000 }); }, expected: "schema:/operations/0/state:enum" },
  { name: "an unknown scenario in a reset answer", def: "TestResetResponse", base: () => ({ contract_version: "bug-request/1", scenario: "worker-lost" }), edit: (c) => { c.scenario = "synthetic-scenario"; }, expected: "schema:/scenario:enum" },
  { name: "an unknown operation kind", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["operations", 1]).kind = "candidate"; }, expected: "schema:/operations/1/kind:enum" },
  { name: "a provider other than the sandbox", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["provider_calls", 0]).provider = "synthetic-provider"; }, expected: "schema:/provider_calls/0/provider:enum" },
  { name: "an operation on an unknown host", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["operations", 1]).host_id = "synthetic-host"; }, expected: ["schema:/operations/1/host_id:enum", "schema:/operations/1/host_id:type", "schema:/operations/1/host_id:anyOf"] },
  { name: "another contract version", def: "SessionStatus", base: () => contractFixture("session.json"), edit: (c) => { c.contract_version = "bug-request/2"; }, expected: "schema:/contract_version:enum" },
  // Bad hashes
  { name: "an uppercase hash", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["candidates", 0]).candidate_id = "E1".repeat(32); }, expected: "schema:/candidates/0/candidate_id:pattern" },
  { name: "a 63-character hash", def: "StartRequest", base: start, edit: (c) => { c.interpretation_sha256 = "1".repeat(63); }, expected: "schema:/interpretation_sha256:pattern" },
  { name: "a bad nullable hash", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["events", 18]).case_id = "not-a-hash"; }, expected: "schema:/events/18/case_id:pattern" },
  { name: "a bad package hash", def: "ValidationRun", base: () => contractFixture("validation-passed.json"), edit: (c) => { at(c, ["package_sha256"]).validator = "g".repeat(64); }, expected: "schema:/package_sha256/validator:pattern" },
  { name: "an operation ID that is a UUID", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["operations", 0]).operation_id = "00000000-0000-4000-8000-000000000301"; }, expected: "schema:/operations/0/operation_id:pattern" },
  { name: "an uppercase operation ID", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["operations", 1]).operation_id = "3B".repeat(32); }, expected: "schema:/operations/1/operation_id:pattern" },
  // Bad UUIDs
  { name: "an uppercase request ID", def: "StartRequest", base: start, edit: (c) => { c.request_id = "00000000-0000-4000-8000-00000000010A"; }, expected: "schema:/request_id:pattern" },
  { name: "a bad slot holder", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["slot"]).holder_request_id = "105"; }, expected: "schema:/slot/holder_request_id:pattern" },
  { name: "a bad validation holder", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["slot"]).holder_validation_id = "201"; }, expected: "schema:/slot/holder_validation_id:pattern" },
  { name: "a bad request ID in test evidence", def: "TestEvidence", base: evidence, edit: (c) => { c.request_id = "00000000-0000-4000-8000-00000000010G"; }, expected: "schema:/request_id:pattern" },
  { name: "a root execution that is not a UUID", def: "TestEvidence", base: evidence, edit: (c) => { c.root_execution_id = "test-request:00000000-0000-4000-8000-000000000105"; }, expected: "schema:/root_execution_id:pattern" },
  { name: "an operation's execution ID that is a hash", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["operations", 0]).execution_id = "3a".repeat(32); }, expected: "schema:/operations/0/execution_id:pattern" },
  { name: "an uppercase execution ID in a provider call", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["provider_calls", 1]).execution_id = "00000000-0000-4000-8000-00000000040A"; }, expected: "schema:/provider_calls/1/execution_id:pattern" },
  { name: "a bad request ID to reconcile", def: "TestReconcileRequest", base: reconcile, edit: (c) => { c.request_id = "105"; }, expected: "schema:/request_id:pattern" },
  { name: "a validation ID without hyphens", def: "ValidationStartRequest", base: () => ({ validation_id: "00000000-0000-4000-8000-000000000201" }), edit: (c) => { c.validation_id = "00000000000040008000000000000201"; }, expected: "schema:/validation_id:pattern" },
  { name: "a bad validation ID in event data", def: "RequestStatus", base: status("status-validated.json"), edit: (c) => { at(c, ["events", 36, "data"]).validation_id = "201"; }, expected: "schema:/events/36/data/validation_id:pattern" },
  // Other formats and ranges
  { name: "an item key with an underscore", def: "StartRequest", base: start, edit: (c) => { at(c, ["input", "items", 0]).item_key = "concurrency_1"; }, expected: "schema:/input/items/0/item_key:pattern" },
  { name: "a time without milliseconds", def: "RequestStatus", base: fulfilled, edit: (c) => { c.created_at = "2026-10-20T14:00:00Z"; }, expected: "schema:/created_at:pattern" },
  { name: "a provider call time without milliseconds", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["provider_calls", 0]).at = "2026-10-20T19:00:00Z"; }, expected: "schema:/provider_calls/0/at:pattern" },
  { name: "an impossible date", def: "RequestStatus", base: fulfilled, edit: (c) => { c.updated_at = "2026-02-30T00:00:00.000Z"; }, expected: "schema:/updated_at:format" },
  { name: "a fractional amount", def: "StartRequest", base: start, edit: (c) => { at(c, ["input"]).budget_microusd = 1.5; }, expected: "schema:/input/budget_microusd:type" },
  { name: "a quantity of zero", def: "StartRequest", base: start, edit: (c) => { at(c, ["input", "items", 0]).quantity = 0; }, expected: "schema:/input/items/0/quantity:minimum" },
  { name: "an empty description in an interpretation's input", def: "Interpretation", base: interpretation("interpretation-supported.json"), edit: (c) => { at(c, ["input", "items", 0]).description = ""; }, expected: "schema:/input/items/0/description:pattern" },
  { name: "an untrimmed description in an interpretation's input", def: "Interpretation", base: interpretation("interpretation-supported.json"), edit: (c) => { at(c, ["input", "items", 0]).description = "lost update "; }, expected: "schema:/input/items/0/description:pattern" },
  { name: "an untrimmed description in an interpreted item", def: "Interpretation", base: interpretation("interpretation-supported.json"), edit: (c) => { at(c, ["items", 0]).description = " lost update"; }, expected: "schema:/items/0/description:pattern" },
  { name: "an untrimmed description in a status item", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["items", 0]).description = "lost update\n"; }, expected: "schema:/items/0/description:pattern" },
  { name: "a negative budget", def: "StartRequest", base: start, edit: (c) => { at(c, ["input"]).budget_microusd = -1; }, expected: "schema:/input/budget_microusd:minimum" },
  { name: "negative spend", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["events", 1, "data"]).spent_microusd = -1; }, expected: "schema:/events/1/data/spent_microusd:minimum" },
  { name: "more than 200 events", def: "RequestStatus", base: fulfilled, edit: (c) => { c.events = Array.from({ length: 201 }, () => at(c, ["events", 0])); }, expected: "schema:/events:maxItems" },
  { name: "a repeated host", def: "StartRequest", base: start, edit: (c) => { at(c, ["input"]).hosts = ["umami", "umami"]; }, expected: "schema:/input/hosts:uniqueItems" },
  { name: "an empty hosts list", def: "StartRequest", base: start, edit: (c) => { at(c, ["input"]).hosts = []; }, expected: "schema:/input/hosts:minItems" },
  { name: "a case part of another media type", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "packages", "bug_case"]).media_type = "application/zip"; }, expected: "schema:/cases/0/packages/bug_case/media_type:const" },
  { name: "a validation_finished event without a result", def: "RequestStatus", base: status("status-validated.json"), edit: (c) => { at(c, ["events", 37, "data"]).result = null; }, expected: ["schema:/events/37/data/result:type", "schema:/events/37/data/result:enum"] },
  { name: "no items", def: "StartRequest", base: start, edit: (c) => { at(c, ["input"]).items = []; }, expected: "schema:/input/items:minItems" },
  { name: "a reserved amount of null", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["operations", 0]).reserved_microusd = null; }, expected: "schema:/operations/0/reserved_microusd:type" },
  { name: "an empty failure code", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["bug_types", 0, "criteria", 0]).failure_code = ""; }, expected: "schema:/bug_types/0/criteria/0/failure_code:minLength" },
  { name: "a failure code of null", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["bug_types", 0, "criteria", 0]).failure_code = null; }, expected: "schema:/bug_types/0/criteria/0/failure_code:type" },
  { name: "an attempt numbered 0", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["operations", 0]).attempt_ordinal = 0; }, expected: "schema:/operations/0/attempt_ordinal:minimum" },
  { name: "an event numbered 0", def: "RequestStatus", base: running, edit: (c) => { at(c, ["events", 0]).seq = 0; }, expected: ["schema:/events/0/seq:minimum", "schema:/events/0/seq:const"] },
  { name: "a string count", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["funnel"]).packages_ready = "2"; }, expected: "schema:/funnel/packages_ready:type" },
  { name: "an object where an empty event data belongs", def: "RequestStatus", base: running, edit: (c) => { at(c, ["events", 0]).data = { baseline_id: "umami@ec0ff503" }; }, expected: "schema:/events/0/data:additionalProperties:baseline_id" },
  { name: "check data on a host event", def: "RequestStatus", base: running, edit: (c) => { at(c, ["events", 3]).data = { check_set: "verification", copy: "clean", outcome: "pass", runs_valid: 1, runs_total: 1 }; }, expected: ["schema:/events/3/data:required:baseline_id", ...["check_set", "copy", "outcome", "runs_valid", "runs_total"].map((field) => `schema:/events/3/data:additionalProperties:${field}`)] },
];

/** A copy with each string in the named fields, or in the lists they hold, mapped, such as every host swapped for the other one. */
function relabel(value: Json, fields: readonly string[], map: Readonly<Record<string, string>>, inField = false): Json {
  if (typeof value === "string") return inField ? (map[value] ?? value) : value;
  if (Array.isArray(value)) return value.map((item) => relabel(item, fields, map, inField));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relabel(item, fields, map, fields.includes(key))]));
}

const [FIRST_HOST, SECOND_HOST] = HOST_ID_VALUES;
const [FIRST_TYPE, SECOND_TYPE] = BUG_TYPE_ID_VALUES;
/** The fixture with its two hosts swapped, so a rule written once per host is tested for each. */
const hostsSwapped = (base: () => JsonObject) => () => asObject(relabel(base(), ["host_id", "hosts"], { [FIRST_HOST]: SECOND_HOST, [SECOND_HOST]: FIRST_HOST }), "swapped");
/** The fixture with its two bug types swapped, so a rule written once per bug type is tested for each. */
const typesSwapped = (base: () => JsonObject) => () => asObject(relabel(base(), ["bug_type_id"], { [FIRST_TYPE]: SECOND_TYPE, [SECOND_TYPE]: FIRST_TYPE }), "swapped");
/** The fixture as it is for `value`, and with the values swapped for the other one. */
const asFor = (value: string, first: string, base: () => JsonObject, swap: (base: () => JsonObject) => () => JsonObject) => (value === first ? base : swap(base));

const listIndex = (list: Json | undefined, field: string, value: string): number =>
  asArray(list, field).findIndex((entry) => asObject(entry, field)[field] === value);

/** The `contains` report of the list at a path of keys and the `const` report of each entry whose field is not the value. */
function containsReportsAt(root: JsonObject, path: readonly string[], field: string, value: string): string[] {
  const where = path.join("/");
  const list = path.reduce<Json | undefined>((node, step) => asObject(node, where)[step], root);
  return [`schema:/${where}:contains`, ...asArray(list, where).flatMap((entry, index) =>
    (asObject(entry, where)[field] === value ? [] : [`schema:/${where}/${String(index)}/${field}:const`]))];
}

/** The `contains` report of a top-level list and the `const` report of each entry whose field is not the value. */
const containsReports = (root: JsonObject, list: string, field: string, value: string): string[] => containsReportsAt(root, [list], field, value);

const supported = interpretation("interpretation-supported.json");
const unsupported = interpretation("interpretation-unsupported.json");
const exhaustedInterpretation = () => at(contractFixture("status-exhausted.json"), ["interpretation"]);
const problem = (code: string, severity: string, itemKey: string | null): JsonObject => ({ code, severity, message: "x", item_key: itemKey });

/**
 * Rules written once per bug type: one total per type (section 5), a total for each requested type
 * and none for a type no item requests, and the type-wide problems of section 6.2.
 */
const PER_TYPE_CASES: Case[] = BUG_TYPE_ID_VALUES.flatMap((type): Case[] => {
  const other = type === FIRST_TYPE ? SECOND_TYPE : FIRST_TYPE;
  const onlyOther = asFor(other, SECOND_TYPE, interpretation("interpretation-budget-below-minimum.json"), typesSwapped);
  const zeroResult = asFor(other, SECOND_TYPE, status("status-zero-result.json"), typesSwapped);
  const exhausted = asFor(type, FIRST_TYPE, status("status-exhausted.json"), typesSwapped);
  const typeTotal = (c: JsonObject) => listIndex(c.type_totals, "bug_type_id", type);
  const twice = (c: JsonObject) => { const list = asArray(c.type_totals, "type_totals"); list.push(structuredClone(list[typeTotal(c)] ?? null)); };
  const without = (c: JsonObject) => { asArray(c.type_totals, "type_totals").splice(typeTotal(c), 1); };
  const totals = (root: JsonObject) => containsReports(root, "type_totals", "bug_type_id", type);
  return [
    { name: `two ${type} totals in an interpretation`, def: "Interpretation", base: supported, edit: twice, expected: totals(variant(supported(), twice)) },
    { name: `an interpretation without the ${type} total its items request`, def: "Interpretation", base: supported, edit: without, expected: totals(variant(supported(), without)) },
    { name: `a requested ${type} total of zero in an interpretation`, def: "Interpretation", base: supported, edit: (c) => { at(c, ["type_totals", typeTotal(c)]).quantity = 0; }, expected: [...totals(supported()), `schema:/type_totals/${String(typeTotal(supported()))}/quantity:minimum`] },
    { name: `a ${type} total in an interpretation whose items request no ${type}`, def: "Interpretation", base: onlyOther, edit: (c) => { asArray(c.type_totals, "type_totals").push({ bug_type_id: type, quantity: 1 }); }, expected: "schema:/type_totals/1/quantity:const" },
    { name: `two ${type} totals in a status`, def: "RequestStatus", base: fulfilled, edit: twice, expected: totals(variant(fulfilled(), twice)) },
    { name: `a status without the ${type} total its items request`, def: "RequestStatus", base: fulfilled, edit: without, expected: totals(variant(fulfilled(), without)) },
    { name: `a requested ${type} total of zero in a status`, def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["type_totals", typeTotal(c)]).requested = 0; }, expected: [...totals(fulfilled()), `schema:/type_totals/${String(typeTotal(fulfilled()))}/requested:minimum`] },
    { name: `a requested ${type} total in a status whose items request no ${type}`, def: "RequestStatus", base: zeroResult, edit: (c) => { asArray(c.type_totals, "type_totals").push({ bug_type_id: type, requested: 1, delivered: 0, missing: 1 }); }, expected: "schema:/type_totals/1/requested:const" },
    // Section 6.2: no selected host has a supported source for the bug type, so every item of the type carries the code.
    { name: `unsupported_combination on one ${type} item only`, def: "Interpretation", base: asFor(type, FIRST_TYPE, unsupported, typesSwapped), edit: (c) => { at(c, ["items", 0, "problems", 0]).code = "unsupported_combination"; }, expected: [1, 2, 4].flatMap((index) => [`schema:/items/${String(index)}/problems:contains`, `schema:/items/${String(index)}/problems/0/code:const`]) },
    // Section 6.2: the quantity warning is computed per bug type, and every supported item of the type carries it.
    { name: `quantity_exceeds_source on one supported ${type} item only`, def: "Interpretation", base: asFor(type, FIRST_TYPE, exhaustedInterpretation, typesSwapped), edit: (c) => { at(c, ["items", 1]).problems = []; }, expected: "schema:/items/1/problems:minItems" },
    // Section 5: extra cases of one type never fill another type's shortfall, and a request works only on its items' types.
    { name: `a ${other} candidate in a request for ${type} only`, def: "RequestStatus", base: exhausted, edit: (c) => { at(c, ["candidates", 0]).bug_type_id = other; }, expected: "schema:/candidates/0/bug_type_id:not" },
    { name: `a ${other} case in a request for ${type} only`, def: "RequestStatus", base: exhausted, edit: (c) => { at(c, ["cases", 0]).bug_type_id = other; }, expected: "schema:/cases/0/bug_type_id:not" },
    { name: `a ${other} source exhausted in a request for ${type} only`, def: "RequestStatus", base: exhausted, edit: (c) => { at(c, ["events", 18, "data"]).bug_type_id = other; }, expected: "schema:/events/18/data/bug_type_id:not" },
  ];
});

/**
 * Rules written once per host: eligible sources on the selected hosts, one per host (sections 4.2 and 6.1), host_unused in both
 * directions (section 6.2), one worst case per host and, in a startable interpretation, one for each host a supported item draws
 * from (sections 6 and 11), and work on the selected hosts only (section 1).
 */
const PER_HOST_CASES: Case[] = HOST_ID_VALUES.flatMap((host): Case[] => {
  const other = host === FIRST_HOST ? SECOND_HOST : FIRST_HOST;
  const elsewhere = asFor(other, SECOND_HOST, unsupported, hostsSwapped);
  const both = asFor(host, FIRST_HOST, supported, hostsSwapped);
  const alone = asFor(host, FIRST_HOST, interpretation("interpretation-budget-below-minimum.json"), hostsSwapped);
  const onOtherHost = asFor(other, SECOND_HOST, status("status-exhausted.json"), hostsSwapped);
  const servedBy = (c: JsonObject) => asArray(c.items, "items").findIndex((entry) => at(asObject(entry, "item"), ["eligible_sources", 0]).host_id === host);
  const onHost = (c: JsonObject) => { asArray(at(c, ["items", 4]).eligible_sources, "eligible_sources").push({ host_id: host, source_id: "synthetic-source", entries: 1 }); };
  const budget = () => at(supported(), ["budget"]);
  const withoutEntry = (list: string) => (c: JsonObject) => { const entries = asArray(at(c, ["budget"])[list], list); entries.splice(listIndex(entries, "host_id", host), 1); };
  /** The second entry goes last, so Ajv, which stops counting at the entry over the limit, checks every entry. */
  const entryTwice = (list: string) => (c: JsonObject) => { const entries = asArray(c[list], list); entries.push(structuredClone(entries[listIndex(entries, "host_id", host)] ?? null)); };
  const twiceReports = (list: string) => containsReportsAt(variant(budget(), entryTwice(list)), [list], "host_id", host);
  return [
    // The interpretation is not startable, so the host the supported item now draws from needs no validation worst case.
    { name: `an eligible source on ${host}, which is not selected`, def: "Interpretation", base: elsewhere, edit: onHost, expected: "schema:/items/4/eligible_sources:not" },
    { name: `two eligible sources on ${host} for one item`, def: "Interpretation", base: supported, edit: (c) => { const list = asArray(at(c, ["items", servedBy(c)]).eligible_sources, "eligible_sources"); list.push(structuredClone(list[0] ?? null)); }, expected: `schema:/items/${String(servedBy(supported()))}/eligible_sources:contains` },
    { name: `a selected host ${host} that serves no item without host_unused`, def: "Interpretation", base: both, edit: (c) => { at(c, ["items", 1]).eligible_sources = structuredClone(asArray(at(c, ["items", 0]).eligible_sources, "eligible_sources")); }, expected: ["schema:/:anyOf", "schema:/problems:contains", "schema:/items:contains", "schema:/items/0/problems:contains", "schema:/items/1/problems:contains"] },
    // Section 6.2: host_unused means a selected host serves none of the items, so a lone selected host that serves one never has it.
    { name: `host_unused while ${host}, the only selected host, serves an item`, def: "Interpretation", base: alone, edit: (c) => { asArray(c.problems, "problems").push(problem("host_unused", "warning", null)); }, expected: ["schema:/:anyOf", "schema:/items/0/eligible_sources:not", "schema:/input/hosts:contains", "schema:/input/hosts/0:const"] },
    // Section 11 reserves the worst case of the case's host from this list, so each host a supported item draws from has an entry.
    { name: `validation worst cases without ${host}, which a supported item draws from`, def: "Interpretation", base: supported, edit: withoutEntry("worst_case_per_validation_microusd"), expected: containsReportsAt(variant(supported(), withoutEntry("worst_case_per_validation_microusd")), ["budget", "worst_case_per_validation_microusd"], "host_id", host) },
    { name: `${host} twice among the candidate worst cases`, def: "InterpretationBudget", base: budget, edit: entryTwice("worst_case_per_candidate_microusd"), expected: twiceReports("worst_case_per_candidate_microusd") },
    { name: `${host} twice among the validation worst cases`, def: "InterpretationBudget", base: budget, edit: entryTwice("worst_case_per_validation_microusd"), expected: twiceReports("worst_case_per_validation_microusd") },
    { name: `a candidate on ${host} in a request for ${other} only`, def: "RequestStatus", base: onOtherHost, edit: (c) => { at(c, ["candidates", 0]).host_id = host; }, expected: "schema:/candidates/0/host_id:not" },
    { name: `a case on ${host} in a request for ${other} only`, def: "RequestStatus", base: onOtherHost, edit: (c) => { at(c, ["cases", 0]).host_id = host; }, expected: "schema:/cases/0/host_id:not" },
    { name: `a host event on ${host} in a request for ${other} only`, def: "RequestStatus", base: onOtherHost, edit: (c) => { at(c, ["events", 3]).host_id = host; }, expected: "schema:/events/3/host_id:not" },
  ];
});

/** The reports of a list that holds a second event of the type: its `contains` report and each other event's `type` report. */
const secondEvent = (root: JsonObject, type: string): string[] => containsReports(root, "events", "type", type);
/** Appends a copy of an event of another fixture under a new number. */
const pushEvent = (file: string, index: number, seq: number) => (c: JsonObject) => {
  asArray(c.events, "events").push({ ...structuredClone(at(contractFixture(file), ["events", index])), seq });
};

/** The ledger states of an operation that is neither settled nor reconciled, so it holds its reservation (section 15.1). */
const UNSETTLED_STATES = TEST_OPERATION_STATE_VALUES.filter((state) => state !== "terminal" && state !== "reconciled");

/** A settled amount belongs only to a terminal or reconciled operation: the others hold their reservation (section 15.1). */
const UNSETTLED_CASES: Case[] = UNSETTLED_STATES.map((state): Case => ({
  name: `a settled amount on an operation in state ${state}`, def: "TestEvidence", base: evidence, edit: (c) => { Object.assign(at(c, ["operations", 0]), { state, settled_microusd: 200000 }); }, expected: "schema:/operations/0/settled_microusd:type",
}));

/** The reports of host_unused in interpretation-supported.json, whose items 0 and 1 each draw from one of its two selected hosts. */
const EVERY_HOST_SERVES = ["schema:/:anyOf", "schema:/items/0/eligible_sources:not", "schema:/items/1/eligible_sources:not"];
/** Removes a host's entry from a status's frozen validation worst cases. */
const withoutValidationEntry = (host: string) => (c: JsonObject) => {
  const entries = asArray(at(c, ["interpretation", "budget"]).worst_case_per_validation_microusd, "worst_case_per_validation_microusd");
  entries.splice(listIndex(entries, "host_id", host), 1);
};
/** The rejection reasons of a cell that did not match in export verification (section 8.3). */
const CELL_MISMATCH_REASONS = ["original_suite_failed_clean", "original_suite_caught_bug", "original_suite_failed_fixed", "checks_failed_clean", "checks_failed_fixed", "bug_not_detected"] as const;
/** The live download routes of section 10.2 for an example's case, set on its two parts as `routes` names them. */
const liveRoutes = (routes: { bug_case: string; validator: string }) => (c: JsonObject) => {
  const caseId = at(c, ["case"]).case_id;
  if (typeof caseId !== "string") throw new Error("an example without its case ID");
  for (const [part, suffix] of Object.entries(routes)) at(c, ["case", "packages", part]).download_path = `/api/factory/requests/00000000-0000-4000-8000-000000000101/cases/${caseId}/packages/${suffix}`;
};

const RULE_CASES: Case[] = [
  // Request status (contract section 8.1)
  { name: "an outcome before finished", def: "RequestStatus", base: running, edit: (c) => { c.outcome = "cancelled"; c.stop_reason = { code: "cancelled_by_user", message: "x" }; }, expected: ["schema:/outcome:type", "schema:/stop_reason:type"] },
  { name: "a finished state without an outcome", def: "RequestStatus", base: running, edit: (c) => { c.state = "finished"; }, expected: ["schema:/outcome:type", "schema:/stop_reason:type", "schema:/candidates:not"] },
  { name: "finished without a stop reason", def: "RequestStatus", base: fulfilled, edit: (c) => { c.stop_reason = null; }, expected: "schema:/stop_reason:type" },
  { name: "a stop code of another outcome", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["stop_reason"]).code = "time_limit"; }, expected: ["schema:/stop_reason/code:const", "schema:/events/34/data/stop_code:const"] },
  { name: "fulfilled with partial delivery", def: "RequestStatus", base: fulfilled, edit: (c) => { c.delivery = "partial"; at(c, ["items", 1]).missing = 1; at(c, ["type_totals", 1]).missing = 1; }, expected: "schema:/delivery:const" },
  { name: "cases without delivery", def: "RequestStatus", base: fulfilled, edit: (c) => { c.outcome = "cancelled"; c.delivery = "none"; at(c, ["stop_reason"]).code = "cancelled_by_user"; at(c, ["events", 34]).data = { outcome: "cancelled", stop_code: "cancelled_by_user" }; for (const field of ["items", "type_totals"]) for (const entry of asArray(c[field], field)) Object.assign(asObject(entry, field), { delivered: 0, missing: 1 }); for (const entry of asArray(c.items, "items")) asObject(entry, "item").case_ids = []; }, expected: "schema:/cases:maxItems" },
  { name: "delivery without cases", def: "RequestStatus", base: status("status-zero-result.json"), edit: (c) => { c.delivery = "partial"; Object.assign(at(c, ["items", 0]), { delivered: 1, case_ids: ["ca".repeat(32)] }); at(c, ["type_totals", 0]).delivered = 1; }, expected: "schema:/cases:minItems" },
  { name: "a frozen interpretation that is not startable", def: "RequestStatus", base: running, edit: (c) => { at(c, ["interpretation"]).startable = false; }, expected: ["schema:/interpretation/startable:const", "schema:/interpretation:anyOf", "schema:/interpretation/problems:contains", "schema:/interpretation/items:contains", "schema:/interpretation/items/0/status:const", "schema:/interpretation/items/1/status:const"] },
  // The case keeps its live download routes, which a published example never uses (section 10.2).
  { name: "the published example among a request's cases", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0]).item_key = null; Object.assign(at(c, ["cases", 0, "provenance"]), { origin: "published_example", request_id: null }); }, expected: ["schema:/cases/0/provenance/origin:const", "schema:/cases/0/packages/bug_case/download_path:not", "schema:/cases/0/packages/validator/download_path:not"] },
  { name: "a fulfilled request whose sources fall short", def: "RequestStatus", base: fulfilled, edit: (c) => { asArray(at(c, ["interpretation", "items", 0]).problems, "problems").push({ code: "quantity_exceeds_source", severity: "warning", message: "x", item_key: "concurrency-1" }); }, expected: "schema:/outcome:not" },
  { name: "a fulfilled request with an item the budget cannot reach", def: "RequestStatus", base: fulfilled, edit: (c) => { asArray(at(c, ["interpretation", "items", 1]).problems, "problems").push({ code: "budget_below_item_minimum", severity: "warning", message: "x", item_key: "date-time-1" }); }, expected: "schema:/outcome:not" },
  { name: "an overrun after finish without reconciliation", def: "RequestStatus", base: fulfilled, edit: (c) => { const budget = at(c, ["budget"]); const spent = Number(budget.budget_microusd) + 10000; Object.assign(budget, { reserved_microusd: 0, spent_microusd: spent, committed_microusd: spent, remaining_microusd: -10000, overrun: true }); }, expected: "schema:/attention:type" },
  { name: "complete delivery with an item still missing a case", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["items", 1]).missing = 1; }, expected: "schema:/items/1/missing:const" },
  { name: "complete delivery with a type total still missing a case", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["type_totals", 0]).missing = 1; }, expected: "schema:/type_totals/0/missing:const" },
  { name: "partial delivery with nothing missing", def: "RequestStatus", base: status("status-partial-budget.json"), edit: (c) => { at(c, ["items", 1]).missing = 0; at(c, ["type_totals", 1]).missing = 0; }, expected: ["schema:/items:contains", "schema:/items/0/missing:minimum", "schema:/items/1/missing:minimum", "schema:/type_totals:contains", "schema:/type_totals/0/missing:minimum", "schema:/type_totals/1/missing:minimum"] },
  { name: "no delivery with an item that has a case", def: "RequestStatus", base: status("status-zero-result.json"), edit: (c) => { Object.assign(at(c, ["items", 0]), { delivered: 1, case_ids: ["ca".repeat(32)] }); }, expected: "schema:/items/0/delivered:const" },
  { name: "no delivery with a type total that has a case", def: "RequestStatus", base: status("status-zero-result.json"), edit: (c) => { at(c, ["type_totals", 0]).delivered = 1; }, expected: "schema:/type_totals/0/delivered:const" },
  { name: "partial delivery with nothing delivered", def: "RequestStatus", base: status("status-partial-budget.json"), edit: (c) => { Object.assign(at(c, ["items", 0]), { delivered: 0, case_ids: [] }); at(c, ["type_totals", 0]).delivered = 0; }, expected: ["schema:/items:contains", "schema:/items/0/delivered:minimum", "schema:/items/1/delivered:minimum", "schema:/type_totals:contains", "schema:/type_totals/0/delivered:minimum", "schema:/type_totals/1/delivered:minimum"] },
  { name: "a status without items", def: "RequestStatus", base: status("status-queued.json"), edit: (c) => { c.items = []; }, expected: ["schema:/items:minItems", "schema:/items:contains", "schema:/type_totals/0/requested:const", "schema:/type_totals/1/requested:const"] },
  { name: "an item that requests nothing", def: "RequestStatus", base: status("status-queued.json"), edit: (c) => { at(c, ["items", 0]).requested = 0; }, expected: "schema:/items/0/requested:minimum" },
  { name: "an item that lists one case twice", def: "RequestStatus", base: fulfilled, edit: (c) => { const item = at(c, ["items", 0]); Object.assign(item, { delivered: 2, case_ids: [...asArray(item.case_ids, "case_ids"), ...asArray(item.case_ids, "case_ids")] }); }, expected: "schema:/items/0/case_ids:uniqueItems" },
  { name: "an item with a case but nothing delivered", def: "RequestStatus", base: running, edit: (c) => { at(c, ["items", 0]).case_ids = ["ca".repeat(32)]; }, expected: "schema:/items/0/case_ids:maxItems" },
  { name: "an item with a delivery but no case", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["items", 0]).case_ids = []; }, expected: "schema:/items/0/case_ids:minItems" },
  // Funnel (section 8.2)
  { name: "delivered cases without a ready package in the funnel", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["funnel"]).packages_ready = 0; }, expected: "schema:/funnel/packages_ready:minimum" },
  { name: "a ready package in the funnel without a case", def: "RequestStatus", base: status("status-zero-result.json"), edit: (c) => { at(c, ["funnel"]).packages_ready = 1; }, expected: "schema:/funnel/packages_ready:const" },
  { name: "cases without a qualified candidate", def: "RequestStatus", base: fulfilled, edit: (c) => { c.candidates = []; }, expected: "schema:/candidates:contains" },
  { name: "a qualified candidate without a case among the cases", def: "RequestStatus", base: running, edit: (c) => { Object.assign(at(c, ["candidates", 0]), { stage: "qualified", item_key: "concurrency-1", case_id: "ca".repeat(32) }); Object.assign(at(c, ["funnel"]), { behavior_checks_passed: 1, requested_criteria_passed: 1 }); }, expected: "schema:/candidates:not" },
  { name: "a candidate checking while the funnel explored none", def: "RequestStatus", base: running, edit: (c) => { at(c, ["funnel"]).candidates_explored = 0; }, expected: "schema:/funnel/candidates_explored:minimum" },
  { name: "a candidate past its behavior checks that the funnel does not count", def: "RequestStatus", base: running, edit: (c) => { at(c, ["candidates", 0]).stage = "behavior_checks_passed"; }, expected: "schema:/funnel/behavior_checks_passed:minimum" },
  { name: "an assigned candidate that the funnel does not count", def: "RequestStatus", base: running, edit: (c) => { Object.assign(at(c, ["candidates", 0]), { stage: "requested_criteria_passed", item_key: "concurrency-1" }); at(c, ["funnel"]).behavior_checks_passed = 1; }, expected: "schema:/funnel/requested_criteria_passed:minimum" },
  // Rules written once per bug type and once per host
  ...PER_TYPE_CASES,
  ...PER_HOST_CASES,
  // Candidates (sections 8.3 and 10.5)
  { name: "a candidate in progress after the request finished", def: "RequestStatus", base: status("status-cancelled.json"), edit: (c) => { Object.assign(at(c, ["candidates", 1]), { stage: "checking", reason: null }); }, expected: "schema:/candidates:not" },
  { name: "two candidates in progress at once", def: "RequestStatus", base: running, edit: (c) => { asArray(c.candidates, "candidates").push({ ...structuredClone(at(c, ["candidates", 0])), candidate_id: "e2".repeat(32), stage: "selected" }); }, expected: "schema:/candidates:contains" },
  { name: "a rejected candidate with an invalid-stage reason", def: "RequestStatus", base: status("status-zero-result.json"), edit: (c) => { at(c, ["candidates", 0, "reason"]).code = "setup_failed"; }, expected: "schema:/candidates/0/reason/code:enum" },
  { name: "a skipped candidate without a reason", def: "RequestStatus", base: status("status-partial-budget.json"), edit: (c) => { at(c, ["candidates", 1]).reason = null; }, expected: "schema:/candidates/1/reason:type" },
  { name: "a qualified candidate with a reason", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["candidates", 0]).reason = { code: "export_mismatch", message: "x" }; }, expected: "schema:/candidates/0/reason:type" },
  { name: "a qualified candidate without a case", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["candidates", 0]).case_id = null; }, expected: "schema:/candidates/0/case_id:type" },
  { name: "a case on a rejected candidate", def: "RequestStatus", base: status("status-zero-result.json"), edit: (c) => { at(c, ["candidates", 0]).case_id = "ca".repeat(32); }, expected: "schema:/candidates/0/case_id:type" },
  { name: "a case on a candidate still packaging", def: "RequestStatus", base: running, edit: (c) => { Object.assign(at(c, ["candidates", 0]), { stage: "packaging", item_key: "concurrency-1", case_id: "ca".repeat(32) }); Object.assign(at(c, ["funnel"]), { behavior_checks_passed: 1, requested_criteria_passed: 1 }); }, expected: "schema:/candidates/0/case_id:type" },
  { name: "a packaging candidate without an item", def: "RequestStatus", base: running, edit: (c) => { at(c, ["candidates", 0]).stage = "packaging"; at(c, ["funnel"]).behavior_checks_passed = 1; }, expected: "schema:/candidates/0/item_key:type" },
  { name: "an item before requested_criteria_passed", def: "RequestStatus", base: running, edit: (c) => { at(c, ["candidates", 0]).item_key = "concurrency-1"; }, expected: ["schema:/candidates/0/item_key:type", "schema:/funnel/requested_criteria_passed:minimum"] },
  { name: "an item on a candidate that fits no item", def: "RequestStatus", base: status("status-wrong-failure.json"), edit: (c) => { at(c, ["candidates", 0]).item_key = "concurrency-1"; at(c, ["funnel"]).requested_criteria_passed = 1; }, expected: "schema:/candidates/0/item_key:type" },
  { name: "an item on a candidate skipped as a duplicate defect", def: "RequestStatus", base: status("status-duplicate-defect.json"), edit: (c) => { at(c, ["candidates", 1]).item_key = "concurrency-1"; }, expected: "schema:/candidates/1/item_key:type" },
  { name: "an item on a candidate skipped for its budget", def: "RequestStatus", base: status("status-partial-budget.json"), edit: (c) => { at(c, ["candidates", 1]).item_key = "date-time-1"; }, expected: "schema:/candidates/1/item_key:type" },
  { name: "a duplicate defect skipped without the candidate that tried it", def: "RequestStatus", base: status("status-wrong-failure.json"), edit: (c) => { Object.assign(at(c, ["candidates", 0]), { stage: "skipped", reason: { code: "duplicate_defect", message: "x" } }); }, expected: "schema:/candidates:minItems" },
  // Sections 6.3 and 8.2: assignment needs all six cells matched in export verification, so a cell mismatch comes before any item.
  ...CELL_MISMATCH_REASONS.map((code): Case => ({
    name: `an item on a candidate rejected with ${code}`, def: "RequestStatus", base: status("status-zero-result.json"), edit: (c) => { Object.assign(at(c, ["candidates", 0]), { item_key: "date-time-1", reason: { code, message: "x" } }); Object.assign(at(c, ["funnel"]), { behavior_checks_passed: 1, requested_criteria_passed: 1 }); }, expected: "schema:/candidates/0/item_key:type",
  })),
  // Events (section 8.4)
  { name: "request_accepted after event 1", def: "RequestStatus", base: running, edit: (c) => { at(c, ["events", 0]).seq = 13; }, expected: "schema:/events/0/seq:const" },
  { name: "another event numbered 1", def: "RequestStatus", base: running, edit: (c) => { at(c, ["events", 1]).seq = 1; }, expected: "schema:/events/1/type:const" },
  { name: "next_after of zero", def: "RequestStatus", base: status("status-queued.json"), edit: (c) => { c.next_after = 0; }, expected: "schema:/next_after:minimum" },
  { name: "request_finished before the request finished", def: "RequestStatus", base: running, edit: pushEvent("status-fulfilled.json", 34, 13), expected: "schema:/state:const" },
  { name: "a request_finished event with another stop code", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["events", 34]).data = { outcome: "cancelled", stop_code: "cancelled_by_user" }; }, expected: "schema:/events/34/data/stop_code:const" },
  { name: "two request_finished events", def: "RequestStatus", base: fulfilled, edit: pushEvent("status-fulfilled.json", 34, 36), expected: secondEvent(variant(fulfilled(), pushEvent("status-fulfilled.json", 34, 36)), "request_finished") },
  { name: "stop_requested while the request runs", def: "RequestStatus", base: running, edit: pushEvent("status-cancelled.json", 23, 13), expected: "schema:/state:enum" },
  { name: "two stop_requested events", def: "RequestStatus", base: status("status-cancelled.json"), edit: pushEvent("status-cancelled.json", 23, 30), expected: secondEvent(variant(contractFixture("status-cancelled.json"), pushEvent("status-cancelled.json", 23, 30)), "stop_requested") },
  { name: "a validation run while the request runs", def: "RequestStatus", base: running, edit: pushEvent("status-validated.json", 36, 13), expected: "schema:/state:const" },
  // Sections 8.5 and 11: the request holds the slot until it finishes, so no case has a validation run before then.
  { name: "validation runs on the cases of a request that is still running", def: "RequestStatus", base: status("status-validated.json"), edit: (c) => { Object.assign(c, { state: "running", outcome: null, stop_reason: null, events: [] }); }, expected: ["schema:/cases/0/validation:type", "schema:/cases/1/validation:type"] },
  { name: "a running validation run on a case of a request that is stopping", def: "RequestStatus", base: fulfilled, edit: (c) => { Object.assign(c, { state: "stopping", outcome: null, stop_reason: null, events: [] }); at(c, ["cases", 0]).validation = contractFixture("validation-running.json"); }, expected: "schema:/cases/0/validation:type" },
  { name: "a skipped event with a reason of another stage", def: "RequestStatus", base: status("status-partial-budget.json"), edit: (c) => { at(c, ["events", 21, "data"]).reason = "stopped"; }, expected: "schema:/events/21/data/reason:enum" },
  { name: "a finished event with a stop code of another outcome", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["events", 34, "data"]).stop_code = "cancelled_by_user"; }, expected: "schema:/events/34/data/stop_code:const" },
  // Section 8.4: criterion_ids are the criteria the candidate demonstrated, which become its case's criteria_met, so at least one, each once.
  { name: "a requested_criteria_passed event without criteria", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["events", 16, "data"]).criterion_ids = []; }, expected: "schema:/events/16/data/criterion_ids:minItems" },
  { name: "a requested_criteria_passed event that lists a criterion twice", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["events", 16, "data"]).criterion_ids = ["concurrency.lost-acknowledged-change", "concurrency.lost-acknowledged-change"]; }, expected: "schema:/events/16/data/criterion_ids:uniqueItems" },
  // Capabilities and interpretation (sections 4 and 6)
  { name: "a supported pair without a source", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["combinations", 1]).source = null; }, expected: "schema:/combinations/1/source:type" },
  { name: "an unsupported pair without a reason", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["combinations", 0]).reason = null; }, expected: "schema:/combinations/0/reason:type" },
  { name: "a supported pair with a reason", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["combinations", 1]).reason = "x"; }, expected: "schema:/combinations/1/reason:type" },
  ...ONCE_EACH_CASES,
  { name: "a negative remaining amount without an overrun", def: "RequestStatus", base: status("status-operational-error.json"), edit: (c) => { at(c, ["budget"]).remaining_microusd = -1; }, expected: "schema:/budget/remaining_microusd:minimum" },
  { name: "an overrun with money remaining", def: "RequestStatus", base: status("status-operational-error.json"), edit: (c) => { at(c, ["budget"]).overrun = true; }, expected: "schema:/budget/remaining_microusd:maximum" },
  { name: "a source with no entries", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["combinations", 1, "source"]).entries = 0; }, expected: "schema:/combinations/1/source/entries:minimum" },
  { name: "source-only difficulty offered as available", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["difficulty_options", 1]).available = true; }, expected: "schema:/difficulty_options/1/available:const" },
  { name: "source-only difficulty as the default", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["difficulty_options", 1]).default = true; }, expected: "schema:/difficulty_options/1/default:const" },
  { name: "source-inferable difficulty marked unavailable", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["difficulty_options", 0]).available = false; }, expected: "schema:/difficulty_options/0/available:const" },
  { name: "source-inferable difficulty not the default", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["difficulty_options", 0]).default = false; }, expected: "schema:/difficulty_options/0/default:const" },
  { name: "a warning code marked blocking", def: "Interpretation", base: () => contractFixture("interpretation-unsupported.json"), edit: (c) => { at(c, ["items", 4, "problems", 0]).severity = "blocking"; }, expected: "schema:/items/4/problems/0/severity:const" },
  { name: "a request-level problem with an item", def: "Interpretation", base: () => contractFixture("interpretation-budget-below-minimum.json"), edit: (c) => { at(c, ["problems", 0]).item_key = "date-time-1"; }, expected: "schema:/problems/0/item_key:type" },
  { name: "a request-level quantity warning", def: "Interpretation", base: interpretation("interpretation-supported.json"), edit: (c) => { asArray(c.problems, "problems").push({ code: "quantity_exceeds_source", severity: "warning", message: "x", item_key: null }); }, expected: "schema:/problems/0/item_key:type" },
  { name: "an item-level warning among the request-level problems", def: "Interpretation", base: interpretation("interpretation-supported.json"), edit: (c) => { asArray(c.problems, "problems").push({ code: "budget_below_item_minimum", severity: "warning", message: "x", item_key: "date-time-1" }); }, expected: "schema:/problems/0/item_key:type" },
  { name: "an item budget warning on an item without an eligible host", def: "Interpretation", base: () => contractFixture("interpretation-unsupported.json"), edit: (c) => { asArray(at(c, ["items", 3]).problems, "problems").push({ code: "budget_below_item_minimum", severity: "warning", message: "x", item_key: "date-time-1" }); }, expected: "schema:/items/3/eligible_sources:minItems" },
  { name: "a supported item without an eligible source", def: "Interpretation", base: unsupported, edit: (c) => { at(c, ["items", 4]).eligible_sources = []; }, expected: ["schema:/items/4/eligible_sources:minItems", "schema:/items/4/problems:contains", "schema:/items/4/problems/0/code:enum"] },
  { name: "a supported item whose eligible source has no matching entry", def: "Interpretation", base: interpretation("interpretation-supported.json"), edit: (c) => { at(c, ["items", 1, "eligible_sources", 0]).entries = 0; }, expected: "schema:/items/1/eligible_sources/0/entries:minimum" },
  { name: "an item-level budget warning without an item", def: "Interpretation", base: interpretation("interpretation-budget-below-item.json"), edit: (c) => { at(c, ["items", 1, "problems", 0]).item_key = null; }, expected: "schema:/items/1/problems/0/item_key:type" },
  { name: "startable with a blocking request problem", def: "Interpretation", base: () => contractFixture("interpretation-budget-below-minimum.json"), edit: (c) => { c.startable = true; }, expected: "schema:/problems:not" },
  { name: "not startable without a blocking problem", def: "Interpretation", base: () => contractFixture("interpretation-supported.json"), edit: (c) => { c.startable = false; }, expected: ["schema:/:anyOf", "schema:/problems:contains", "schema:/items:contains", "schema:/items/0/status:const", "schema:/items/1/status:const"] },
  { name: "a supported item with a blocking problem", def: "Interpretation", base: () => contractFixture("interpretation-supported.json"), edit: (c) => { asArray(at(c, ["items", 1]).problems, "problems").push({ code: "no_matching_source", severity: "blocking", message: "x", item_key: "date-time-1" }); }, expected: ["schema:/items/1/problems:not", "schema:/items/1/criteria:minItems", "schema:/items/1/eligible_sources:maxItems"] },
  { name: "source-only difficulty not refused", def: "Interpretation", base: () => contractFixture("interpretation-unsupported.json"), edit: (c) => { at(c, ["items", 2, "difficulty"]).status = "not_required"; }, expected: "schema:/items/2/difficulty/status:const" },
  { name: "a supported item that requires source-only difficulty", def: "Interpretation", base: () => contractFixture("interpretation-unsupported.json"), edit: (c) => { Object.assign(at(c, ["items", 2]), { status: "supported", problems: [] }); }, expected: ["schema:/items/2/status:const", "schema:/items/2/problems:contains", "schema:/items/2/problems:minItems"] },
  { name: "a source-only item without the unsupported_difficulty problem", def: "Interpretation", base: () => contractFixture("interpretation-unsupported.json"), edit: (c) => { at(c, ["items", 2, "problems", 0]).code = "unrecognized_description"; }, expected: ["schema:/items/2/problems:contains", "schema:/items/2/problems/0/code:const", "schema:/items/2/unmatched_text:minItems"] },
  { name: "criteria for an item without a description", def: "Interpretation", base: () => contractFixture("interpretation-supported.json"), edit: (c) => { at(c, ["items", 1]).criteria = structuredClone(asArray(at(c, ["items", 0]).criteria, "criteria")); }, expected: "schema:/items/1/criteria:maxItems" },
  { name: "unmatched text for an item without a description", def: "Interpretation", base: () => contractFixture("interpretation-unsupported.json"), edit: (c) => { at(c, ["items", 3]).unmatched_text = ["after a network retry"]; }, expected: ["schema:/items/3/unmatched_text:maxItems", "schema:/items/3/problems:contains", "schema:/items/3/problems/0/code:const"] },
  { name: "a supported item with unmatched text", def: "Interpretation", base: () => contractFixture("interpretation-unsupported.json"), edit: (c) => { Object.assign(at(c, ["items", 1]), { status: "supported", problems: [] }); }, expected: ["schema:/items/1/status:const", "schema:/items/1/problems:contains", "schema:/items/1/problems:minItems"] },
  { name: "unmatched text without the unrecognized_description problem", def: "Interpretation", base: () => contractFixture("interpretation-unsupported.json"), edit: (c) => { at(c, ["items", 1, "problems", 0]).code = "no_matching_source"; }, expected: ["schema:/items/1/problems:contains", "schema:/items/1/problems/0/code:const", "schema:/items/1/eligible_sources:maxItems"] },
  { name: "a source-only request item interpreted as source-inferable", def: "Interpretation", base: supported, edit: (c) => { at(c, ["input", "items", 1]).difficulty = "source_only_difficulty_required"; }, expected: ["schema:/items:contains", "schema:/items/0/difficulty/requested:const", "schema:/items/1/difficulty/requested:const"] },
  { name: "a frozen interpretation that downgrades a source-only request item", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["interpretation", "input", "items", 0]).difficulty = "source_only_difficulty_required"; }, expected: ["schema:/interpretation/items:contains", "schema:/interpretation/items/0/difficulty/requested:const", "schema:/interpretation/items/1/difficulty/requested:const"] },
  { name: "an interpreted source-only item that no request item asks for", def: "Interpretation", base: unsupported, edit: (c) => { at(c, ["input", "items", 2]).difficulty = "source_inferable_allowed"; }, expected: ["schema:/input/items:contains", ...[0, 1, 2, 3, 4].map((index) => `schema:/input/items/${String(index)}/difficulty:const`)] },
  { name: "an interpretation without items", def: "Interpretation", base: supported, edit: (c) => { c.items = []; c.problems = [problem("host_unused", "warning", null)]; }, expected: "schema:/items:minItems" },
  { name: "unrecognized_description without unmatched text", def: "Interpretation", base: unsupported, edit: (c) => { at(c, ["items", 1]).unmatched_text = []; }, expected: "schema:/items/1/unmatched_text:minItems" },
  { name: "unrecognized_description on an item without a description", def: "Interpretation", base: unsupported, edit: (c) => { asArray(at(c, ["items", 3]).problems, "problems").push(problem("unrecognized_description", "blocking", "date-time-1")); }, expected: "schema:/items/3/unmatched_text:minItems" },
  { name: "an empty unmatched text entry", def: "Interpretation", base: unsupported, edit: (c) => { at(c, ["items", 1]).unmatched_text = [""]; }, expected: "schema:/items/1/unmatched_text/0:pattern" },
  { name: "unmatched text that does not start and end with a word", def: "Interpretation", base: unsupported, edit: (c) => { at(c, ["items", 1]).unmatched_text = [" after a network retry. "]; }, expected: "schema:/items/1/unmatched_text/0:pattern" },
  { name: "unsupported_difficulty on an item that does not require source-only difficulty", def: "Interpretation", base: unsupported, edit: (c) => { asArray(at(c, ["items", 0]).problems, "problems").push(problem("unsupported_difficulty", "blocking", "stale-response")); }, expected: "schema:/items/0/difficulty/requested:const" },
  { name: "no_matching_source on an item without criteria", def: "Interpretation", base: unsupported, edit: (c) => { asArray(at(c, ["items", 3]).problems, "problems").push(problem("no_matching_source", "blocking", "date-time-1")); }, expected: "schema:/items/3/criteria:minItems" },
  { name: "no_matching_source on an item with an eligible source", def: "Interpretation", base: unsupported, edit: (c) => { asArray(at(c, ["items", 1]).problems, "problems").push(problem("no_matching_source", "blocking", "lost-change-retry")); }, expected: "schema:/items/1/eligible_sources:maxItems" },
  { name: "unsupported_combination on an item with an eligible source", def: "Interpretation", base: unsupported, edit: (c) => { at(c, ["items", 3]).eligible_sources = [{ host_id: "task-report", source_id: "synthetic-task-report-date-time", entries: 1 }]; }, expected: "schema:/items/3/eligible_sources:maxItems" },
  { name: "an item without an eligible source or a reason for it", def: "Interpretation", base: unsupported, edit: (c) => { at(c, ["items", 2]).eligible_sources = []; }, expected: ["schema:/items/2/problems:contains", "schema:/items/2/problems/0/code:enum"] },
  { name: "a request-level problem among an item's problems", def: "Interpretation", base: unsupported, edit: (c) => { asArray(at(c, ["items", 0]).problems, "problems").push(problem("budget_below_minimum", "blocking", null)); }, expected: "schema:/items/0/problems/1/item_key:type" },
  { name: "host_unused without an item among an item's problems", def: "Interpretation", base: supported, edit: (c) => { at(c, ["items", 1]).eligible_sources = structuredClone(asArray(at(c, ["items", 0]).eligible_sources, "eligible_sources")); asArray(at(c, ["items", 0]).problems, "problems").push(problem("host_unused", "warning", null)); }, expected: "schema:/items/0/problems/0/item_key:type" },
  // Section 6.2: host_unused means a selected host serves none of the items, at either level.
  { name: "a request-level host_unused while every selected host serves an item", def: "Interpretation", base: supported, edit: (c) => { asArray(c.problems, "problems").push(problem("host_unused", "warning", null)); }, expected: EVERY_HOST_SERVES },
  { name: "an item-level host_unused while every selected host serves an item", def: "Interpretation", base: supported, edit: (c) => { asArray(at(c, ["items", 1]).problems, "problems").push(problem("host_unused", "warning", "date-time-1")); }, expected: EVERY_HOST_SERVES },
  // Section 11 looks the case's host up in the frozen interpretation's validation worst cases.
  { name: "a frozen interpretation whose validation worst cases lack a case's host", def: "RequestStatus", base: fulfilled, edit: withoutValidationEntry(SECOND_HOST), expected: containsReportsAt(variant(fulfilled(), withoutValidationEntry(SECOND_HOST)), ["interpretation", "budget", "worst_case_per_validation_microusd"], "host_id", SECOND_HOST) },
  // Cases (section 10)
  { name: "a qualified case with a mismatched cell", def: "RequestStatus", base: fulfilled, edit: (c) => { Object.assign(at(c, ["cases", 0, "matrix", "verification", "buggy"]), { observed: "pass", matches_expectation: false }); }, expected: "schema:/cases/0/matrix/verification/buggy/matches_expectation:const" },
  { name: "a cell whose match disagrees with its outcomes", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "matrix", "original_suite", "clean"]).observed = "error"; }, expected: ["schema:/cases/0/matrix/original_suite/clean:anyOf", "schema:/cases/0/matrix/original_suite/clean/observed:const", "schema:/cases/0/matrix/original_suite/clean/expected:const"] },
  { name: "a buggy copy expected to pass the checks", def: "RequestStatus", base: fulfilled, edit: (c) => { Object.assign(at(c, ["cases", 1, "matrix", "verification", "buggy"]), { expected: "pass", observed: "pass" }); }, expected: "schema:/cases/1/matrix/verification/buggy/expected:const" },
  { name: "a validator part in the bug case slot", def: "RequestStatus", base: fulfilled, edit: (c) => { Object.assign(at(c, ["cases", 0, "packages", "bug_case"]), { kind: "validator", format: "rbw-validator/1" }); }, expected: "schema:/cases/0/packages/bug_case/kind:const" },
  { name: "a part with the other part's format", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "packages", "validator"]).format = "rbw-bug-case/1"; }, expected: "schema:/cases/0/packages/validator/format:const" },
  { name: "a case whose validator part is not ready", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "packages", "validator"]).ready = false; }, expected: "schema:/cases/0/packages/validator/ready:const" },
  { name: "a case whose two parts are both not ready", def: "RequestStatus", base: fulfilled, edit: (c) => { for (const part of ["bug_case", "validator"]) at(c, ["cases", 0, "packages", part]).ready = false; }, expected: ["schema:/cases/0/packages/bug_case/ready:const", "schema:/cases/0/packages/validator/ready:const"] },
  { name: "a published example whose two parts are both not ready", def: "ExampleResponse", base: () => contractFixture("example.json"), edit: (c) => { for (const part of ["bug_case", "validator"]) at(c, ["case", "packages", part]).ready = false; }, expected: ["schema:/case/packages/bug_case/ready:const", "schema:/case/packages/validator/ready:const"] },
  { name: "a case whose bug case part has no download path", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "packages", "bug_case"]).download_path = null; }, expected: "schema:/cases/0/packages/bug_case/download_path:type" },
  { name: "a case whose validator part has no download path", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 1, "packages", "validator"]).download_path = null; }, expected: "schema:/cases/1/packages/validator/download_path:type" },
  { name: "a published example whose two parts have no download path", def: "ExampleResponse", base: () => contractFixture("example.json"), edit: (c) => { for (const part of ["bug_case", "validator"]) at(c, ["case", "packages", part]).download_path = null; }, expected: ["schema:/case/packages/bug_case/download_path:type", "schema:/case/packages/validator/download_path:type"] },
  { name: "a case whose bug case part has an empty download path", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "packages", "bug_case"]).download_path = ""; }, expected: ["schema:/cases/0/packages/bug_case/download_path:minLength", "schema:/cases/0/packages/bug_case/download_path:pattern"] },
  { name: "a case whose validator part has an empty download path", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 1, "packages", "validator"]).download_path = ""; }, expected: ["schema:/cases/1/packages/validator/download_path:minLength", "schema:/cases/1/packages/validator/download_path:pattern"] },
  { name: "a published example whose two parts have an empty download path", def: "ExampleResponse", base: () => contractFixture("example.json"), edit: (c) => { for (const part of ["bug_case", "validator"]) at(c, ["case", "packages", part]).download_path = ""; }, expected: ["schema:/case/packages/bug_case/download_path:minLength", "schema:/case/packages/validator/download_path:minLength"] },
  { name: "a case that meets no criterion", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0]).criteria_met = []; }, expected: "schema:/cases/0/criteria_met:minItems" },
  { name: "a published example that meets no criterion", def: "ExampleResponse", base: () => contractFixture("example.json"), edit: (c) => { at(c, ["case"]).criteria_met = []; }, expected: "schema:/case/criteria_met:minItems" },
  { name: "a live case whose part has a download path outside the template", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "packages", "bug_case"]).download_path = "/x"; }, expected: "schema:/cases/0/packages/bug_case/download_path:pattern" },
  { name: "a live case whose two download paths are swapped", def: "RequestStatus", base: fulfilled, edit: (c) => { const bugCase = at(c, ["cases", 1, "packages", "bug_case"]); const validator = at(c, ["cases", 1, "packages", "validator"]); [bugCase.download_path, validator.download_path] = [validator.download_path ?? null, bugCase.download_path ?? null]; }, expected: ["schema:/cases/1/packages/bug_case/download_path:pattern", "schema:/cases/1/packages/validator/download_path:pattern"] },
  { name: "a live case without an item", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0]).item_key = null; }, expected: "schema:/cases/0/item_key:type" },
  { name: "a live case without a request", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "provenance"]).request_id = null; }, expected: "schema:/cases/0/provenance/request_id:type" },
  { name: "a case with another verdict", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["cases", 0, "qualification"]).verdict = "rejected"; }, expected: "schema:/cases/0/qualification/verdict:const" },
  { name: "a published example that names a request", def: "ExampleResponse", base: () => contractFixture("example.json"), edit: (c) => { at(c, ["case", "provenance"]).request_id = "00000000-0000-4000-8000-000000000101"; }, expected: "schema:/case/provenance/request_id:type" },
  { name: "an example with live provenance", def: "ExampleResponse",base: () => contractFixture("example.json"), edit: (c) => { Object.assign(at(c, ["case", "provenance"]), { origin: "live_request", request_id: "00000000-0000-4000-8000-000000000101" }); at(c, ["case"]).item_key = "concurrency-1"; }, expected: ["schema:/case/provenance/origin:const", "schema:/case/packages/bug_case/download_path:pattern", "schema:/case/packages/validator/download_path:pattern"] },
  // Section 10.2: the live download route needs a session, and the completed example's URL needs none.
  { name: "a published example whose parts point at the live download routes", def: "ExampleResponse", base: () => contractFixture("example.json"), edit: liveRoutes({ bug_case: "bug-case", validator: "validator" }), expected: ["schema:/case/packages/bug_case/download_path:not", "schema:/case/packages/validator/download_path:not"] },
  { name: "a published example whose parts point at each other's live download routes", def: "ExampleResponse", base: () => contractFixture("example.json"), edit: liveRoutes({ bug_case: "validator", validator: "bug-case" }), expected: ["schema:/case/packages/bug_case/download_path:not", "schema:/case/packages/validator/download_path:not"] },
  // Validation runs (section 11)
  { name: "a result before finished", def: "ValidationRun", base: () => contractFixture("validation-running.json"), edit: (c) => { c.result = "error"; }, expected: "schema:/result:type" },
  { name: "a finish time before finished", def: "ValidationRun", base: () => contractFixture("validation-running.json"), edit: (c) => { c.finished_at = "2026-10-20T14:52:41.093Z"; }, expected: "schema:/finished_at:type" },
  { name: "a settled cost before finished", def: "ValidationRun", base: () => contractFixture("validation-running.json"), edit: (c) => { c.cost_microusd = 120000; }, expected: "schema:/cost_microusd:type" },
  { name: "a finished run without a finish time", def: "ValidationRun", base: () => contractFixture("validation-passed.json"), edit: (c) => { c.finished_at = null; }, expected: "schema:/finished_at:type" },
  { name: "a passed run without a settled cost", def: "ValidationRun", base: () => contractFixture("validation-passed.json"), edit: (c) => { c.cost_microusd = null; }, expected: "schema:/cost_microusd:type" },
  { name: "a passed run without a matrix", def: "ValidationRun", base: () => contractFixture("validation-passed.json"), edit: (c) => { c.matrix = null; }, expected: "schema:/matrix:type" },
  { name: "a matrix before finished", def: "ValidationRun", base: () => contractFixture("validation-running.json"), edit: (c) => { c.matrix = structuredClone(contractFixture("validation-passed.json").matrix ?? null); }, expected: "schema:/matrix:type" },
  { name: "a finished run without a result", def: "ValidationRun", base: () => contractFixture("validation-passed.json"), edit: (c) => { c.result = null; }, expected: "schema:/result:type" },
  { name: "a failed run without a settled cost", def: "ValidationRun", base: () => contractFixture("validation-failed.json"), edit: (c) => { c.cost_microusd = null; }, expected: "schema:/cost_microusd:type" },
  { name: "a failed run without a matrix", def: "ValidationRun", base: () => contractFixture("validation-failed.json"), edit: (c) => { c.matrix = null; }, expected: "schema:/matrix:type" },
  { name: "a run cell with a changed expectation", def: "ValidationRun", base: () => contractFixture("validation-failed.json"), edit: (c) => { at(c, ["matrix", "original_suite", "buggy"]).expected = "fail"; at(c, ["matrix", "original_suite", "buggy"]).matches_expectation = false; }, expected: "schema:/matrix/original_suite/buggy/expected:const" },
  { name: "a passed run with a mismatched cell", def: "ValidationRun", base: () => contractFixture("validation-failed.json"), edit: (c) => { c.result = "passed"; }, expected: "schema:/matrix/verification/buggy/matches_expectation:const" },
  { name: "a failed run with a cell in error", def: "ValidationRun", base: () => contractFixture("validation-error.json"), edit: (c) => { c.result = "failed"; }, expected: ["schema:/matrix/original_suite/clean/observed:enum", "schema:/matrix/verification/clean/observed:enum"] },
  { name: "a failed run whose cells all match", def: "ValidationRun", base: () => contractFixture("validation-passed.json"), edit: (c) => { c.result = "failed"; }, expected: ["schema:/:anyOf", ...["original_suite", "verification"].flatMap((set) => ["clean", "buggy", "fixed"].map((copy) => `schema:/matrix/${set}/${copy}/matches_expectation:const`))] },
  { name: "an error run with six valid cells", def: "ValidationRun", base: () => contractFixture("validation-failed.json"), edit: (c) => { c.result = "error"; }, expected: ["schema:/:anyOf", "schema:/matrix:type", ...["original_suite", "verification"].flatMap((set) => ["clean", "buggy", "fixed"].map((copy) => `schema:/matrix/${set}/${copy}/observed:enum`))] },
  // Test evidence (section 15.1)
  { name: "a validation run holding the slot without its request", def: "TestEvidence", base: evidence, edit: (c) => { Object.assign(at(c, ["slot"]), { holder_request_id: null, holder_validation_id: "00000000-0000-4000-8000-000000000201" }); }, expected: "schema:/slot/holder_request_id:type" },
  ...UNSETTLED_CASES,
  { name: "a reconciled operation without a settled amount", def: "TestEvidence", base: evidence, edit: (c) => { Object.assign(at(c, ["operations", 0]), { state: "reconciled", settled_microusd: null }); }, expected: "schema:/operations/0/settled_microusd:type" },
  { name: "a worker operation on a host", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["operations", 0]).host_id = "umami"; }, expected: "schema:/operations/0/host_id:const" },
  ...(["candidate_copy", "validation", "validation_copy"] as const).map((kind): Case => ({
    name: `a ${kind} operation without a host`, def: "TestEvidence", base: evidence, edit: (c) => { Object.assign(at(c, ["operations", 1]), { kind, host_id: null }); }, expected: ["schema:/operations/1/host_id:type", "schema:/operations/1/host_id:enum"],
  })),
  // Errors (section 12)
  { name: "busy without details", def: "ErrorResponse", base: () => contractFixture("error-busy.json"), edit: (c) => { at(c, ["error"]).details = null; }, expected: "schema:/error/details:type" },
  { name: "an active busy that is not retryable", def: "ErrorResponse", base: () => contractFixture("error-busy.json"), edit: (c) => { at(c, ["error"]).retryable = false; }, expected: "schema:/error/retryable:const" },
  { name: "a reconciliation busy that is retryable", def: "ErrorResponse", base: () => contractFixture("error-busy-needs-reconciliation.json"), edit: (c) => { at(c, ["error"]).retryable = true; }, expected: "schema:/error/retryable:const" },
  { name: "an unavailable that is not retryable", def: "ErrorResponse", base: () => contractFixture("error-unavailable.json"), edit: (c) => { at(c, ["error"]).retryable = false; }, expected: "schema:/error/retryable:const" },
  { name: "details on another code", def: "ErrorResponse", base: () => contractFixture("error-not-found.json"), edit: (c) => { at(c, ["error"]).details = { reason: "active" }; }, expected: "schema:/error/details:type" },
  { name: "a stale interpretation without one", def: "ErrorResponse", base: () => contractFixture("error-interpretation-stale.json"), edit: (c) => { at(c, ["error"]).details = { reason: "active" }; }, expected: ["schema:/error/details:additionalProperties:reason", "schema:/error/details:required:interpretation"] },
  { name: "an unsupported request with a startable interpretation", def: "ErrorResponse", base: () => contractFixture("error-interpretation-stale.json"), edit: (c) => { at(c, ["error"]).code = "unsupported_request"; }, expected: "schema:/error/details/interpretation/startable:const" },
];

const INTERNAL_CASES: Case[] = [
  { name: "a short app commit", def: "BaselineIdentity", base: () => internalFixture("baseline-identity.json"), edit: (c) => { c.app_commit = "ca4a71f"; }, expected: "schema:/app_commit:pattern" },
  { name: "an absolute plant path", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { at(c, ["plant", "targets", 0]).path = "/etc/synthetic"; }, expected: "schema:/plant/targets/0/path:pattern" },
  { name: "a failure code on a catalog entry", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { c.failure_code = "acknowledged_completion_not_counted"; }, expected: "schema:/:additionalProperties:failure_code" },
  { name: "a plant with no target", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { at(c, ["plant"]).targets = []; }, expected: "schema:/plant/targets:minItems" },
  { name: "an unknown repair kind", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { at(c, ["reference_repair"]).kind = "rewrite"; }, expected: "schema:/reference_repair/kind:enum" },
  { name: "an assessed difficulty", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { at(c, ["difficulty"]).status = "assessed"; }, expected: "schema:/difficulty/status:enum" },
  { name: "a catalog entry without presentation text", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { delete c.presentation; }, expected: "schema:/:required:presentation" },
  { name: "an unpinned kit image", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { at(c, ["environment"]).kit_image_digest = null; }, expected: "schema:/environment/kit_image_digest:type" },
  { name: "a protocol state with no valid runs", def: "Protocol", base: () => internalFixture("protocol.json"), edit: (c) => { at(c, ["per_state", "buggy"]).min_valid_runs = 0; }, expected: "schema:/per_state/buggy/min_valid_runs:minimum" },
  { name: "a protocol without a copy state", def: "Protocol", base: () => internalFixture("protocol.json"), edit: (c) => { delete at(c, ["per_state"]).fixed; }, expected: "schema:/per_state:required:fixed" },
  { name: "a file set entry outside its root", def: "BugCaseInputs", base: () => internalFixture("bug-case-inputs.json"), edit: (c) => { at(c, ["source", "files", 0]).path = "../outside.ts"; }, expected: "schema:/source/files/0/path:pattern" },
  { name: "a parent segment inside a file path", def: "BugCaseInputs", base: () => internalFixture("bug-case-inputs.json"), edit: (c) => { at(c, ["source", "files", 0]).path = "src/../../outside.ts"; }, expected: "schema:/source/files/0/path:pattern" },
  { name: "a dot segment in a file path", def: "BugCaseInputs", base: () => internalFixture("bug-case-inputs.json"), edit: (c) => { at(c, ["source", "files", 0]).path = "src/./store.ts"; }, expected: "schema:/source/files/0/path:pattern" },
  { name: "an empty segment in a file path", def: "BugCaseInputs", base: () => internalFixture("bug-case-inputs.json"), edit: (c) => { at(c, ["source", "files", 0]).path = "src//store.ts"; }, expected: "schema:/source/files/0/path:pattern" },
  { name: "a trailing slash in a file path", def: "BugCaseInputs", base: () => internalFixture("bug-case-inputs.json"), edit: (c) => { at(c, ["source", "files", 0]).path = "src/"; }, expected: "schema:/source/files/0/path:pattern" },
  { name: "a backslash in a file path", def: "BugCaseInputs", base: () => internalFixture("bug-case-inputs.json"), edit: (c) => { at(c, ["source", "files", 0]).path = "src\\store.ts"; }, expected: "schema:/source/files/0/path:pattern" },
  { name: "a control character in a file path", def: "BugCaseInputs", base: () => internalFixture("bug-case-inputs.json"), edit: (c) => { at(c, ["source", "files", 0]).path = "src/store\u0000.ts"; }, expected: "schema:/source/files/0/path:pattern" },
  { name: "validator inputs expecting the buggy copy to pass the checks", def: "ValidatorInputs", base: () => internalFixture("validator-inputs.json"), edit: (c) => { at(c, ["expected", "verification"]).buggy = "pass"; }, expected: "schema:/expected/verification/buggy:const" },
  { name: "an unpacked pair without the fixed tree", def: "UnpackedPair", base: () => internalFixture("unpacked-pair.json"), edit: (c) => { delete at(c, ["states"]).fixed; }, expected: "schema:/states:required:fixed" },
  { name: "a copy with network access", def: "CopyPlan", base: () => internalFixture("copy-plan.json"), edit: (c) => { at(c, ["limits"]).network = "host"; }, expected: "schema:/limits/network:const" },
  { name: "a tag in place of a digest", def: "CopyPlan", base: () => internalFixture("copy-plan.json"), edit: (c) => { at(c, ["image"]).digest = "latest"; }, expected: "schema:/image/digest:pattern" },
  { name: "an empty command", def: "CopyPlan", base: () => internalFixture("copy-plan.json"), edit: (c) => { c.command = []; }, expected: "schema:/command:minItems" },
  { name: "a copy plan without destinations", def: "CopyPlan", base: plan, edit: (c) => { delete c.destinations; }, expected: "schema:/:required:destinations" },
  { name: "destinations without the results path", def: "CopyPlan", base: plan, edit: (c) => { delete at(c, ["destinations"]).results; }, expected: "schema:/destinations:required:results" },
  { name: "an unknown destination", def: "CopyPlan", base: plan, edit: (c) => { at(c, ["destinations"]).cache = "/workspace/cache"; }, expected: "schema:/destinations:additionalProperties:cache" },
  { name: "a relative app destination", def: "CopyPlan", base: plan, edit: (c) => { at(c, ["destinations"]).app = "workspace/app"; }, expected: "schema:/destinations/app:pattern" },
  { name: "a parent segment in the evaluator destination", def: "CopyPlan", base: plan, edit: (c) => { at(c, ["destinations"]).evaluator = "/workspace/app/../evaluator"; }, expected: "schema:/destinations/evaluator:pattern" },
  { name: "a trailing slash in the results destination", def: "CopyPlan", base: plan, edit: (c) => { at(c, ["destinations"]).results = "/workspace/results/"; }, expected: "schema:/destinations/results:pattern" },
  { name: "the root as a destination", def: "CopyPlan", base: plan, edit: (c) => { at(c, ["destinations"]).results = "/"; }, expected: "schema:/destinations/results:pattern" },
  { name: "a backslash in a destination", def: "CopyPlan", base: plan, edit: (c) => { at(c, ["destinations"]).app = "/workspace\\app"; }, expected: "schema:/destinations/app:pattern" },
  { name: "copy roots without the evaluator root", def: "CopyRoots", base: roots, edit: (c) => { delete c.evaluator_root; }, expected: "schema:/:required:evaluator_root" },
  { name: "an empty app root", def: "CopyRoots", base: roots, edit: (c) => { c.app_root = ""; }, expected: "schema:/app_root:minLength" },
  { name: "an unknown copy outcome", def: "CollectedCopy", base: collected, edit: (c) => { c.outcome = "crashed"; }, expected: "schema:/outcome:enum" },
  { name: "a fractional exit code", def: "CollectedCopy", base: collected, edit: (c) => { c.exit_code = 1.5; }, expected: "schema:/exit_code:type" },
  { name: "an uppercase results hash", def: "CollectedCopy", base: collected, edit: (c) => { c.results_sha256 = "E8".repeat(32); }, expected: "schema:/results_sha256:pattern" },
  { name: "a collected copy without its results directory", def: "CollectedCopy", base: collected, edit: (c) => { delete c.results_dir; }, expected: "schema:/:required:results_dir" },
  { name: "a results directory without its hash", def: "CollectedCopy", base: collected, edit: (c) => { c.results_sha256 = null; }, expected: "schema:/results_sha256:type" },
  { name: "a results hash without its directory", def: "CollectedCopy", base: () => internalFixture("collected-copy-setup-failed.json"), edit: (c) => { c.results_sha256 = "e8".repeat(32); }, expected: "schema:/results_sha256:type" },
  { name: "an unknown field in a collected copy", def: "CollectedCopy", base: collected, edit: (c) => { c.stdout = "synthetic output"; }, expected: "schema:/:additionalProperties:stdout" },
  { name: "a collected time without milliseconds", def: "CollectedCopy", base: collected, edit: (c) => { c.finished_at = "2026-10-20T14:05:21Z"; }, expected: "schema:/finished_at:pattern" },
  { name: "a tag in place of a collected image digest", def: "CollectedCopy", base: collected, edit: (c) => { c.image_digest = "latest"; }, expected: "schema:/image_digest:pattern" },
  { name: "a collected copy on an unknown architecture", def: "CollectedCopy", base: collected, edit: (c) => { c.architecture = "riscv64"; }, expected: "schema:/architecture:enum" },
  { name: "an unknown architecture", def: "CopyRecord", base: () => internalFixture("copy-record.json"), edit: (c) => { c.architecture = "riscv64"; }, expected: "schema:/architecture:enum" },
  { name: "a suite observation without its counts", def: "CopyRecord", base: () => internalFixture("copy-record.json"), edit: (c) => { delete at(c, ["original_suite"]).executed; }, expected: "schema:/original_suite:required:executed" },
  { name: "an unknown field in a cell observation", def: "CopyRecord", base: () => internalFixture("copy-record.json"), edit: (c) => { at(c, ["verification"]).expected = "fail"; }, expected: "schema:/verification:additionalProperties:expected" },
  { name: "a complete record without its evidence hash", def: "CopyRecord", base: () => internalFixture("copy-record.json"), edit: (c) => { c.evidence_sha256 = null; }, expected: "schema:/evidence_sha256:type" },
  { name: "an uppercase evidence hash", def: "CopyRecord", base: () => internalFixture("copy-record-setup-failed.json"), edit: (c) => { c.evidence_sha256 = "E8".repeat(32); }, expected: "schema:/evidence_sha256:pattern" },
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

/** Values the contract allows that a stricter schema could wrongly refuse. */
const ACCEPTED: Case[] = [
  { name: "an unsupported pair with a declared source", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["combinations", 0]).source = structuredClone(at(c, ["combinations", 1, "source"])); }, expected: [] },
  { name: "an unsupported pair whose declared source has no entries", def: "Capabilities", base: capabilities, edit: (c) => { at(c, ["combinations", 0]).source = { ...structuredClone(at(c, ["combinations", 1, "source"])), entries: 0 }; }, expected: [] },
  { name: "capabilities that list their hosts, bug types, pairs and difficulty options in another order", def: "Capabilities", base: capabilities, edit: (c) => { for (const field of ["hosts", "bug_types", "combinations", "difficulty_options"]) asArray(c[field], field).reverse(); }, expected: [] },
  { name: "an untrimmed description in a start request", def: "StartRequest", base: start, edit: (c) => { at(c, ["input", "items", 0]).description = "  lost update\n"; }, expected: [] },
  { name: "an empty description in a start request", def: "StartRequest", base: start, edit: (c) => { at(c, ["input", "items", 0]).description = ""; }, expected: [] },
  { name: "a blank description in an interpretation request", def: "RequestInput", base: () => at(start(), ["input"]), edit: (c) => { at(c, ["items", 0]).description = " \t\n "; }, expected: [] },
  { name: "an overrun after the request finished, with its outcome kept", def: "RequestStatus", base: fulfilled, edit: (c) => { const budget = at(c, ["budget"]); const spent = Number(budget.budget_microusd) + 10000; Object.assign(budget, { reserved_microusd: 0, spent_microusd: spent, committed_microusd: spent, remaining_microusd: -10000, overrun: true }); c.attention = { code: "needs_reconciliation", message: "x" }; }, expected: [] },
  { name: "a queued validation run", def: "ValidationRun", base: () => contractFixture("validation-running.json"), edit: (c) => { Object.assign(c, { state: "queued", started_at: null }); }, expected: [] },
  { name: "a package part outside a case that is not ready and has no download path", def: "PackagePart", base: () => at(fulfilled(), ["cases", 0, "packages", "bug_case"]), edit: (c) => { Object.assign(c, { ready: false, download_path: null }); }, expected: [] },
  { name: "a finished error run whose spend is uncertain", def: "ValidationRun", base: () => contractFixture("validation-error.json"), edit: (c) => { c.cost_microusd = null; }, expected: [] },
  { name: "test evidence with a free slot and a reconciled operation", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["slot"]).holder_request_id = null; Object.assign(at(c, ["operations", 0]), { state: "reconciled", settled_microusd: 200000 }); }, expected: [] },
  { name: "a validation run holding the slot for its request", def: "TestEvidence", base: evidence, edit: (c) => { at(c, ["slot"]).holder_validation_id = "00000000-0000-4000-8000-000000000201"; }, expected: [] },
  { name: "a settled operation: terminal with a settled amount", def: "TestEvidence", base: evidence, edit: (c) => { Object.assign(at(c, ["operations", 0]), { state: "terminal", settled_microusd: 180000 }); }, expected: [] },
  { name: "a terminal operation not yet settled", def: "TestEvidence", base: evidence, edit: (c) => { Object.assign(at(c, ["operations", 0]), { state: "terminal", settled_microusd: null }); }, expected: [] },
  { name: "a reconciled operation settled at zero", def: "TestEvidence", base: evidence, edit: (c) => { Object.assign(at(c, ["operations", 0]), { state: "reconciled", settled_microusd: 0 }); }, expected: [] },
  ...HOST_ID_VALUES.map((host): Case => ({ name: `a validation run and its copy on ${host}`, def: "TestEvidence", base: evidence, edit: (c) => { Object.assign(at(c, ["operations", 2]), { kind: "validation", host_id: host }); Object.assign(at(c, ["operations", 3]), { kind: "validation_copy", host_id: host }); }, expected: [] })),
  { name: "a provider call that stops a copy's job", def: "TestEvidence", base: evidence, edit: (c) => { asArray(c.provider_calls, "provider_calls").push({ ...at(c, ["provider_calls", 1]), action: "stop", at: "2026-10-20T19:02:00.000Z" }); }, expected: [] },
  { name: "a description with a line break", def: "StartRequest", base: start, edit: (c) => { at(c, ["input", "items", 0]).description = "lost update\nwhen two requests overlap"; }, expected: [] },
  { name: "a negative remaining amount on an overrun", def: "RequestStatus", base: status("status-operational-error.json"), edit: (c) => { Object.assign(at(c, ["budget"]), { spent_microusd: 1200000, committed_microusd: 1700000, remaining_microusd: -700000, overrun: true }); }, expected: [] },
  { name: "an error run without a matrix", def: "ValidationRun", base: () => contractFixture("validation-error.json"), edit: (c) => { c.matrix = null; }, expected: [] },
  { name: "a requested_criteria_passed event with two distinct criteria", def: "RequestStatus", base: fulfilled, edit: (c) => { at(c, ["events", 16, "data"]).criterion_ids = ["concurrency.lost-acknowledged-change", "concurrency.stale-success-response"]; }, expected: [] },
  { name: "a candidate rejected after its assignment that keeps its item", def: "RequestStatus", base: status("status-zero-result.json"), edit: (c) => { Object.assign(at(c, ["candidates", 0]), { item_key: "date-time-1", reason: { code: "export_mismatch", message: "x" } }); Object.assign(at(c, ["funnel"]), { behavior_checks_passed: 1, requested_criteria_passed: 1 }); }, expected: [] },
  ...BUG_TYPE_ID_VALUES.flatMap((type): Case[] => {
    const other = type === FIRST_TYPE ? SECOND_TYPE : FIRST_TYPE;
    return [
      { name: `a ${type} total of zero in an interpretation whose items request no ${type}`, def: "Interpretation", base: asFor(other, SECOND_TYPE, interpretation("interpretation-budget-below-minimum.json"), typesSwapped), edit: (c) => { asArray(c.type_totals, "type_totals").push({ bug_type_id: type, quantity: 0 }); }, expected: [] },
      { name: `a ${type} total of zero in a status whose items request no ${type}`, def: "RequestStatus", base: asFor(other, SECOND_TYPE, status("status-zero-result.json"), typesSwapped), edit: (c) => { asArray(c.type_totals, "type_totals").push({ bug_type_id: type, requested: 0, delivered: 0, missing: 0 }); }, expected: [] },
    ];
  }),
  { name: "a request-level host_unused for a selected host that serves no item", def: "Interpretation", base: supported, edit: (c) => { at(c, ["items", 1]).eligible_sources = structuredClone(asArray(at(c, ["items", 0]).eligible_sources, "eligible_sources")); c.problems = [problem("host_unused", "warning", null)]; }, expected: [] },
  { name: "an item-level host_unused for a selected host that serves no item", def: "Interpretation", base: supported, edit: (c) => { at(c, ["items", 1]).eligible_sources = structuredClone(asArray(at(c, ["items", 0]).eligible_sources, "eligible_sources")); at(c, ["items", 1]).problems = [problem("host_unused", "warning", "date-time-1")]; }, expected: [] },
  { name: "host_unused for a selected host that only unsupported items draw from", def: "Interpretation", base: unsupported, edit: (c) => { asArray(c.items, "items").splice(4, 1); asArray(c.problems, "problems").push(problem("host_unused", "warning", null)); }, expected: [] },
  { name: "worst cases without a selected host that serves no item", def: "Interpretation", base: supported, edit: (c) => { at(c, ["items", 1]).eligible_sources = structuredClone(asArray(at(c, ["items", 0]).eligible_sources, "eligible_sources")); c.problems = [problem("host_unused", "warning", null)]; for (const list of ["worst_case_per_candidate_microusd", "worst_case_per_validation_microusd"]) { const entries = asArray(at(c, ["budget"])[list], list); entries.splice(listIndex(entries, "host_id", FIRST_HOST), 1); } }, expected: [] },
  // Section 11 reserves from the frozen interpretation, which is startable, and the document does not say which hosts the list covers otherwise.
  ...HOST_ID_VALUES.map((host): Case => ({ name: `validation worst cases without ${host}, which a supported item draws from, in an interpretation that is not startable`, def: "Interpretation", base: asFor(host, SECOND_HOST, unsupported, hostsSwapped), edit: (c) => { const entries = asArray(at(c, ["budget"]).worst_case_per_validation_microusd, "worst_case_per_validation_microusd"); entries.splice(listIndex(entries, "host_id", host), 1); }, expected: [] })),
  { name: "a published example at a site-relative path outside the live routes", def: "ExampleResponse", base: () => contractFixture("example.json"), edit: (c) => { at(c, ["case", "packages", "bug_case"]).download_path = "/published/factory-examples/rbw-bug-case-cacacacacaca-v1.tar.gz"; at(c, ["case", "packages", "validator"]).download_path = "/published/factory-examples/rbw-validator-cacacacacaca-v1.tar.gz"; }, expected: [] },
  { name: "unmatched text with inner punctuation, letters outside ASCII and a single digit", def: "Interpretation", base: unsupported, edit: (c) => { at(c, ["items", 1]).unmatched_text = ["après une reprise, réseau", "2"]; }, expected: [] },
  { name: "a later page with no new events", def: "RequestStatus", base: fulfilled, edit: (c) => { c.events = []; }, expected: [] },
  { name: "a stop recorded before the request finished", def: "RequestStatus", base: status("status-cancelled.json"), edit: (c) => { c.state = "stopping"; c.outcome = null; c.stop_reason = null; c.events = asArray(c.events, "events").slice(0, 24); c.next_after = 24; at(c, ["candidates", 1]).stage = "checking"; at(c, ["candidates", 1]).reason = null; }, expected: [] },
  { name: "a description covered only by filler phrases", def: "Interpretation", base: () => contractFixture("interpretation-supported.json"), edit: (c) => { at(c, ["items", 0]).criteria = []; }, expected: [] },
  { name: "a bracketed route segment in a plant target", def: "CatalogEntry", base: () => internalFixture("catalog-entry.json"), edit: (c) => { at(c, ["plant", "targets", 0]).path = "src/app/api/synthetic/[syntheticId]/route.ts"; }, expected: [] },
  { name: "route groups and a dotfile in a file set", def: "BugCaseInputs", base: () => internalFixture("bug-case-inputs.json"), edit: (c) => { asArray(at(c, ["source"]).files, "files").push({ path: "src/app/(main)/synthetic/[syntheticId]/(reports)/Synthetic Page.tsx", sha256: "a".repeat(64) }, { path: ".gitignore", sha256: "b".repeat(64) }, { path: ".synthetic/@scope/a+b..c.ts", sha256: "c".repeat(64) }); }, expected: [] },
  { name: "destinations with dot-prefixed and spaced segments", def: "CopyPlan", base: plan, edit: (c) => { Object.assign(at(c, ["destinations"]), { app: "/workspace/.rbw/app", evaluator: "/opt/rbw evaluator/v1.0", results: "/workspace/..results" }); }, expected: [] },
  { name: "a timed-out copy with an exit code and partial results", def: "CollectedCopy", base: collected, edit: (c) => { Object.assign(c, { outcome: "timed_out", exit_code: 137 }); }, expected: [] },
  { name: "a timed-out copy with no exit code and no results", def: "CollectedCopy", base: collected, edit: (c) => { Object.assign(c, { outcome: "timed_out", exit_code: null, results_dir: null, results_sha256: null }); }, expected: [] },
  { name: "an incomplete record of a timed-out copy that brought back no results", def: "CopyRecord", base: () => internalFixture("copy-record.json"), edit: (c) => { Object.assign(c, { status: "incomplete", evidence_sha256: null }); }, expected: [] },
  { name: "an invalid record whose copy brought back results", def: "CopyRecord", base: () => internalFixture("copy-record-setup-failed.json"), edit: (c) => { c.evidence_sha256 = "e8".repeat(32); }, expected: [] },
  { name: "a dotfile in a copy plan", def: "CopyPlan", base: () => internalFixture("copy-plan.json"), edit: (c) => { asArray(c.files, "files").push({ path: ".eslintrc.json", sha256: "d".repeat(64) }); }, expected: [] },
];

describe("accepts what the contract allows", () => {
  it.each(ACCEPTED.map((item) => [item.name, item] as const))("%s", (_name, item) => {
    expect(validateContract(item.def, variant(item.base(), item.edit))).toEqual([]);
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
