// Synthetic integration: the request loop with the fake harness, the in-memory ledger and event store,
// projected to RequestStatus, for every named scenario of contract section 15.1. Settled amounts may
// differ from the fixtures; outcomes, stop codes, delivery, attention, stages and counts must match.
import { validateContract } from "@rbw/factory-contract/validate";
import type { RequestStatus, TestScenario } from "@rbw/factory-contract";
import { describe, expect, it } from "vitest";
import { criteriaCatalogV1 } from "../src/criteria.ts";
import { lostWorkerEvents } from "../src/projection.ts";
import type { HarnessResult } from "../src/ports.ts";
import { scenarioSetup, SCENARIOS, validationPlan } from "../src/testing/scenarios.ts";
import { fixtureInput, world } from "./orchestrator-support.ts";
import { statusFixture } from "./support.ts";

function summary(status: RequestStatus): unknown {
  return {
    state: status.state,
    outcome: status.outcome,
    stop_code: status.stop_reason?.code ?? null,
    delivery: status.delivery,
    attention: status.attention?.code ?? null,
    funnel: status.funnel,
    items: status.items.map((item) => [item.item_key, item.requested, item.delivered, item.missing, item.case_ids.length]),
    type_totals: status.type_totals,
    candidates: status.candidates.map((c) => [c.entry_id, c.stage, c.reason?.code ?? null, c.item_key, c.case_id !== null, c.started_at !== null, c.finished_at !== null]),
    cases: status.cases.map((c) => [c.host_id, c.item_key, c.criteria_met.map((m) => m.criterion_id)]),
    candidates_started: status.limits.candidates_started,
  };
}

/** The scenarios with an end-state fixture that a run reaches on its own. */
const RUNS: readonly TestScenario[] = SCENARIOS.filter((scenario) => scenario !== "worker-lost" && scenario !== "uncertain-provider" && scenario !== "setup-failed");

