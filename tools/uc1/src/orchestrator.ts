// The UC1 run orchestrator (docs/uc1-preregistration.md is the contract). Three steps, each its
// own command:
//
//   1. sessions (`pilot` or `run`): refuse anything the pre-registration does not allow, create and
//      persist the paired_comparison root under the public_demo policy, run the pilot's seeded
//      grade round trips (grade 1, no model), hold the development slot for the root, and run the
//      attempts in index order (up to 3 at once): a fresh session on the pinned kit image, the
//      solver loop with the arm's tools, the diff, then grade 1 on local Docker. Every model call
//      passes the spend guard first. Infrastructure errors are rerun at the same index, up to 2
//      times; a stop (spend, ledger or a session refusal) ends the pass, and the next pass resumes
//      (after a spend refusal, only once the ledger is reconciled). An attempt the spend guard
//      refused after a model turn counts as capped and is never rerun.
//   2. grade2: the protected regrade on Vercel Sandbox, serially, each job only when its worst
//      case fits the allowance, with the slot free for the controller to take.
//   3. finalize: the analyzer's rows and results record, the summary, the report, the publisher's
//      staging directory, and the root's terminal status.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newRunIds } from "@rbw/local-runner";
import type { RunIds } from "@rbw/local-runner";
import { CanonicalError, RecordError, assertRecord, encodeCanonical, parseRecord, sha256Hex } from "@rbw/schema";
import type { RootRun } from "@rbw/schema";
import { SOLVER_PROFILES, analyze, attemptKey, readSolverRateSheet, resultsRecordJson, runAttempt, solverEnvelope, transcriptLine } from "@rbw/solver";
import type { AttemptRow, ResultsRecord, SolverModelName, SolverProfile } from "@rbw/solver";
import { jobName, prepareGrade, runGrade, writeGradeIds } from "@rbw/solver-session/grade";
import type { GradeCommand, GradeNumber, GradeResult, GradeRoute, GradeTarget } from "@rbw/solver-session/grade";
import { profileSha256 } from "@rbw/writer";
import { Allowance, guardSpend } from "./allowance.ts";
import { CaseError, caseInputDigests, changedCaseInputs, checkCaseForMode, checkScreenTarget, controllerBase, loadCase, screenStatus } from "./case.ts";
import type { CaseConfig } from "./case.ts";
import { SessionRefused } from "./deps.ts";
import type { AttemptSession, Uc1Deps } from "./deps.ts";
import { DECLARED_STAGES, DEVELOPMENT_POOL, DEVELOPMENT_SLOT, MAX_CONCURRENCY, MAX_GRADE_RETRIES, PILOT_LABEL, SEEDED_ROUND_TRIPS, SPEND_CAPS_MICROUSD, attemptPlan } from "./plan.ts";
import type { PlannedAttempt, RunMode } from "./plan.ts";
import {
  PendingGrade,
  attemptDirName,
  attemptRow,
  attemptStatus,
  isCountedEnd,
  isGraded,
  listRuns,
  needsGrade,
  readAttempt,
  readAttempts,
  readJson,
  readRun,
  readSeeded,
  readStops,
  writeAtomic,
  writeAttempt,
  writeJson,
  writeSeeded,
} from "./records.ts";
import type { AttemptRecord, AttemptRun, GradeTry, RunRecord, SeededRecord, StatesRecord, StopRecord } from "./records.ts";
import { buildSummary, reportMarkdown, writeStaging } from "./report.ts";
import type { RunSummary } from "./report.ts";

/** Refused before anything starts: nothing is written, no model is called. */
export class RunRefusal extends Error {
  override name = "RunRefusal";
}

export interface SessionsOptions {
  mode: RunMode;
  /** The directory holding every UC1 run; the allowance covers every root under it. */
  runsDir: string;
  /** This run's directory name under runsDir; an existing run of that name resumes. */
  name: string;
  caseFile: string;
  policyFile: string;
  model: SolverModelName;
  /** Sessions at once, 1 to 3. */
  concurrency: number;
}

export interface SessionsOutcome {
  /** 0 when every planned index has a final status and nothing stopped. */
  exitCode: number;
  runDir: string;
  rootExecutionId: string;
  stop: StopRecord | null;
}

const ACTOR = "uc1";
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_RERUN_KEY = 9;
/** The submitted target file's bytes, under the run's directory. */
const TARGET_FILE = "target.bin";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadPolicy(path: string): { bytes: Buffer; sha256: string; projectId: string } {
  const bytes = readFileSync(path);
  let policy;
  try {
    policy = parseRecord("ProjectPolicy", bytes);
  } catch (error) {
    if (error instanceof RecordError || error instanceof CanonicalError) throw new RunRefusal("the policy file is not a canonical ProjectPolicy record");
    throw error;
  }
  if (policy.purpose !== "public_demo" || policy.visibility !== "public") throw new RunRefusal(`the paired comparison runs under a public_demo policy; this one is ${policy.purpose}`);
  return { bytes, sha256: sha256Hex(bytes), projectId: policy.project_id };
}

/** The model the counted run froze: the first run with a counted attempt decides it. */
function frozenModel(runsDir: string): { model: SolverModelName; name: string } | null {
  for (const { dir, run } of listRuns(runsDir)) {
    if (run.mode !== "run") continue;
    if (readAttempts(dir, run).some((record) => record.runs.some(isCountedEnd))) return { model: run.model, name: run.name };
  }
  return null;
}

/**
 * A counted run needs the pilot behind it: a pilot root on the same model that finalize made
 * terminal with outcome completed. The pre-registration makes the pilot, and the model decision
 * after it, prerequisites of the counted run.
 */
