import { afterEach, describe, expect, it } from "vitest";
import { ALL_OK, SEARCH_INPUT } from "../support/fixtures.ts";
import { makeWorld } from "../support/harness.ts";
import type { World } from "../support/harness.ts";
import { recorded } from "../support/assert.ts";

let world: World | undefined;
afterEach(async () => {
  if (world !== undefined) {
    expect(world.server.unmatched).toEqual([]);
    await world.close();
    world = undefined;
  }
});

async function status(w: World, operationId: string) {
  const result = await w.rawSpend.operationStatus({ operation_id: operationId });
  if (!result.ok) {
    throw new Error(`status refused ${result.code}`);
  }
  return result;
}

describe("reserve, launch, settle", () => {
  it("runs slot check, reserve, launching, request, terminal, settle in that order", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    await world.searcher.searchSource("source-1", SEARCH_INPUT);
    expect(world.log).toEqual([
      "slotStatus",
      "reserve",
      "transition:launching",
      "request:search",
      "transition:terminal",
      "settle",
    ]);
  });

  it("reserves the worst case of 2 credits at the injected price", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const result = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    const op = await status(world, result.record.operation_id);
    expect(op.reserved_microusd).toBe(16_000n);
    expect(result.spend?.reserved_microusd).toBe(16_000n);
  });

  it("settles reported credits of 1 at 8,000 micro-USD and releases the rest", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const result = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    const op = await status(world, result.record.operation_id);
    expect(op).toMatchObject({ state: "reconciled", settled_microusd: 8_000n, open_microusd: 0n, released_microusd: 8_000n });
    expect(result.record.reported_credits).toBe(1);
    expect(result.record.outcome).toBe("complete");
    expect(result.spend).toMatchObject({ settled_microusd: 8_000n, over_envelope: false });
  });

  it("retains the full worst case when usage is missing, and stays terminal", async () => {
    world = await makeWorld({ recordings: ["source-1.no-usage"] });
    const result = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    const op = await status(world, result.record.operation_id);
    expect(op).toMatchObject({ state: "terminal", settled_microusd: 0n, open_microusd: 16_000n });
    expect(result.record.reported_credits).toBeNull();
    expect(result.record.outcome).toBe("complete");
  });

  it("settles an extract that reports 0 credits as unknown and retains the worst case", async () => {
    world = await makeWorld({ recordings: ["docs-1.zero-credits"] });
    const result = recorded(await world.searcher.extractDocs("docs-1", SEARCH_INPUT));
    const op = await status(world, result.record.operation_id);
    expect(op).toMatchObject({ state: "terminal", settled_microusd: 0n, open_microusd: 16_000n });
    expect(result.record.outcome).toBe("complete");
  });

  it("settles an extract that reports 1 credit as known", async () => {
    world = await makeWorld({ recordings: ["docs-1.ok"] });
    const result = recorded(await world.searcher.extractDocs("docs-1", SEARCH_INPUT));
    const op = await status(world, result.record.operation_id);
    expect(op).toMatchObject({ state: "reconciled", settled_microusd: 8_000n });
  });

  it("records credits above 2 as reported and raises the over-envelope halt", async () => {
    world = await makeWorld({ recordings: ["source-1.credits-3", "source-2.ok"] });
    const result = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    expect(result.record.reported_credits).toBe(3);
    expect(result.spend).toMatchObject({ settled_microusd: 24_000n, over_envelope: true });
    const halt = await world.rawSpend.haltStatus();
    expect(halt).toMatchObject({ ok: true, halted: true });
    const next = recorded(await world.searcher.searchSource("source-2", SEARCH_INPUT));
    expect(next.record.reason).toBe("spend_refused:pool_halted");
    expect(next.stop).toBe("spend_refused");
    expect(world.server.requests).toHaveLength(1);
  });

  it("refuses an insufficient pool with no request and no retry", async () => {
    world = await makeWorld({ recordings: ALL_OK, cap: 15_999 });
    const result = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    expect(result.record.outcome).toBe("incomplete");
    expect(result.record.reason).toBe("spend_refused:insufficient_funds");
    expect(result.stop).toBe("spend_refused");
    expect(world.server.requests).toHaveLength(0);
    expect(world.log).toEqual(["slotStatus", "reserve"]);
  });

  it("refuses with slot_not_held before reserving when the root does not hold the slot", async () => {
    world = await makeWorld({ recordings: ALL_OK, holdSlot: false });
    const result = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    expect(result.record.reason).toBe("spend_refused:slot_not_held");
    expect(world.log).toEqual(["slotStatus"]);
    expect(world.server.requests).toHaveLength(0);
  });

  it("refuses with unknown_price before reserving when the rate sheet has no Tavily credit price", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const { createSearcher, createTavilyClient, parseRateSheet } = await import("../../src/index.ts");
    const { CONTEXT, POOL, SETTINGS, SLOT, SYNTHETIC_KEY } = await import("../support/fixtures.ts");
    const searcher = createSearcher({
      client: createTavilyClient({ apiKey: SYNTHETIC_KEY, apiBaseURL: world.server.baseURL }),
      spend: world.spend,
      context: CONTEXT,
      rates: parseRateSheet("[]"),
      poolKey: POOL,
      slotKey: SLOT,
      settings: SETTINGS,
      excludedIdentifiers: [],
    });
    const result = recorded(await searcher.searchSource("source-1", SEARCH_INPUT));
    expect(result.record.reason).toBe("spend_refused:unknown_price");
    expect(world.log).not.toContain("reserve");
    expect(world.server.requests).toHaveLength(0);
  });

  it("gives each call its own operation under one reservation protocol", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const a = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    const b = recorded(await world.searcher.searchSource("source-2", SEARCH_INPUT));
    expect(a.record.operation_id).not.toBe(b.record.operation_id);
    expect(a.record.operation_id).toMatch(/^[0-9a-f]{64}$/);
  });
});
