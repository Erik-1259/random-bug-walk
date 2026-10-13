// The UC1 run orchestrator (docs/uc1-preregistration.md is the contract). Three steps, each its
// own command:
//
//   1. sessions (`pilot` or `run`): refuse anything the pre-registration does not allow, create and
//      persist the paired_comparison root under the public_demo policy, run the pilot's seeded
//      grade round trips (grade 1, no model), hold the development slot for the root, and run the
//      attempts in index order (up to 3 at once): a fresh session on the pinned kit image, the
//      solver loop with the arm's tools, the diff, then grade 1 on local Docker. Every model call
//      passes the spend guard first. Infrastructure errors are rerun at the same index, up to 2
//      times; a stop (spend, ledger or a session refusal) ends the pass, and the next pass resumes.
//   2. grade2: the protected regrade on Vercel Sandbox, serially, each job only when its worst
//      case fits the allowance, with the slot free for the controller to take.
//   3. finalize: the analyzer's rows and results record, the summary, the report, the publisher's
//      staging directory, and the root's terminal status.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
import { CaseError, checkCaseForMode, controllerBase, loadCase, screenStatus } from "./case.ts";
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
  isGraded,
  listRuns,
  needsGrade,
  readAttempt,
  readAttempts,
  readJson,
  readRun,
  readSeeded,
  readStops,
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
    if (readAttempts(dir, run).some((record) => record.runs.some((entry) => entry.ended === "submitted" || entry.ended === "cap_reached"))) return { model: run.model, name: run.name };
  }
  return null;
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
  writeFileSync(join(runDir, "root-run.json"), encodeCanonical(record));
  return record;
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

