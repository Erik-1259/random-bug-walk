import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SearchError, createTavilyClient, installWireTap } from "../../src/index.ts";
import { ALL_OK, RECORDINGS_DIR, SYNTHETIC_KEY, buildRecordings, loadRecordings } from "../support/fixtures.ts";
import type { Recording } from "../support/replay-server.ts";
import { startReplayServer } from "../support/replay-server.ts";

describe("client construction", () => {
  for (const [label, apiKey] of [
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   \t"],
  ] as const) {
    it(`throws missing_api_key for a ${label} key and sends no request`, async () => {
      const server = await startReplayServer({ recordings: [] });
      try {
        let thrown: unknown;
        try {
          createTavilyClient({ apiKey, apiBaseURL: server.baseURL });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(SearchError);
        expect((thrown as SearchError).code).toBe("missing_api_key");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(server.requests).toHaveLength(0);
      } finally {
        await server.close();
      }
    });
  }

  it("requires an explicit, valid base URL", () => {
    expect(() => createTavilyClient({ apiKey: SYNTHETIC_KEY } as never)).toThrow(/missing_base_url/);
    expect(() => createTavilyClient({ apiKey: SYNTHETIC_KEY, apiBaseURL: "not a url" })).toThrow(/invalid_base_url/);
  });

  it("cannot target the real Tavily API unless live use is switched on explicitly", () => {
    for (const url of ["https://api.tavily.com", "https://api.tavily.com/", "https://eu.api.tavily.com"]) {
      expect(() => createTavilyClient({ apiKey: SYNTHETIC_KEY, apiBaseURL: url })).toThrow(/live_endpoint_refused/);
    }
    expect(() =>
      createTavilyClient({ apiKey: SYNTHETIC_KEY, apiBaseURL: "https://api.tavily.com", allowLive: true }),
    ).not.toThrow();
  });

  it("sends the key only as a bearer header, never in the body", async () => {
    const server = await startReplayServer({ recordings: loadRecordings(ALL_OK) });
    try {
      const client = createTavilyClient({ apiKey: SYNTHETIC_KEY, apiBaseURL: server.baseURL });
      await client.search("synthetic report filter empty table", {
        searchDepth: "basic",
        maxResults: 5,
        includeDomains: ["github.com", "stackoverflow.com"],
        includeDomainsMode: "restrict",
        startDate: "2020-01-01",
        endDate: "2026-10-01",
        autoParameters: false,
        includeUsage: true,
        timeout: 30,
      });
      expect(server.requests[0]?.hadAuthorization).toBe(true);
      expect(JSON.stringify(server.requests[0]?.body)).not.toContain(SYNTHETIC_KEY);
      expect(server.unmatched).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("recordings", () => {
  it("hold no api_key field, Authorization header or key-like value", () => {
    const files = readdirSync(RECORDINGS_DIR);
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const file of files) {
      const text = readFileSync(join(RECORDINGS_DIR, file), "utf8");
      expect(text, file).not.toMatch(/api_key|apikey|authorization|bearer|tvly-|"headers"/i);
      expect(text, file).not.toContain(SYNTHETIC_KEY);
      expect((JSON.parse(text) as Recording).provenance, file).toBe("synthetic");
    }
  });

  it("use only reserved example.invalid hosts", () => {
    for (const file of readdirSync(RECORDINGS_DIR)) {
      const text = readFileSync(join(RECORDINGS_DIR, file), "utf8");
      for (const host of text.match(/https?:\/\/[^/"\s]+/g) ?? []) {
        expect(host, file).toMatch(/example\.invalid$/);
      }
    }
  });

  it("match the generator output, so an edit to either side is noticed", () => {
    const expected = buildRecordings();
    const files = readdirSync(RECORDINGS_DIR).sort();
    expect(files).toEqual(
      Object.keys(expected)
        .map((name) => `${name}.json`)
        .sort(),
    );
    for (const [name, recording] of Object.entries(expected)) {
      expect(JSON.parse(readFileSync(join(RECORDINGS_DIR, `${name}.json`), "utf8"))).toEqual(recording);
    }
  });

  it("cover results, passages, a failed URL, zero results, 429, 500, missing usage and 0 credits", () => {
    const all = Object.values(buildRecordings());
    const body = (r: Recording): Record<string, unknown> => r.response.body as Record<string, unknown>;
    const count = (r: Recording, key: string): number => (body(r)[key] as unknown[]).length;
    const has = (predicate: (r: Recording) => boolean): boolean => all.some(predicate);
    expect(has((r) => r.endpoint === "search" && r.response.status === 200 && Array.isArray(body(r).results) && count(r, "results") > 0)).toBe(true);
    expect(has((r) => r.endpoint === "extract" && count(r, "results") > 0)).toBe(true);
    expect(has((r) => r.endpoint === "extract" && count(r, "failed_results") > 0)).toBe(true);
    expect(has((r) => r.endpoint === "search" && Array.isArray(body(r).results) && count(r, "results") === 0)).toBe(true);
    expect(has((r) => r.response.status === 429)).toBe(true);
    expect(has((r) => r.response.status === 500)).toBe(true);
    expect(has((r) => r.response.status === 200 && !("usage" in body(r)))).toBe(true);
    expect(has((r) => r.endpoint === "extract" && JSON.stringify(body(r).usage) === '{"credits":0}')).toBe(true);
  });
});

describe("wire tap", () => {
  it("keeps a body-level api_key and the headers out of the captured exchange", async () => {
    const server = await startReplayServer({ recordings: [] });
    const tap = installWireTap();
    try {
      const client = createTavilyClient({ apiKey: SYNTHETIC_KEY, apiBaseURL: server.baseURL });
      await client.search("synthetic tap query", { timeout: 5, api_key: SYNTHETIC_KEY }).catch(() => undefined);
      const exchange = tap.take();
      expect(exchange?.endpoint).toBe("search");
      expect(exchange?.request_body).toEqual({ query: "synthetic tap query" });
      expect(JSON.stringify(exchange)).not.toContain(SYNTHETIC_KEY);
      expect(exchange?.response?.status).toBe(599);
      expect(tap.take()).toBeNull();
    } finally {
      tap.remove();
      await server.close();
    }
  });
});

describe("replay server", () => {
  it("answers an unmatched request with an error and lists it", async () => {
    const server = await startReplayServer({ recordings: [] });
    try {
      const client = createTavilyClient({ apiKey: SYNTHETIC_KEY, apiBaseURL: server.baseURL });
      await expect(client.search("no recording for this", { timeout: 5 })).rejects.toThrow();
      expect(server.unmatched).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
