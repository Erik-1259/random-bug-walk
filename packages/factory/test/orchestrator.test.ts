import { validateContract } from "@rbw/factory-contract/validate";
import type { CopyRecord, Event, InterpretedCells } from "@rbw/factory-contract";
import { describe, expect, it } from "vitest";
import type { RequestLedger } from "../src/ports.ts";
import { FakeHostAdapter, TEST_PROFILE, syntheticEntry, syntheticSha } from "../src/testing/catalog.ts";
import { UncertainOutcomeError, qualifyingPlan } from "../src/testing/harness.ts";
import { fixtureInput, world } from "./orchestrator-support.ts";
import type { World } from "./orchestrator-support.ts";

const LOST = "concurrency.lost-acknowledged-change";
const LOST_CODE = "acknowledged_completion_not_counted";

function types(events: readonly Event[]): string[] {
  return events.map((event) => event.type);
}

function ended(events: readonly Event[]): { type: string; reason: string }[] {
  return events.flatMap((event) => (event.type === "candidate_rejected" || event.type === "candidate_invalid" || event.type === "candidate_incomplete" || event.type === "candidate_skipped" ? [{ type: event.type, reason: event.data.reason }] : []));
}

function finished(events: readonly Event[]): unknown {
  const last = events.at(-1);
  return last?.type === "request_finished" ? last.data : null;
}

/** Routes the loop's ledger calls to the world's in-memory ledger, except the overridden ones. */
function ledgerWith(w: World, overrides: Partial<RequestLedger>): void {
  const ledger = w.ledger;
  w.deps.ledger = {
    status: () => ledger.status(),
    reserveCandidate: (input) => ledger.reserveCandidate(input),
    settleCandidate: (input) => ledger.settleCandidate(input),
    settleWorker: (input) => ledger.settleWorker(input),
    ...overrides,
  };
}

/** Makes the first append of an event of this type fail without committing. */
function failFirstAppend(w: World, type: Event["type"]): void {
  const sink = w.deps.events;
  let failed = false;
  w.deps.events = {
    append: (event) => {
      if (failed || event.type !== type) return sink.append(event);
      failed = true;
      return Promise.reject(new Error("connection reset"));
    },
  };
}

function taskReportRegistry(entries: Parameters<typeof syntheticEntry>[0][]): FakeHostAdapter[] {
  return [new FakeHostAdapter({ host_id: "task-report", entries: entries.map((options) => syntheticEntry(options)) })];
}

const concurrencyOnly = (quantity: number, budget = 1_500_000) => ({
  hosts: ["task-report" as const],
  items: [{ item_key: "concurrency-1", bug_type_id: "concurrency" as const, quantity, description: null, difficulty: "source_inferable_allowed" as const }],
  budget_microusd: budget,
});