function refuseWithoutCompletedPilot(runsDir: string, model: SolverModelName): void {
  const completed = listRuns(runsDir).some(({ dir, run }) => {
    if (run.mode !== "pilot" || run.model !== model) return false;
    const path = join(dir, "root-run.json");
    if (!existsSync(path)) return false;
    const root = readJson(path) as Partial<RootRun>;
    return root.status === "terminal" && root.outcome === "completed";
  });
  if (!completed) throw new RunRefusal(`a counted run needs a finalized, completed harness pilot on ${model} under the runs directory`);
}

/** Refuses to continue a run when a file or directory its case names no longer has the content the run started with. */
function refuseChangedInputs(runDir: string, run: RunRecord): void {
  const changed = changedCaseInputs(run.inputs_sha256, readJson(join(runDir, "case.json")) as CaseConfig);
  if (changed.length > 0) throw new RunRefusal(`run ${run.name}: the case's ${changed.join(", ")} changed since the run started; restore ${changed.length === 1 ? "it" : "them"} or start a new run name`);
}

function rootRunRecord(run: RunRecord, status: RootRun["status"], outcome: RootRun["outcome"], children: readonly string[]): RootRun {
  return assertRecord("RootRun", {
    schema_version: 1,
    project_id: run.project_id,
    root_execution_id: run.root_execution_id,
    project_policy_sha256: run.project_policy_sha256,
    kind: "paired_comparison",
    declared_stages: [...DECLARED_STAGES],
    child_execution_ids: [...new Set(children)],
    status,
    outcome,
  });
}

/** Every execution recorded under the root: each attempt run and each grade's own execution. */
function childExecutions(records: readonly AttemptRecord[], seeded: readonly SeededRecord[]): string[] {
  const ids: string[] = [];
  for (const record of records) {
    for (const run of record.runs) {
      ids.push(run.execution_id);
      for (const item of [...run.grade1, ...run.grade2]) ids.push(item.execution_id);
    }
  }
  for (const item of seeded) for (const entry of [...item.grade1, ...item.grade2]) ids.push(entry.execution_id);
  return ids;
}

function writeRootRun(runDir: string, run: RunRecord, status: RootRun["status"], outcome: RootRun["outcome"]): RootRun {
  const record = rootRunRecord(run, status, outcome, childExecutions(readAttempts(runDir, run), readSeeded(runDir)));
  writeAtomic(join(runDir, "root-run.json"), encodeCanonical(record));
  return record;
}

/** Refuses more work on a run whose root finalize made terminal: the publisher freezes that root's first terminal snapshot. */
function refuseFinalized(runDir: string, name: string): void {
  const path = join(runDir, "root-run.json");
  if (existsSync(path) && (readJson(path) as RootRun).status === "terminal") {
    throw new RunRefusal(`run ${name} was finalized and its root is terminal; start a new run name to continue`);
  }
}

/** Refuses a resume once the case's image no longer resolves to the digest the run started on (the sessions run it by that reference). */
async function refuseMovedImage(config: CaseConfig, deps: Uc1Deps): Promise<void> {
  let digest: string;
  try {
    digest = await deps.resolveImage(config.image);
  } catch (error) {
    throw new RunRefusal(`the case's image ${config.image} cannot be inspected: ${message(error)}`);
  }
  if (digest !== config.image_digest) throw new RunRefusal(`the image resolves to ${digest}, not the case's ${config.image_digest}`);
}

function gradeTarget(runDir: string): GradeTarget {
  const states = readJson(join(runDir, "states.json")) as StatesRecord;
  return { target_path: states.target_path, clean_sha256: states.clean_sha256, planted: readFileSync(join(runDir, "states", "planted.bin")) };
}

interface RunContext {
  runDir: string;
  run: RunRecord;
  config: CaseConfig;
  ids: RunIds;
  deps: Uc1Deps;
}

/** The controller's exit code when it refuses a job's inputs before running anything. */
const CONTROLLER_REFUSED = 2;

/**
 * One grade of a prepared route: its own ids file (a fresh execution under the root, written once and
 * kept on resume), the controller job, its summary.
 */
/** True when the controller's summary exists and is whole JSON (not cut short by an interrupted write). */
function summaryParses(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    readJson(path);
    return true;
  } catch {
    return false;
  }
}

async function gradeTry(ctx: RunContext, route: Exclude<GradeRoute, { route: "not_graded" }>, grade: GradeNumber, work: string, label: string, retry: number): Promise<GradeTry> {
  const ids = writeGradeIds(ctx.ids, join(work, "ids", `grade-${String(grade)}`), label, () => ctx.deps.uuid(), retry, work);
  const command: GradeCommand = {
    work,
    attempt: label,
    retry,
    base: controllerBase(ctx.config),
    sandboxImage: ctx.config.sandbox_image,
    referenceFix: ctx.config.reference_fix,
    ids,
    projectPolicy: join(ctx.runDir, "policy.json"),
  };
  let result: GradeResult;
  let exit = null as number | null;
  try {
    result = await runGrade(route, grade, command, {
      runController: async (args) => {
        exit = await ctx.deps.runController(args);
        return exit;
      },
    });
  } catch (error) {
    // The controller could not be started: no verdict on the attempt, so an infrastructure grade, retried as a grade only.
    result = { grade, job: jobName(grade, label, retry), state: "infrastructure", detail: `controller: ${message(error)}`, summary_sha256: null, trial: null };
  }
  const refused = exit === CONTROLLER_REFUSED;
  if (refused) {
    // The controller refused the job's inputs (for example a job its work directory holds under other inputs):
    // any summary there is not this grade's, so it is an infrastructure grade, retried as its own job.
    result = { grade, job: result.job, state: "infrastructure", detail: `controller: refused the job's inputs (exit ${String(CONTROLLER_REFUSED)}); see its error output`, summary_sha256: null, trial: null };
  } else if (result.state === "invalid" && !summaryParses(join(work, "jobs", result.job, "summary.json"))) {
    // A summary cut short by an interrupted write is no verdict on the attempt: an infrastructure grade, retried.
    result = { grade, job: result.job, state: "infrastructure", detail: "controller: the job's summary is incomplete (an interrupted write)", summary_sha256: null, trial: null };
  } else if (result.state === "missing") {
    // The job ended without a summary (for example a job interrupted before it wrote one, whose next
    // invocation exits without a verdict): no verdict on the attempt, so an infrastructure grade, retried.
    result = { grade, job: result.job, state: "infrastructure", detail: `controller: the job ended without a summary (exit ${exit === null ? "none" : String(exit)})`, summary_sha256: null, trial: null };
  }
  const executionId = (readJson(ids[grade]) as RunIds).executions["alternative-fix"];
  const summaryPath = join(work, "jobs", result.job, "summary.json");
  let settled: number | null = null;
  if (!refused && existsSync(summaryPath)) {
    try {
      const value = (readJson(summaryPath) as { spend?: { settled_microusd?: unknown } }).spend?.settled_microusd;
      settled = typeof value === "number" ? value : null;
    } catch {
      settled = null;
    }
  }
  ctx.deps.report(`grade=${String(grade)} job=${result.job} state=${result.state}${settled === null ? "" : ` settled_microusd=${String(settled)}`}${refused ? " refused=inputs" : ""}`);
  return { result, execution_id: executionId, settled_microusd: settled };
}

