import { afterEach, describe, expect, it } from "vitest";
import { SEARCH_INPUT, SETTINGS } from "../support/fixtures.ts";
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

async function opState(w: World, id: string) {
  const r = await w.rawSpend.operationStatus({ operation_id: id });
  if (!r.ok) {
    throw new Error("status refused");
  }
  return r;
}

describe("error rule: a failure is incomplete, never no_public_match", () => {
  for (const [scenario, status] of [
    ["429", "rate limit"],
    ["500", "server error"],
  ] as const) {
    it(`gives incomplete with provider_error for a ${status} on a phrase check`, async () => {
      world = await makeWorld({ recordings: [`phrase-1.${scenario}`] });
      const result = recorded(await world.searcher.checkPhrase("phrase-1", SEARCH_INPUT));
      expect(result.record.outcome).toBe("incomplete");
      expect(result.record.reason).toBe("provider_error");
      expect(result.record.reported_credits).toBeNull();
      expect(result.stop).toBeNull();
      expect(world.server.requests).toHaveLength(1);
    });
  }

  it("marks the operation terminal (failed) and settles its usage as unknown after a 500", async () => {
    world = await makeWorld({ recordings: ["source-1.500"] });
    const result = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    expect(result.record.reason).toBe("provider_error");
    expect(await opState(world, result.record.operation_id)).toMatchObject({
      state: "terminal",
      settled_microusd: 0n,
      open_microusd: 16_000n,
    });
    expect(world.log.slice(-2)).toEqual(["transition:terminal", "settle"]);
    const events = await world.db.query(
      `SELECT terminal_status FROM ${world.schema}.operation_events WHERE operation_id = $1 AND cause = 'transition' AND to_state = 'terminal'`,
      [result.record.operation_id],
    );
    expect(events.rows).toEqual([{ terminal_status: "failed" }]);
  });

  it("does not retry a failed call", async () => {
    world = await makeWorld({ recordings: ["phrase-1.429"] });
    await world.searcher.checkPhrase("phrase-1", SEARCH_INPUT);
    expect(world.server.requests).toHaveLength(1);
  });

  it("gives incomplete with timeout for a lost response, and leaves the operation uncertain", async () => {
    world = await makeWorld({
      recordings: [],
      fault: () => "hang",
      settings: { ...SETTINGS, timeout_seconds: 0.3 },
    });
    const result = recorded(await world.searcher.checkPhrase("phrase-1", SEARCH_INPUT));
    expect(result.record.outcome).toBe("incomplete");
    expect(result.record.reason).toBe("timeout");
    expect(result.stop).toBe("uncertain");
    expect(await opState(world, result.record.operation_id)).toMatchObject({ state: "uncertain" });
    expect(world.log).not.toContain("settle");
    expect(world.server.requests).toHaveLength(1);
  });

  it("gives incomplete with provider_uncertain for a connection reset after sending", async () => {
    world = await makeWorld({ recordings: [], fault: () => "reset" });
    const result = recorded(await world.searcher.checkPhrase("phrase-1", SEARCH_INPUT));
    expect(result.record.outcome).toBe("incomplete");
    expect(result.record.reason).toBe("provider_uncertain");
    expect(result.stop).toBe("uncertain");
    expect(await opState(world, result.record.operation_id)).toMatchObject({ state: "uncertain" });
    expect(world.server.requests).toHaveLength(1);
  });

  for (const scenario of ["malformed", "bad-result"]) {
    it(`gives incomplete with malformed_response for a ${scenario} body on a phrase check`, async () => {
      world = await makeWorld({ recordings: [`phrase-1.${scenario}`] });
      const result = recorded(await world.searcher.checkPhrase("phrase-1", SEARCH_INPUT));
      expect(result.record.outcome).toBe("incomplete");
      expect(result.record.reason).toBe("malformed_response");
    });
  }

  it("gives incomplete with malformed_response for a malformed source search", async () => {
    world = await makeWorld({ recordings: ["source-1.bad-result"] });
    const result = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    expect(result.record.outcome).toBe("incomplete");
    expect(result.record.reason).toBe("malformed_response");
    expect(result.record.results).toEqual([]);
  });

  it("gives incomplete with a spend refusal reason when the pool is too small", async () => {
    world = await makeWorld({ recordings: [], cap: 1 });
    const result = recorded(await world.searcher.checkPhrase("phrase-1", SEARCH_INPUT));
    expect(result.record).toMatchObject({ outcome: "incomplete", reason: "spend_refused:insufficient_funds" });
  });

  it("gives no_public_match, with its time, only for a successful zero-result response", async () => {
    world = await makeWorld({ recordings: ["phrase-1.zero-results"] });
    const result = recorded(await world.searcher.checkPhrase("phrase-1", SEARCH_INPUT));
    expect(result.record.outcome).toBe("no_public_match");
    expect(result.record.reason).toBeNull();
    expect(result.record.statement).toContain(result.record.completed_at);
    expect(result.record.statement).toMatch(/as of that time only/);
  });

  it("gives public_match listing the matching URLs", async () => {
    world = await makeWorld({ recordings: ["phrase-3.match"] });
    const result = recorded(await world.searcher.checkPhrase("phrase-3", SEARCH_INPUT));
    expect(result.record.outcome).toBe("public_match");
    expect(result.record.results.map((r) => "url" in r && r.url)).toEqual([
      "https://example.invalid/issues/100",
      "https://example.invalid/issues/101",
    ]);
  });

  it("treats a failed URL in an extract response as incomplete", async () => {
    world = await makeWorld({ recordings: ["docs-1.failed-url"] });
    const result = recorded(await world.searcher.extractDocs("docs-1", SEARCH_INPUT));
    expect(result.record.outcome).toBe("incomplete");
    expect(result.record.reason).toBe("provider_error");
    expect(result.record.kind).toBe("docs");
  });
});

describe("result freezing", () => {
  it("freezes source results in order with an excerpt capped at the configured length", async () => {
    world = await makeWorld({ recordings: ["source-1.ok"], settings: { ...SETTINGS, excerpt_max_chars: 20 } });
    const result = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    const results = result.record.results as { url: string; title: string; published_date: string | null; score: number; excerpt: string }[];
    expect(results.map((r) => r.url)).toEqual([
      "https://example.invalid/issues/100",
      "https://example.invalid/issues/101",
      "https://example.invalid/issues/102",
    ]);
    expect(results[0]).toMatchObject({ title: "Synthetic result 1", published_date: "2024-05-01", score: 0.9 });
    expect(results[1]?.published_date).toBeNull();
    expect(results[0]?.excerpt).toBe("Synthetic excerpt 1 ");
    expect(results.every((r) => r.excerpt.length <= 20)).toBe(true);
  });

  it("freezes extract passages with their source URL", async () => {
    world = await makeWorld({ recordings: ["docs-1.ok"] });
    const result = recorded(await world.searcher.extractDocs("docs-1", SEARCH_INPUT));
    expect(result.record.outcome).toBe("complete");
    expect(result.record.results).toEqual([
      {
        url: "https://docs.example.invalid/guide/reports",
        passages: ["Reports can be filtered by date.", "An empty filter shows every row."],
      },
    ]);
  });

  it("stamps UTC times ending in Z and a stable hash of the record bytes", async () => {
    world = await makeWorld({ recordings: ["source-1.ok"] });
    const { record } = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    expect(record.requested_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(record.completed_at).toMatch(/Z$/);
    expect(record.completed_at >= record.requested_at).toBe(true);
    expect(record.schema_version).toBe(1);
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
