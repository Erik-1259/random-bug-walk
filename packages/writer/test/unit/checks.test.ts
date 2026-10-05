import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkIssue } from "../../src/issue-checks.ts";
import type { IssueOutput } from "../../src/issue-schema.ts";
import { parseObservedSymptom } from "../../src/observed-symptom.ts";
import type { ObservedSymptom } from "../../src/observed-symptom.ts";
import { CANDIDATE, EXCLUDED_IDENTIFIERS, ISSUE_OUTPUTS, symptom } from "../fixtures/cases.ts";
import { openDb, rig } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

function observed(): ObservedSymptom {
  const parsed = parseObservedSymptom(symptom("valid"));
  if (!parsed.ok) {
    throw new Error(parsed.detail);
  }
  return parsed.symptom;
}

const VALID = ISSUE_OUTPUTS.valid as IssueOutput;

function check(output: Partial<IssueOutput>, excluded: readonly string[] = EXCLUDED_IDENTIFIERS) {
  return checkIssue({ ...VALID, ...output }, observed(), excluded);
}

describe("check 1: structure", () => {
  it("rejects a missing field and an empty step list, and runs no later check", () => {
    const missing = checkIssue({ title: "synthetic" }, observed(), []);
    expect(missing.structure.ok).toBe(false);
    expect(missing.status).toBe("rejected");
    expect(missing.codes).toEqual(["invalid_structure"]);
    expect(missing.numeric).toBeNull();
    expect(missing.identifiers).toBeNull();
    expect(checkIssue({ ...VALID, reproduction_steps: [] }, observed(), []).structure.ok).toBe(false);
    expect(checkIssue({ ...VALID, extra: "synthetic" }, observed(), []).structure.ok).toBe(false);
  });
});

describe("check 2: numeric statements", () => {
  it("passes the valid synthetic issue", () => {
    const report = check({});
    expect(report.numeric).toEqual({ ok: true, violations: [] });
    expect(report.status).toBe("ready_for_review");
  });

  it("compares digit runs as integers, so 07 matches 7 and 2026-01-02 is supported", () => {
    const report = check({ environment: "Synthetic: 006 views on 2026-01-02, status 0200." });
    expect(report.numeric?.ok).toBe(true);
  });

  it("names the field and the number of an unsupported number", () => {
    const report = check({ title: "Daily counts are off by 97" });
    expect(report.status).toBe("rejected");
    expect(report.codes).toContain("numeric_mismatch");
    expect(report.numeric?.violations).toEqual([{ field: "title", reason: "unsupported_number", number: "97" }]);
  });

  it("checks every field, steps included", () => {
    const report = check({ reproduction_steps: ["Open the report", "Wait 45 seconds"] });
    expect(report.numeric?.violations).toEqual([
      { field: "reproduction_steps[1]", reason: "unsupported_number", number: "45" },
    ]);
  });

  it("supports numbers from query parameters, timestamps, the HTTP status and doc excerpts", () => {
    const base = observed();
    const withNumbers = parseObservedSymptom({
      ...symptom("valid"),
      request: { ...base.request, query: { startAt: "1767225600000" } },
      doc_excerpts: [{ text: "Synthetic: data is kept for 400 days.", source_url: "https://docs.example.invalid/x" }],
    });
    if (!withNumbers.ok) {
      throw new Error(withNumbers.detail);
    }
    const report = checkIssue(
      { ...VALID, environment: "startAt 1767225600000, kept 400 days, status 200, event 1767322800." },
      withNumbers.symptom,
      [],
    );
    expect(report.numeric?.ok).toBe(true);
  });

  it("requires the expected vector in expected_result and the observed vector in actual_result", () => {
    const report = check({ expected_result: "2026-01-01 shows 6 pageviews." });
    expect(report.numeric?.violations).toEqual([
      { field: "expected_result", reason: "missing_expected_vector", number: null },
    ]);
    const observedMissing = check({ actual_result: "2026-01-02 shows 8 pageviews." });
    expect(observedMissing.numeric?.violations).toEqual([
      { field: "actual_result", reason: "missing_observed_vector", number: null },
    ]);
  });

  it("rejects vectors placed in the wrong sections", () => {
    const report = check({ expected_result: VALID.actual_result, actual_result: VALID.expected_result });
    expect(report.status).toBe("rejected");
    expect(report.numeric?.violations).toEqual([
      { field: "expected_result", reason: "missing_expected_vector", number: null },
      { field: "actual_result", reason: "missing_observed_vector", number: null },
    ]);
  });
});

