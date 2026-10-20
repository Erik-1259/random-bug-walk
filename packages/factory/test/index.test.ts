import { describe, expect, it } from "vitest";
import { attention, budgetKey, requestFinished } from "../src/index.ts";
import { budgetKey as identityBudgetKey } from "../src/identity.ts";
import { REQUEST_ID, world } from "./orchestrator-support.ts";

describe("the package entry", () => {
  it("exports the finish and attention builders under the request loop's own keys, so a later append replays the loop's events", async () => {
    const w = world({
      input: {
        hosts: ["task-report"],
        items: [{ item_key: "concurrency-1", bug_type_id: "concurrency", quantity: 1, description: null, difficulty: "source_inferable_allowed" }],
        budget_microusd: 1_500_000,
      },
    });
    const ledger = w.ledger;
    w.deps.ledger = {
      status: () => ledger.status(),
      reserveCandidate: () => Promise.reject(new Error("timeout")),
      settleCandidate: (input) => ledger.settleCandidate(input),
      settleWorker: (input) => ledger.settleWorker(input),
    };
    expect((await w.run()).stop_code).toBe("needs_reconciliation");
    const later = "2026-10-20T15:00:00.000Z";
    const finish = requestFinished("needs_reconciliation", later);
    const raise = attention("needs_reconciliation", later);
    expect([finish.event_key, raise.event_key]).toEqual(["run:finished", "run:attention:needs_reconciliation"]);
    const before = w.events.events.length;
    await w.events.append(finish);
    await w.events.append(raise);
    expect(w.events.replays).toEqual(["run:finished", "run:attention:needs_reconciliation"]);
    expect(w.events.events).toHaveLength(before);
    expect(requestFinished("worker_lost", later, "lost:finished")).toMatchObject({ event_key: "lost:finished", data: { outcome: "operational_error", stop_code: "worker_lost" } });
  });

  it("exports the request budget key", () => {
    expect(budgetKey).toBe(identityBudgetKey);
    expect(budgetKey(REQUEST_ID)).toMatch(/^[0-9a-f]{64}$/);
  });
});