/** One grade of a prepared route: its own ids file (a fresh execution under the root), the controller job, its summary. */
async function gradeTry(ctx: RunContext, route: Exclude<GradeRoute, { route: "not_graded" }>, grade: GradeNumber, work: string, label: string, retry: number): Promise<GradeTry> {
  const ids = writeGradeIds(ctx.ids, join(work, "ids", `grade-${String(grade)}`), label, () => ctx.deps.uuid(), retry);
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
  try {
    result = await runGrade(route, grade, command, { runController: (args) => ctx.deps.runController(args) });
  } catch (error) {
    // The controller could not be started: no verdict on the attempt, so an infrastructure grade, retried as a grade only.
    result = { grade, job: jobName(grade, label, retry), state: "infrastructure", detail: `controller: ${message(error)}`, summary_sha256: null, trial: null };
  }
  const executionId = (readJson(ids[grade]) as RunIds).executions["alternative-fix"];
  const summaryPath = join(work, "jobs", result.job, "summary.json");
  let settled: number | null = null;
  if (existsSync(summaryPath)) {
    try {
      const value = (readJson(summaryPath) as { spend?: { settled_microusd?: unknown } }).spend?.settled_microusd;
      settled = typeof value === "number" ? value : null;
    } catch {
      settled = null;
    }
  }
  ctx.deps.report(`grade=${String(grade)} job=${result.job} state=${result.state}${settled === null ? "" : ` settled_microusd=${String(settled)}`}`);
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

/** One run at an index: session, solver loop, diff, close, grade 1. */
async function runOnce(pass: Pass, item: PlannedAttempt, record: AttemptRecord): Promise<void> {
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
    }
    finishRun(pass, run, opened.getTime());
    save();
    deps.report(`attempt=${key} status=${run.ended}`);
    return;
  }
  let target: Buffer | null = null;
  try {
    const states = readJson(join(pass.runDir, "states.json")) as StatesRecord;
    if (session.planted_sha256 !== states.planted_sha256 || session.digest !== pass.config.image_digest) {
      run.ended = "refused";
      run.refusal = "the session's planted file or image digest is not the case's";
      pass.halt("session_refused", `${key}: ${run.refusal}`);
    } else {
      const transcript = join(dir, "transcript.jsonl");
      const result = await runAttempt({
        spend: guardSpend(deps.spend, pass.allowance),
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
      });
      run.result = result;
      run.ended = result.outcome;
      if (result.outcome === "infrastructure_error") run.infrastructure = result.infrastructure?.reason ?? "infrastructure_error";
      if (result.outcome === "spend_refused") {
        const stop = pass.allowance.stop;
        pass.halt(stop?.reason ?? "ledger_refused", stop?.detail ?? `${result.refusal?.code ?? "refused"}: ${result.refusal?.detail ?? ""}`);
      }
      if (result.outcome === "submitted" || result.outcome === "cap_reached") {
        try {
          const ended = await session.end(result.outcome === "submitted" ? "submit" : "cap");
          run.submission = ended.submission;
          target = ended.target;
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
      run.close_error = message(error);
    }
  }
  finishRun(pass, run, opened.getTime());
  record.status = attemptStatus(record.runs);
  save();
  const result = run.result;
  deps.report(`attempt=${key} status=${run.ended} turns=${String(result?.turns ?? 0)} tokens=${String(result === null ? 0 : result.input_tokens + result.output_tokens)} settled_microusd=${String(result?.settled_microusd ?? 0)}`);

  if (run.submission === null || (run.ended !== "submitted" && run.ended !== "cap_reached")) return;
  if (run.submission.scope === "out_of_scope") return;
  const route: GradeRoute =
    target === null
      ? { route: "not_graded", attempt_sha256: "missing", clean_equal: false, reason: "invalid_fix", detail: "the target file is missing" }
      : prepareGrade(target, gradeTarget(pass.runDir), join(dir, "grade", "fix"));
  run.route = route;
  save();
  if (isGraded(route)) await grade1(pass, route, join(dir, "grade"), key, run.grade1, save);
}

/** Runs an index to a final status (with its reruns), unless the pass stops. */
async function runIndex(pass: Pass, item: PlannedAttempt): Promise<void> {
  const record: AttemptRecord = readAttempt(pass.runDir, item) ?? { schema_version: 1, index: item.index, arm: item.arm, seed: item.seed, status: "pending", runs: [] };
  for (const run of record.runs) {
    if (run.ended === null) {
      run.ended = "infrastructure_error";
      run.infrastructure = "interrupted: the process ended during this run";
    }
  }
  for (;;) {
    record.status = attemptStatus(record.runs);
    if (record.runs.length > 0) writeAttempt(pass.runDir, record);
    if (record.status === "counted" || record.status === "infrastructure_error") return;
    if (pass.stop !== null) return;
    const fits = await pass.allowance.check(pass.turnWorst);
    if (!fits.ok) {
      pass.halt(fits.reason, fits.detail);
      return;
    }
    await runOnce(pass, item, record);
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
  try {
    loaded = loadCase(options.caseFile);
    checkCaseForMode(options.mode, loaded.config, screenStatus(readFileSync(loaded.config.screen_record)));
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
  } else if (existsSync(runDir) && readdirSync(runDir).length > 0) {
    throw new RunRefusal(`${runDir} exists and is not a UC1 run`);
  }
  const frozen = frozenModel(options.runsDir);
  if (frozen !== null && frozen.model !== options.model) throw new RunRefusal(`the model is frozen at ${frozen.model} after the first counted attempt (run ${frozen.name}); switching is refused`);

  let run: RunRecord;
  if (existing === null) {
    const states = await deps.deriveStates(config, mkdtempSync(join(tmpdir(), "rbw-uc1-states-")));
    if (states.digest !== config.image_digest) throw new RunRefusal(`the image resolves to ${states.digest}, not the case's ${config.image_digest}`);
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
    writeFileSync(join(runDir, "states", "clean.bin"), states.clean);
    writeFileSync(join(runDir, "states", "planted.bin"), states.planted);
    writeFileSync(join(runDir, "states", "alternative.bin"), states.alternative);
    const statesRecord: StatesRecord = { target_path: states.target_path, digest: states.digest, clean_sha256: sha256Hex(states.clean), planted_sha256: plantedSha, alternative_sha256: sha256Hex(states.alternative) };
    writeJson(join(runDir, "states.json"), statesRecord);
    writeJson(join(runDir, "case.json"), config);
    writeFileSync(join(runDir, "policy.json"), policy.bytes);
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

  const seededOk = run.mode === "pilot" ? await seededGrades(pass) : true;

  const slot = { slot_key: DEVELOPMENT_SLOT, root_execution_id: run.root_execution_id, actor_role: ACTOR };
  const status = await deps.spend.slotStatus({ slot_key: DEVELOPMENT_SLOT });
  let held = false;
  if (!status.ok) pass.halt("slot_unavailable", status.code);
  else if (status.holder === run.root_execution_id) held = true;
  else if (status.holder !== null) pass.halt("slot_held", `the development slot is held by ${status.holder}`);
  else {
    const hold = await deps.spend.acquireSlot(slot);
    if (hold.ok) held = true;
    else pass.halt("slot_refused", hold.code);
  }
  writeRootRun(runDir, run, "running", null);

  if (held) {
    const queue = run.plan.filter((item) => {
      const record = readAttempt(runDir, item);
      return record === null || (record.status !== "counted" && record.status !== "infrastructure_error");
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

  writeProgress(runDir, run, null);
  const allFinal = run.plan.every((item) => {
    const record = readAttempt(runDir, item);
    return record !== null && (record.status === "counted" || record.status === "infrastructure_error");
  });
  return { exitCode: pass.stop === null && allFinal && seededOk ? 0 : 1, runDir, rootExecutionId: run.root_execution_id, stop: pass.stop };
}

/** results/summary.json as it stands, without the analysis (a progress view between steps). */
function writeProgress(runDir: string, run: RunRecord, ledger: Parameters<typeof buildSummary>[4]): RunSummary {
  const summary = buildSummary(run, readAttempts(runDir, run), readSeeded(runDir), readStops(runDir), ledger, null);
  writeJson(join(runDir, "results", "summary.json"), summary);
  return summary;
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
      const held = await allowance.withHold(`${item.label}-r${String(retry)}`, deps.grade2WorstCaseMicrousd, () => gradeTry(ctx, item.route, 2, item.work, item.label, retry));
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
  writeProgress(runDir, run, null);
  const pending = items.filter((item) => needsGrade(item.tries) || item.tries.at(-1)?.result.state === "infrastructure").length;
  deps.report(`grade2 graded=${String(graded)} pending=${String(pending)} max_retries=${String(MAX_GRADE_RETRIES)}`);
  return { exitCode: stop === null && pending === 0 ? 0 : 1, graded, stop };
}

export interface FinalizeOutcome {
  exitCode: number;
  rootRun: RootRun;
  summary: RunSummary;
}

/** Step 3: the analyzer's rows and results record, the summary and report, the staging directory and the root's terminal status. */
export async function finalize(options: { runDir: string }, deps: Pick<Uc1Deps, "allowanceSource" | "now" | "report">): Promise<FinalizeOutcome> {
  const { runDir } = options;
  const run = readRun(runDir);
  if (run === null) throw new RunRefusal(`${runDir} is not a UC1 run`);
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
  if (analysisJson !== null) writeFileSync(join(runDir, "results", "analysis.json"), analysisJson);
  const report = reportMarkdown(summary, analysis);
  const config = readJson(join(runDir, "case.json")) as CaseConfig;
  writeStaging(runDir, { run, records, seeded, rows, analysisJson, summary, report, screenRecord: config.screen_record });

  const allFinal = run.plan.every((item) => records.some((record) => record.index === item.index && (record.status === "counted" || record.status === "infrastructure_error")));
  // A seeded round trip demonstrates the grader only when it took the expected route and both grades passed.
  const seededPassed = seeded.every((item) => item.route_matches && item.grade1.at(-1)?.result.state === "passed" && item.grade2.at(-1)?.result.state === "passed");
  const unresolved = ledger.uncertain.length > 0 || ledger.open_microusd > 0n || ledger.halted;
  const rootRun = unresolved ? writeRootRun(runDir, run, "needs_reconciliation", null) : writeRootRun(runDir, run, "terminal", allFinal && seededPassed ? "completed" : "incomplete");
  deps.report(`root=${run.root_execution_id} status=${rootRun.status} outcome=${rootRun.outcome ?? "-"} rows=${String(rows.length)} staging=${join(runDir, "staging")}`);
  return { exitCode: rootRun.status === "terminal" && rootRun.outcome === "completed" ? 0 : 1, rootRun, summary };
}
