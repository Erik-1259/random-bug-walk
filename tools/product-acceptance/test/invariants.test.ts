import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkCriteriaEvents, checkStatus, checkValidation, object, objects } from "../src/invariants.ts";
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
function at(value: unknown, index = 0) { const item = objects(value)[index]; assert(item); return item; }
describe("pinned revision 2 response invariants (runner self-tests only)", () => {
  for (const name of ["queued", "running", "fulfilled", "exhausted", "duplicate-defect", "partial-budget", "cancelled", "operational-error", "zero-result", "wrong-failure"]) {
    it(`accepts published status-${name}`, () => { expect(() => { checkStatus(fixture(`status-${name}`)); }).not.toThrow(); });
  }
  for (const name of ["running", "passed", "failed", "error"]) {
    it(`accepts published validation-${name}`, () => { expect(() => { checkValidation(fixture(`validation-${name}`)); }).not.toThrow(); });
  }
  const corruptions: [string, (value: Record<string, unknown>) => void][] = [
    ["wrong missing count", v => { at(v.items, 0).missing = 9; }],
    ["unselected host", v => { at(v.cases).host_id = "synthetic-other-host"; }],
    ["wrong source", v => { object(at(v.cases).provenance).source_id = "synthetic-other-source"; }],
    ["cross-item delivery", v => { at(v.cases, 0).item_key = "synthetic-other"; }],
    ["duplicate defect", v => { at(v.cases, 1).defect_id = at(v.cases, 0).defect_id; }],
    ["per-host budget", v => { object(v.budget).budget_microusd = 4000000; }],
    ["incorrect remaining", v => { object(v.budget).remaining_microusd = 0; }],
    ["unqualified delivery", v => { object(at(v.cases, 0).qualification).verdict = "rejected"; }],
    ["hidden reference repair", v => { at(v.cases, 0).reference_repair = "synthetic-patch"; }],
    ["download before ready", v => { object(object(at(v.cases, 0).packages).bug_case).ready = false; }],
    ["swapped package", v => { object(object(at(v.cases, 0).packages).validator).kind = "bug_case"; }],
    ["wrong terminal reason", v => { object(v.stop_reason).code = "worker_lost"; }],
    ["rejected candidate counted", v => { at(v.candidates, 0).stage = "rejected"; }],
    ["wrong requested quantity", v => { at(v.items, 0).requested = 2; }],
  ];
  for (const [name, mutate] of corruptions) it(`rejects ${name}`, () => {
    const value = object(fixture("status-fulfilled")); mutate(value);
    expect(() => { checkStatus(value); }).toThrow();
  });
  it("rejects a pending validation labeled passed", () => {
    const v = object(fixture("validation-running")); v.result = "passed";
    expect(() => { checkValidation(v); }).toThrow();
  });
  it("rejects failed validation labeled passed", () => {
    const v = object(fixture("validation-failed")); v.result = "passed";
    expect(() => { checkValidation(v); }).toThrow();
  });
});
it("does not force a completed count to override an earlier cancellation", () => {
  const value = object(fixture("status-fulfilled"));
  value.outcome = "cancelled"; value.stop_reason = { code: "cancelled_by_user", message: "synthetic cancellation" };
  expect(() => { checkStatus(value); }).not.toThrow();
});
it("treats case ID lists as sets when the contract does not specify their order", () => {
  const value = object(fixture("status-fulfilled"));
  objects(value.items).reverse();
  expect(() => { checkStatus(value); }).not.toThrow();
});
for (const set of ["original_suite", "verification"]) for (const copy of ["clean", "buggy", "fixed"]) {
  for (const kind of ["case", "validation"]) it(`rejects rewritten ${kind} expectation for ${set}.${copy}`, () => {
    const value = object(fixture(kind === "case" ? "status-fulfilled" : "validation-passed"));
    const target = kind === "case" ? at(value.cases) : value;
    const cell = object(object(object(target.matrix)[set])[copy]);
    cell.expected = cell.expected === "pass" ? "fail" : "pass";
    cell.observed = cell.expected;
    cell.matches_expectation = true;
    expect(() => { if (kind === "case") checkStatus(value); else checkValidation(value); }).toThrow();
  });
}
it("rejects unrelated type totals even when their count matches requested types", () => {
  const value = object(fixture("status-fulfilled"));
  value.type_totals = objects(value.type_totals).map((_total, index) => ({
    bug_type_id: `synthetic-unrequested-${String(index)}`, requested: 0, delivered: 0, missing: 0,
  }));
  expect(() => { checkStatus(value); }).toThrow();
});
it("accepts a zero-count row for an unrequested known type", () => {
  const value = object(fixture("status-zero-result"));
  value.type_totals = [...objects(value.type_totals), { bug_type_id: "concurrency", requested: 0, delivered: 0, missing: 0 }];
  expect(() => { checkStatus(value); }).not.toThrow();
});
it.each(["requested", "delivered", "missing"])("rejects an unrequested type with nonzero %s", field => {
  const value = object(fixture("status-zero-result"));
  value.type_totals = [...objects(value.type_totals), { bug_type_id: "concurrency", requested: 0, delivered: 0, missing: 0, [field]: 1 }];
  expect(() => { checkStatus(value); }).toThrow();
});
it("rejects an unknown zero-count type", () => {
  const value = object(fixture("status-zero-result"));
  value.type_totals = [...objects(value.type_totals), { bug_type_id: "synthetic-unknown", requested: 0, delivered: 0, missing: 0 }];
  expect(() => { checkStatus(value); }).toThrow("unknown type total");
});
it("requires every requested type even when an allowed zero-count type is present", () => {
  const value = object(fixture("status-zero-result"));
  value.type_totals = [{ bug_type_id: "concurrency", requested: 0, delivered: 0, missing: 0 }];
  expect(() => { checkStatus(value); }).toThrow("missing requested type total");
});
it("rejects duplicate type total identities", () => {
  const value = object(fixture("status-zero-result"));
  value.type_totals = [...objects(value.type_totals), structuredClone(at(value.type_totals))];
  expect(() => { checkStatus(value); }).toThrow("duplicate identity");
});
it("requires a demonstrated criterion for a case whose item has no description", () => {
  const value = object(fixture("status-fulfilled"));
  at(value.cases, 1).criteria_met = [];
  expect(() => { checkStatus(value); }).toThrow("case has no demonstrated criterion");
});
it.each(["same-version", "different-version"])("rejects duplicate demonstrated criterion IDs with %s", version => {
  const value = object(fixture("status-fulfilled"));
  const c = at(value.cases, 1);
  const duplicate = structuredClone(at(c.criteria_met));
  if (version === "different-version") duplicate.version = "synthetic-other-version";
  c.criteria_met = [...objects(c.criteria_met), duplicate];
  expect(() => { checkStatus(value); }).toThrow("duplicate identity");
});
it.each(["passed", "failed"])("requires a recorded cost for a finished %s validation", result => {
  const value = object(fixture(`validation-${result}`));
  value.cost_microusd = null;
  expect(() => { checkValidation(value); }).toThrow("completed validation has no recorded cost");
});
it("preserves null cost for a finished validation with uncertain spend", () => {
  const value = object(fixture("validation-error"));
  value.cost_microusd = null;
  expect(() => { checkValidation(value); }).not.toThrow();
  expect(value.cost_microusd).toBeNull();
});
it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "synthetic-cost"])("rejects invalid completed validation cost %s", cost => {
  const value = object(fixture("validation-error"));
  value.cost_microusd = cost;
  expect(() => { checkValidation(value); }).toThrow();
});
it("checks delivered criteria against the complete event history", () => {
  const value = object(fixture("status-fulfilled"));
  expect(() => { checkCriteriaEvents(value, value.events, true); }).not.toThrow();
});
it("accepts a status page that omits earlier criterion events", () => {
  const value = object(fixture("status-fulfilled"));
  value.events = [];
  expect(() => { checkStatus(value); }).not.toThrow();
});
for (const host of ["task-report", "umami"]) for (const set of ["original_suite", "verification"]) for (const copy of ["clean", "buggy", "fixed"]) {
  it.each(["runs_valid", "runs_total"])(`binds qualification matrix ${host}/${set}/${copy} %s to its check event`, field => {
    const value = object(fixture("status-fulfilled"));
    const delivered = objects(value.cases).find(c => c.host_id === host); assert(delivered);
    const cell = object(object(object(delivered.matrix)[set])[copy]);
    cell[field] = Number(cell[field]) + (field === "runs_valid" ? -1 : 1);
    expect(() => { checkStatus(value); }).toThrow("qualification matrix differs from check transition");
  });
}
it("accepts qualification matrix checks across partial status pages", () => {
  const value = object(fixture("status-fulfilled"));
  const check = objects(value.events).find(event => event.type === "check_finished"); assert(check);
  value.events = [check];
  expect(() => { checkStatus(value); }).not.toThrow();
});
it("accepts qualification matrix run counts that agree with a different declared protocol", () => {
  const value = object(fixture("status-fulfilled"));
  for (const delivered of objects(value.cases)) {
    object(delivered.repetition).protocol_id = "synthetic-other-protocol";
    for (const set of ["original_suite", "verification"]) for (const copy of ["clean", "buggy", "fixed"]) {
      const cell = object(object(object(delivered.matrix)[set])[copy]); cell.runs_valid = 7; cell.runs_total = 9;
    }
  }
  for (const event of objects(value.events).filter(event => event.type === "check_finished")) {
    object(event.data).runs_valid = 7; object(event.data).runs_total = 9;
  }
  expect(() => { checkStatus(value); }).not.toThrow();
});
it("accepts a criterion event before its case is ready", () => {
  const value = object(fixture("status-fulfilled"));
  const event = objects(value.events).find(e => e.type === "requested_criteria_passed"); assert(event);
  value.state = "running";
  value.cases = [];
  for (const candidate of objects(value.candidates)) { candidate.case_id = null; candidate.stage = "packaging"; }
  expect(() => { checkCriteriaEvents(value, [event]); }).not.toThrow();
});
it.each(["empty", "duplicate", "non-string"])("rejects %s criterion IDs on an observed page", kind => {
  const value = object(fixture("status-fulfilled"));
  const event = objects(value.events).find(e => e.type === "requested_criteria_passed"); assert(event);
  object(event.data).criterion_ids = kind === "empty" ? [] : kind === "duplicate" ? ["synthetic-criterion", "synthetic-criterion"] : [1];
  value.events = [event];
  expect(() => { checkStatus(value); }).toThrow();
});
it("rejects event criteria that differ from the delivered case", () => {
  const value = object(fixture("status-fulfilled"));
  const event = objects(value.events).find(e => e.type === "requested_criteria_passed"); assert(event);
  object(event.data).criterion_ids = ["synthetic-other-criterion"];
  expect(() => { checkCriteriaEvents(value, value.events, true); }).toThrow("event criteria differ from delivered case");
});
it("requires the delivered case's criterion event in complete terminal history", () => {
  const value = object(fixture("status-fulfilled"));
  const history = objects(value.events).filter(e => e.type !== "requested_criteria_passed");
  expect(() => { checkCriteriaEvents(value, history, true); }).toThrow("delivered case has no criterion event");
});
it("rejects an empty criterion identity even when the case and event agree", () => {
  const value = object(fixture("status-fulfilled"));
  const c = at(value.cases, 1);
  at(c.criteria_met).criterion_id = "";
  const candidate = objects(value.candidates).find(candidate => candidate.case_id === c.case_id); assert(candidate);
  const event = objects(value.events).find(event => event.type === "requested_criteria_passed" && event.candidate_id === candidate.candidate_id); assert(event);
  object(event.data).criterion_ids = [""];
  expect(() => { checkStatus(value); }).toThrow("empty criterion identity");
});
it("rejects an empty criterion identity before a case is delivered", () => {
  const value = object(fixture("status-fulfilled"));
  const event = objects(value.events).find(e => e.type === "requested_criteria_passed"); assert(event);
  object(event.data).criterion_ids = [""];
  value.state = "running";
  value.cases = [];
  expect(() => { checkCriteriaEvents(value, [event]); }).toThrow("empty criterion identity");
});
it.each(["wrong-type", "unknown", "unknown-version"])("rejects internally consistent %s demonstrated criteria for a no-description item", change => {
  const value = object(fixture("status-fulfilled"));
  const c = at(value.cases, 1);
  const criterion = at(c.criteria_met);
  if (change === "wrong-type") criterion.criterion_id = "concurrency.lost-acknowledged-change";
  if (change === "unknown") criterion.criterion_id = "synthetic-unknown-criterion";
  if (change === "unknown-version") criterion.version = "synthetic-unknown-version";
  const candidate = objects(value.candidates).find(candidate => candidate.case_id === c.case_id); assert(candidate);
  const event = objects(value.events).find(event => event.type === "requested_criteria_passed" && event.candidate_id === candidate.candidate_id); assert(event);
  object(event.data).criterion_ids = [criterion.criterion_id];
  expect(() => { checkStatus(value); }).toThrow("demonstrated criterion is not in the pinned bug type catalog");
});