/** Grade 1 with its infrastructure retries: local Docker, in-memory ledger, no spend. */
async function grade1(ctx: RunContext, route: Exclude<GradeRoute, { route: "not_graded" }>, work: string, label: string, tries: GradeTry[], save: () => void): Promise<void> {
  while (needsGrade(tries)) {
    tries.push(await gradeTry(ctx, route, 1, work, label, tries.length));
    save();
  }
}

/** The pilot's seeded round trips: the alternative fix through the fix route, the clean bytes through the clean-equal route. */
async function seededGrades(ctx: RunContext): Promise<boolean> {
  const target = gradeTarget(ctx.runDir);
  let matches = true;
  for (const seed of SEEDED_ROUND_TRIPS) {
    const dir = join(ctx.runDir, "seeded", seed.label);
    const existing = existsSync(join(dir, "seeded.json")) ? (readJson(join(dir, "seeded.json")) as SeededRecord) : null;
    const bytes = readFileSync(join(ctx.runDir, "states", seed.state === "clean" ? "clean.bin" : "alternative.bin"));
    const route = existing?.route ?? prepareGrade(bytes, target, join(dir, "fix"));
    const record: SeededRecord = existing ?? { schema_version: 1, label: seed.label, state: seed.state, expected_route: seed.route, route, route_matches: route.route === seed.route, grade1: [], grade2: [] };
    writeSeeded(ctx.runDir, record);
    ctx.deps.report(`seeded=${seed.label} route=${route.route} expected=${seed.route}`);
    if (isGraded(route)) await grade1(ctx, route, join(dir, "grade"), seed.label, record.grade1, () => {
        writeSeeded(ctx.runDir, record);
      });
    matches &&= record.route_matches && record.grade1.at(-1)?.result.state === "passed";
  }
  return matches;
}

interface Pass extends RunContext {
  allowance: Allowance;
  profile: SolverProfile;
  rateSheet: Uint8Array;
  turnWorst: bigint;
  issue: string;
  stop: StopRecord | null;
  halt(reason: string, detail: string): void;
}

function finishRun(pass: Pass, run: AttemptRun, opened: number): void {
  const ended = pass.deps.now();
  run.ended_at = ended.toISOString();
  run.session_wall_ms = ended.getTime() - opened;
}

/**
 * One run at an index: session, solver loop, diff, close, grade 1. `hold` is an admitted rerun's
 * allowance hold: its model calls draw on it, and it ends when the session closes.
 */
