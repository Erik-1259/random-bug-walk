import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkStatus, checkValidation, object, objects } from "../src/invariants.ts";
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
function at(value: unknown, index = 0) { const item = objects(value)[index]; assert(item); return item; }
describe("pinned revision 1 response invariants (runner self-tests only)", () => {
  for (const name of ["queued", "running", "fulfilled", "exhausted", "duplicate-defect", "partial-budget", "cancelled", "operational-error", "zero-result"]) {
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
