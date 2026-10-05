import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SearchError,
  buildIdentity,
  buildProfile,
  loadRateSheet,
  parseRateSheet,
  parseRunContext,
  parseSearchInput,
  priceOf,
} from "../../src/index.ts";
import { CONTEXT, RATE_ENTRIES, SEARCH_INPUT, SETTINGS, hex } from "../support/fixtures.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("search input", () => {
  it("accepts the synthetic input", () => {
    expect(parseSearchInput(SEARCH_INPUT).candidate).toBe("synthetic-candidate-1");
  });

  it("refuses unknown fields, wrong versions and missing fields", () => {
    expect(() => parseSearchInput({ ...SEARCH_INPUT, extra: 1 })).toThrow();
    expect(() => parseSearchInput({ ...SEARCH_INPUT, schema_version: 2 })).toThrow();
    expect(() => parseSearchInput({ ...SEARCH_INPUT, source: { ...SEARCH_INPUT.source, extra: 1 } })).toThrow();
    const { docs, ...withoutDocs } = SEARCH_INPUT;
    expect(docs).toBeDefined();
    expect(() => parseSearchInput(withoutDocs)).toThrow();
  });

  it("requires exactly three non-empty phrases without double quotes", () => {
    expect(() => parseSearchInput({ ...SEARCH_INPUT, phrases: ["a", "b"] })).toThrow();
    expect(() => parseSearchInput({ ...SEARCH_INPUT, phrases: ["a", "b", "c", "d"] })).toThrow();
    expect(() => parseSearchInput({ ...SEARCH_INPUT, phrases: ["a", "", "c"] })).toThrow();
    expect(() => parseSearchInput({ ...SEARCH_INPUT, phrases: ["a", 'say "hi"', "c"] })).toThrow();
  });

  it("requires valid dates in order and a label-safe candidate", () => {
    const withSource = (patch: object): object => ({ ...SEARCH_INPUT, source: { ...SEARCH_INPUT.source, ...patch } });
    expect(() => parseSearchInput(withSource({ start_date: "2026-13-01" }))).toThrow();
    expect(() => parseSearchInput(withSource({ start_date: "2026-10-02", end_date: "2026-10-01" }))).toThrow();
    expect(() => parseSearchInput({ ...SEARCH_INPUT, candidate: "has:colon" })).toThrow();
    expect(() => parseSearchInput({ ...SEARCH_INPUT, candidate: "x".repeat(41) })).toThrow();
  });
});

describe("run context", () => {
  it("accepts the synthetic context and refuses unknown or malformed fields", () => {
    expect(parseRunContext(CONTEXT).root_execution_id).toBe(CONTEXT.root_execution_id);
    expect(() => parseRunContext({ ...CONTEXT, extra: 1 })).toThrow();
    expect(() => parseRunContext({ ...CONTEXT, project_id: "NOT-A-UUID" })).toThrow();
    expect(() => parseRunContext({ ...CONTEXT, task_revision: "abc" })).toThrow();
    const { execution_id, ...rest } = CONTEXT;
    expect(execution_id).toBeDefined();
    expect(() => parseRunContext(rest)).toThrow();
  });
});

describe("rate sheet", () => {
  it("hashes the exact bytes of the file and finds the Tavily credit price", () => {
    const dir = mkdtempSync(join(tmpdir(), "synthetic-rates-"));
    dirs.push(dir);
    const path = join(dir, "rates.json");
    const text = `${JSON.stringify(RATE_ENTRIES, null, 4)}\n`;
    writeFileSync(path, text);
    const sheet = loadRateSheet(path);
    expect(sheet.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(priceOf(sheet, "tavily", "credit")).toEqual({ microusd: 8000, per_units: 1 });
    expect(priceOf(sheet, "tavily", "call")).toBeNull();
  });

  it("refuses malformed entries and an unreadable file", () => {
    expect(() => parseRateSheet("{}")).toThrow(SearchError);
    expect(() => parseRateSheet('[{"service":"tavily"}]')).toThrow(SearchError);
    expect(() => loadRateSheet("/nonexistent/synthetic-rates.json")).toThrow(SearchError);
  });
});

describe("search profile and identity", () => {
  it("changes the profile digest when an option, limit or domain list changes", () => {
    const base = buildProfile(SETTINGS);
    expect(base.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(buildProfile(SETTINGS).sha256).toBe(base.sha256);
    expect(buildProfile({ ...SETTINGS, timeout_seconds: 31 }).sha256).not.toBe(base.sha256);
    expect(buildProfile({ ...SETTINGS, project_docs_domains: ["other.example.invalid"] }).sha256).not.toBe(base.sha256);
    expect(buildProfile({ ...SETTINGS, max_results: 6 }).sha256).not.toBe(base.sha256);
  });

  it("derives the operation id from the call identity and the payload hash from the options", () => {
    const profile = buildProfile(SETTINGS);
    const a = buildIdentity({ context: CONTEXT, profile, candidate: "synthetic-candidate-1", name: "source-1", kind: "search.source", options: { q: 1 } });
    const same = buildIdentity({ context: CONTEXT, profile, candidate: "synthetic-candidate-1", name: "source-1", kind: "search.source", options: { q: 2 } });
    const other = buildIdentity({ context: CONTEXT, profile, candidate: "synthetic-candidate-1", name: "source-2", kind: "search.source", options: { q: 1 } });
    expect(a.operation_id).toBe(same.operation_id);
    expect(a.payload_hash).not.toBe(same.payload_hash);
    expect(a.operation_id).not.toBe(other.operation_id);
    expect(a.call_name).toBe("search.source.synthetic-candidate-1.source-1");
    expect(a.runtime_profile_sha256).toBe(profile.sha256);
    expect(hex(0)).toHaveLength(64);
  });
});