async function runOnce(pass: Pass, item: PlannedAttempt, record: AttemptRecord, hold: string | null): Promise<void> {
  const { deps, run: runRecord } = pass;
  const rerun = record.runs.length;
  if (rerun > MAX_RERUN_KEY) {
    pass.halt("rerun_limit", `attempt ${String(item.index)} has run ${String(rerun)} times; reconcile before running it again`);
    return;
  }
  const key = attemptKey({ arm: item.arm, index: item.index, rerun });
  const dir = join(pass.runDir, "attempts", attemptDirName(item), `r${String(rerun)}`);
  const sessionId = `uc1-${runRecord.root_execution_id.slice(0, 8)}-${key}`;
  const opened = deps.now();
  const run: AttemptRun = {
    rerun,
    attempt_key: key,
    execution_id: deps.uuid(),
    session_id: sessionId,
    seed: item.seed,
    started_at: opened.toISOString(),
    ended_at: null,
    session_wall_ms: null,
    ended: null,
    infrastructure: null,
    refusal: null,
    result: null,
    submission: null,
    close_error: null,
    route: null,
    grade1: [],
    grade2: [],
  };
  record.runs.push(run);
  record.status = attemptStatus(record.runs);
  const save = () => {
    writeAttempt(pass.runDir, record);
  };
  save();
  mkdirSync(dir, { recursive: true });
  deps.report(`attempt=${key} status=starting`);

  let session: AttemptSession;
  try {
    session = await deps.openSession({ id: sessionId, work: join(dir, "session"), serverLogs: item.arm === "on", config: pass.config });
  } catch (error) {
    if (error instanceof SessionRefused) {
      run.ended = "refused";
      run.refusal = error.message;
      pass.halt("session_refused", `${key}: ${error.message}`);
    } else {
      run.ended = "infrastructure_error";
      run.infrastructure = `session_open: ${message(error)}`;
      // A failed open may leave the container it created (its own cleanup failures are swallowed), so it
      // is removed before a rerun opens; when that fails, the run is kept like a failed close: the pass
      // stops, and the next one removes the container before anything else.
      try {
        await deps.removeSession(sessionId);
      } catch (removal) {
        run.close_error = `after session_open failed: ${message(removal)}`;
        run.ended = "close_failed";
        pass.halt("close_failed", `${key}: session ${sessionId} could not be removed after its open failed: ${message(removal)}`);
      }
    }
    finishRun(pass, run, opened.getTime());
    save();
    deps.report(`attempt=${key} status=${run.ended}`);
    return;
  }
  try {
    const states = readJson(join(pass.runDir, "states.json")) as StatesRecord;
    if (session.planted_sha256 !== states.planted_sha256 || session.digest !== pass.config.image_digest) {
      run.ended = "refused";
      run.refusal = "the session's planted file or image digest is not the case's";
      pass.halt("session_refused", `${key}: ${run.refusal}`);
    } else {
      const transcript = join(dir, "transcript.jsonl");
      const result = await runAttempt({
        spend: hold === null ? guardSpend(deps.spend, pass.allowance) : guardSpend(deps.spend, pass.allowance, hold),
        fetch: deps.fetch,
        ...(deps.apiKey === undefined ? {} : { apiKey: deps.apiKey }),
        profile: pass.profile,
        context: {
          project_id: runRecord.project_id,
          project_policy_sha256: runRecord.project_policy_sha256,
          batch_id: pass.ids.batch_id,
          task_revision: runRecord.task_revision,
          root_execution_id: runRecord.root_execution_id,
          execution_id: run.execution_id,
          parent_execution_id: runRecord.root_execution_id,
        },
        poolKey: DEVELOPMENT_POOL,
        allocationKey: null,
        slotKey: DEVELOPMENT_SLOT,
        rateSheet: pass.rateSheet,
        spec: { arm: item.arm, index: item.index, rerun },
        issue: pass.issue,
        session: session.solver,
        transcript: (event) => {
          appendFileSync(transcript, transcriptLine(event));
        },
        now: () => deps.now(),
        // The pre-registered wall cap covers the whole attempt, so the session's open and initial build count against it.
        startedAt: opened,
      });
      run.result = result;
      run.ended = result.outcome;
      if (result.outcome === "infrastructure_error") run.infrastructure = result.infrastructure?.reason ?? "infrastructure_error";
      if (result.outcome === "cap_reached" && result.turns === 0) {
        // A cap used up before the solver's first turn (a slow session open or cold build against the
        // wall cap) leaves nothing the solver did: an infrastructure error, rerun at the same index,
        // never a counted attempt with zero turns and zero tokens.
        run.ended = "infrastructure_error";
        run.infrastructure = `cap_before_first_turn: the ${result.cap ?? "attempt"} cap was reached before the solver's first turn`;
      }
      if (result.outcome === "spend_refused") {
        const stop = pass.allowance.stop;
        pass.halt(stop?.reason ?? "ledger_refused", stop?.detail ?? `${result.refusal?.code ?? "refused"}: ${result.refusal?.detail ?? ""}`);
      }
      // A counted spend refusal (after at least one model turn) is a capped attempt: its current target is saved and graded.
      if (isCountedEnd(run)) {
        try {
          const ended = await session.end(run.ended === "submitted" ? "submit" : "cap");
          run.submission = ended.submission;
          // Kept beside the record before the run is saved as counted, so a stop before grade 1 finishes can grade these bytes on resume.
          if (ended.target !== null) writeAtomic(join(dir, TARGET_FILE), ended.target);
        } catch (error) {
          run.ended = "infrastructure_error";
          run.infrastructure = `submission: ${message(error)}`;
        }
      }
    }
  } catch (error) {
    run.ended = "infrastructure_error";
    run.infrastructure = `harness: ${message(error)}`;
  } finally {
    try {
      await session.close();
    } catch (error) {
      // The session keeps its container when its close fails, so this run is neither counted nor
      // rerun: the pass stops, and the next one removes the container before anything else.
      run.close_error = message(error);
      run.ended = "close_failed";
      pass.halt("close_failed", `${key}: session ${sessionId} could not be closed: ${run.close_error}`);
    }
    if (hold !== null) pass.allowance.release(hold);
  }
  finishRun(pass, run, opened.getTime());
  record.status = attemptStatus(record.runs);
  save();
  const result = run.result;
  deps.report(`attempt=${key} status=${run.ended} turns=${String(result?.turns ?? 0)} tokens=${String(result === null ? 0 : result.input_tokens + result.output_tokens)} settled_microusd=${String(result?.settled_microusd ?? 0)}`);

  await gradeFinal(pass, record);
}

/** Whether a counted attempt's final run still owes its route or grade 1 (the process stopped between them). */
function gradingPending(record: AttemptRecord): boolean {
  const final = record.runs.at(-1);
  const scope = final?.submission?.scope;
  if (record.status !== "counted" || final === undefined || scope === undefined || scope === "out_of_scope") return false;
  return final.route === null || (isGraded(final.route) && needsGrade(final.grade1));
}

/** The route and grade 1 of a counted attempt's final run, from its saved target bytes; resumable at either step. */
async function gradeFinal(pass: Pass, record: AttemptRecord): Promise<void> {
  const run = record.runs.at(-1);
  if (run === undefined || !gradingPending(record)) return;
  const dir = join(pass.runDir, "attempts", attemptDirName(record), `r${String(run.rerun)}`);
  const save = () => {
    writeAttempt(pass.runDir, record);
  };
  if (run.route === null) {
    const targetPath = join(dir, TARGET_FILE);
    run.route = existsSync(targetPath)
      ? prepareGrade(readFileSync(targetPath), gradeTarget(pass.runDir), join(dir, "grade", "fix"))
      : { route: "not_graded", attempt_sha256: "missing", clean_equal: false, reason: "invalid_fix", detail: "the target file is missing" };
    save();
  }
  if (isGraded(run.route)) await grade1(pass, run.route, join(dir, "grade"), run.attempt_key, run.grade1, save);
}

