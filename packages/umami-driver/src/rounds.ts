// The added-check rounds: a reset before every round, one fixture run per round, and one
// observation per check per round. A failing check never stops later rounds. Each outcome file is
// validated and cross-checked against the round's Playwright report; nothing is read from logs.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CheckObservation, ExpectedCheck, TrialReason } from "@rbw/schema";
import type { ArtifactStore } from "./artifacts.ts";
import { findCheckTest, parseFixtureOutcome } from "./fixture.ts";
import type { FixtureOutcome } from "./fixture.ts";
import { iso } from "./limits.ts";
import type { PhaseOutcome, PhaseTiming, Timers } from "./limits.ts";
import { ReportError, parsePlaywrightReport } from "./playwright-report.ts";
import type { ParsedReport, ReportedTest } from "./playwright-report.ts";
import type { CommandResult } from "./process.ts";

export interface Problem {
  phase: string;
  reason: TrialReason;
  detail: string;
}

/** A round's directories: the fixture's output directory, empty at the start, and Playwright's scratch directory. */
export interface RoundDirs {
  output: string;
  tmp: string;
}

export interface RoundsOptions {
  checks: readonly ExpectedCheck[];
  repeatCount: number;
  /** Each round's fixture output directory is created under this one. */
  workDir: string;
  store: ArtifactStore;
  /** The tests phase's signal; once aborted, no further round starts. */
  signal: AbortSignal;
  timers: Timers;
  /** Resets the fixture to a clean migrated baseline; returns a reason when it fails. */
  reset(repeatIndex: number, signal: AbortSignal): Promise<TrialReason | null>;
  runRound(repeatIndex: number, dirs: RoundDirs, signal: AbortSignal): Promise<CommandResult>;
}

export interface RoundsResult {
  /** Every expected check for every round, by round and then in expected-check order. */
  observations: CheckObservation[];
  problems: Problem[];
  rounds: PhaseTiming[];
}

export function roundName(repeatIndex: number): string {
  return `round-${String(repeatIndex).padStart(2, "0")}`;
}

export function notRun(checkId: string, repeatIndex: number): CheckObservation {
  return {
    check_id: checkId,
    repeat_index: repeatIndex,
    observed: "not_run",
    failure_code: "artifact_missing",
    duration_ms: 0,
    response_artifact_key: null,
    response_artifact_sha256: null,
  };
}

function isSkipped(test: ReportedTest): boolean {
  return test.result === "skipped" || (test.result === null && test.status === "skipped");
}

/** True when the report's status for the check's test agrees with the outcome file. */
function agrees(outcome: FixtureOutcome, test: ReportedTest): boolean {
  if (outcome.observed === "pass") return test.result === "passed";
  return test.result === "failed" || test.result === "timedOut";
}

interface Collected {
  observation: CheckObservation;
  problems: Problem[];
}

async function collectCheck(
  check: ExpectedCheck,
  repeatIndex: number,
  outputDir: string,
  report: ParsedReport | null,
  store: ArtifactStore,
): Promise<Collected> {
  const id = check.check_id;
  const phase = roundName(repeatIndex);
  const prefix = `added/${phase}`;
  const problem = (reason: TrialReason, detail: string): Problem => ({ phase, reason, detail: `${id}: ${detail}` });
  const test = report === null ? null : findCheckTest(report, id);
  const file = await store.addFile("fixture_outcome", `${prefix}/observations/${id}.json`, join(outputDir, "observations", `${id}.json`), "application/json");
  if (file.status === "refused") {
    return { observation: notRun(id, repeatIndex), problems: [problem("limit_exceeded", "outcome file refused by the size limit")] };
  }
  const parsed = file.bytes === null ? null : parseFixtureOutcome(file.bytes, id, repeatIndex);
  if (!parsed?.ok) {
    if (test !== null && isSkipped(test)) {
      return {
        observation: { ...notRun(id, repeatIndex), observed: "skipped", failure_code: "test_skipped", duration_ms: test.duration_ms },
        problems: [problem("test_skipped", "the report shows the check as skipped")],
      };
    }
    const detail = parsed === null ? "no outcome file" : `outcome file rejected (${parsed.problem})`;
    return { observation: notRun(id, repeatIndex), problems: [problem("artifact_missing", detail)] };
  }
  const outcome = parsed.outcome;
  if (test === null) {
    return { observation: notRun(id, repeatIndex), problems: [problem("artifact_missing", "the report has no test for the check")] };
  }
  if (isSkipped(test) || !agrees(outcome, test)) {
    return {
      observation: { ...notRun(id, repeatIndex), observed: "setup_fail", failure_code: "unrelated_failure" },
      problems: [problem("unrelated_failure", "the outcome file contradicts the report's status for the check")],
    };
  }
  const observation: CheckObservation = {
    check_id: id,
    repeat_index: repeatIndex,
    observed: outcome.observed,
    failure_code: outcome.failure_code,
    duration_ms: outcome.duration_ms,
    response_artifact_key: null,
    response_artifact_sha256: null,
  };
  const problems: Problem[] = [];
  if (outcome.response_artifact_key !== null) {
    const response = await store.addFile("check_response", `${prefix}/responses/${id}.json`, join(outputDir, outcome.response_artifact_key), "application/json");
    if (response.status === "missing") {
      problems.push(problem("artifact_missing", "the response file named by the outcome is absent"));
    } else if (response.status === "refused" || response.entry === null) {
      problems.push(problem("limit_exceeded", "response file refused by the size limit"));
    } else if (response.entry.sha256 !== outcome.response_artifact_sha256) {
      problems.push(problem("artifact_hash_mismatch", "the response file's hash differs from the outcome's"));
    } else {
      observation.response_artifact_key = response.entry.key;
      observation.response_artifact_sha256 = response.entry.sha256;
    }
  }
  if (outcome.observed === "setup_fail") problems.push(problem(outcome.failure_code, "the check's setup failed"));
  return { observation, problems };
}

