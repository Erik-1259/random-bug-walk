import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CatalogError, criteriaCatalogV1, criterionOf, parseCriteriaCatalog } from "../src/criteria.ts";
import { matchDescription } from "../src/match.ts";
import { REPO_ROOT, fixtureCatalog } from "./support.ts";

const RAW = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "factory", "criteria-catalog", "v1.json"), "utf8")) as Record<string, unknown>;

describe("criteria catalog version 1", () => {
  const catalog = criteriaCatalogV1();

  it("is version 1 with the three criteria and the codes the real checks report", () => {
    expect(catalog.criteria_catalog_version).toBe("1");
    const codes = catalog.bug_types.flatMap((type) => type.criteria.map((criterion) => [type.bug_type_id, criterion.criterion_id, criterion.version, criterion.failure_code]));
    expect(codes).toEqual([
      ["concurrency", "concurrency.lost-acknowledged-change", "1", "acknowledged_completion_not_counted"],
      ["concurrency", "concurrency.stale-success-response", "1", "stale_success_response"],
      ["date_time", "date_time.time-zone-grouping", "1", "local_day_counts_mismatch"],
    ]);
  });

  it("publishes the fixtures' labels, descriptions and failure codes", () => {
    const published = fixtureCatalog();
    for (const type of published.bug_types) {
      for (const criterion of type.criteria) {
        const ours = criterionOf(catalog, criterion.criterion_id);
        expect(ours?.criterion).toMatchObject({ label: criterion.label, description: criterion.description, failure_code: criterion.failure_code, version: criterion.version });
      }
    }
  });

  it("gives every criterion at least four example phrases and declares the filler phrases", () => {
    for (const type of catalog.bug_types) for (const criterion of type.criteria) expect(criterion.example_phrases.length).toBeGreaterThanOrEqual(4);
    expect(catalog.filler_phrases).toEqual(expect.arrayContaining(["I want a bug where", "I need a bug where", "a bug where", "find a bug where", "please"]));
  });

  it("matches each example phrase to its own criterion only", () => {
    for (const type of catalog.bug_types) {
      for (const criterion of type.criteria) {
        for (const phrase of criterion.example_phrases) {
          const match = matchDescription(phrase, type.criteria, catalog.filler_phrases);
          expect(match.unmatched_text).toEqual([]);
          expect(match.criteria.map((m) => m.criterion.criterion_id)).toEqual([criterion.criterion_id]);
        }
      }
    }
  });

  it("refuses a catalog that repeats a failure code, misses a bug type or has an unknown field", () => {
    const repeated = structuredClone(RAW) as { bug_types: { criteria: { failure_code: string }[] }[] };
    const [first] = repeated.bug_types;
    if (first?.criteria[1] !== undefined && first.criteria[0] !== undefined) first.criteria[1].failure_code = first.criteria[0].failure_code;
    expect(() => parseCriteriaCatalog(repeated)).toThrow(CatalogError);
    expect(() => parseCriteriaCatalog({ ...RAW, bug_types: (RAW.bug_types as unknown[]).slice(0, 1) })).toThrow(/every bug type/);
    expect(() => parseCriteriaCatalog({ ...RAW, extra: true })).toThrow(/exactly the fields/);
  });
});

describe("criteria-match version 1", () => {
  const catalog = fixtureCatalog();
  const concurrency = catalog.bug_types[0]?.criteria ?? [];

  it("covers a description with a filler phrase and a criterion phrase, keeping the description's case", () => {
    const match = matchDescription("I want a bug where An acknowledged change is lost when requests overlap", concurrency, catalog.filler_phrases);
    expect(match.unmatched_text).toEqual([]);
    expect(match.criteria.map((m) => [m.criterion.criterion_id, m.matched_text])).toEqual([["concurrency.lost-acknowledged-change", "An acknowledged change is lost when requests overlap"]]);
  });

  it("compares words case-insensitively and treats punctuation and spaces only as separators", () => {
    const match = matchDescription("I WANT a bug where... lost   update!", concurrency, catalog.filler_phrases);
    expect(match.unmatched_text).toEqual([]);
    expect(match.criteria.map((m) => m.matched_text)).toEqual(["lost   update"]);
  });

  it("reports each maximal run of uncovered words as the description's text", () => {
    const match = matchDescription("An acknowledged change is lost when requests overlap after a network retry", concurrency, catalog.filler_phrases);
    expect(match.unmatched_text).toEqual(["after a network retry"]);
    const two = matchDescription("Sadly, lost update, twice, in prod", concurrency, catalog.filler_phrases);
    expect(two.unmatched_text).toEqual(["Sadly", "twice, in prod"]);
  });

  it("matches phrases exactly, never a part of a word", () => {
    const match = matchDescription("lost updates", concurrency, catalog.filler_phrases);
    expect(match.criteria).toEqual([]);
    expect(match.unmatched_text).toEqual(["lost updates"]);
  });

  it("treats a description of filler phrases only, or with no word, as no description", () => {
    expect(matchDescription("I want a bug where", concurrency, catalog.filler_phrases)).toEqual({ criteria: [], unmatched_text: [], treated_as_none: true });
    expect(matchDescription("!!!", concurrency, catalog.filler_phrases)).toEqual({ criteria: [], unmatched_text: [], treated_as_none: true });
  });

  it("matches several criteria of the type when the description names them", () => {
    const match = matchDescription("lost update and the response shows a value that was not saved", concurrency, catalog.filler_phrases);
    expect(match.criteria.map((m) => m.criterion.criterion_id)).toEqual(["concurrency.lost-acknowledged-change", "concurrency.stale-success-response"]);
    expect(match.unmatched_text).toEqual(["and"]);
  });
});