/** Whether grade 1 of a counted attempt's final run ended in infrastructure after its retries. */
function grade1Infrastructure(record: AttemptRecord | null): boolean {
  const final = record?.runs.at(-1);
  return record?.status === "counted" && final !== undefined && isGraded(final.route) && final.grade1.at(-1)?.result.state === "infrastructure";
}

/** Runs an index to a final status (with its reruns), unless the pass stops. */
async function runIndex(pass: Pass, item: PlannedAttempt): Promise<void> {
  const record: AttemptRecord = readAttempt(pass.runDir, item) ?? { schema_version: 1, index: item.index, arm: item.arm, seed: item.seed, status: "pending", runs: [] };
  for (;;) {
    record.status = attemptStatus(record.runs);
    if (record.runs.length > 0) writeAttempt(pass.runDir, record);
    if (record.status === "counted") {
      await gradeFinal(pass, record);
      return;
    }
    if (record.status === "infrastructure_error") return;
    if (pass.stop !== null) return;
    // Any restart of an index that already has a run (an infrastructure rerun, or a restart after a
    // spend refusal before the first model turn) is a whole new attempt, so its own worst case must fit before it starts, and it
    // stays held until its session ends, so a restart starting meanwhile cannot count on the same room.
    // Only a never-started index starts on one turn's worst case.
    const hold = record.runs.length > 0 ? `rerun-${attemptKey({ arm: item.arm, index: item.index, rerun: record.runs.length })}` : null;
    const fits = hold === null ? await pass.allowance.check(pass.turnWorst) : await pass.allowance.admit(hold, BigInt(pass.run.attempt_worst_case_microusd));
    if (!fits.ok) {
      pass.halt(fits.reason, fits.detail);
      return;
    }
    try {
      await runOnce(pass, item, record, hold);
    } finally {
      if (hold !== null) pass.allowance.release(hold);
    }
  }
}

/**
 * Removes the container of every run whose session was left open: a run the process ended during
 * (never closed), or one whose close or post-failed-open removal failed (the container stayed). Each
 * such run becomes an infrastructure error, rerun under the usual limit. Runs before any grade job or new session, so a
 * leftover container never keeps its share of the host while other work runs; a removal that fails
 * stops the pass before anything else starts.
 */
async function removeLeftoverSessions(pass: Pass): Promise<void> {
  for (const item of pass.run.plan) {
    const record = readAttempt(pass.runDir, item);
    if (record === null) continue;
    let changed = false;
    for (const run of record.runs) {
      if (run.ended !== null && run.ended !== "close_failed") continue;
      const closeFailed = run.ended === "close_failed";
      try {
        await pass.deps.removeSession(run.session_id);
      } catch (error) {
        if (closeFailed) pass.halt("close_failed", `${run.attempt_key}: the session ${run.session_id} whose close failed could not be removed: ${message(error)}`);
        else pass.halt("stale_session", `${run.attempt_key}: the interrupted run's session ${run.session_id} could not be removed: ${message(error)}`);
        return;
      }
      run.ended = "infrastructure_error";
      run.infrastructure = closeFailed ? `close_failed: ${run.close_error ?? "unknown"}` : "interrupted: the process ended during this run";
      changed = true;
    }
    if (changed) {
      record.status = attemptStatus(record.runs);
      writeAttempt(pass.runDir, record);
    }
  }
}

/**
 * The pre-registration's spend stop: after a spend refusal "the run stops and the ledger is
 * reconciled before anything else happens". A resume of a run with a spend-refused attempt goes on
 * only when the ledger shows no open, uncertain or halted operation under the UC1 roots.
 */
async function refuseUnreconciledAfterSpendStop(pass: Pass, runsDir: string): Promise<void> {
  if (pass.stop !== null) return;
  const refused = readAttempts(pass.runDir, pass.run).some((record) => record.runs.some((run) => run.ended === "spend_refused"));
  if (!refused) return;
  const view = await pass.deps.allowanceSource.view(uc1Roots(runsDir));
  if (view.halted || view.uncertain.length > 0 || view.open_microusd > 0n) {
    pass.halt("ledger_unreconciled", `a spend refusal stopped this run; reconcile the ledger before resuming (open ${view.open_microusd.toString()} micro-USD, uncertain ${String(view.uncertain.length)}, halted ${String(view.halted)})`);
  }
}

/** Every UC1 root under the runs directory, read when the allowance asks, so a new root counts at once. */
function uc1Roots(runsDir: string): string[] {
  return listRuns(runsDir).map(({ run }) => run.root_execution_id);
}

function appendStop(runDir: string, stop: StopRecord): void {
  appendFileSync(join(runDir, "stops.jsonl"), `${JSON.stringify(stop)}\n`);
}