describe("runRequest: delivery", () => {
  it("fulfils a two-host request one candidate at a time and settles the worker before finishing", async () => {
    const w = world({ input: fixtureInput("status-fulfilled.json") });
    const result = await w.run();
    expect(result).toEqual({ outcome: "fulfilled", stop_code: "fulfilled", needs_reconciliation: false, delivered: 2, notes: [] });
    const events = w.events.events;
    expect(finished(events)).toEqual({ outcome: "fulfilled", stop_code: "fulfilled" });
    expect(w.qualified).toEqual(["synthetic-task-report-concurrency-01", "synthetic-umami-date-time-01"]);
    expect(w.ledger.calls.map((call) => call.call)).toEqual(["reserveCandidate", "settleCandidate", "reserveCandidate", "settleCandidate", "settleWorker"]);
    expect(types(events).slice(-2)).toEqual(["budget_updated", "request_finished"]);
    const status = w.status();
    expect(validateContract("RequestStatus", status)).toEqual([]);
    expect(status).toMatchObject({ state: "finished", outcome: "fulfilled", delivery: "complete", attention: null });
    expect(status.funnel).toEqual({ candidates_explored: 2, behavior_checks_passed: 2, requested_criteria_passed: 2, packages_ready: 2 });
    expect(status.budget).toMatchObject({ reserved_microusd: 0, spent_microusd: 1_100_000, remaining_microusd: 900_000 });
    expect(status.items.map((item) => [item.item_key, item.delivered, item.missing])).toEqual([["concurrency-1", 1, 0], ["date-time-1", 1, 0]]);
  });

  it("stores each case's evidence before its package_ready event and its case_delivered last", async () => {
    const w = world({ input: fixtureInput("status-fulfilled.json") });
    await w.run();
    const order = w.log.filter((entry) => ["package", "evidence", "event:package_ready", "event:case_delivered"].includes(entry));
    expect(order).toEqual(["package", "evidence", "event:package_ready", "event:case_delivered", "package", "evidence", "event:package_ready", "event:case_delivered"]);
    const [first] = [...w.evidence.values()];
    expect(first?.case.qualification.record_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.record.verdict).toBe("accepted");
  });

  it("assigns the case to the item with more criteria and reports the exhausted source", async () => {
    const w = world({ input: fixtureInput("status-exhausted.json") });
    const result = await w.run();
    expect(result.stop_code).toBe("sources_exhausted");
    const status = w.status();
    expect(status.items.map((item) => [item.item_key, item.delivered])).toEqual([["concurrency-any", 0], ["concurrency-1", 1]]);
    expect(w.events.events.filter((event) => event.type === "source_exhausted").map((event) => event.data)).toEqual([{ bug_type_id: "concurrency", source_id: "synthetic-task-report-concurrency" }]);
    expect(status).toMatchObject({ outcome: "sources_exhausted", delivery: "partial" });
  });

  it("tries each defect once: a second entry with the same defect is skipped", async () => {
    const registry = taskReportRegistry([
      { host_id: "task-report", bug_type_id: "concurrency", n: 1, criteria: [LOST] },
      { host_id: "task-report", bug_type_id: "concurrency", n: 2, criteria: [LOST], defect_of: 1 },
    ]);
    const w = world({ input: concurrencyOnly(2), registry });
    const result = await w.run();
    expect(result).toMatchObject({ stop_code: "sources_exhausted", delivered: 1 });
    expect(w.qualified).toEqual(["synthetic-task-report-concurrency-01"]);
    expect(ended(w.events.events)).toEqual([{ type: "candidate_skipped", reason: "duplicate_defect" }]);
    const status = w.status();
    expect(status.candidates.map((c) => [c.entry_id, c.stage, c.started_at === null])).toEqual([
      ["synthetic-task-report-concurrency-01", "qualified", false],
      ["synthetic-task-report-concurrency-02", "skipped", true],
    ]);
    expect(status.candidates[0]?.defect_id).toBe(status.candidates[1]?.defect_id);
    expect(status.limits.candidates_started).toBe(1);
  });

  it("fills several units of one item with distinct defects and stops when the item is full", async () => {
    const registry = taskReportRegistry([1, 2, 3].map((n) => ({ host_id: "task-report" as const, bug_type_id: "concurrency" as const, n, criteria: [LOST] })));
    const w = world({ input: concurrencyOnly(2), registry });
    const result = await w.run();
    expect(result).toMatchObject({ stop_code: "fulfilled", delivered: 2 });
    expect(w.qualified).toHaveLength(2);
    const status = w.status();
    expect(status.items[0]).toMatchObject({ delivered: 2, missing: 0 });
    expect(new Set(status.items[0]?.case_ids).size).toBe(2);
  });
});

