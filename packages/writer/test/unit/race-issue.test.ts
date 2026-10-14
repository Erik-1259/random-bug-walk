// The race family's issue input, prompt and checks. The recorded cases replay committed synthetic
// recordings (test/fixtures/recordings/issue-race-*.json); nothing calls a model.
import type { PGlite } from "@electric-sql/pglite";
import { assertRecord, validateRecord } from "@rbw/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FetchFunction } from "../../src/http.ts";
import { checkIssue } from "../../src/issue-checks.ts";
import { buildIssuePrompt } from "../../src/issue-prompt.ts";
import type { IssueOutput } from "../../src/issue-schema.ts";
import { parseObservedSymptom } from "../../src/observed-symptom.ts";
import { parseWriterSymptom } from "../../src/race-symptom.ts";
import type { WriterSymptom } from "../../src/race-symptom.ts";
import { CANDIDATE, EXCLUDED_IDENTIFIERS, ISSUE_OUTPUTS, RACE_ISSUE_OUTPUTS, SYNTHETIC_USAGE, completion, raceSymptom, symptom } from "../fixtures/cases.ts";
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
    ["a pass outcome: one acceptance and one refusal, observed equal to expected", () => ({
      ...raceSymptom("valid"),
      concurrent_attempts: [
        { label: "request a", sent_ms: 0, settled_ms: 87, http_status: 200, outcome: "accepted", error_code: null },
        { label: "request b", sent_ms: 1, settled_ms: 92, http_status: 400, outcome: "refused", error_code: "synthetic-invalid-code" },
      ],
      observed: { accepted: 1, refused: 1 },
    })],
    ["expected counts other than one acceptance and one refusal", () => ({ ...raceSymptom("valid"), expected: { accepted: 2, refused: 0 } })],
    ["no sequential attempts", () => ({ ...raceSymptom("valid"), sequential_attempts: [] })],
    ["three sequential attempts", () => {
      const value = raceSymptom("valid");
      return { ...value, sequential_attempts: [...attempts(value, "sequential_attempts"), attempts(value, "sequential_attempts")[1]] };
    }],
    ["a sequential reuse sent before the first use settled", () => {
      const value = raceSymptom("valid");
      (attempts(value, "sequential_attempts")[1] as Record<string, unknown>).sent_ms = 10;
      return value;
    }],
    ["a sequential reuse that was accepted", () => {
      const value = raceSymptom("valid");
      Object.assign(attempts(value, "sequential_attempts")[1] as Record<string, unknown>, { http_status: 200, outcome: "accepted", error_code: null });
      return value;
    }],
    ["a sequential first use that was refused", () => {
      const value = raceSymptom("valid");
      Object.assign(attempts(value, "sequential_attempts")[0] as Record<string, unknown>, { http_status: 400, outcome: "refused", error_code: "synthetic-invalid-code" });
      return value;
    }],
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
  it("asks for one fixed count line in each result field and never for the code, and carries the observation", () => {
    const race = RACE();
    const prompt = buildIssuePrompt(race);
    expect(prompt.system).toContain("`Expected: accepted=<n>, refused=<n>`");
    expect(prompt.system).toContain("`Observed: accepted=<n>, refused=<n>`");
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

  const missingExpected = [{ field: "expected_result", reason: "missing_expected_vector", number: null }];
  const missingObserved = [{ field: "actual_result", reason: "missing_observed_vector", number: null }];

  it("need the exact Expected line in expected_result", () => {
    expect(check({ expected_result: "Of the two requests sent at the same time, 1 should be accepted and 1 refused." }).numeric?.violations).toEqual(missingExpected);
    expect(check({ expected_result: "One should go through.\nExpected: accepted=2, refused=0" }).numeric?.violations).toEqual(missingExpected);
    expect(check({ expected_result: "Expected: accepted=1, refused=1" }).numeric?.ok).toBe(true);
  });

  // The observed counts (2 accepted, 0 refused) are read only from one line that reads exactly
  // `Observed: accepted=<n>, refused=<n>`. `true` means the counts are read and match.
  const OBSERVED_LINES: [string, string, boolean][] = [
    ["the exact line after prose", "Both requests returned HTTP 200.\nObserved: accepted=2, refused=0", true],
    ["the exact line alone", "Observed: accepted=2, refused=0", true],
    ["the exact line with a CRLF break", "Both tabs were signed in.\r\nObserved: accepted=2, refused=0", true],
    ["no line", "Both requests returned HTTP 200 and each tab was signed in.", false],
    ["a duplicated line", "Observed: accepted=2, refused=0\nObserved: accepted=2, refused=0", false],
    ["a second, malformed Observed line", "Observed: accepted=2, refused=0\nObserved: both tabs were signed in", false],
    ["spaces around the equals signs", "Observed: accepted = 2, refused = 0", false],
    ["a lowercase label", "observed: accepted=2, refused=0", false],
    ["a capitalized key", "Observed: Accepted=2, refused=0", false],
    ["the keys in the other order", "Observed: refused=0, accepted=2", false],
    ["a count in words", "Observed: accepted=two, refused=0", false],
    ["a trailing period", "Observed: accepted=2, refused=0.", false],
    ["trailing text", "Observed: accepted=2, refused=0 (both 200)", false],
    ["leading whitespace", "  Observed: accepted=2, refused=0", false],
    ["the line inside a sentence", "Both were signed in. Observed: accepted=2, refused=0", false],
    ["wrong counts", "Observed: accepted=1, refused=1", false],
    ["free-text counts without the line", "2 were accepted and 0 refused.", false],
    ["labeled free-text counts without the line", "Accepted: 2, refused: 0.", false],
  ];
  it.each(OBSERVED_LINES)("read the observed counts from %s", (_name, actual, states) => {
    expect(check({ actual_result: actual }).numeric?.violations).toEqual(states ? [] : missingObserved);
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

  it("keeps an issue whose own count line misstates the acceptances rejected, as the model wrote it", async () => {
    const outcome = await run("race-numeric-mismatch");
    expect(outcome.call.status).toBe("completed");
    expect(outcome.report?.status).toBe("rejected");
    expect(outcome.report?.codes).toContain("numeric_mismatch");
    expect(outcome.issue?.actual_result).toContain("Observed: accepted=1, refused=1");
  });
});

describe("the count lines the writer adds to a race issue", () => {
  const EXPECTED_PROSE = "Of the two requests sent at the same time, one should be accepted and the other refused.";
  const ACTUAL_PROSE = "Both requests returned HTTP 200 and each tab was signed in.";

  /** Runs writeIssue once with the model answering `content`. */
  const writeWith = async (symptomValue: Record<string, unknown>, content: unknown) => {
    const fetch: FetchFunction = () =>
      Promise.resolve(new Response(completion(JSON.stringify(content), SYNTHETIC_USAGE), { status: 200, headers: { "content-type": "application/json" } }));
    const r = await rig(db, { fetch });
    const outcome = await r.writer.writeIssue({ candidate: CANDIDATE, symptom: symptomValue, excludedIdentifiers: EXCLUDED_IDENTIFIERS });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(r.fetchSpy.calls).toHaveLength(1);
    return outcome;
  };

  it("writes both lines from the observation when the model leaves them out, and the issue passes the numeric check", async () => {
    const outcome = await writeWith(raceSymptom("lines-missing"), { ...VALID, expected_result: EXPECTED_PROSE, actual_result: ACTUAL_PROSE });
    expect(outcome.issue?.expected_result).toBe(`${EXPECTED_PROSE}\nExpected: accepted=1, refused=1`);
    expect(outcome.issue?.actual_result).toBe(`${ACTUAL_PROSE}\nObserved: accepted=2, refused=0`);
    expect(outcome.report?.numeric).toEqual({ ok: true, violations: [] });
    expect(outcome.report?.status).toBe("ready_for_review");
  });

  it("drops duplicated and malformed count lines that agree with the observation and ends each field with exactly the canonical line", async () => {
    const outcome = await writeWith(raceSymptom("lines-duplicated"), {
      ...VALID,
      expected_result: `Expected: accepted=1, refused=1\n${EXPECTED_PROSE}\n  expected: one accepted, one refused\nEXPECTED : accepted=1, refused=1`,
      actual_result: `Observed: accepted=2, refused=0\r\n${ACTUAL_PROSE}\nobserved:accepted=2,refused=0\n`,
    });
    expect(outcome.issue?.expected_result).toBe(`${EXPECTED_PROSE}\nExpected: accepted=1, refused=1`);
    expect(outcome.issue?.actual_result).toBe(`${ACTUAL_PROSE}\nObserved: accepted=2, refused=0`);
    expect(outcome.report?.status).toBe("ready_for_review");
  });

  it("keeps the model's issue, rejected, when its own count line contradicts the observation", async () => {
    const actual = "1 request was accepted and 1 refused.\nObserved: accepted=1, refused=1";
    const outcome = await writeWith(raceSymptom("lines-contradict"), { ...VALID, expected_result: EXPECTED_PROSE, actual_result: actual });
    expect(outcome.issue?.actual_result).toBe(actual);
    expect(outcome.report?.status).toBe("rejected");
  });

  it("drops a count line placed in the other result field, so each field holds only its own canonical line", async () => {
    const outcome = await writeWith(raceSymptom("lines-misplaced"), {
      ...VALID,
      expected_result: `${EXPECTED_PROSE}\nObserved: accepted=2, refused=0`,
      actual_result: `${ACTUAL_PROSE}\nexpected: accepted=1, refused=1`,
    });
    expect(outcome.issue?.expected_result).toBe(`${EXPECTED_PROSE}\nExpected: accepted=1, refused=1`);
    expect(outcome.issue?.actual_result).toBe(`${ACTUAL_PROSE}\nObserved: accepted=2, refused=0`);
  });

  it("returns the issue the checks saw, which the real issue checks pass again on their own", async () => {
    const outcome = await writeWith(raceSymptom("consumer"), { ...VALID, expected_result: EXPECTED_PROSE, actual_result: ACTUAL_PROSE });
    expect(outcome.issue).not.toBeNull();
    const again = checkIssue(outcome.issue, parsed(raceSymptom("consumer")), EXCLUDED_IDENTIFIERS);
    expect(again).toEqual(outcome.report);
    expect(again.status).toBe("ready_for_review");
  });

  it("leaves a time-zone issue exactly as the model wrote it, even with lines that look like count lines", async () => {
    const timeZone = ISSUE_OUTPUTS.valid as IssueOutput;
    const content = { ...timeZone, expected_result: `${timeZone.expected_result}\nExpected: accepted=1, refused=1`, actual_result: `Observed: synthetic\n${timeZone.actual_result}` };
    const outcome = await writeWith(symptom("valid"), content);
    expect(outcome.issue).toEqual(content);
    expect(JSON.stringify(outcome.issue)).toBe(JSON.stringify(content));
    expect(outcome.report).toEqual(checkIssue(content, parsed(symptom("valid")), EXCLUDED_IDENTIFIERS));
  });
});
