// The race family's issue input, prompt and checks. The recorded cases replay committed synthetic
// recordings (test/fixtures/recordings/issue-race-*.json); nothing calls a model.
import type { PGlite } from "@electric-sql/pglite";
import { assertRecord, validateRecord } from "@rbw/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkIssue } from "../../src/issue-checks.ts";
import { buildIssuePrompt } from "../../src/issue-prompt.ts";
import type { IssueOutput } from "../../src/issue-schema.ts";
import { parseObservedSymptom } from "../../src/observed-symptom.ts";
import { parseWriterSymptom } from "../../src/race-symptom.ts";
import type { WriterSymptom } from "../../src/race-symptom.ts";
import { CANDIDATE, EXCLUDED_IDENTIFIERS, ISSUE_OUTPUTS, RACE_ISSUE_OUTPUTS, raceSymptom, symptom } from "../fixtures/cases.ts";
import { openDb, operationCount, rig } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

function parsed(value: unknown): WriterSymptom {
  const result = parseWriterSymptom(value);
  if (!result.ok) {
    throw new Error(result.detail);
  }
  return result.symptom;
}

const RACE = (): WriterSymptom => parsed(raceSymptom("checks"));
const VALID = RACE_ISSUE_OUTPUTS["race-valid"] as IssueOutput;
const check = (output: Partial<IssueOutput>) => checkIssue({ ...VALID, ...output }, RACE(), EXCLUDED_IDENTIFIERS);

type Attempts = { outcome: string; error_code: string | null; http_status: number }[];
const attempts = (value: Record<string, unknown>, key: "concurrent_attempts" | "sequential_attempts"): Attempts => value[key] as Attempts;

describe("the race symptom input", () => {
  it("accepts the synthetic race observation, which is also a valid RaceSymptom record", () => {
    expect(parseWriterSymptom(raceSymptom("valid")).ok).toBe(true);
    expect(parseWriterSymptom({ ...raceSymptom("valid"), locale: null }).ok).toBe(true);
    expect(() => assertRecord("RaceSymptom", raceSymptom("valid"))).not.toThrow();
  });

  const bad: [string, () => Record<string, unknown>][] = [
    ["an extra top-level field", () => ({ ...raceSymptom("valid"), backup_code: "SYNTHETIC-CODE" })],
    ["an extra field in an attempt", () => {
      const value = raceSymptom("valid");
      (attempts(value, "concurrent_attempts")[0] as Record<string, unknown>).token = "synthetic";
      return value;
    }],
    ["three concurrent attempts", () => {
      const value = raceSymptom("valid");
      return { ...value, concurrent_attempts: [...attempts(value, "concurrent_attempts"), attempts(value, "concurrent_attempts")[0]] };
    }],
    ["observed counts that disagree with the attempts", () => ({ ...raceSymptom("valid"), observed: { accepted: 1, refused: 1 } })],
    ["an accepted attempt with an error code", () => {
      const value = raceSymptom("valid");
      (attempts(value, "sequential_attempts")[0] as Record<string, unknown>).error_code = "synthetic-invalid-code";
      return value;
    }],
    ["a refused attempt without an error code", () => {
      const value = raceSymptom("valid");
      (attempts(value, "sequential_attempts")[1] as Record<string, unknown>).error_code = null;
      return value;
    }],
    ["a zero overlap", () => ({ ...raceSymptom("valid"), overlap_ms: 0 })],
    ["a positive overlap that is not the earlier settle time minus the later send time", () => ({ ...raceSymptom("valid"), overlap_ms: 90 })],
    ["another symptom kind", () => ({ ...raceSymptom("valid"), symptom_kind: "synthetic_kind" })],
    ["a request method other than GET or POST", () => ({ ...raceSymptom("valid"), request: { method: "PUT", path: "/api/synthetic/verify", query: {} } })],
    ["a documentation link that is not HTTPS", () => ({
      ...raceSymptom("valid"),
      doc_excerpts: [{ text: "Synthetic excerpt.", source_url: "http://docs.example.invalid/two-step" }],
    })],
  ];

  it("accepts nothing the canonical RaceSymptom record refuses", () => {
    for (const [, value] of bad) {
      if (validateRecord("RaceSymptom", value()).length > 0) expect(parseWriterSymptom(value()).ok).toBe(false);
    }
  });

  it.each(bad)("refuses %s before reserving or calling", async (_name, value) => {
    expect(parseWriterSymptom(value()).ok).toBe(false);
    const r = await rig(db);
    const outcome = await r.writer.writeIssue({ candidate: CANDIDATE, symptom: value(), excludedIdentifiers: EXCLUDED_IDENTIFIERS });
    expect(outcome).toMatchObject({ ok: false, code: "invalid_input" });
    expect(r.fetchSpy.calls).toHaveLength(0);
    expect(r.events).toEqual([]);
    expect(await operationCount(db, r.schema)).toBe(0);
  });

  it("leaves the time-zone input as strict as before: a symptom_kind field is not an ObservedSymptom field", () => {
    expect(parseWriterSymptom(symptom("valid")).ok).toBe(true);
    expect(parseObservedSymptom({ ...symptom("valid"), symptom_kind: "concurrent_double_acceptance" }).ok).toBe(false);
    expect(parseWriterSymptom({ ...symptom("valid"), symptom_kind: "concurrent_double_acceptance" }).ok).toBe(false);
  });
});