/** Step 1: the pilot or the counted run's attempts, with grade 1. */
export async function runSessions(options: SessionsOptions, deps: Uc1Deps): Promise<SessionsOutcome> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > MAX_CONCURRENCY) throw new RunRefusal(`--concurrency must be 1 to ${String(MAX_CONCURRENCY)}`);
  if (!NAME.test(options.name)) throw new RunRefusal("the run name must be lower-case letters, digits and hyphens");
  if (!(options.model in SOLVER_PROFILES)) throw new RunRefusal("--model must be super or kimi");
  let loaded;
  let screen;
  try {
    loaded = loadCase(options.caseFile);
    screen = screenStatus(readFileSync(loaded.config.screen_record));
    checkCaseForMode(options.mode, loaded.config, screen);
  } catch (error) {
    if (error instanceof CaseError) throw new RunRefusal(error.message);
    throw error;
  }
  const { config } = loaded;
  const policy = loadPolicy(options.policyFile);
  const profile = SOLVER_PROFILES[options.model];
  const rateSheet = readSolverRateSheet();
  const priced = solverEnvelope(rateSheet, profile);
  if (!priced.ok) throw new RunRefusal(`the solver rate sheet cannot price ${profile.service}: ${priced.detail}`);
  const issueBytes = readFileSync(config.issue);
  const runDir = join(options.runsDir, options.name);
  const existing = readRun(runDir);
  if (existing !== null) {
    if (existing.model !== options.model) throw new RunRefusal(`run ${options.name} ran on ${existing.model}; it cannot resume on ${options.model}`);
    if (existing.mode !== options.mode || existing.case_sha256 !== loaded.sha256 || existing.project_policy_sha256 !== policy.sha256 || existing.issue_sha256 !== sha256Hex(issueBytes)) {
      throw new RunRefusal(`run ${options.name} was started with another mode, case, policy or issue`);
    }
    if (
      existing.runtime_profile_sha256 !== profileSha256(profile) ||
      existing.rate_sheet_sha256 !== priced.rate_sheet_sha256 ||
      existing.turn_worst_case_microusd !== priced.turn_worst_case_microusd ||
      existing.attempt_worst_case_microusd !== priced.attempt_worst_case_microusd
    ) {
      throw new RunRefusal(`run ${options.name} was started with another solver profile or rate sheet`);
    }
    refuseFinalized(runDir, options.name);
    refuseChangedInputs(runDir, existing);
    await refuseMovedImage(config, deps);
  } else if (existsSync(runDir) && readdirSync(runDir).length > 0) {
    throw new RunRefusal(`${runDir} exists and is not a UC1 run`);
  }
  const frozen = frozenModel(options.runsDir);
  if (frozen !== null && frozen.model !== options.model) throw new RunRefusal(`the model is frozen at ${frozen.model} after the first counted attempt (run ${frozen.name}); switching is refused`);
  if (options.mode === "run") refuseWithoutCompletedPilot(options.runsDir, options.model);

  let run: RunRecord;
  if (existing === null) {
    // The states come back as bytes, so the exported source tree is removed as soon as they are read.
    const scratch = mkdtempSync(join(tmpdir(), "rbw-uc1-states-"));
    let states;
    try {
      states = await deps.deriveStates(config, scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (states.digest !== config.image_digest) throw new RunRefusal(`the image resolves to ${states.digest}, not the case's ${config.image_digest}`);
    if (options.mode === "run") {
      try {
        checkScreenTarget(screen, states);
      } catch (error) {
        if (error instanceof CaseError) throw new RunRefusal(error.message);
        throw error;
      }
    }
    const ids: RunIds = { ...newRunIds(() => deps.uuid()), project_id: policy.projectId };
    const plantedSha = sha256Hex(states.planted);
    const issueSha = sha256Hex(issueBytes);
    run = {
      schema_version: 1,
      kind: "uc1_run",
      mode: options.mode,
      name: options.name,
      label: options.mode === "pilot" ? PILOT_LABEL : null,
      case_id: config.case_id,
      case_sha256: loaded.sha256,
      screen_record_sha256: sha256Hex(readFileSync(config.screen_record)),
      issue_sha256: issueSha,
      inputs_sha256: caseInputDigests(config),
      model: options.model,
      model_id: profile.hashed.model,
      service: profile.service,
      runtime_profile_sha256: profileSha256(profile),
      rate_sheet_sha256: priced.rate_sheet_sha256,
      turn_worst_case_microusd: priced.turn_worst_case_microusd,
      attempt_worst_case_microusd: priced.attempt_worst_case_microusd,
      cap_microusd: SPEND_CAPS_MICROUSD[options.model].toString(),
      project_id: policy.projectId,
      project_policy_sha256: policy.sha256,
      root_execution_id: ids.root_execution_id,
      task_revision: sha256Hex(encodeCanonical({ kind: "uc1_solver_task", case_id: config.case_id, image_digest: config.image_digest, planted_sha256: plantedSha, issue_sha256: issueSha })),
      plan: attemptPlan(options.mode, options.model),
      created_at: deps.now().toISOString(),
    };
    mkdirSync(join(runDir, "states"), { recursive: true });
    writeAtomic(join(runDir, "states", "clean.bin"), states.clean);
    writeAtomic(join(runDir, "states", "planted.bin"), states.planted);
    writeAtomic(join(runDir, "states", "alternative.bin"), states.alternative);
    const statesRecord: StatesRecord = { target_path: states.target_path, digest: states.digest, clean_sha256: sha256Hex(states.clean), planted_sha256: plantedSha, alternative_sha256: sha256Hex(states.alternative) };
    writeJson(join(runDir, "states.json"), statesRecord);
    writeJson(join(runDir, "case.json"), config);
    writeAtomic(join(runDir, "policy.json"), policy.bytes);
    writeJson(join(runDir, "ids.json"), ids);
    writeJson(join(runDir, "run.json"), run);
    // The root exists, under the public_demo policy, before the first attempt or grade.
    writeRootRun(runDir, run, "prepared", null);
    deps.report(`root=${run.root_execution_id} kind=paired_comparison status=prepared mode=${run.mode} case=${run.case_id} model=${run.model_id}`);
  } else {
    run = existing;
    deps.report(`root=${run.root_execution_id} resume mode=${run.mode}`);
  }

  const pass: Pass = {
    runDir,
    run,
    config: readJson(join(runDir, "case.json")) as CaseConfig,
    ids: readJson(join(runDir, "ids.json")) as RunIds,
    deps,
    allowance: new Allowance(deps.allowanceSource, BigInt(run.cap_microusd), () => uc1Roots(options.runsDir)),
    profile,
    rateSheet,
    turnWorst: BigInt(priced.turn_worst_case_microusd),
    issue: issueBytes.toString("utf8"),
    stop: null,
    halt(reason, detail) {
      if (this.stop !== null) return;
      this.stop = { reason, detail, at: deps.now().toISOString() };
      appendStop(runDir, this.stop);
      deps.report(`stop=${reason} detail=${detail}`);
    },
  };

  await removeLeftoverSessions(pass);
  await refuseUnreconciledAfterSpendStop(pass, options.runsDir);

  // The slot is taken before any grade job, the pilot's seeded round trips included: a slot another
  // root holds stops the pass before any job runs, so no grade retry is spent on the contention and
  // a later resume continues where this one stopped.
  // Grade 1 jobs run the controller on --backend docker, which opens its own in-memory ledger per
  // job, so their slot acquire and release never touch this hold on the development ledger.
  const slot = { slot_key: DEVELOPMENT_SLOT, root_execution_id: run.root_execution_id, actor_role: ACTOR };
  // A leftover session that could not be removed has already stopped the pass: no slot, no job.
  const status = pass.stop === null ? await deps.spend.slotStatus({ slot_key: DEVELOPMENT_SLOT }) : null;
  let held = false;
  if (status === null) held = false;
  else if (!status.ok) pass.halt("slot_unavailable", status.code);
  else if (status.holder === run.root_execution_id) held = true;
  else if (status.holder !== null) pass.halt("slot_held", `slot busy: the development slot is held by ${status.holder}; resume with the same command once it is free`);
  else {
    const hold = await deps.spend.acquireSlot(slot);
    if (hold.ok) held = true;
    else pass.halt("slot_refused", hold.code);
  }
  writeRootRun(runDir, run, "running", null);

  let seededOk = run.mode !== "pilot";
  if (held) {
    const queue = run.plan.filter((item) => {
      const record = readAttempt(runDir, item);
      return record === null || gradingPending(record) || (record.status !== "counted" && record.status !== "infrastructure_error");
    });
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (pass.stop !== null) return;
        const item = queue[next];
        next += 1;
        if (item === undefined) return;
        await runIndex(pass, item);
      }
    };
    try {
      if (run.mode === "pilot") seededOk = await seededGrades(pass);
      await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
    } finally {
      // Released even when a step threw, so a harness fault never leaves the development slot held.
      const released = await deps.spend.releaseSlot({ ...slot, evidence: null, reason: null });
      if (!released.ok) {
        pass.halt("slot_release_blocked", `${released.code}: ${released.detail ?? ""}`);
        writeRootRun(runDir, run, "needs_reconciliation", null);
      }
    }
  }

  await writeProgress(runDir, run, deps);
  const finals = run.plan.map((item) => readAttempt(runDir, item));
  const allCounted = finals.every((record) => record?.status === "counted" && !gradingPending(record));
  // An attempt that ended an infrastructure error after its reruns, or whose grade 1 did after its retries, is final but still exits 1.
  const graded1 = !finals.some(grade1Infrastructure);
  return { exitCode: pass.stop === null && allCounted && graded1 && seededOk ? 0 : 1, runDir, rootExecutionId: run.root_execution_id, stop: pass.stop };
}

