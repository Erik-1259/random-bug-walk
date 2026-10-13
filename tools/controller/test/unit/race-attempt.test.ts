// The race family's candidate attempt, end to end on the simulated kit with the fake writer and
// the fake search: the order of its stages, the RaceSymptom the issue writer gets, the 11-copy
// admission with the latency in every copy, and the privacy of the issue text. The simulated race
// app writes a placeholder response body, so the race fixture's observation writer is wrapped here
// to record evidence in the form the fixture's checks write it (encodeEvidence). Every time is invented.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseCanonical, parseRecord } from "@rbw/schema";
import { INVALID_BACKUP_CODE } from "@rbw/umami-fixture-rc1";
import type { ObservationInput, VerifyAttempt } from "@rbw/umami-fixture-rc1";
import { pickPhrases, prepareAttempt, runAttempt, symptomFamilyOf } from "../../src/attempt.ts";
import type { AttemptOutcome } from "../../src/attempt.ts";
import { RACE_FAMILY, TIME_ZONE_FAMILY } from "../../src/symptom.ts";
import { stage } from "../../../release/src/stage.ts";
import { ATTEMPT_PROJECT_ID, DOCS_URL, SOURCE_URL, attemptDeps, attemptFiles, attemptInputs, racePrivateInput, syntheticRaceIssue } from "../support/attempt.ts";
import type { AttemptOptions, AttemptWorld } from "../support/attempt.ts";
import { world } from "../support/harness.ts";
import type { LedgerCall, World } from "../support/harness.ts";
import { FakeClock } from "../../../local-runner/test/support/fakes.ts";
import { RACE_CHECK, SERIAL_CHECK, writeRaceProbeDir } from "../../../local-runner/test/support/synthetic.ts";

const accepted = (sent: number, settled: number): VerifyAttempt => ({ sent_ms: sent, settled_ms: settled, status: 200, error_code: null, token_issued: true, failure: null });
const refused = (sent: number, settled: number): VerifyAttempt => ({ sent_ms: sent, settled_ms: settled, status: 400, error_code: INVALID_BACKUP_CODE, token_issued: false, failure: null });

/** The evidence a race check would record for the simulated app's outcome. */
function evidenceFor(input: ObservationInput): unknown {
  if (input.check_id === SERIAL_CHECK) return { check_id: SERIAL_CHECK, kind: "serial_reuse", attempts: [accepted(0, 63.8), refused(130.2, 170.9)] };
  if (input.failure_code === "double_spend") return { check_id: RACE_CHECK, kind: "concurrent_double_spend", attempts: [accepted(0.012, 87.4), accepted(0.731, 91.6)], overlap_ms: 86.669 };
  return { check_id: RACE_CHECK, kind: "concurrent_double_spend", attempts: [accepted(0.02, 50.3), refused(0.6, 61.1)], overlap_ms: 49.7 };
}

vi.mock("@rbw/umami-fixture-rc1", async (importOriginal) => {
  const original = await importOriginal<typeof import("@rbw/umami-fixture-rc1")>();
  return {
    ...original,
    writeObservation: (outputDir: string, input: ObservationInput) => original.writeObservation(outputDir, { ...input, response_body: original.encodeEvidence(evidenceFor(input) as never) }),
  };
});

const LATENCY_MS = 50;

interface Run {
  w: World;
  aw: AttemptWorld;
  work: string;
  outcome: AttemptOutcome;
}

async function raceAttempt(options: AttemptOptions = {}): Promise<Run> {
  const w = await world({ kit: { family: "race" }, clock: new FakeClock({ manual: true }) });
  const files = attemptFiles(w.dir, racePrivateInput());
  const inputs = attemptInputs(w, files, { family: "race", raceLatencyMs: LATENCY_MS, probesDir: writeRaceProbeDir(), alternativeDir: undefined });
  const aw = attemptDeps(w, inputs.work, options);
  const outcome = await runAttempt(prepareAttempt(inputs, aw.env), aw.deps);
  return { w, aw, work: inputs.work, outcome };
}

function reserves(calls: readonly LedgerCall[]): { call_name: string; project_id: string; root_execution_id: string }[] {
  return calls.filter((call) => call.method === "reserve").map((call) => call.request as never);
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((path) => join(dir, path)).filter((path) => statSync(path).isFile());
}

function summaryFamily(run: Run, job: string): unknown {
  return (parseCanonical(readFileSync(join(run.work, "jobs", job, "summary.json"))) as unknown as { family?: unknown }).family;
}

/** The frozen issue's fields and its three phrases: private until the release tool publishes the issue. */
function issueTexts(run: Run): string[] {
  const issue = parseCanonical(readFileSync(join(run.work, "candidate", "issue.json"))) as unknown as { title: string; reproduction_steps: string[]; expected_result: string; actual_result: string };
  return [issue.title, ...issue.reproduction_steps, issue.expected_result, issue.actual_result, ...pickPhrases(issue as never)];
}

