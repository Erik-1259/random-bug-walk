import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { contractRevision, runValidation, type IsolatedBackend, type Reply } from "../src/runner.ts";
import { integer, object, objects, text } from "../src/invariants.ts";

const fixture = (name: string) => object(JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8")) as unknown);
function first<T>(values: T[]): T { const value = values[0]; assert(value); return value; }

// Synthetic transport responses test the runner's rejection behavior, not a backend.
function scenario(result: "failed" | "error" = "failed") {
  const before = fixture("status-fulfilled");
  const budget = object(before.budget);
  budget.spent_microusd = 1_100_000; budget.committed_microusd = 1_100_000; budget.remaining_microusd = 900_000;
  const c = first(objects(before.cases));
  const cost = c.host_id === "task-report" ? 200_000 : 300_000;
  const run = fixture(`validation-${result}`);
  run.case_id = c.case_id; run.cost_microusd = cost;
  run.package_sha256 = { bug_case: object(object(c.packages).bug_case).sha256, validator: object(object(c.packages).validator).sha256 };
  const after = structuredClone(before);
  first(objects(after.cases)).validation = run;
  Object.assign(object(after.budget), { spent_microusd: 1_100_000 + cost, committed_microusd: 1_100_000 + cost, remaining_microusd: 900_000 - cost });
  const history = objects(before.events);
  const event = (type: string, data: Record<string, unknown>, ordinal: number) => ({
    ...first(history), seq: history.length + ordinal, type, data, host_id: c.host_id, item_key: c.item_key,
    case_id: c.case_id, candidate_id: null, message: "synthetic validation event",
  });
  const reserve = event("budget_updated", { reserved_microusd: cost, spent_microusd: 1_100_000, remaining_microusd: 900_000 - cost }, 1);
  const started = event("validation_started", { validation_id: run.validation_id }, 2);
  const finished = event("validation_finished", { validation_id: run.validation_id, result }, 3);
  const settled = event("budget_updated", { reserved_microusd: 0, spent_microusd: 1_100_000 + cost, remaining_microusd: 900_000 - cost }, 4);
  for (const e of [reserve, settled]) { e.host_id = null; e.item_key = null; e.case_id = null; }
  after.events = [...structuredClone(history), reserve, started, finished, settled]; after.next_after = history.length + 4;
  const operations = [200_000, 100_000, 100_000, 100_000, 200_000, 200_000, 200_000].map((amount, index) => ({
    operation_id: (index + 1).toString(16).padStart(64, "0"), kind: index === 0 ? "worker" : "candidate_copy",
    call_name: `synthetic-operation-${String(index)}`, state: "terminal", reserved_microusd: amount, settled_microusd: amount, attempt_ordinal: 1,
  }));
  const prior = { contract_version: "bug-request/1", request_id: before.request_id, operations,
    slot: { slot_key: "factory", holder_request_id: null, holder_validation_id: null },
    provider_calls: operations.map(op => ({ call_name: op.call_name, provider: "sandbox", action: "create", at: before.created_at })),
  };
  const evidence: Record<string, unknown> = structuredClone(prior);
  evidence.operations = [...structuredClone(operations), { operation_id: "ab".repeat(32), kind: "validation", call_name: "synthetic-validation", state: "terminal", reserved_microusd: cost, settled_microusd: cost, attempt_ordinal: 1 }];
  evidence.provider_calls = [...structuredClone(prior.provider_calls), { call_name: "synthetic-validation", provider: "sandbox", action: "create", at: before.created_at }];
  let accepted = false;
  const path = `/api/factory/requests/${text(before.request_id)}`;
  const request = vi.fn((method: "GET" | "POST", target: string, payload?: unknown): Promise<Reply> => {
    if (method === "POST") {
      accepted = true;
      run.validation_id = object(payload).validation_id;
      started.data.validation_id = run.validation_id; finished.data.validation_id = run.validation_id;
      return Promise.resolve({ status: 202, body: { ...run, state: "running", result: null, matrix: null, cost_microusd: null, finished_at: null } });
    }
    if (target.includes("/validations/")) return Promise.resolve({ status: 200, body: run });
    if (target.includes("/test/evidence?")) return Promise.resolve({ status: 200, body: accepted ? evidence : prior });
    assert(target.startsWith(path));
    const cursor = Number(target.split("?after=")[1] ?? 0);
    const page = structuredClone(after);
    page.events = objects(after.events).filter(e => integer(e.seq) > cursor).slice(0, 7);
    page.next_after = objects(page.events).at(-1)?.seq ?? cursor;
    return Promise.resolve({ status: 200, body: page });
  });
  const backend: IsolatedBackend = { request, verifyIsolation: () => Promise.resolve({ backendRevision: "a".repeat(40), contractRevision }), wait: () => Promise.resolve(), reconnect: () => Promise.resolve() };
  return { before, after, run, evidence, prior, backend, request, cost, started, finished, reserve, settled };
}

it.each(["failed", "error"] as const)("checks completed %s validation accounting and slot evidence", async result => {
  const s = scenario(result);
  await expect(runValidation(s.backend, s.before, result)).resolves.toBeUndefined();
  expect(s.request.mock.calls.filter(([, path]) => path.includes("/test/evidence?"))).toHaveLength(2);
  expect(s.request.mock.calls.some(([method, path]) => method === "GET" && path.includes("?after="))).toBe(true);
});

it.each(["missing-field", "null-cost", "discounted-cost"])("rejects %s on the completed named validation", async change => {
  const s = scenario("error");
  if (change === "missing-field") delete s.run.finished_at;
  else s.run.cost_microusd = change === "null-cost" ? null : 40_000;
  await expect(runValidation(s.backend, s.before, "error")).rejects.toThrow();
});

it.each(["missing-charge", "retained-reservation", "retained-slot", "stale-validation", "changed-target", "changed-other-case", "changed-outcome"])("rejects %s after validation completion", async change => {
  const s = scenario();
  if (change === "missing-charge") s.after.budget = structuredClone(s.before.budget);
  if (change === "retained-reservation") Object.assign(object(s.after.budget), { reserved_microusd: s.cost, spent_microusd: 1_100_000 });
  if (change === "retained-slot") { object(s.evidence.slot).holder_request_id = s.before.request_id; object(s.evidence.slot).holder_validation_id = s.run.validation_id; }
  if (change === "stale-validation") first(objects(s.after.cases)).validation = null;
  if (change === "changed-target") first(objects(s.after.cases)).title = "synthetic changed target";
  if (change === "changed-other-case") { const other = objects(s.after.cases)[1]; assert(other); other.title = "synthetic changed other case"; }
  if (change === "changed-outcome") { s.after.outcome = "sources_exhausted"; s.after.stop_reason = { code: "sources_exhausted", message: "synthetic changed outcome" }; }
  await expect(runValidation(s.backend, s.before, "failed")).rejects.toThrow();
});

it.each(["prior-event", "validation-started", "validation-finished", "reservation-event", "settlement-event", "wrong-result", "wrong-case", "wrong-reservation"])("rejects %s validation event history", async change => {
  const s = scenario();
  if (change === "prior-event") first(objects(s.after.events)).message = "synthetic changed earlier event";
  const removals: Record<string, Record<string, unknown>> = { "validation-started": s.started, "validation-finished": s.finished, "reservation-event": s.reserve, "settlement-event": s.settled };
  const removed = removals[change];
  if (removed !== undefined) {
    s.after.events = objects(s.after.events).filter(event => event !== removed).map((event, index) => ({ ...event, seq: index + 1 }));
    s.after.next_after = objects(s.after.events).length;
  }
  if (change === "wrong-result") s.finished.data.result = "passed";
  if (change === "wrong-case") s.finished.case_id = "ac".repeat(32);
  if (change === "wrong-reservation") s.reserve.data.reserved_microusd = 1;
  await expect(runValidation(s.backend, s.before, "failed")).rejects.toThrow();
});

it.each(["changed-prior", "missing-validation", "wrong-operation-kind"])("rejects %s ledger evidence after validation", async change => {
  const s = scenario();
  if (change === "changed-prior") first(objects(s.evidence.operations)).operation_id = "ce".repeat(32);
  if (change === "missing-validation") s.evidence.operations = objects(s.evidence.operations).filter(op => op.kind !== "validation");
  if (change === "wrong-operation-kind") { const op = objects(s.evidence.operations).at(-1); assert(op); op.kind = "candidate_copy"; }
  await expect(runValidation(s.backend, s.before, "failed")).rejects.toThrow();
});

it("accepts a validation reservation split across validation operations", async () => {
  const s = scenario();
  s.evidence.operations = [...objects(s.evidence.operations).filter(op => op.kind !== "validation"), ...[1, 2].map(i => ({
    operation_id: String(i).repeat(64), kind: "validation_copy", call_name: `synthetic-validation-copy-${String(i)}`, state: "terminal", reserved_microusd: s.cost / 2, settled_microusd: s.cost / 2, attempt_ordinal: 1,
  }))];
  s.evidence.provider_calls = [...objects(s.evidence.provider_calls).filter(call => call.call_name !== "synthetic-validation"), ...[1, 2].map(i => ({ call_name: `synthetic-validation-copy-${String(i)}`, provider: "sandbox", action: "create", at: s.before.created_at }))];
  await expect(runValidation(s.backend, s.before, "failed")).resolves.toBeUndefined();
});
