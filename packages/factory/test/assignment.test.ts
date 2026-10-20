import { describe, expect, it } from "vitest";
import { assignItem, assignmentOrder, demonstratedCriteria, itemStates, nextCandidate, servesItem, unfilledUnits } from "../src/assignment.ts";
import type { ItemState, PlannedCandidate } from "../src/assignment.ts";
import { criteriaCatalogV1 } from "../src/criteria.ts";
import { candidateInfo } from "../src/sources.ts";
import { FakeHostAdapter, SYNTHETIC_BASELINES, syntheticEntry } from "../src/testing/catalog.ts";
import { interpretationFixture } from "./support.ts";

const LOST = "concurrency.lost-acknowledged-change";
const STALE = "concurrency.stale-success-response";
const TZ = "date_time.time-zone-grouping";

function item(key: string, index: number, criteria: string[], quantity = 1, delivered = 0, type: ItemState["bug_type_id"] = "concurrency"): ItemState {
  return { item_key: key, bug_type_id: type, criterion_ids: criteria, quantity, delivered, index };
}

function planned(host: "task-report" | "umami", n: number, criteria: string[], defectOf?: number): PlannedCandidate {
  const type = host === "umami" ? "date_time" : "concurrency";
  const entry = syntheticEntry({ host_id: host, bug_type_id: type, n, criteria, ...(defectOf === undefined ? {} : { defect_of: defectOf }) });
  return { ...candidateInfo(SYNTHETIC_BASELINES[host], entry), baseline_id: SYNTHETIC_BASELINES[host].baseline_id, entry, adapter: new FakeHostAdapter({ host_id: host, entries: [entry] }), worst_case_microusd: 300_000 };
}

describe("items and units", () => {
  it("reads every interpreted item with its matched criteria, in request order", () => {
    const interpretation = interpretationFixture("interpretation-supported.json");
    expect(itemStates(interpretation)).toEqual([
      { item_key: "concurrency-1", bug_type_id: "concurrency", criterion_ids: [LOST], quantity: 1, delivered: 0, index: 0 },
      { item_key: "date-time-1", bug_type_id: "date_time", criterion_ids: [], quantity: 1, delivered: 0, index: 1 },
    ]);
  });

  it("counts unfilled units as the quantity less the delivered cases", () => {
    expect(unfilledUnits(item("a", 0, [], 3, 1))).toBe(2);
    expect(unfilledUnits(item("a", 0, [], 2, 2))).toBe(0);
  });

  it("orders items with more criteria first, then by request order", () => {
    const order = assignmentOrder([item("any", 0, []), item("one", 1, [LOST]), item("two", 2, [LOST, STALE]), item("one-b", 3, [STALE])]);
    expect(order.map((entry) => entry.item_key)).toEqual(["two", "one", "one-b", "any"]);
  });
});

describe("demonstrated criteria", () => {
  const catalog = criteriaCatalogV1();

  it("counts a criterion only when its published failure code was observed on the buggy copy", () => {
    expect(demonstratedCriteria(catalog, "concurrency", ["acknowledged_completion_not_counted"]).map((c) => c.criterion_id)).toEqual([LOST]);
    expect(demonstratedCriteria(catalog, "concurrency", ["stale_success_response", "acknowledged_completion_not_counted"]).map((c) => c.criterion_id)).toEqual([LOST, STALE]);
    expect(demonstratedCriteria(catalog, "concurrency", [])).toEqual([]);
  });

  it("ignores codes of another bug type and unknown codes", () => {
    expect(demonstratedCriteria(catalog, "concurrency", ["local_day_counts_mismatch", "synthetic_unrelated"])).toEqual([]);
    expect(demonstratedCriteria(catalog, "date_time", ["local_day_counts_mismatch"]).map((c) => c.criterion_id)).toEqual([TZ]);
  });
});

describe("assignment", () => {
  it("assigns to the item with more criteria first, even when it comes second", () => {
    const items = [item("concurrency-any", 0, []), item("concurrency-1", 1, [LOST])];
    expect(assignItem(items, "concurrency", [LOST])?.item_key).toBe("concurrency-1");
  });

  it("needs every criterion of an item demonstrated", () => {
    const items = [item("both", 0, [LOST, STALE]), item("lost", 1, [LOST])];
    expect(assignItem(items, "concurrency", [LOST])?.item_key).toBe("lost");
    expect(assignItem(items, "concurrency", [LOST, STALE])?.item_key).toBe("both");
  });

  it("lets an item without criteria take any demonstrated criterion of its type, and nothing else", () => {
    const items = [item("any", 0, [])];
    expect(assignItem(items, "concurrency", [STALE])?.item_key).toBe("any");
    expect(assignItem(items, "concurrency", [])).toBeNull();
  });

  it("skips items without an unfilled unit, so a case never counts twice", () => {
    const items = [item("lost", 0, [LOST], 1, 1), item("any", 1, [], 2, 0)];
    expect(assignItem(items, "concurrency", [LOST])?.item_key).toBe("any");
    expect(assignItem([item("lost", 0, [LOST], 1, 1)], "concurrency", [LOST])).toBeNull();
  });

  it("never assigns across bug types", () => {
    const items = [item("dt", 0, [], 1, 0, "date_time")];
    expect(assignItem(items, "concurrency", [LOST])).toBeNull();
  });

  it("answers null when the failure fits no item with an unfilled unit (wrong_failure)", () => {
    expect(assignItem([item("lost", 0, [LOST])], "concurrency", [STALE])).toBeNull();
  });
});

describe("candidate selection", () => {
  const taskOne = planned("task-report", 1, [LOST]);
  const taskTwo = planned("task-report", 2, [STALE]);
  const umami = planned("umami", 1, [TZ]);

  it("serves an item only with an entry of its type that declares every criterion of the item", () => {
    expect(servesItem(taskOne, item("lost", 0, [LOST]))).toBe(true);
    expect(servesItem(taskTwo, item("lost", 0, [LOST]))).toBe(false);
    expect(servesItem(taskTwo, item("any", 0, []))).toBe(true);
    expect(servesItem(umami, item("any", 0, []))).toBe(false);
  });

  it("selects for items in assignment order, then entries in catalog order across hosts", () => {
    const items = [item("dt", 0, [], 1, 0, "date_time"), item("lost", 1, [LOST])];
    expect(nextCandidate(items, [umami, taskOne, taskTwo], new Set())?.entry_id).toBe(taskOne.entry_id);
    expect(nextCandidate(items, [umami, taskOne, taskTwo], new Set([taskOne.candidate_id]))?.entry_id).toBe(umami.entry_id);
  });

  it("never selects for a filled item or a tried entry, and answers null when nothing is left", () => {
    const items = [item("lost", 0, [LOST], 1, 1), item("dt", 1, [], 1, 0, "date_time")];
    expect(nextCandidate(items, [taskOne, umami], new Set())?.entry_id).toBe(umami.entry_id);
    expect(nextCandidate(items, [taskOne, umami], new Set([umami.candidate_id]))).toBeNull();
  });
});