describe("the attempt's symptom family", () => {
  it("is the time-zone fixture without a family, and each family's own fixture with one", () => {
    expect(symptomFamilyOf(undefined)).toBe(TIME_ZONE_FAMILY);
    expect(symptomFamilyOf("time-zone")).toBe(TIME_ZONE_FAMILY);
    expect(symptomFamilyOf("race")).toBe(RACE_FAMILY);
  });
});

describe("a race-family attempt, start to finish", () => {
  let run: Run;

  beforeAll(async () => {
    run = await raceAttempt();
  });

  it("runs the kit check, the observation, the searches, the card, the issue, the phrase checks and an 11-copy admission, in that order, under one root, and completes", () => {
    expect(run.outcome.exitCode).toBe(0);
    expect(run.outcome.rootRun).toMatchObject({ project_id: ATTEMPT_PROJECT_ID, kind: "factory", status: "terminal", outcome: "completed" });
    expect(run.outcome.rootRun.child_execution_ids).toHaveLength(3);
    const names = reserves(run.w.ledgerCalls).map((reserve) => reserve.call_name.replace(/^(sandbox\.copy:[a-z-]+):.*$/, "$1"));
    expect(names.filter((name, index) => name !== names[index - 1])).toEqual([
      "sandbox.copy:kit-check",
      "sandbox.copy:observe",
      "search.source:synthetic-candidate-1:source-1",
      "search.source:synthetic-candidate-1:source-2",
      "search.docs:synthetic-candidate-1:docs-1",
      "writer.card:synthetic-candidate-1:1",
      "writer.issue:synthetic-candidate-1:2",
      "search.phrase:synthetic-candidate-1:phrase-1",
      "search.phrase:synthetic-candidate-1:phrase-2",
      "search.phrase:synthetic-candidate-1:phrase-3",
      "sandbox.copy:admission",
    ]);
    expect(names.filter((name) => name === "sandbox.copy:admission")).toHaveLength(11);
    for (const reserve of reserves(run.w.ledgerCalls)) expect(reserve).toMatchObject({ project_id: ATTEMPT_PROJECT_ID, root_execution_id: run.outcome.rootRun.root_execution_id });
    expect(run.aw.lines.some((line) => line.startsWith("stage=admission status=complete") && line.includes("outcome_verdict=pass"))).toBe(true);
  });

  it("records each job as the race family's, with ADM-06 not applicable, 11 admission copies and the attempt's latency, and every copy set that latency", () => {
    for (const job of ["kit-check", "observe", "admission"]) {
      expect(summaryFamily(run, job)).toMatchObject({ id: "race", adm06: { status: "not_applicable" }, admission_copies: 11, race_latency_ms: LATENCY_MS });
    }
    const latencies = [...run.w.kit.containers.values()].map((container) => container.latency);
    expect(latencies.length).toBeGreaterThan(11);
    expect(new Set(latencies)).toEqual(new Set([String(LATENCY_MS)]));
  });

  it("hands the issue writer a RaceSymptom built from the observation: two acceptances observed against one expected, and the passing control", () => {
    const symptom = parseRecord("RaceSymptom", readFileSync(join(run.work, "candidate", "symptom.json")));
    expect(symptom).toMatchObject({ symptom_kind: "concurrent_double_acceptance", expected: { accepted: 1, refused: 1 }, observed: { accepted: 2, refused: 0 }, overlap_ms: 86, user_action: racePrivateInput().user_action });
    expect(symptom.concurrent_attempts.map((attempt) => [attempt.sent_ms, attempt.settled_ms, attempt.outcome])).toEqual([
      [0, 87, "accepted"],
      [1, 92, "accepted"],
    ]);
    expect(symptom.sequential_attempts.map((attempt) => attempt.outcome)).toEqual(["accepted", "refused"]);
    expect(symptom.doc_excerpts.every((excerpt) => excerpt.source_url === DOCS_URL)).toBe(true);
    const issueRequest = run.aw.writer.calls.find((call) => call.kind === "issue")?.body ?? "";
    expect(issueRequest).toContain("concurrent_double_acceptance");
    expect(issueRequest).not.toContain(RACE_CHECK);
    expect(parseCanonical(readFileSync(join(run.work, "candidate", "issue.json")))).toEqual(syntheticRaceIssue(symptom));
    expect(parseCanonical(readFileSync(join(run.work, "candidate", "issue-check.json")))).toMatchObject({ status: "ready_for_review" });
  });

  it("checks the three phrases picked from the race issue, each from 6 to 12 words with no double quote, and finds novelty clear", () => {
    const issue = parseCanonical(readFileSync(join(run.work, "candidate", "issue.json"))) as never;
    const phrases = pickPhrases(issue);
    expect(phrases).toEqual(["Synthetic report: one backup code signs in twice when it is entered", "Of the two requests sent together, one should be accepted and the", "Both tabs were signed in with the same backup code."]);
    for (const phrase of phrases) expect(phrase.split(" ").length).toBeGreaterThanOrEqual(6);
    expect(run.aw.search.queries.map((query) => query.replace(/^"|"$/g, ""))).toEqual(phrases);
    expect(parseCanonical(readFileSync(join(run.work, "candidate", "novelty.json")))).toMatchObject({ status: "clear" });
  });

  it("keeps the issue text private: no issue field, phrase, query or URL reaches a report line, a log line, a job directory, the RootRun or the staged jobs", () => {
    const secrets = [...issueTexts(run), ...run.aw.search.sourceQueries, SOURCE_URL];
    const lines = [...run.aw.lines, ...run.w.logs].join("\n");
    const published = [lines, readFileSync(join(run.work, "root-run.json"), "utf8"), ...files(join(run.work, "jobs")).map((file) => readFileSync(file, "latin1"))];
    for (const secret of secrets) for (const text of published) expect(text).not.toContain(secret);
    expect(lines).not.toMatch(/https?:/);
    const out = join(mkdtempSync(join(tmpdir(), "rbw-race-attempt-stage-")), "staged");
    const staged = stage({ run: run.work, rootRun: join(run.work, "root-run.json"), out, redactionsOut: join(mkdtempSync(join(tmpdir(), "rbw-race-attempt-redactions-")), "redactions.tsv") });
    expect(staged.ok).toBe(true);
    const texts = files(out).map((file) => readFileSync(file, "latin1"));
    expect(texts.length).toBeGreaterThan(0);
    for (const secret of secrets) for (const text of texts) expect(text).not.toContain(secret);
  });
});