describe("named scenarios (synthetic)", () => {
  const catalog = criteriaCatalogV1();

  it.each(RUNS)("%s ends as its fixture shows", async (scenario) => {
    const setup = scenarioSetup(scenario, catalog);
    const w = world({
      input: fixtureInput(setup.input_fixture),
      registry: setup.registry,
      plan: setup.plan,
      hooks: {
        pause: () => {
          w.stop.requested = true;
          return Promise.resolve();
        },
      },
    });
    await w.run();
    const status = w.status();
    expect(validateContract("RequestStatus", status)).toEqual([]);
    const expected = statusFixture(setup.end_fixture ?? "");
    expect(summary(status)).toEqual(summary(expected));
  });

  it("worker-lost ends as status-operational-error.json once the lost-worker finish is appended", async () => {
    const setup = scenarioSetup("worker-lost", catalog);
    let lost: () => void = () => undefined;
    const lostSignal = new Promise<void>((resolve) => {
      lost = resolve;
    });
    const w = world({
      input: fixtureInput(setup.input_fixture),
      registry: setup.registry,
      plan: setup.plan,
      hooks: {
        workerLost: () => {
          lost();
          return Promise.resolve();
        },
        hang: () => new Promise<void>(() => undefined),
      },
    });
    void w.run();
    await lostSignal;
    for (const event of lostWorkerEvents({ events: w.events.events, now: new Date(w.clock.now + 180_000) })) await w.events.append(event);
    const status = w.status();
    expect(validateContract("RequestStatus", status)).toEqual([]);
    expect(summary(status)).toEqual(summary(statusFixture("status-operational-error.json")));
    expect(status.budget.reserved_microusd).toBe(500_000);
  });

  it("uncertain-provider finishes operational_error / needs_reconciliation with no delivery", async () => {
    const setup = scenarioSetup("uncertain-provider", catalog);
    const w = world({ input: fixtureInput(setup.input_fixture), registry: setup.registry, plan: setup.plan });
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "operational_error", stop_code: "needs_reconciliation", needs_reconciliation: true });
    expect(w.status()).toMatchObject({ delivery: "none", attention: { code: "needs_reconciliation" } });
  });

  it("setup-failed: the Umami candidate's clean copy cannot be prepared, its buggy and fixed copies still run, and it ends invalid with no delivery", async () => {
    const setup = scenarioSetup("setup-failed", catalog);
    // Contract section 15.1: input from status-zero-result.json, no end-state fixture.
    expect([setup.input_fixture, setup.end_fixture]).toEqual(["status-zero-result.json", null]);
    const harnessed: HarnessResult[] = [];
    const w = world({
      input: fixtureInput(setup.input_fixture),
      registry: setup.registry,
      plan: setup.plan,
      qualify: (inner) => async (input) => {
        const answer = await inner(input);
        harnessed.push(answer);
        return answer;
      },
    });
    const result = await w.run();
    expect(result).toMatchObject({ outcome: "sources_exhausted", stop_code: "sources_exhausted", delivered: 0 });
    const status = w.status();
    expect(validateContract("RequestStatus", status)).toEqual([]);
    expect([status.outcome, status.stop_reason?.code, status.delivery, status.attention]).toEqual(["sources_exhausted", "sources_exhausted", "none", null]);
    expect(status.candidates.map((c) => [c.host_id, c.entry_id, c.stage, c.reason?.code ?? null])).toEqual([["umami", "synthetic-umami-date-time-01", "invalid", "setup_failed"]]);
    expect(status.funnel).toEqual({ candidates_explored: 1, behavior_checks_passed: 0, requested_criteria_passed: 0, packages_ready: 0 });
    expect(status.cases).toEqual([]);
    // The harness does not stop after the clean copy: every state's copy runs, as the real harness runs them.
    expect(harnessed.map((answer) => [answer.result, answer.stopped, answer.records.map((record) => [record.state, record.status])])).toEqual([
      ["error", false, [["clean", "invalid"], ["buggy", "complete"], ["fixed", "complete"]]],
    ]);
    expect(status.events.map((event) => event.type)).toEqual([
      "request_accepted", "budget_updated", "worker_started", "host_preparing", "host_ready", "candidate_selected", "budget_updated",
      "check_finished", "check_finished", "check_finished", "check_finished", "check_finished", "check_finished",
      "candidate_invalid", "budget_updated", "source_exhausted", "budget_updated", "request_finished",
    ]);
    const checks = status.events.flatMap((event) => (event.type === "check_finished" ? [[event.data.copy, event.data.check_set, event.data.outcome, event.data.runs_valid, event.data.runs_total]] : []));
    expect(checks).toEqual([
      ["clean", "original_suite", "error", 0, 3],
      ["clean", "verification", "error", 0, 3],
      ["buggy", "original_suite", "pass", 3, 3],
      ["buggy", "verification", "fail", 3, 3],
      ["fixed", "original_suite", "pass", 3, 3],
      ["fixed", "verification", "pass", 3, 3],
    ]);
    expect(status.events.flatMap((event) => (event.type === "candidate_invalid" ? [event.data.reason] : []))).toEqual(["setup_failed"]);
    // Everything settles at its worst case: the worker's $0.20 and the candidate's three copies at $0.20 each.
    expect(status.budget).toMatchObject({ reserved_microusd: 0, spent_microusd: 800_000, overrun: false });
  });

  it("names the validation result each scenario's validation runs observe", () => {
    expect(scenarioSetup("validation-failed", catalog).validation).toBe("failed");
    expect(scenarioSetup("validation-error", catalog).validation).toBe("error");
    expect(scenarioSetup("two-host-fulfilled", catalog).validation).toBe("passed");
    expect(validationPlan("failed", ["x"]).buggy.verification).toBe("pass");
    expect(validationPlan("error", ["x"]).clean.original_suite).toBe("error");
  });
});