describe("runRequest: verdicts", () => {
  it("rejects a candidate whose original suite catches the bug and never delivers it", async () => {
    const w = world({
      input: fixtureInput("status-zero-result.json"),
      plan: () => ({ states: { ...qualifyingPlan(["local_day_counts_mismatch"]), buggy: { original_suite: "fail", verification: "fail", failure_codes: ["local_day_counts_mismatch"] } } }),
    });
    const result = await w.run();
    expect(result).toMatchObject({ stop_code: "sources_exhausted", delivered: 0 });
    expect(ended(w.events.events)).toEqual([{ type: "candidate_rejected", reason: "original_suite_caught_bug" }]);
    expect(w.status()).toMatchObject({ delivery: "none", cases: [], funnel: { candidates_explored: 1, behavior_checks_passed: 0 } });
  });

  it("rejects a candidate whose failure fits no criterion of the item with wrong_failure after behavior checks pass", async () => {
    const w = world({ input: fixtureInput("status-wrong-failure.json"), plan: () => ({ states: qualifyingPlan(["stale_success_response"]) }) });
    await w.run();
    expect(types(w.events.events)).toContain("behavior_checks_passed");
    expect(types(w.events.events)).not.toContain("requested_criteria_passed");
    expect(ended(w.events.events)).toEqual([{ type: "candidate_rejected", reason: "wrong_failure" }]);
    expect(w.status().funnel).toEqual({ candidates_explored: 1, behavior_checks_passed: 1, requested_criteria_passed: 0, packages_ready: 0 });
  });

  it("keeps an invalid candidate out of rejection, reopens its unit and lets the next entry fill it", async () => {
    const registry = taskReportRegistry([1, 2].map((n) => ({ host_id: "task-report" as const, bug_type_id: "concurrency" as const, n, criteria: [LOST] })));
    const w = world({
      input: concurrencyOnly(1),
      registry,
      plan: (entry) => (entry.entry_id.endsWith("-01") ? { states: { ...qualifyingPlan([LOST_CODE]), clean: { original_suite: "error", verification: "error" } } } : { states: qualifyingPlan([LOST_CODE]) }),
    });
    const result = await w.run();
    expect(result).toMatchObject({ stop_code: "fulfilled", delivered: 1 });
    expect(ended(w.events.events)).toEqual([{ type: "candidate_invalid", reason: "setup_failed" }]);
    expect(w.status().candidates.map((c) => c.stage)).toEqual(["invalid", "qualified"]);
  });

  it("makes a candidate with too few valid runs incomplete, not rejected", async () => {
    const w = world({ input: concurrencyOnly(1), plan: () => ({ states: { ...qualifyingPlan([LOST_CODE]), fixed: { original_suite: "fail", verification: "incomplete" } } }) });
    await w.run();
    expect(ended(w.events.events)).toEqual([{ type: "candidate_incomplete", reason: "incomplete_run" }]);
  });

  it("rejects parts that fail their integrity checks as export_mismatch", async () => {
    const w = world({ input: concurrencyOnly(1), plan: () => ({ states: qualifyingPlan([LOST_CODE]), integrity: "failed" }) });
    await w.run();
    expect(ended(w.events.events)).toEqual([{ type: "candidate_rejected", reason: "export_mismatch" }]);
  });

  it("never puts check output, observation detail or failure codes into events, candidates or cases", async () => {
    const w = world({ input: fixtureInput("status-fulfilled.json") });
    await w.run();
    const text = JSON.stringify(w.status());
    expect(text).not.toContain("synthetic detail");
    expect(text).not.toContain(LOST_CODE);
    expect(text).not.toContain("local_day_counts_mismatch");
  });

  it("gives every appended event its own deterministic key", async () => {
    const w = world({ input: fixtureInput("status-fulfilled.json") });
    await w.run();
    expect(w.events.keys.size).toBe(w.events.events.length);
    expect(w.events.replays).toEqual([]);
  });

  it("appends check_finished from the harness's checked cells: a pass on fewer valid runs than the protocol's floor reads incomplete", async () => {
    // The adapter reports the clean copy's original suite as a pass on 2 of 3 runs; the protocol needs 3.
    class FewValidRuns extends FakeHostAdapter {
      override interpret(records: CopyRecord[]): InterpretedCells {
        const cells = super.interpret(records);
        if (records[0]?.state !== "clean") return cells;
        return { ...cells, original_suite: { ...cells.original_suite, runs_valid: 2 } };
      }
    }
    const registry = [new FewValidRuns({ host_id: "task-report", entries: [syntheticEntry({ host_id: "task-report", bug_type_id: "concurrency", n: 1, criteria: [LOST] })] })];
    const w = world({ input: concurrencyOnly(1), registry });
    const result = await w.run();
    const checks = w.events.events.flatMap((event) => (event.type === "check_finished" ? [{ set: event.data.check_set, copy: event.data.copy, outcome: event.data.outcome, message: event.message }] : []));
    expect(checks).toHaveLength(6);
    expect(checks[0]).toEqual({ set: "original_suite", copy: "clean", outcome: "incomplete", message: "Original suite on the clean copy: incomplete (2 of 3 runs valid)." });
    expect(ended(w.events.events)).toEqual([{ type: "candidate_incomplete", reason: "incomplete_run" }]);
    expect(result).toMatchObject({ stop_code: "sources_exhausted", delivered: 0 });
  });
});