/**
 * results/summary.json as it stands, without the analysis (a progress view between steps). Its spend
 * figures come from the ledger; when the ledger cannot be read, the progress view is left as it was.
 */
async function writeProgress(runDir: string, run: RunRecord, deps: Pick<Uc1Deps, "allowanceSource" | "report">): Promise<void> {
  let ledger;
  try {
    ledger = await deps.allowanceSource.view([run.root_execution_id]);
  } catch (error) {
    deps.report(`progress=skipped detail=the ledger could not be read: ${message(error)}`);
    return;
  }
  writeJson(join(runDir, "results", "summary.json"), buildSummary(run, readAttempts(runDir, run), readSeeded(runDir), readStops(runDir), ledger, null));
}

export interface Grade2Outcome {
  exitCode: number;
  /** Grade 2 jobs run in this call. */
  graded: number;
  stop: StopRecord | null;
}

/** Step 2: the protected regrade on Vercel Sandbox for every graded attempt and seeded round trip, serially. */
export async function runGrade2(options: { runDir: string }, deps: Uc1Deps): Promise<Grade2Outcome> {
  const { runDir } = options;
  const run = readRun(runDir);
  if (run === null) throw new RunRefusal(`${runDir} is not a UC1 run`);
  refuseFinalized(runDir, run.name);
  refuseChangedInputs(runDir, run);
  const slot = await deps.spend.slotStatus({ slot_key: DEVELOPMENT_SLOT });
  if (!slot.ok) throw new RunRefusal(`the development slot is unavailable (${slot.code})`);
  if (slot.holder !== null) throw new RunRefusal(`the development slot is held by ${slot.holder}; grade 2 needs it free, since the controller takes it for each job`);
  const ctx: RunContext = { runDir, run, config: readJson(join(runDir, "case.json")) as CaseConfig, ids: readJson(join(runDir, "ids.json")) as RunIds, deps };
  const allowance = new Allowance(deps.allowanceSource, BigInt(run.cap_microusd), () => uc1Roots(dirname(runDir)));
  let stop: StopRecord | null = null;
  let graded = 0;

  interface Item {
    label: string;
    route: Exclude<GradeRoute, { route: "not_graded" }>;
    work: string;
    tries: GradeTry[];
    save: () => void;
  }
  const items: Item[] = [];
  for (const record of readSeeded(runDir)) {
    if (isGraded(record.route)) items.push({ label: record.label, route: record.route, work: join(runDir, "seeded", record.label, "grade"), tries: record.grade2, save: () => {
          writeSeeded(runDir, record);
        } });
  }
  for (const record of readAttempts(runDir, run)) {
    const final = record.runs.at(-1);
    if (record.status !== "counted" || final === undefined || !isGraded(final.route)) continue;
    items.push({ label: final.attempt_key, route: final.route, work: join(runDir, "attempts", attemptDirName(record), `r${String(final.rerun)}`, "grade"), tries: final.grade2, save: () => {
        writeAttempt(runDir, record);
      } });
  }
  outer: for (const item of items) {
    while (needsGrade(item.tries)) {
      const retry = item.tries.length;
      const grade = () => gradeTry(ctx, item.route, 2, item.work, item.label, retry);
      // A job that already wrote its summary (the process stopped before its try was saved) has
      // settled: the controller replays it with no new spend, so it takes no allowance hold.
      const settled = summaryParses(join(item.work, "jobs", jobName(2, item.label, retry), "summary.json"));
      const held = settled ? { ok: true as const, value: await grade() } : await allowance.withHold(`${item.label}-r${String(retry)}`, deps.grade2WorstCaseMicrousd, grade);
      if (!held.ok) {
        stop = { reason: held.reason, detail: held.detail, at: deps.now().toISOString() };
        appendStop(runDir, stop);
        deps.report(`stop=${held.reason} detail=${held.detail}`);
        break outer;
      }
      item.tries.push(held.value);
      item.save();
      graded += 1;
    }
  }
  await writeProgress(runDir, run, deps);
  const pending = items.filter((item) => needsGrade(item.tries) || item.tries.at(-1)?.result.state === "infrastructure").length;
  deps.report(`grade2 graded=${String(graded)} pending=${String(pending)} max_retries=${String(MAX_GRADE_RETRIES)}`);
  return { exitCode: stop === null && pending === 0 ? 0 : 1, graded, stop };
}