describe("the phrase picker on a race issue", () => {
  const wordCount = (phrase: string): number => phrase.split(" ").length;
  const steps = ["Sign in with a password and open the backup code prompt in two browser tabs.", "Enter the same backup code in both tabs and submit them at the same moment.", "Look at which tabs are signed in."];

  it("never takes a phrase from the fixed Expected and Observed count lines, and uses distinct reproduction steps when the prose before them is under 6 words", () => {
    const issue = {
      title: "One backup code signs in twice when it is entered in two tabs",
      reproduction_steps: steps,
      expected_result: "One is refused.\nExpected: accepted=1, refused=1",
      actual_result: "Both tabs signed in.\nObserved: accepted=2, refused=0",
      environment: "Synthetic.",
    };
    const [, expected, actual] = pickPhrases(issue);
    expect(expected).toBe("Sign in with a password and open the backup code prompt in");
    expect(actual).toBe("Enter the same backup code in both tabs and submit them at");
    for (const phrase of [expected, actual]) {
      expect(phrase).not.toMatch(/accepted=|refused=/);
      expect(wordCount(phrase)).toBeGreaterThanOrEqual(6);
      expect(wordCount(phrase)).toBeLessThanOrEqual(12);
    }
  });

  it("falls back from a 5-word sentence but keeps a 6-word one", () => {
    const issue = {
      title: "One backup code signs in twice when it is entered in two tabs",
      reproduction_steps: steps,
      expected_result: "Only one should be accepted.\nExpected: accepted=1, refused=1",
      actual_result: "Both tabs were signed in together.\nObserved: accepted=2, refused=0",
      environment: "Synthetic.",
    };
    expect(pickPhrases(issue).slice(1)).toEqual(["Sign in with a password and open the backup code prompt in", "Both tabs were signed in together."]);
  });

  it("keeps the short prose only when no reproduction step has 6 words", () => {
    const issue = {
      title: "One backup code signs in twice when it is entered in two tabs",
      reproduction_steps: ["Open two tabs."],
      expected_result: "One is refused.\nExpected: accepted=1, refused=1",
      actual_result: "Both tabs signed in.\nObserved: accepted=2, refused=0",
      environment: "Synthetic.",
    };
    expect(pickPhrases(issue).slice(1)).toEqual(["One is refused.", "Both tabs signed in."]);
  });
});

describe("a race-family attempt's stops", () => {
  it("stops a race root whose issue is not ready_for_review before any phrase check or admission", async () => {
    const run = await raceAttempt({ issue: "rejected" });
    expect(run.outcome.rootRun).toMatchObject({ status: "terminal", outcome: "failed" });
    expect(run.aw.search.queries).toEqual([]);
    expect(existsSync(join(run.work, "jobs", "admission"))).toBe(false);
    // The stop is the issue check on a race symptom, not an earlier failure in the symptom path.
    expect(parseRecord("RaceSymptom", readFileSync(join(run.work, "candidate", "symptom.json")))).toMatchObject({ symptom_kind: "concurrent_double_acceptance" });
    expect(parseCanonical(readFileSync(join(run.work, "candidate", "issue-check.json")))).toMatchObject({ status: "rejected" });
    expect(run.aw.lines.some((line) => line.includes("reason=issue_not_ready"))).toBe(true);
  });
});