describe("runRequest: packaging and evidence", () => {
  const twoEntries = () => taskReportRegistry([1, 2].map((n) => ({ host_id: "task-report" as const, bug_type_id: "concurrency" as const, n, criteria: [LOST] })));

  it("rejects with export_mismatch and delivers nothing when the stored bug case is not the archive export verification ran on, leaving the unit for the next entry", async () => {
    const w = world({ input: concurrencyOnly(1), registry: twoEntries() });
    const store = w.deps.packageCase;
    w.deps.packageCase = async (input) => {
      const packages = await store(input);
      return input.entry.entry_id.endsWith("-01") ? { ...packages, bug_case: { ...packages.bug_case, sha256: syntheticSha("another-bug-case") } } : packages;
    };
    const result = await w.run();
    expect(result).toMatchObject({ stop_code: "fulfilled", delivered: 1 });
    expect(ended(w.events.events)).toEqual([{ type: "candidate_rejected", reason: "export_mismatch" }]);
    const status = w.status();
    const [first, second] = status.candidates;
    expect([first?.stage, second?.stage]).toEqual(["rejected", "qualified"]);
    const delivering = w.events.events.filter((event) => (event.type === "package_ready" || event.type === "case_delivered") && event.candidate_id === first?.candidate_id);
    expect(delivering).toEqual([]);
    expect(status.items[0]).toMatchObject({ delivered: 1, missing: 0 });
  });

  it("ends the candidate incomplete, settles it and finishes operational_error when its parts cannot be stored", async () => {
    const w = world({ input: concurrencyOnly(1), registry: twoEntries() });
    w.deps.packageCase = () => Promise.reject(new Error("the object store refused the write"));
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "operational_error", needs_reconciliation: false, delivered: 0 });
    expect(result.notes).toEqual([expect.stringContaining("the object store refused the write")]);
    expect(ended(w.events.events)).toEqual([{ type: "candidate_incomplete", reason: "incomplete_run" }]);
    expect(types(w.events.events)).not.toContain("package_ready");
    expect(types(w.events.events)).not.toContain("case_delivered");
    expect(w.qualified).toHaveLength(1);
    expect(w.ledger.calls.map((call) => call.call)).toEqual(["reserveCandidate", "settleCandidate", "settleWorker"]);
    expect(w.evidence.size).toBe(0);
  });

  it("ends the candidate incomplete, settles it and finishes operational_error when its evidence cannot be stored", async () => {
    const w = world({ input: concurrencyOnly(1), registry: twoEntries() });
    w.deps.writeEvidence = () => Promise.reject(new Error("the evidence table refused the write"));
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "operational_error", needs_reconciliation: false, delivered: 0 });
    expect(result.notes).toEqual([expect.stringContaining("the evidence table refused the write")]);
    expect(ended(w.events.events)).toEqual([{ type: "candidate_incomplete", reason: "incomplete_run" }]);
    expect(types(w.events.events)).not.toContain("package_ready");
    expect(types(w.events.events)).not.toContain("case_delivered");
    expect(w.qualified).toHaveLength(1);
    expect(w.ledger.calls.map((call) => call.call)).toEqual(["reserveCandidate", "settleCandidate", "settleWorker"]);
    const status = w.status();
    expect(status).toMatchObject({ outcome: "operational_error", delivery: "none", cases: [] });
    expect(status.candidates.map((c) => [c.stage, c.finished_at !== null])).toEqual([["incomplete", true]]);
  });
});

