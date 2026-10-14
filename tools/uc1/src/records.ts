// The run directory's records and the analyzer's rows. One directory per root:
//
//   run.json, case.json, policy.json, ids.json, root-run.json   the run, its inputs and its root
//   states.json, states/{clean,planted,alternative}.bin          the case's code states
//   attempts/<NNN>-<arm>/attempt.json                            one record per attempt index
//   attempts/<NNN>-<arm>/r<k>/{session,transcript.jsonl,grade}   each run at that index
//   seeded/<label>/seeded.json                                   the pilot's seeded round trips
//   stops.jsonl                                                  every stop, with its reason
//   results/{rows.json,analysis.json,summary.json}               the analyzer's input and output
//   staging/                                                     the publisher's staging layout
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AttemptOutcome, AttemptResult, AttemptRow, Arm, Grade, SolverModelName, ToolName } from "@rbw/solver";
import { TOOL_NAMES } from "@rbw/solver";
import type { SubmitResult } from "@rbw/solver-session";
import type { GradeResult, GradeRoute } from "@rbw/solver-session/grade";
import { MAX_GRADE_RETRIES, MAX_INFRASTRUCTURE_RERUNS } from "./plan.ts";
import type { PlannedAttempt, RunMode, SeededLabel } from "./plan.ts";

export interface RunRecord {
  schema_version: 1;
  kind: "uc1_run";
  mode: RunMode;
  name: string;
  /** The pilot's publication label; null for a counted run. */
  label: string | null;
  case_id: string;
  case_sha256: string;
  screen_record_sha256: string;
  issue_sha256: string;
  /** The content hash of every file and directory the case names, keyed by case field (null for a null field). */
  inputs_sha256: Record<string, string | null>;
  model: SolverModelName;
  model_id: string;
  service: string;
  runtime_profile_sha256: string;
  rate_sheet_sha256: string;
  turn_worst_case_microusd: number;
  attempt_worst_case_microusd: number;
  /** The UC1 cap for this model, as a decimal string. */
  cap_microusd: string;
  project_id: string;
  project_policy_sha256: string;
  root_execution_id: string;
  task_revision: string;
  plan: PlannedAttempt[];
  created_at: string;
}

export interface StatesRecord {
  target_path: string;
  digest: string;
  clean_sha256: string;
  planted_sha256: string;
  alternative_sha256: string;
}

/** One grade's run: the controller's result, the execution it recorded under, and what it settled. */
export interface GradeTry {
  result: GradeResult;
  execution_id: string;
  /** The controller summary's settled spend, kept as evidence; spend totals read the ledger by execution_id instead. */
  settled_microusd: number | null;
}

/** How a run at an index ended; null while it runs (and after a crash, until the next pass marks it interrupted). */
/**
 * `close_failed`: the session could not be closed (its logs kept and its container removed), so the
 * container may still run; the run is neither counted nor rerun until a resume removes it.
 */
export type RunEnd = AttemptOutcome | "refused" | "close_failed" | null;

export interface AttemptRun {
  rerun: number;
  attempt_key: string;
  execution_id: string;
  session_id: string;
  seed: number;
  started_at: string;
  ended_at: string | null;
  /** Session open to close, including the cold builds. */
  session_wall_ms: number | null;
  ended: RunEnd;
  infrastructure: string | null;
  refusal: string | null;
  result: AttemptResult | null;
  submission: SubmitResult | null;
  close_error: string | null;
  /** The grade route; null when the attempt is out of scope or has no submission. */
  route: GradeRoute | null;
  grade1: GradeTry[];
  grade2: GradeTry[];
}

/**
 * `counted`: the final run reached submit or a cap. `infrastructure_error`: every allowed rerun
 * failed on infrastructure. `stopped`: the run stopped (spend, a refusal or a failed close) during this index; the
 * next pass runs it again. `pending`: not run yet, or an infrastructure rerun is due.
 */
export type AttemptStatus = "counted" | "infrastructure_error" | "stopped" | "pending";