export interface FinalizeOutcome {
  exitCode: number;
  rootRun: RootRun;
  summary: RunSummary;
}

/**
 * Whether a settled root's attempts and seeded round trips let finalize call it completed. A counted
 * run completes when every planned attempt is final (counted, or an infrastructure error after its
 * reruns, which the analysis excludes). A pilot is the counted run's prerequisite, so it completes
 * only when every planned attempt was counted with its grading finished, and every seeded round trip
 * exists, took its expected route and passed both grades.
 */
function rootCompleted(run: RunRecord, records: readonly AttemptRecord[], seeded: readonly SeededRecord[]): boolean {
  const final = (index: number) => records.find((record) => record.index === index);
  if (run.mode === "run") return run.plan.every((item) => {
    const status = final(item.index)?.status;
    return status === "counted" || status === "infrastructure_error";
  });
  const attemptsCounted = run.plan.every((item) => {
    const record = final(item.index);
    return record?.status === "counted" && !gradingPending(record);
  });
  const seededPassed = SEEDED_ROUND_TRIPS.every((seed) => {
    const item = seeded.find((entry) => entry.label === seed.label);
    return item !== undefined && item.route_matches && item.grade1.at(-1)?.result.state === "passed" && item.grade2.at(-1)?.result.state === "passed";
  });
  return attemptsCounted && seededPassed;
}

/** Step 3: the analyzer's rows and results record, the summary and report, the staging directory and the root's terminal status. */
export async function finalize(options: { runDir: string }, deps: Pick<Uc1Deps, "allowanceSource" | "now" | "report">): Promise<FinalizeOutcome> {
  const { runDir } = options;
  const run = readRun(runDir);
  if (run === null) throw new RunRefusal(`${runDir} is not a UC1 run`);
  refuseChangedInputs(runDir, run);
  const records = readAttempts(runDir, run);
  const seeded = readSeeded(runDir);
  const target = (readJson(join(runDir, "states.json")) as StatesRecord).target_path;
  let rows: AttemptRow[];
  try {
    rows = records.flatMap((record) => {
      const row = attemptRow(run.case_id, target, record);
      return row === null ? [] : [row];
    });
  } catch (error) {
    if (error instanceof PendingGrade) throw new RunRefusal(error.message);
    throw error;
  }
  const pendingSeeded = seeded.filter((item) => isGraded(item.route) && needsGrade(item.grade2));
  if (pendingSeeded.length > 0) throw new RunRefusal(`the seeded round trip ${pendingSeeded.map((item) => item.label).join(", ")} has no finished grade 2; run grade2 first`);
  let analysis: ResultsRecord | null = null;
  let analysisJson: string | null = null;
  let analysisRef: RunSummary["analysis"] = null;
  if (rows.length > 0) {
    try {
      analysis = analyze(rows);
      analysisJson = resultsRecordJson(analysis);
      analysisRef = "results/analysis.json";
    } catch (error) {
      analysisRef = { error: message(error) };
    }
  }
  const ledger = await deps.allowanceSource.view([run.root_execution_id]);
  const roots = uc1Roots(dirname(runDir));
  const allRoots = await deps.allowanceSource.view(roots);
  const summary = buildSummary(run, records, seeded, readStops(runDir), ledger, analysisRef, { roots: roots.length, view: allRoots });
  writeJson(join(runDir, "results", "rows.json"), rows);
  writeJson(join(runDir, "results", "summary.json"), summary);
  if (analysisJson !== null) writeAtomic(join(runDir, "results", "analysis.json"), analysisJson);
  const report = reportMarkdown(summary, analysis);
  const config = readJson(join(runDir, "case.json")) as CaseConfig;
  writeStaging(runDir, { run, records, seeded, rows, analysisJson, summary, report, screenRecord: config.screen_record });

  const unresolved = ledger.uncertain.length > 0 || ledger.open_microusd > 0n || ledger.halted;
  const rootRun = unresolved ? writeRootRun(runDir, run, "needs_reconciliation", null) : writeRootRun(runDir, run, "terminal", rootCompleted(run, records, seeded) ? "completed" : "incomplete");
  deps.report(`root=${run.root_execution_id} status=${rootRun.status} outcome=${rootRun.outcome ?? "-"} rows=${String(rows.length)} staging=${join(runDir, "staging")}`);
  return { exitCode: rootRun.status === "terminal" && rootRun.outcome === "completed" ? 0 : 1, rootRun, summary };
}