describe("the race issue prompt", () => {
  it("asks for the accepted and refused counts as digits and never for the code, and carries the observation", () => {
    const race = RACE();
    const prompt = buildIssuePrompt(race);
    expect(prompt.system).toContain("how many of the requests sent at the same time should be accepted and how many refused");
    expect(prompt.system).toContain("Never write a backup code, a token or a password.");
    expect(prompt.system).not.toContain("time zone");
    expect(prompt.user).toBe(`Observation:\n${JSON.stringify(race, null, 2)}`);
  });

  it("keeps the time-zone prompt for an ObservedSymptom", () => {
    const prompt = buildIssuePrompt(parsed(symptom("valid")));
    expect(prompt.system).toContain("one short sentence per local day of the primary time zone");
    expect(prompt.system).not.toContain("backup code");
  });
});

describe("the race issue checks", () => {
  it("pass the valid synthetic race issue", () => {
    const report = check({});
    expect(report.numeric).toEqual({ ok: true, violations: [] });
    expect(report.status).toBe("ready_for_review");
  });

  it("need the expected accepted count, then the refused count, in expected_result", () => {
    expect(check({ expected_result: "Only one of them should go through." }).numeric?.violations).toEqual([{ field: "expected_result", reason: "missing_expected_vector", number: null }]);
    expect(check({ expected_result: "1 should be refused." }).numeric?.violations).toEqual([{ field: "expected_result", reason: "missing_expected_vector", number: null }]);
  });

  it("need the observed accepted count, then the refused count, in actual_result", () => {
    const report = check({ actual_result: "0 were refused and 2 were accepted." });
    expect(report.status).toBe("rejected");
    expect(report.numeric?.violations).toEqual([{ field: "actual_result", reason: "missing_observed_vector", number: null }]);
  });

  it("count only digits stated next to an accepted or refused outcome, not endpoint, status or time digits", () => {
    const missing = [{ field: "actual_result", reason: "missing_observed_vector", number: null }];
    const digitPath = parsed({ ...raceSymptom("checks"), request: { method: "POST", path: "/api/2fa/verify", query: {} } });
    const actual = "POST /api/2fa/verify at 0 ms behaved unexpectedly.";
    expect(checkIssue({ ...VALID, actual_result: actual }, digitPath, EXCLUDED_IDENTIFIERS).numeric?.violations).toEqual(missing);
    expect(check({ actual_result: "Request b returned 200 at 0 ms and both tabs were signed in." }).numeric?.violations).toEqual(missing);
    expect(check({ actual_result: "Request a was sent at 0 ms and accepted; request b at 1 ms was refused." }).numeric?.violations).toEqual(missing);
    expect(check({ actual_result: "Accepted: 2, refused: 0." }).numeric?.ok).toBe(true);
    expect(check({ actual_result: "Of the 2 requests, 2 of them were accepted and 0 were refused." }).numeric?.ok).toBe(true);
  });

  it("reject a number the observation does not hold, such as a computed total", () => {
    expect(check({ environment: "Locale en-US; 3 sign-ins in total." }).numeric?.violations).toEqual([{ field: "environment", reason: "unsupported_number", number: "3" }]);
  });

  it("support the times, statuses and path digits of the observation", () => {
    expect(check({ environment: "Requests sent at 0 and 1 ms settled at 87 and 92 ms, in flight together 86 ms; reuse returned 400." }).numeric?.ok).toBe(true);
  });

  it("report the race family's hint words and not the time-zone family's", () => {
    const report = check({ environment: "Looks like a race condition with no lock or transaction; the default page is used." });
    expect(report.status).toBe("ready_for_review");
    expect(report.hint_words.map((hint) => hint.word)).toEqual(["race", "lock", "transaction"]);
  });

  it("leave the time-zone checks unchanged: bucket vectors and the time-zone hint words", () => {
    const timeZone = parsed(symptom("valid"));
    expect(checkIssue(ISSUE_OUTPUTS.valid, timeZone, EXCLUDED_IDENTIFIERS).status).toBe("ready_for_review");
    expect(checkIssue(VALID, timeZone, EXCLUDED_IDENTIFIERS).numeric?.violations.map((item) => item.reason)).toContain("missing_expected_vector");
    expect(checkIssue(ISSUE_OUTPUTS["hint-words"], timeZone, EXCLUDED_IDENTIFIERS).hint_words.map((hint) => hint.word)).toEqual(["parameter", "ignored", "default"]);
  });
});

describe("the issue writer on recorded race responses", () => {
  const run = async (variant: "race-valid" | "race-numeric-mismatch") => {
    const r = await rig(db);
    const outcome = await r.writer.writeIssue({ candidate: CANDIDATE, symptom: raceSymptom(variant), excludedIdentifiers: EXCLUDED_IDENTIFIERS });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    return outcome;
  };

  it("sends the race prompt and marks a valid issue ready_for_review", async () => {
    const outcome = await run("race-valid");
    expect(outcome.call.status).toBe("completed");
    expect(outcome.report?.status).toBe("ready_for_review");
    expect(outcome.issue).toEqual(RACE_ISSUE_OUTPUTS["race-valid"]);
  });

  it("rejects an issue whose actual result misstates the acceptances", async () => {
    const outcome = await run("race-numeric-mismatch");
    expect(outcome.call.status).toBe("completed");
    expect(outcome.report?.codes).toEqual(["numeric_mismatch"]);
    expect(outcome.report?.numeric?.violations).toEqual([{ field: "actual_result", reason: "missing_observed_vector", number: null }]);
  });
});