async function readRoundReport(outputDir: string, phase: string, store: ArtifactStore, problems: Problem[]): Promise<ParsedReport | null> {
  const file = await store.addFile("fixture_report", `added/${phase}/report.json`, join(outputDir, "report.json"), "application/json");
  if (file.status === "refused") {
    problems.push({ phase, reason: "limit_exceeded", detail: "round report refused by the size limit" });
    return null;
  }
  if (file.bytes === null) {
    problems.push({ phase, reason: "artifact_missing", detail: "the round wrote no report" });
    return null;
  }
  try {
    return parsePlaywrightReport(file.bytes.toString("utf8"), "");
  } catch (error) {
    if (!(error instanceof ReportError)) throw error;
    problems.push({ phase, reason: "artifact_missing", detail: `the round report is unreadable (${error.message})` });
    return null;
  }
}

/** Collects into `into`, which the caller owns, so what finished before an unexpected error is kept. */
export async function runAddedRounds(
  options: RoundsOptions,
  into: RoundsResult = { observations: [], problems: [], rounds: [] },
): Promise<RoundsResult> {
  const { timers, store } = options;
  const { observations, problems, rounds } = into;
  for (let repeatIndex = 1; repeatIndex <= options.repeatCount; repeatIndex += 1) {
    const phase = roundName(repeatIndex);
    const start = timers.now();
    const timing = (outcome: PhaseOutcome): PhaseTiming => {
      const end = timers.now();
      return {
        name: "round",
        repeat_index: repeatIndex,
        started_at: iso(start),
        ended_at: iso(end),
        duration_ms: end - start,
        limit_ms: null,
        deadline_ms: null,
        overrun_ms: 0,
        outcome,
      };
    };
    const skipRound = (problem: Problem, outcome: PhaseOutcome): void => {
      observations.push(...options.checks.map((check) => notRun(check.check_id, repeatIndex)));
      problems.push(problem);
      rounds.push(timing(outcome));
    };
    if (options.signal.aborted) {
      skipRound({ phase, reason: "timeout", detail: "the tests phase ended before this round started" }, "skipped");
      continue;
    }
    const resetReason = await options.reset(repeatIndex, options.signal);
    if (resetReason !== null) {
      skipRound({ phase, reason: resetReason, detail: "the reset before this round failed" }, "failed");
      continue;
    }
    const dirs = { output: join(options.workDir, phase, "output"), tmp: join(options.workDir, phase, "tmp") };
    await mkdir(dirs.output, { recursive: true });
    await mkdir(dirs.tmp, { recursive: true });
    const result = await options.runRound(repeatIndex, dirs, options.signal);
    await store.addStream("stdout", `added/${phase}/runner.stdout.txt`, result.stdout);
    await store.addStream("stderr", `added/${phase}/runner.stderr.txt`, result.stderr);
    const outputDir = dirs.output;
    const report = await readRoundReport(outputDir, phase, store, problems);
    for (const check of options.checks) {
      const collected = await collectCheck(check, repeatIndex, outputDir, report, store);
      observations.push(collected.observation);
      problems.push(...collected.problems);
    }
    rounds.push(timing(result.aborted ? "timeout" : "ok"));
  }
  return into;
}