it.each(["host_id", "bug_type_id", "source_id", "entry_id"])("binds delivered case %s to its qualified candidate", field => {
  const value = object(fixture("status-fulfilled"));
  const c = at(value.cases);
  const candidate = objects(value.candidates).find(candidate => candidate.case_id === c.case_id); assert(candidate);
  // Keep the case eligible for its unchanged interpretation; only its linked
  // candidate's identity disagrees. Entry identity has no eligibility shortcut.
  if (field === "host_id") candidate.host_id = "umami";
  if (field === "bug_type_id") candidate.bug_type_id = "date_time";
  if (field === "source_id") candidate.source_id = "synthetic-other-source";
  if (field === "entry_id") object(c.provenance).entry_id = "synthetic-other-entry";
  expect(() => { checkStatus(value); }).toThrow("qualified candidate");
});
it.each(["before", "after"])("rejects a second qualified candidate for one delivered case when listed %s it", order => {
  const value = object(fixture("status-fulfilled"));
  const duplicate = structuredClone(at(value.candidates));
  duplicate.candidate_id = "07".repeat(32);
  duplicate.entry_id = "synthetic-another-entry";
  value.candidates = order === "before" ? [duplicate, ...objects(value.candidates)] : [...objects(value.candidates), duplicate];
  expect(() => { checkStatus(value); }).toThrow("multiple qualified candidates");
});
it("rejects a qualified candidate whose case is absent while other delivered cases remain", () => {
  const value = object(fixture("status-fulfilled"));
  const orphan = structuredClone(at(value.candidates));
  orphan.candidate_id = "07".repeat(32); orphan.defect_id = "08".repeat(32); orphan.case_id = "09".repeat(32);
  orphan.entry_id = "synthetic-other-entry";
  value.candidates = [...objects(value.candidates), orphan];
  expect(() => { checkStatus(value); }).toThrow("qualified candidate has no delivered case");
});
it("preserves opaque case and candidate identities when their relationships agree", () => {
  const value = object(fixture("status-fulfilled"));
  const candidate = at(value.candidates);
  const replacements = [[candidate.candidate_id, "07".repeat(32)], [candidate.defect_id, "08".repeat(32)], [candidate.case_id, "09".repeat(32)]];
  let serialized = JSON.stringify(value);
  for (const [prior, next] of replacements) {
    assert(typeof prior === "string" && typeof next === "string");
    serialized = serialized.replaceAll(prior, next);
  }
  expect(() => { checkStatus(JSON.parse(serialized) as unknown); }).not.toThrow();
});

for (const [host, baseline, otherBaseline] of [
  ["task-report", "task-report@ca4a71f", "umami@ec0ff503"],
  ["umami", "umami@ec0ff503", "task-report@ca4a71f"],
] as const) {
  it.each(["other-host", "unknown"])(`rejects %s baseline metadata on a delivered ${host} case`, change => {
    const value = object(fixture("status-fulfilled"));
    const c = objects(value.cases).find(c => c.host_id === host); assert(c);
    c.baseline_id = change === "other-host" ? otherBaseline : "synthetic-baseline@0000000";
    expect(() => { checkStatus(value); }).toThrow("case baseline differs from pinned host");
  });
  it(`accepts the pinned baseline on a delivered ${host} case`, () => {
    const value = object(fixture("status-fulfilled"));
    const c = objects(value.cases).find(c => c.host_id === host); assert(c);
    expect(c.baseline_id).toBe(baseline);
    expect(() => { checkStatus(value); }).not.toThrow();
  });
}