describe("check 3: identifier scan", () => {
  it("rejects a term from the caller's list, case-insensitively on word boundaries", () => {
    const report = check({ environment: "The page calls GETSYNTHETICRANGE twice." });
    expect(report.codes).toEqual(["excluded_identifier"]);
    expect(report.identifiers?.violations).toEqual([
      { field: "environment", offset: 15, kind: "listed", term: "getSyntheticRange" },
    ]);
  });

  it("does not match a listed term inside a longer word", () => {
    expect(check({ environment: "xgetSyntheticRangey" }).identifiers?.ok).toBe(true);
  });

  it("matches listed terms that contain punctuation", () => {
    expect(check({ environment: "Check synthetic.check-one failed." }).identifiers?.violations[0]).toMatchObject({
      kind: "listed",
      term: "synthetic.check-one",
    });
  });

  it.each([
    ["a source path", "See src/lib/synthetic-range.ts for details.", "source_path"],
    ["an absolute source path", "See /src/lib/synthetic-range.ts now.", "source_path"],
    ["an alias import path", "It comes from @/lib/synthetic-range.ts.", "source_path"],
    ["a home-relative path", "Open ~/synthetic/helper.py.", "source_path"],
    ["a bracketed route segment", "In src/app/api/sites/[siteId]/stats/route.ts the totals differ.", "source_path"],
    ["a path in a stack frame", "It fails at file:///app/src/lib/synthetic.ts line 4.", "source_path"],
    ["a path in a URL", "See https://code.example.invalid/src/components/SyntheticChart.tsx.", "source_path"],
    ["a route-group path", "In src/app/(dashboard)/sites/page.tsx the chart is empty.", "source_path"],
    ["a check ID with a hyphenated first part", "The check date-range.tz-offset fails.", "check_id"],
    ["a bare source file", "The bug is in synthetic_helper.py.", "source_path"],
    ["an SQL file", "Run queries/synthetic.sql again.", "source_path"],
    ["a TSX file", "In components/SyntheticChart.tsx the chart renders.", "source_path"],
    ["a 40-character commit ID", "Introduced in 0123456789abcdef0123456789abcdef01234567.", "commit_id"],
    ["a dotted check-style ID", "The check timezone.bucket-shift fails.", "check_id"],
    ["a card field name", "Its fault_shape is a dropped argument.", "card_field"],
  ])("rejects %s without a list", (_name, text, kind) => {
    const report = checkIssue({ ...VALID, environment: text }, observed(), []);
    expect(report.status).toBe("rejected");
    expect(report.codes).toContain("excluded_identifier");
    expect(report.identifiers?.violations.map((v) => v.kind)).toContain(kind);
  });

  it("scans a long path-like text in linear time", () => {
    const started = performance.now();
    checkIssue({ ...VALID, environment: "a/".repeat(25_000) }, observed(), []);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("does not treat a product name such as Node.js as a source path", () => {
    expect(checkIssue({ ...VALID, environment: "Browser and Node.js versions are current." }, observed(), []).identifiers?.ok).toBe(true);
  });
});

describe("check 4: hint words", () => {
  it("reports every hint word with field and offset, and never blocks", () => {
    const report = check({
      environment: "The timezone parameter is ignored; counts use the default.",
      reproduction_steps: ["Pass through the argument", "It defaults to UTC"],
    });
    expect(report.status).toBe("ready_for_review");
    expect(report.codes).toEqual([]);
    const words = report.hint_words.map((h) => `${h.field}@${String(h.offset)}:${h.word}`);
    expect(words).toEqual(
      expect.arrayContaining([
        "environment@13:parameter",
        "environment@26:ignored",
        "environment@50:default",
        "reproduction_steps[0]@0:pass through",
        "reproduction_steps[0]@17:argument",
        "reproduction_steps[1]@3:default",
        "reproduction_steps[1]@3:defaults to utc",
      ]),
    );
  });

  it("reports passed, forward and dropped", () => {
    const report = check({ environment: "The value is passed, forwarded and dropped." });
    expect(report.hint_words.map((h) => h.word)).toEqual(["passed", "forward", "dropped"]);
  });
});

describe("the issue writer runs the checks on recorded responses", () => {
  const run = async (variant: string) => {
    const r = await rig(db);
    const outcome = await r.writer.writeIssue({
      candidate: CANDIDATE,
      symptom: symptom(variant),
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    return outcome;
  };

  it("marks a valid issue ready_for_review and never approved", async () => {
    const outcome = await run("valid");
    expect(outcome.report?.status).toBe("ready_for_review");
    expect(outcome.issue).toEqual(ISSUE_OUTPUTS.valid);
  });

  it("rejects an issue with an unsupported number", async () => {
    const outcome = await run("unsupported-number");
    expect(outcome.report?.codes).toEqual(["numeric_mismatch"]);
    expect(outcome.report?.numeric?.violations).toEqual([
      { field: "actual_result", reason: "unsupported_number", number: "97" },
    ]);
  });

  it("rejects an issue that names an excluded identifier", async () => {
    const outcome = await run("excluded-identifier");
    expect(outcome.report?.codes).toEqual(["excluded_identifier"]);
  });

  it("reports hint words and keeps the issue ready_for_review", async () => {
    const outcome = await run("hint-words");
    expect(outcome.report?.status).toBe("ready_for_review");
    expect(outcome.report?.hint_words.map((h) => h.word)).toEqual(["parameter", "ignored", "default"]);
  });

  it("treats a schema-invalid response as a failed call with a structure failure", async () => {
    const outcome = await run("schema-invalid");
    expect(outcome.call.status).toBe("failed");
    expect(outcome.call.failure).toBe("invalid_output");
    expect(outcome.issue).toBeNull();
    expect(outcome.report?.structure.ok).toBe(false);
    expect(outcome.report?.status).toBe("rejected");
  });
});
