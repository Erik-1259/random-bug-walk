import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SearchError,
  canonicalJson,
  createDirectoryRecordStore,
  createMemoryRecordStore,
  freezeRecord,
  summarizeNovelty,
  verifyRecord,
} from "../../src/index.ts";
import type { SearchRecord } from "../../src/index.ts";
import { ALL_OK, SEARCH_INPUT, hex } from "../support/fixtures.ts";
import { makeWorld } from "../support/harness.ts";
import type { World } from "../support/harness.ts";
import { recordOf, recorded } from "../support/assert.ts";

let world: World | undefined;
const dirs: string[] = [];
afterEach(async () => {
  if (world !== undefined) {
    await world.close();
    world = undefined;
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function phraseRecord(outcome: "public_match" | "no_public_match" | "incomplete", n: number): SearchRecord {
  return freezeRecord({
    schema_version: 1,
    candidate: "synthetic-candidate-1",
    call_name: `phrase-${String(n)}`,
    kind: "phrase",
    request: { endpoint: "search", query: `"synthetic phrase ${String(n)}"`, options: {} },
    requested_at: "2026-10-04T12:00:00.000Z",
    completed_at: "2026-10-04T12:00:01.000Z",
    outcome,
    reason: outcome === "incomplete" ? "provider_error" : null,
    results: outcome === "public_match" ? [{ url: "https://example.invalid/a", title: "t", published_date: null, score: 1, excerpt: "" }] : [],
    reported_credits: 1,
    operation_id: hex(n),
    statement: outcome === "no_public_match" ? "No public match as of 2026-10-04T12:00:01.000Z; this holds as of that time only." : null,
  });
}

describe("novelty summary", () => {
  it("is clear only when all three phrase records are no_public_match", () => {
    const summary = summarizeNovelty([1, 2, 3].map((n) => phraseRecord("no_public_match", n)));
    expect(summary).toMatchObject({ status: "clear", matching_urls: [] });
  });

  it("blocks release when one phrase has a public match", () => {
    const summary = summarizeNovelty([
      phraseRecord("no_public_match", 1),
      phraseRecord("public_match", 2),
      phraseRecord("no_public_match", 3),
    ]);
    expect(summary.status).toBe("blocked");
    expect(summary.matching_urls).toEqual(["https://example.invalid/a"]);
  });

  it("stays blocked when a match sits beside an incomplete record", () => {
    const summary = summarizeNovelty([
      phraseRecord("incomplete", 1),
      phraseRecord("public_match", 2),
      phraseRecord("no_public_match", 3),
    ]);
    expect(summary.status).toBe("blocked");
  });

  it("is incomplete when one phrase record is incomplete", () => {
    const summary = summarizeNovelty([
      phraseRecord("no_public_match", 1),
      phraseRecord("incomplete", 2),
      phraseRecord("no_public_match", 3),
    ]);
    expect(summary.status).toBe("incomplete");
  });

  it("is never clear for missing, duplicated or non-phrase records", () => {
    expect(summarizeNovelty([]).status).toBe("incomplete");
    expect(summarizeNovelty([1, 2].map((n) => phraseRecord("no_public_match", n))).status).toBe("incomplete");
    const dup = [1, 1, 2].map((n) => phraseRecord("no_public_match", n));
    expect(summarizeNovelty(dup).status).toBe("incomplete");
  });

  it("computes the summary from real records of a run", async () => {
    world = await makeWorld({ recordings: ["phrase-1.zero-results", "phrase-2.match", "phrase-3.zero-results"] });
    const records: SearchRecord[] = [];
    for (const name of ["phrase-1", "phrase-2", "phrase-3"]) {
      records.push(recordOf(await world.searcher.checkPhrase(name, SEARCH_INPUT)));
    }
    expect(summarizeNovelty(records).status).toBe("blocked");
  });
});

describe("frozen records", () => {
  it("hashes the canonical bytes, stably and independent of key order", () => {
    const record = phraseRecord("no_public_match", 1);
    expect(verifyRecord(record)).toBe(true);
    const { sha256, ...rest } = record;
    const reordered = Object.fromEntries(Object.entries(rest).reverse());
    expect(freezeRecord(reordered as Omit<SearchRecord, "sha256">).sha256).toBe(sha256);
    expect(verifyRecord({ ...record, outcome: "public_match" })).toBe(false);
  });

  it("canonicalizes with sorted keys and no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: "x" }] })).toBe('{"a":[2,{"c":"x"}],"b":1}');
  });

  it("refuses to rewrite a key with different bytes and accepts identical bytes", () => {
    const store = createMemoryRecordStore();
    const first = phraseRecord("no_public_match", 1);
    store.put("synthetic-candidate-1.phrase-1", first);
    store.put("synthetic-candidate-1.phrase-1", first);
    expect(() => {
      store.put("synthetic-candidate-1.phrase-1", phraseRecord("public_match", 1));
    }).toThrow(SearchError);
    expect(store.get("synthetic-candidate-1.phrase-1")).toEqual(first);
  });

  it("writes one file per key in the directory store and refuses different bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "synthetic-search-"));
    dirs.push(dir);
    const store = createDirectoryRecordStore(dir);
    const first = phraseRecord("no_public_match", 2);
    store.put("synthetic-candidate-1.phrase-2", first);
    expect(readdirSync(dir)).toEqual(["synthetic-candidate-1.phrase-2.record.json"]);
    expect(JSON.parse(readFileSync(join(dir, "synthetic-candidate-1.phrase-2.record.json"), "utf8"))).toEqual(first);
    expect(() => {
      store.put("synthetic-candidate-1.phrase-2", phraseRecord("public_match", 2));
    }).toThrow(/record_conflict/);
    expect(createDirectoryRecordStore(dir).get("synthetic-candidate-1.phrase-2")).toEqual(first);
  });

  it("rejects store keys that could leave the directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "synthetic-search-"));
    dirs.push(dir);
    expect(() => createDirectoryRecordStore(dir).get("../escape")).toThrow(SearchError);
  });

  it("writes each call's record once; a reader reuses it and a repeated call is refused", async () => {
    const store = createMemoryRecordStore();
    world = await makeWorld({ recordings: ALL_OK, store });
    const first = recorded(await world.searcher.searchSource("source-1", SEARCH_INPUT));
    expect(store.get("synthetic-candidate-1.source-1")).toEqual(first.record);
    const logLength = world.log.length;
    const requests = world.server.requests.length;
    expect((await world.searcher.searchSource("source-1", SEARCH_INPUT)).status).toBe("refused");
    expect(world.log.length).toBe(logLength);
    expect(world.server.requests.length).toBe(requests);
    expect(store.get("synthetic-candidate-1.source-1")).toEqual(first.record);
  });
});