describe("runRequest: budget", () => {
  it("skips a candidate the remaining budget cannot cover and stops budget_exhausted when nothing fits", async () => {
    const w = world({ input: fixtureInput("status-partial-budget.json") });
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "stopped_at_limit", stop_code: "budget_exhausted", delivered: 1 });
    expect(ended(w.events.events)).toEqual([{ type: "candidate_skipped", reason: "no_budget_for_candidate" }]);
    expect(w.ledger.calls.filter((call) => call.call === "reserveCandidate")).toHaveLength(1);
    expect(types(w.events.events)).not.toContain("source_exhausted");
    expect(w.status()).toMatchObject({ delivery: "partial", limits: { candidates_started: 1 } });
  });

  it("skips a candidate the factory pool cannot cover the same way", async () => {
    const w = world({ input: concurrencyOnly(1), ledger: { pool_cap_microusd: 40_000_000, other_committed_microusd: 40_000_000 - 200_000 - 299_999 } });
    const result = await w.run();
    expect(result.stop_code).toBe("budget_exhausted");
    expect(ended(w.events.events)).toEqual([{ type: "candidate_skipped", reason: "no_budget_for_candidate" }]);
    expect(w.qualified).toEqual([]);
  });

  it("skips a candidate whose reservation the ledger refuses, though the pre-check passed", async () => {
    const w = world({ input: concurrencyOnly(1) });
    const ledger: RequestLedger = w.deps.ledger;
    w.deps.ledger = { ...ledger, status: () => ledger.status(), reserveCandidate: () => Promise.resolve({ kind: "refused", reason: "budget" }), settleCandidate: (i) => ledger.settleCandidate(i), settleWorker: (i) => ledger.settleWorker(i) };
    const result = await w.run();
    expect(result.stop_code).toBe("budget_exhausted");
    expect(w.qualified).toEqual([]);
  });

  it("stops operational_error without a candidate when the ledger is halted", async () => {
    const w = world({ input: concurrencyOnly(1) });
    w.ledger.halted = true;
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "operational_error" });
    expect(types(w.events.events)).not.toContain("candidate_selected");
  });

  it("starts no new candidate after an overrun and finishes operational_error", async () => {
    const registry = taskReportRegistry([1, 2].map((n) => ({ host_id: "task-report" as const, bug_type_id: "concurrency" as const, n, criteria: [LOST] })));
    const w = world({ input: concurrencyOnly(2, 500_000), registry, ledger: { candidateCost: () => 400_000 } });
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "operational_error", delivered: 1 });
    expect(w.qualified).toHaveLength(1);
    expect(w.status().budget.overrun).toBe(true);
  });

  it("finishes operational_error, not fulfilled, when the last candidate's settlement overruns the budget", async () => {
    // $1.50 budget: the worker's $0.20 and a candidate that settles at $1.40 commit $1.60.
    const w = world({ input: concurrencyOnly(1, 1_500_000), ledger: { candidateCost: () => 1_400_000 } });
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "operational_error", delivered: 1 });
    expect(w.status()).toMatchObject({ outcome: "operational_error", delivery: "complete", budget: { overrun: true } });
  });

  it("finishes operational_error, not cancelled, when a stopped candidate's settlement overruns the budget", async () => {
    const w = world({
      input: concurrencyOnly(1, 1_500_000),
      ledger: { candidateCost: () => 1_400_000 },
      plan: () => ({ states: qualifyingPlan([LOST_CODE]), pause_at_copy: 2 }),
      hooks: {
        pause: () => {
          w.stop.requested = true;
          return Promise.resolve();
        },
      },
    });
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "operational_error", delivered: 0 });
    expect(ended(w.events.events)).toEqual([{ type: "candidate_incomplete", reason: "stopped" }]);
    expect(w.status().budget.overrun).toBe(true);
  });
});

