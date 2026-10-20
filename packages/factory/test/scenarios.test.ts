// Synthetic integration: the request loop with the fake harness, the in-memory ledger and event store,
// projected to RequestStatus, for every named scenario of contract section 15.1. Settled amounts may
// differ from the fixtures; outcomes, stop codes, delivery, attention, stages and counts must match.
import { validateContract } from "@rbw/factory-contract/validate";
import type { RequestStatus, TestScenario } from "@rbw/factory-contract";
import { describe, expect, it } from "vitest";
import { criteriaCatalogV1 } from "../src/criteria.ts";
import { lostWorkerEvents } from "../src/projection.ts";
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

const RUNS: readonly TestScenario[] = SCENARIOS.filter((scenario) => scenario !== "worker-lost" && scenario !== "uncertain-provider");

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

  it("names the validation result each scenario's validation runs observe", () => {
    expect(scenarioSetup("validation-failed", catalog).validation).toBe("failed");
    expect(scenarioSetup("validation-error", catalog).validation).toBe("error");
    expect(scenarioSetup("two-host-fulfilled", catalog).validation).toBe("passed");
    expect(validationPlan("failed", ["x"]).buggy.verification).toBe("pass");
    expect(validationPlan("error", ["x"]).clean.original_suite).toBe("error");
  });
});
