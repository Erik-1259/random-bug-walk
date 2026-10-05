import { afterEach, describe, expect, it } from "vitest";
import { ALL_OK, SEARCH_INPUT, SETTINGS, SLOT } from "../support/fixtures.ts";
import { makeWorld } from "../support/harness.ts";
import type { World } from "../support/harness.ts";
import { expectRefused, recorded } from "../support/assert.ts";

let world: World | undefined;
afterEach(async () => {
  if (world !== undefined) {
    expect(world.server.unmatched).toEqual([]);
    await world.close();
    world = undefined;
  }
});

describe("call limits", () => {
  it("refuses a seventh call, an unknown name and a name of the wrong kind before reserving", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const { searcher } = world;
    await searcher.searchSource("source-1", SEARCH_INPUT);
    await searcher.searchSource("source-2", SEARCH_INPUT);
    await searcher.extractDocs("docs-1", SEARCH_INPUT);
    await searcher.checkPhrase("phrase-1", SEARCH_INPUT);
    await searcher.checkPhrase("phrase-2", SEARCH_INPUT);
    await searcher.checkPhrase("phrase-3", SEARCH_INPUT);
    const before = { log: world.log.length, requests: world.server.requests.length };
    expectRefused(await searcher.searchSource("source-3", SEARCH_INPUT), "call_limit_reached");
    expectRefused(await searcher.checkPhrase("phrase-4", SEARCH_INPUT), "call_limit_reached");
    expectRefused(await searcher.searchSource("docs-1", SEARCH_INPUT), "call_limit_reached");
    expectRefused(await searcher.extractDocs("source-1", SEARCH_INPUT), "call_limit_reached");
    expect(world.log.length).toBe(before.log);
    expect(world.server.requests.length).toBe(before.requests);
    expect(world.server.requests).toHaveLength(6);
  });

  it("refuses a repeated name before reserving, and keeps the first record", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const first = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    const logLength = world.log.length;
    expectRefused(await world.searcher.searchSource("source-1", SEARCH_INPUT), "call_limit_reached");
    expect(world.log.length).toBe(logLength);
    expect(world.server.requests).toHaveLength(1);
    expect(first.record.outcome).toBe("complete");
  });

  it("does not let a restarted process run a used name again", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const first = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    // A new searcher has no memory of the first one; the spend database still has the operation.
    const { createSearcher, createTavilyClient, parseRateSheet } = await import("../../src/index.ts");
    const { CONTEXT, POOL, RATE_ENTRIES, SYNTHETIC_KEY } = await import("../support/fixtures.ts");
    const restarted = createSearcher({
      client: createTavilyClient({ apiKey: SYNTHETIC_KEY, apiBaseURL: world.server.baseURL }),
      spend: world.spend,
      context: CONTEXT,
      rates: parseRateSheet(JSON.stringify(RATE_ENTRIES)),
      poolKey: POOL,
      slotKey: SLOT,
      settings: SETTINGS,
      excludedIdentifiers: [],
    });
    const second = recorded(await restarted.searchSource("source-1", SEARCH_INPUT));
    expect(world.server.requests).toHaveLength(1);
    expect(second.record.outcome).toBe("incomplete");
    expect(second.record.reason).toBe("spend_refused:operation_replay");
    expect(second.stop).toBe("spend_refused");
    expect(second.record.operation_id).toBe(first.record.operation_id);
  });

  it("refuses a restarted run whose request changed with operation_conflict", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    await world.searcher.searchSource("source-1", SEARCH_INPUT);
    const { createSearcher, createTavilyClient, parseRateSheet } = await import("../../src/index.ts");
    const { CONTEXT, POOL, RATE_ENTRIES, SYNTHETIC_KEY } = await import("../support/fixtures.ts");
    const restarted = createSearcher({
      client: createTavilyClient({ apiKey: SYNTHETIC_KEY, apiBaseURL: world.server.baseURL }),
      spend: world.spend,
      context: CONTEXT,
      rates: parseRateSheet(JSON.stringify(RATE_ENTRIES)),
      poolKey: POOL,
      slotKey: SLOT,
      settings: SETTINGS,
      excludedIdentifiers: [],
    });
    const changed = { ...SEARCH_INPUT, source: { ...SEARCH_INPUT.source, symptom_words: ["different"] } };
    const result = recorded(await restarted.searchSource("source-1", changed));
    expect(result.record.reason).toBe("spend_refused:operation_conflict");
    expect(world.server.requests).toHaveLength(1);
  });

  it("refuses an input that does not match the schema", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const bad = { ...SEARCH_INPUT, extra: true } as unknown as typeof SEARCH_INPUT;
    expectRefused(await world.searcher.searchSource("source-1", bad), "invalid_input");
    expect(world.log).toEqual([]);
  });
});

describe("docs and source domain policy", () => {
  it("refuses an excluded-domain and an off-domain docs URL before reserving", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const withUrl = (url: string): typeof SEARCH_INPUT => ({ ...SEARCH_INPUT, docs: { ...SEARCH_INPUT.docs, url } });
    expectRefused(
      await world.searcher.extractDocs("docs-1", withUrl("https://datelib.example.invalid/api/format")),
      "docs_domain_excluded",
    );
    expectRefused(
      await world.searcher.extractDocs("docs-1", withUrl("https://sub.datelib.example.invalid/x")),
      "docs_domain_excluded",
    );
    expectRefused(
      await world.searcher.extractDocs("docs-1", withUrl("https://other.example.invalid/guide")),
      "docs_domain_not_allowed",
    );
    expectRefused(
      await world.searcher.extractDocs("docs-1", withUrl("https://notdocs.example.invalid.evil.invalid/")),
      "docs_domain_not_allowed",
    );
    expectRefused(await world.searcher.extractDocs("docs-1", withUrl("not a url")), "docs_domain_not_allowed");
    expect(world.log).toEqual([]);
    expect(world.server.requests).toHaveLength(0);
  });

  it("refuses source domains outside GitHub, Stack Overflow and the project-docs domains", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const withDomains = (include_domains: string[]): typeof SEARCH_INPUT => ({
      ...SEARCH_INPUT,
      source: { ...SEARCH_INPUT.source, include_domains },
    });
    expectRefused(await world.searcher.searchSource("source-1", withDomains(["blog.example.invalid"])), "source_domain_not_allowed");
    expectRefused(
      await world.searcher.searchSource("source-1", withDomains(["github.com", "datelib.example.invalid"])),
      "source_domain_not_allowed",
    );
    expect(world.log).toEqual([]);
  });
});

describe("query hygiene", () => {
  it("refuses an excluded identifier in any query before reserving", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const source = { ...SEARCH_INPUT, source: { ...SEARCH_INPUT.source, symptom_words: ["Synthetic_Internal_Fn"] } };
    expectRefused(await world.searcher.searchSource("source-1", source), "excluded_identifier");
    const docs = { ...SEARCH_INPUT, docs: { ...SEARCH_INPUT.docs, query: "see synthetic/internal/path.ts now" } };
    expectRefused(await world.searcher.extractDocs("docs-1", docs), "excluded_identifier");
    const phrases = ["synthetic phrase one", "has synthetic_internal_fn inside", "synthetic phrase three"];
    expectRefused(await world.searcher.checkPhrase("phrase-2", { ...SEARCH_INPUT, phrases }), "excluded_identifier");
    expect(world.log).toEqual([]);
    expect(world.server.requests).toHaveLength(0);
  });
});