describe("runRequest: stops and limits", () => {
  it("finishes cancelled without a candidate when the stop is recorded before the first one", async () => {
    const w = world({ input: fixtureInput("status-fulfilled.json") });
    w.stop.requested = true;
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "cancelled", stop_code: "cancelled_by_user", delivered: 0 });
    expect(types(w.events.events)).not.toContain("candidate_selected");
    expect(w.ledger.calls.map((call) => call.call)).toEqual(["settleWorker"]);
  });

  it("ends the candidate in progress as incomplete (stopped) at the next copy boundary and keeps the delivered case", async () => {
    const w = world({ input: fixtureInput("status-cancelled.json"), plan: (entry) => ({ states: qualifyingPlan(entry.host_id === "umami" ? ["local_day_counts_mismatch"] : [LOST_CODE]), ...(entry.host_id === "umami" ? { pause_at_copy: 2 } : {}) }), hooks: { pause: () => { w.stop.requested = true; return Promise.resolve(); } } });
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "cancelled", stop_code: "cancelled_by_user", delivered: 1 });
    expect(ended(w.events.events)).toEqual([{ type: "candidate_incomplete", reason: "stopped" }]);
    const status = w.status();
    expect(status).toMatchObject({ delivery: "partial", outcome: "cancelled" });
    expect(status.candidates.map((c) => c.stage)).toEqual(["qualified", "incomplete"]);
    expect(w.ledger.calls.filter((call) => call.call === "settleCandidate")).toHaveLength(2);
  });

  it("stops time_limit at the deadline before selecting another candidate", async () => {
    const profile = { ...TEST_PROFILE, limits: { ...TEST_PROFILE.limits, max_wall_clock_s: 1 } };
    const w = world({ input: fixtureInput("status-fulfilled.json"), profile, tick: 200 });
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "stopped_at_limit", stop_code: "time_limit" });
  });

  it("starts no copy whose timeout would pass the deadline and ends that candidate stopped", async () => {
    const profile = { ...TEST_PROFILE, limits: { ...TEST_PROFILE.limits, max_wall_clock_s: 600 } };
    const w = world({ input: concurrencyOnly(1), profile });
    const result = await w.run();
    expect(result.stop_code).toBe("time_limit");
    expect(ended(w.events.events)).toEqual([{ type: "candidate_incomplete", reason: "stopped" }]);
    expect(types(w.events.events)).not.toContain("check_finished");
  });

  it("stops candidate_limit once the limit of started candidates is reached", async () => {
    const profile = { ...TEST_PROFILE, limits: { ...TEST_PROFILE.limits, max_candidates: 1 } };
    const w = world({ input: fixtureInput("status-fulfilled.json"), profile });
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "stopped_at_limit", stop_code: "candidate_limit", delivered: 1 });
    expect(w.qualified).toHaveLength(1);
  });
});

describe("runRequest: uncertain outcomes", () => {
  it("never retries an uncertain harness outcome: attention, needs_reconciliation, and the reservation stays held", async () => {
    const w = world({ input: fixtureInput("status-fulfilled.json"), plan: (entry) => ({ states: qualifyingPlan([LOST_CODE]), ...(entry.host_id === "task-report" ? { uncertain_at_copy: 1 } : {}) }) });
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "needs_reconciliation", needs_reconciliation: true, delivered: 0 });
    expect(result.notes).toEqual([expect.stringContaining("UncertainOutcomeError")]);
    expect(w.qualified).toHaveLength(1);
    expect(w.ledger.calls.map((call) => call.call)).toEqual(["reserveCandidate", "settleWorker"]);
    expect(ended(w.events.events)).toEqual([{ type: "candidate_incomplete", reason: "incomplete_run" }]);
    const attention = w.events.events.filter((event) => event.type === "attention");
    expect(attention.map((event) => event.data)).toEqual([{ code: "needs_reconciliation" }]);
    const status = w.status();
    expect(status).toMatchObject({ outcome: "operational_error", attention: { code: "needs_reconciliation" }, budget: { reserved_microusd: 300_000 } });
    expect(validateContract("RequestStatus", status)).toEqual([]);
    expect(UncertainOutcomeError).toBeDefined();
  });

  it("treats a failed candidate settlement as uncertain spend", async () => {
    const w = world({ input: concurrencyOnly(1) });
    const ledger = w.ledger;
    w.deps.ledger = { status: () => ledger.status(), reserveCandidate: (i) => ledger.reserveCandidate(i), settleCandidate: () => Promise.reject(new Error("connection reset")), settleWorker: (i) => ledger.settleWorker(i) };
    const result = await w.run();
    expect(result).toMatchObject({ stop_code: "needs_reconciliation", needs_reconciliation: true, delivered: 1 });
    expect(w.status().attention?.code).toBe("needs_reconciliation");
  });

  it("records the needs_reconciliation attention on the retry when its first append fails", async () => {
    const w = world({ input: concurrencyOnly(1), plan: () => ({ states: qualifyingPlan([LOST_CODE]), uncertain_at_copy: 1 }) });
    failFirstAppend(w, "attention");
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "needs_reconciliation", needs_reconciliation: true });
    expect(w.events.events.filter((event) => event.type === "attention").map((event) => event.data)).toEqual([{ code: "needs_reconciliation" }]);
    expect(w.status().attention?.code).toBe("needs_reconciliation");
  });

  it("finishes needs_reconciliation after an uncertain reservation even when the attention's first append fails", async () => {
    const w = world({ input: concurrencyOnly(1) });
    ledgerWith(w, { reserveCandidate: () => Promise.reject(new Error("timeout")) });
    failFirstAppend(w, "attention");
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "needs_reconciliation", needs_reconciliation: true });
    expect(w.events.events.filter((event) => event.type === "attention").map((event) => event.data)).toEqual([{ code: "needs_reconciliation" }]);
    expect(w.qualified).toEqual([]);
  });

  it("keeps the outcome but asks for reconciliation when the worker's settlement fails", async () => {
    const w = world({ input: concurrencyOnly(1) });
    const ledger = w.ledger;
    w.deps.ledger = { status: () => ledger.status(), reserveCandidate: (i) => ledger.reserveCandidate(i), settleCandidate: (i) => ledger.settleCandidate(i), settleWorker: () => Promise.reject(new Error("timeout")) };
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "fulfilled", stop_code: "fulfilled", needs_reconciliation: true });
    expect(w.status()).toMatchObject({ outcome: "fulfilled", attention: { code: "needs_reconciliation" } });
  });
});

