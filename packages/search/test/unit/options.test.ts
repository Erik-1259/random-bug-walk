import { afterEach, describe, expect, it } from "vitest";
import { SEARCH_INPUT, ALL_OK, wireBody } from "../support/fixtures.ts";
import { makeWorld } from "../support/harness.ts";
import type { World } from "../support/harness.ts";
import { recordOf } from "../support/assert.ts";

let world: World | undefined;
afterEach(async () => {
  if (world !== undefined) {
    expect(world.server.unmatched).toEqual([]);
    await world.close();
    world = undefined;
  }
});

describe("request options (one test per call of the plan)", () => {
  it("sends exactly the required options for each of the six calls", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const { searcher } = world;
    await searcher.searchSource("source-1", SEARCH_INPUT);
    await searcher.searchSource("source-2", SEARCH_INPUT);
    await searcher.extractDocs("docs-1", SEARCH_INPUT);
    await searcher.checkPhrase("phrase-1", SEARCH_INPUT);
    await searcher.checkPhrase("phrase-2", SEARCH_INPUT);
    await searcher.checkPhrase("phrase-3", SEARCH_INPUT);
    expect(world.server.requests.map((r) => [r.endpoint, r.body])).toEqual([
      ["search", wireBody("source-1")],
      ["search", wireBody("source-2")],
      ["extract", wireBody("docs-1")],
      ["search", wireBody("phrase-1")],
      ["search", wireBody("phrase-2")],
      ["search", wireBody("phrase-3")],
    ]);
  });

  it("sets autoParameters false, includeUsage, basic depth and a timeout on every call", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const { searcher } = world;
    await searcher.searchSource("source-1", SEARCH_INPUT);
    await searcher.checkPhrase("phrase-1", SEARCH_INPUT);
    await searcher.extractDocs("docs-1", SEARCH_INPUT);
    const [source, phrase, docs] = world.server.requests.map((r) => r.body);
    expect(source).toMatchObject({ auto_parameters: false, include_usage: true, search_depth: "basic" });
    expect(source).toMatchObject({ include_domains_mode: "restrict", start_date: "2020-01-01", end_date: "2026-10-01" });
    expect(phrase).toMatchObject({ auto_parameters: false, include_usage: true, exact_match: true });
    expect(phrase).not.toHaveProperty("include_domains");
    expect(docs).toMatchObject({ extract_depth: "basic", include_usage: true, timeout: 30 });
    expect(docs).toHaveProperty("query", SEARCH_INPUT.docs.query);
    expect((docs as { urls: string[] }).urls).toHaveLength(1);
  });

  it("quotes the phrase and freezes the exact request options in the record", async () => {
    world = await makeWorld({ recordings: ALL_OK });
    const record = recordOf(await world.searcher.checkPhrase("phrase-2", SEARCH_INPUT));
    expect(record.request.query).toBe('"synthetic phrase two"');
    expect(record.request.options).toMatchObject({ exactMatch: true, autoParameters: false, includeUsage: true });
    expect(JSON.stringify(record)).not.toMatch(/authorization|api_key|apikey|bearer/i);
  });
});