export interface AttemptRecord {
  schema_version: 1;
  index: number;
  arm: Arm;
  seed: number;
  status: AttemptStatus;
  runs: AttemptRun[];
}

export interface SeededRecord {
  schema_version: 1;
  label: SeededLabel;
  state: "alternative_fix" | "clean";
  expected_route: "alternative_fix" | "clean_equal";
  route: GradeRoute;
  route_matches: boolean;
  grade1: GradeTry[];
  grade2: GradeTry[];
}

export interface StopRecord {
  reason: string;
  detail: string;
  at: string;
}

/** Writes JSON through a temporary file and a rename, so a record is never half written. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

/** A record this tool wrote; the caller names its type. */
export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readRun(runDir: string): RunRecord | null {
  const path = join(runDir, "run.json");
  return existsSync(path) ? (readJson(path) as RunRecord) : null;
}

/** Every UC1 run under the runs directory (one level down), in name order. */
export function listRuns(runsDir: string): { dir: string; run: RunRecord }[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      const run = readRun(join(runsDir, name));
      return run === null ? [] : [{ dir: join(runsDir, name), run }];
    });
}

export function attemptDirName(item: Pick<PlannedAttempt, "index" | "arm">): string {
  return `${String(item.index).padStart(3, "0")}-${item.arm}`;
}

export function readAttempt(runDir: string, item: Pick<PlannedAttempt, "index" | "arm">): AttemptRecord | null {
  const path = join(runDir, "attempts", attemptDirName(item), "attempt.json");
  return existsSync(path) ? (readJson(path) as AttemptRecord) : null;
}

export function writeAttempt(runDir: string, record: AttemptRecord): void {
  writeJson(join(runDir, "attempts", attemptDirName(record), "attempt.json"), record);
}

export function readAttempts(runDir: string, run: RunRecord): AttemptRecord[] {
  return run.plan.flatMap((item) => {
    const record = readAttempt(runDir, item);
    return record === null ? [] : [record];
  });
}

export function readSeeded(runDir: string): SeededRecord[] {
  const dir = join(runDir, "seeded");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .filter((label) => existsSync(join(dir, label, "seeded.json")))
    .map((label) => readJson(join(dir, label, "seeded.json")) as SeededRecord);
}

export function writeSeeded(runDir: string, record: SeededRecord): void {
  writeJson(join(runDir, "seeded", record.label, "seeded.json"), record);
}