/** A task-report fake whose entries declare different numbers of copies per state. */
class PricedAdapter extends FakeHostAdapter {
  readonly copiesOf: (entryId: string) => number;

  constructor(entries: ReturnType<typeof syntheticEntry>[], copiesOf: (entryId: string) => number) {
    super({ host_id: "task-report", entries });
    this.copiesOf = copiesOf;
  }

  override protocol(entry?: { entry_id: string }): ReturnType<FakeHostAdapter["protocol"]> {
    const base = super.protocol();
    const copies = entry === undefined ? 1 : this.copiesOf(entry.entry_id);
    return { ...base, per_state: { clean: { ...base.per_state.clean, copies }, buggy: { ...base.per_state.buggy, copies }, fixed: { ...base.per_state.fixed, copies } } };
  }
}

describe("runRequest: internal failures and admission edges", () => {
  it("ends the candidate incomplete, settles it and finishes operational_error when the stop check fails between copies", async () => {
    const w = world({ input: concurrencyOnly(1) });
    let calls = 0;
    w.deps.stopRequested = () => {
      calls += 1;
      return calls >= 3 ? Promise.reject(new Error("connection reset")) : Promise.resolve(false);
    };
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "operational_error", needs_reconciliation: false });
    expect(result.notes).toEqual([expect.stringContaining("connection reset")]);
    expect(ended(w.events.events)).toEqual([{ type: "candidate_incomplete", reason: "incomplete_run" }]);
    expect(w.ledger.calls.map((call) => call.call)).toEqual(["reserveCandidate", "settleCandidate", "settleWorker"]);
    expect(validateContract("RequestStatus", w.status())).toEqual([]);
  });

  it("finishes needs_reconciliation, ending the candidate, when an adapter fails while the candidate holds its reservation", async () => {
    const arm = { armed: false, calls: 0 };
    class Failing extends FakeHostAdapter {
      override protocol(): ReturnType<FakeHostAdapter["protocol"]> {
        if (arm.armed) arm.calls += 1;
        // The first call of the run prices the candidate; the second, as it starts, fails.
        if (arm.calls > 1) throw new Error("the protocol file is unreadable");
        return super.protocol();
      }
    }
    const registry = [new Failing({ host_id: "task-report", entries: [syntheticEntry({ host_id: "task-report", bug_type_id: "concurrency", n: 1, criteria: [LOST] })] })];
    const w = world({ input: concurrencyOnly(1), registry });
    arm.armed = true;
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "needs_reconciliation", needs_reconciliation: true });
    expect(ended(w.events.events)).toEqual([{ type: "candidate_incomplete", reason: "incomplete_run" }]);
    expect(w.ledger.calls.map((call) => call.call)).toEqual(["reserveCandidate", "settleWorker"]);
    expect(w.status()).toMatchObject({ attention: { code: "needs_reconciliation" }, budget: { reserved_microusd: 300_000 } });
  });

  it("records the selection before ending the candidate when its candidate_selected append fails without committing", async () => {
    const w = world({ input: concurrencyOnly(1) });
    const sink = w.deps.events;
    let failed = false;
    w.deps.events = {
      append: (event) => {
        if (failed || event.type !== "candidate_selected") return sink.append(event);
        failed = true;
        return Promise.reject(new Error("connection reset"));
      },
    };
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "operational_error", needs_reconciliation: false });
    expect(types(w.events.events).filter((type) => type.startsWith("candidate_"))).toEqual(["candidate_selected", "candidate_incomplete"]);
    expect(w.ledger.calls.map((call) => call.call)).toEqual(["settleWorker"]);
    expect(validateContract("RequestStatus", w.status())).toEqual([]);
    expect(w.status().candidates.map((candidate) => [candidate.stage, candidate.reason?.code])).toEqual([["incomplete", "incomplete_run"]]);
  });

  it("records the selection once when its candidate_selected append committed but reported a failure", async () => {
    const w = world({ input: concurrencyOnly(1) });
    const sink = w.deps.events;
    let failed = false;
    w.deps.events = {
      append: async (event) => {
        await sink.append(event);
        if (failed || event.type !== "candidate_selected") return;
        failed = true;
        throw new Error("connection reset after the commit");
      },
    };
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "operational_error", needs_reconciliation: false });
    expect(types(w.events.events).filter((type) => type.startsWith("candidate_"))).toEqual(["candidate_selected", "candidate_incomplete"]);
    expect(validateContract("RequestStatus", w.status())).toEqual([]);
    expect(w.status().candidates.map((candidate) => [candidate.stage, candidate.reason?.code])).toEqual([["incomplete", "incomplete_run"]]);
  });

  it("finishes operational_error without a candidate when the stop check fails before one starts", async () => {
    const w = world({ input: concurrencyOnly(1) });
    w.deps.stopRequested = () => Promise.reject(new Error("connection reset"));
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "operational_error", needs_reconciliation: false });
    expect(types(w.events.events)).not.toContain("candidate_selected");
    expect(finished(w.events.events)).toEqual({ outcome: "operational_error", stop_code: "operational_error" });
  });

  it("stops operational_error, not budget_exhausted, when the ledger refuses a reservation because it is halted", async () => {
    const w = world({ input: concurrencyOnly(1) });
    const ledger = w.ledger;
    w.deps.ledger = { status: () => ledger.status(), reserveCandidate: () => Promise.resolve({ kind: "refused", reason: "halted" }), settleCandidate: (i) => ledger.settleCandidate(i), settleWorker: (i) => ledger.settleWorker(i) };
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "operational_error" });
    expect(ended(w.events.events)).toEqual([{ type: "candidate_skipped", reason: "no_budget_for_candidate" }]);
  });

  it("does not count a defect as tried when its first entry was skipped for budget", async () => {
    const expensive = syntheticEntry({ host_id: "task-report", bug_type_id: "concurrency", n: 1, criteria: [LOST] });
    const cheap = syntheticEntry({ host_id: "task-report", bug_type_id: "concurrency", n: 2, criteria: [LOST], defect_of: 1 });
    const registry = [new PricedAdapter([expensive, cheap], (id) => (id === expensive.entry_id ? 3 : 1))];
    // The budget after the worker is $0.80: entry 01 needs 9 copies ($0.90), entry 02 three ($0.30).
    const w = world({ input: concurrencyOnly(1, 1_000_000), registry });
    const result = await w.run();
    expect(result).toMatchObject({ stop_code: "fulfilled", delivered: 1 });
    expect(ended(w.events.events)).toEqual([{ type: "candidate_skipped", reason: "no_budget_for_candidate" }]);
    expect(w.qualified).toEqual([cheap.entry_id]);
  });
});
