import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QUERIES, QUERY_FILE, parseQueries, searchUrl } from "../../src/queries.ts";

describe("query list", () => {
  it("loads the searches from the data file, in order", () => {
    const file = JSON.parse(readFileSync(QUERY_FILE, "utf8")) as { queries: { kind: string; q: string }[] };
    expect(QUERIES.map((query) => ({ kind: query.kind, q: query.q }))).toEqual(file.queries.map((query) => ({ kind: query.kind, q: query.q })));
  });

  it("searches by the date APIs a time-zone fix touches, not by prose", () => {
    const text = QUERIES.map((query) => query.q).join("\n");
    for (const api of ["formatInTimeZone", "toZonedTime", "fromZonedTime", "utcToZonedTime", "dayjs", "Intl.DateTimeFormat", "useDateRange", "startOfDay", "startOfMonth"]) {
      expect(text, api).toContain(api);
    }
    expect(text).not.toContain('"pass timezone"');
  });

  it("asks for merged pull requests only, and for each query names the API it targets", () => {
    for (const query of QUERIES.filter((entry) => entry.kind === "pulls")) {
      expect(query.q).toMatch(/\bis:pr\b.*\bis:merged\b/);
    }
    expect(QUERIES.filter((query) => !query.q.includes(query.api))).toEqual([]);
  });

  it("refuses a malformed or empty query file", () => {
    expect(() => parseQueries('{"queries": []}')).toThrow(/query file/);
    expect(() => parseQueries('{"queries": [{"kind": "code", "api": "x", "q": "x"}]}')).toThrow(/query file/);
    expect(() => parseQueries("not json")).toThrow(/query file/);
    expect(parseQueries('{"queries": [{"kind": "commits", "api": "toZonedTime", "q": "toZonedTime timezone"}]}')).toEqual([
      { kind: "commits", api: "toZonedTime", q: "toZonedTime timezone" },
    ]);
  });

  it("builds the commit and issue search URLs for the first page", () => {
    expect(searchUrl({ kind: "commits", q: "toZonedTime fix" })).toBe("/search/commits?q=toZonedTime+fix&per_page=30&page=1");
    expect(searchUrl({ kind: "pulls", q: "is:pr toZonedTime" })).toBe("/search/issues?q=is%3Apr+toZonedTime&per_page=30&page=1");
  });
});