export function readStops(runDir: string): StopRecord[] {
  const path = join(runDir, "stops.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as StopRecord);
}

export function isInfrastructure(run: AttemptRun): boolean {
  return run.ended === "infrastructure_error" || run.ended === null;
}

/** The record's status from its runs (see AttemptStatus). */
export function attemptStatus(runs: readonly AttemptRun[]): AttemptStatus {
  const last = runs.at(-1);
  if (last === undefined) return "pending";
  if (last.ended === "submitted" || last.ended === "cap_reached") return "counted";
  if (last.ended === "spend_refused" || last.ended === "refused" || last.ended === "close_failed") return "stopped";
  return runs.filter(isInfrastructure).length > MAX_INFRASTRUCTURE_RERUNS ? "infrastructure_error" : "pending";
}

/** Whether a grade's tries call for another: none yet, or an infrastructure stop with retries left. */
export function needsGrade(tries: readonly GradeTry[]): boolean {
  const last = tries.at(-1);
  if (last === undefined) return true;
  return last.result.state === "infrastructure" && tries.length <= MAX_GRADE_RETRIES;
}

export function isGraded(route: GradeRoute | null): route is Exclude<GradeRoute, { route: "not_graded" }> {
  return route !== null && route.route !== "not_graded";
}

function lastState(tries: readonly GradeTry[]): GradeResult["state"] | null {
  return tries.at(-1)?.result.state ?? null;
}

/** Grade 1 as the analyzer reads it: a verdict, or null when it never reached one. */
function grade1Value(tries: readonly GradeTry[]): Grade | null {
  const state = lastState(tries);
  if (state === "passed") return "pass";
  if (state === "failed" || state === "missing" || state === "invalid") return "fail";
  return null;
}

/** Grade 2, authoritative: passed only when it passed; an invalid or (after its retries) infrastructure grade is unsolved. A job without a summary is graded infrastructure and retried. */
function grade2Value(tries: readonly GradeTry[]): Grade {
  return lastState(tries) === "passed" ? "pass" : "fail";
}

export class PendingGrade extends Error {
  override name = "PendingGrade";
}

function emptyToolCalls(): Record<ToolName, number> {
  return Object.fromEntries(TOOL_NAMES.map((name) => [name, 0])) as Record<ToolName, number>;
}

/**
 * The analyzer's row for one attempt index (packages/solver's AttemptRow), or null while the
 * index has no final status. Throws PendingGrade when a counted, graded attempt has no finished grade 2.
 */
export function attemptRow(caseId: string, targetPath: string, record: AttemptRecord): AttemptRow | null {
  if (record.status !== "counted" && record.status !== "infrastructure_error") return null;
  const final = record.runs.at(-1);
  if (final === undefined) return null;
  const reruns = record.runs.slice(0, -1).filter(isInfrastructure).length;
  const result = final.result;
  const base = {
    bug_id: caseId,
    arm: record.arm,
    index: record.index,
    reruns,
    tokens: result === null ? 0 : result.input_tokens + result.output_tokens,
    turns: result?.turns ?? 0,
    cap: result?.cap ?? null,
    history_elisions: result?.elided_tool_results ?? 0,
    tool_calls: result === null ? emptyToolCalls() : { ...result.tool_calls },
    contaminated: result !== null && result.contamination.length > 0,
  };
  if (record.status === "infrastructure_error") {
    return { ...base, status: "infrastructure_error", grade1: null, grade2: null, out_of_scope: false, prohibited_edits: 0 };
  }
  const submission = final.submission;
  const outOfScope = submission?.scope === "out_of_scope";
  const prohibited = submission === null ? 0 : submission.changed.filter((change) => change.path !== targetPath).length;
  if (outOfScope) return { ...base, status: "counted", grade1: null, grade2: null, out_of_scope: true, prohibited_edits: prohibited };
  if (!isGraded(final.route)) {
    // Nothing gradeable was submitted (no change, or not a single-file patch): unsolved in both grades.
    return { ...base, status: "counted", grade1: "fail", grade2: "fail", out_of_scope: false, prohibited_edits: prohibited };
  }
  if (needsGrade(final.grade2)) throw new PendingGrade(`attempt ${String(record.index)} (${record.arm}) has no finished grade 2; run grade2 first`);
  return { ...base, status: "counted", grade1: grade1Value(final.grade1), grade2: grade2Value(final.grade2), out_of_scope: false, prohibited_edits: prohibited };
}

/**
 * What the ledger settled under these executions, each counted once. The ledger is the only source
 * of spend figures: a run the process lost before its result was saved still has its settled calls
 * there, under the execution the record named before the first call.
 */
export function ledgerSettled(byExecution: ReadonlyMap<string, bigint>, executions: Iterable<string>): number {
  let total = 0n;
  for (const id of new Set(executions)) total += byExecution.get(id) ?? 0n;
  return Number(total);
}

/** Every grade 2 execution of an attempt run's or seeded round trip's tries. */
export function grade2Executions(tries: readonly GradeTry[]): string[] {
  return tries.map((item) => item.execution_id);
}

/** Sums of what a run settled, from the ledger by execution: model calls (each attempt run) and grade 2 jobs. */
export function settledTotals(records: readonly AttemptRecord[], seeded: readonly SeededRecord[], byExecution: ReadonlyMap<string, bigint>): { model: number; grade2: number } {
  const runs = records.flatMap((record) => record.runs);
  const model = ledgerSettled(byExecution, runs.map((run) => run.execution_id));
  const grade2 = ledgerSettled(byExecution, [...runs.flatMap((run) => grade2Executions(run.grade2)), ...seeded.flatMap((item) => grade2Executions(item.grade2))]);
  return { model, grade2 };
}
