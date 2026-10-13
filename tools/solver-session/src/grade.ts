// The grade of one solver attempt: the target file's bytes after the session, graded twice by the
// trusted controller's judge_verify on the development pool and slot (never the judge's).
//
// Route:
//   - the bytes equal the clean file: `--judge-fixed fixed`, so fixed-01 is the reference fix, which
//     is byte-identical to the attempt. The alternative-fix layout cannot carry it, because the
//     local runner refuses an alternative fix equal to the clean file.
//   - the bytes differ from the clean and the planted file: alternative-fix.json and its patch from
//     the planted file, graded with `--fix`.
//   - the bytes equal the planted file (no change) or are not a checked single-file patch: no grade,
//     and the attempt is unsolved.
//
// Two grades (R1): grade 1 on local Docker (in-memory ledger, $0) and grade 2 on Vercel Sandbox,
// which is authoritative. Solved means grade 2's summary is complete, names the development slot,
// placed the attempt's exact bytes as fixed-01, and imported fixed-01 as complete with its added
// verdict `match` and no original-suite failure. A missing, unreadable, refused or tampered result
// is never solved. A job that stopped before a verdict (a slot or reservation refusal, a launch or
// copy error, a build refusal, a ledger outage) is an `infrastructure` grade: unsolved, reported apart
// from a wrong fix and rerunnable (R8). A disagreement between two verdicts is recorded for publication.
//
// Attempts graded under one root (the design's shared root and policy) stay apart in the ledger: each
// grade's job name carries the attempt label and the retry number, so its call name and operation ID
// are its own (a rerun of an infrastructure grade is a fresh job, never the stored refusal), and each
// grade gets its own ids file (writeGradeIds) with the root's IDs and a fresh alternative-fix
// execution. Grade 1 and grade 2 are separate calls (runGrade), so a runner can run grade 1 as each
// session ends and grade 2 serially, since every grade 2 takes the one development slot.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { structuredPatch } from "diff";
import { CodeStateRefusal, applyPatchChecked } from "@rbw/local-runner";
import type { RunIds } from "@rbw/local-runner";
import { sha256Hex } from "@rbw/schema";

export const GRADED_TRIAL = "fixed-01";
export const ALTERNATIVE_RECORD = "alternative-fix.json";
export const ALTERNATIVE_PATCH = "alternative-fix.patch";
/** The controller options the grade sets itself; the caller's base options may not repeat them. */
export const RESERVED_OPTIONS = ["--job-kind", "--ledger", "--trials", "--backend", "--sandbox-image", "--name", "--work", "--fix", "--judge-fixed", "--prebuilt", "--ids", "--project-policy"] as const;

/** The case's target file: its path, the clean file's hash, and the planted file's bytes. */
export interface GradeTarget {
  target_path: string;
  clean_sha256: string;
  planted: Uint8Array;
}

export type GradeRoute =
  | { route: "clean_equal"; attempt_sha256: string; clean_equal: true }
  | { route: "alternative_fix"; attempt_sha256: string; clean_equal: false; fix_dir: string; patch_sha256: string }
  | { route: "not_graded"; attempt_sha256: string; clean_equal: false; reason: "unchanged" | "invalid_fix"; detail: string };

function sha256(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

/** A git-style one-file diff from the planted file to the attempt, in the layout applyPatchChecked reads. */
export function plantedPatch(target: string, planted: Uint8Array, attempt: Uint8Array): string {
  const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const { hunks } = structuredPatch("a", "b", decode(planted), decode(attempt), undefined, undefined, { context: 3 });
  const body = hunks.map((hunk) => `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@\n${hunk.lines.map((line) => `${line}\n`).join("")}`).join("");
  return `diff --git a/${target} b/${target}\n--- a/${target}\n+++ b/${target}\n${body}`;
}

/**
 * Picks the attempt's route and, for an alternative fix, writes alternative-fix.json and its patch
 * into `fixDir`. The patch is applied back to the planted file with the local runner's own check,
 * so a fix the controller would refuse is not graded.
 */
export function prepareGrade(attempt: Uint8Array, target: GradeTarget, fixDir: string): GradeRoute {
  const attemptSha = sha256(attempt);
  if (attemptSha === target.clean_sha256) return { route: "clean_equal", attempt_sha256: attemptSha, clean_equal: true };
  const plantedSha = sha256(target.planted);
  if (attemptSha === plantedSha) return { route: "not_graded", attempt_sha256: attemptSha, clean_equal: false, reason: "unchanged", detail: "the target file is the planted file" };
  let patch: string;
  try {
    patch = plantedPatch(target.target_path, target.planted, attempt);
    applyPatchChecked(target.planted, patch, { target: target.target_path, base_sha256: plantedSha, result_sha256: attemptSha });
  } catch (error) {
    if (error instanceof TypeError || error instanceof CodeStateRefusal) {
      return { route: "not_graded", attempt_sha256: attemptSha, clean_equal: false, reason: "invalid_fix", detail: error instanceof CodeStateRefusal ? error.reason : "the target file is not valid UTF-8" };
    }
    throw error;
  }
  mkdirSync(fixDir, { recursive: true });
  writeFileSync(join(fixDir, ALTERNATIVE_PATCH), patch);
  const record = {
    base_sha256: plantedSha,
    description: "A solver attempt's change to the planted file, graded as fixed-01.",
    patch: ALTERNATIVE_PATCH,
    result_sha256: attemptSha,
    target_path: target.target_path,
  };
  writeFileSync(join(fixDir, ALTERNATIVE_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  return { route: "alternative_fix", attempt_sha256: attemptSha, clean_equal: false, fix_dir: fixDir, patch_sha256: sha256(Buffer.from(patch)) };
}

export type GradeNumber = 1 | 2;

export interface GradeCommand {
  /** The run directory both grades share; each grade is its own job in it. */
  work: string;
  /**
   * The attempt's label (lowercase letters, digits and single hyphens), unique among the attempts
   * graded under one root. It names the grade jobs, and so their call names and operation IDs.
   */
  attempt: string;
  /**
   * The grade's retry number: 0 (the default) for the first run, and one more for each rerun of an
   * infrastructure grade, so the rerun is its own controller job instead of a replay of the refused one.
   */
  retry?: number;
  /** The case's controller options: --image, --manifest, --terms, --kit-stage, --original-suite, and any the case needs. */
  base: readonly string[];
  /** Grade 2's kit image in VCR, pinned by digest. */
  sandboxImage: string;
  /**
   * The case's committed alternative fix (`--fix`), used by the clean-equal route: the controller
   * derives it (and refuses the job if it does not apply) even when fixed-01 grades the reference fix,
   * and the local runner's default only fits the time-zone case. Required, so a race-case exact revert
   * is never graded against the time-zone fix.
   */
  referenceFix: string;
  /** Each grade's ids file (`--ids`), written by writeGradeIds; absent, each grade mints its own root. */
  ids?: Readonly<Record<GradeNumber, string>>;
  /** The run's ProjectPolicy record (`--project-policy`); it needs `ids` naming its project. */
  projectPolicy?: string;
}

const ATTEMPT_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The grade's controller job name; the retry number always ends it, so no label and retry pair collides with another. */
export function jobName(grade: GradeNumber, attempt: string, retry = 0): string {
  if (!ATTEMPT_LABEL.test(attempt)) throw new Error("the attempt label must be lowercase letters, digits and single hyphens");
  if (!Number.isSafeInteger(retry) || retry < 0) throw new Error("the retry number must be a whole number from 0");
  return `${grade === 1 ? "grade-1-docker" : "grade-2-sandbox"}-${attempt}-r${String(retry)}`;
}

/**
 * Writes one ids file per grade into `dir`: the root's IDs with a fresh alternative-fix execution, so
 * both grades of every attempt share the root and policy but record under their own execution. A file
 * already written for the same grade, attempt and retry is kept, never regenerated: the ids are part
 * of the controller job's inputs, so a resumed grade replays the job that ran instead of being refused.
 */
export function writeGradeIds(root: RunIds, dir: string, attempt: string, uuid: () => string, retry = 0): Record<GradeNumber, string> {
  mkdirSync(dir, { recursive: true });
  const file = (grade: GradeNumber): string => {
    const path = join(dir, `${jobName(grade, attempt, retry)}.ids.json`);
    if (existsSync(path)) return path;
    const ids: RunIds = { ...root, executions: { ...root.executions, "alternative-fix": uuid() } };
    writeFileSync(path, `${JSON.stringify(ids, null, 2)}\n`);
    return path;
  };
  return { 1: file(1), 2: file(2) };
}

/** The controller's `run` arguments for one grade: judge_verify, fixed-01 only, on the development ledger. */
export function gradeArgs(route: GradeRoute, grade: GradeNumber, command: GradeCommand): string[] {
  if (route.route === "not_graded") throw new Error("an attempt that is not graded has no grade command");
  const reserved = command.base.find((arg) => (RESERVED_OPTIONS as readonly string[]).includes(arg.split("=")[0] ?? ""));
  if (reserved !== undefined) throw new Error(`the base options may not set ${reserved}; the grade sets it`);
  if (route.route === "clean_equal" && (typeof command.referenceFix !== "string" || command.referenceFix === "")) {
    throw new Error("a clean-equal grade needs the case's committed alternative fix (referenceFix); the default only fits the time-zone case");
  }
  if (command.ids !== undefined && command.ids[1] === command.ids[2]) throw new Error("each grade needs its own ids file");
  if (command.projectPolicy !== undefined && command.ids === undefined) throw new Error("the project policy needs the per-grade ids naming its project");
  const ids = [...(command.ids === undefined ? [] : ["--ids", command.ids[grade]]), ...(command.projectPolicy === undefined ? [] : ["--project-policy", command.projectPolicy])];
  const backend = grade === 1 ? ["--backend", "docker"] : ["--backend", "sandbox", "--sandbox-image", command.sandboxImage];
  const fix =
    route.route === "clean_equal"
      ? ["--judge-fixed", "fixed", "--fix", command.referenceFix]
      : ["--judge-fixed", "alternative_fix", "--fix", route.fix_dir];
  return ["run", "--job-kind", "judge_verify", "--ledger", "development", "--trials", GRADED_TRIAL, "--name", jobName(grade, command.attempt, command.retry), "--work", command.work, ...backend, ...fix, ...ids, ...command.base];
}

/** `infrastructure`: the job stopped before a verdict on the attempt; unsolved, reported apart, rerunnable. */
export type GradeState = "passed" | "failed" | "missing" | "invalid" | "infrastructure";

export interface GradeResult {
  grade: GradeNumber;
  job: string;
  state: GradeState;
  detail: string | null;
  summary_sha256: string | null;
  trial: { status: string | null; added_verdict: string | null; original_executed: number | null; original_failed: number | null; placed_sha256: string | null } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Reads one grade's controller summary (`<work>/jobs/<job>/summary.json`) and judges it for this
 * attempt. Passed only when every check holds; a missing or malformed summary is `missing` or
 * `invalid`, and a summary for other bytes, another trial set or the judge slot is `invalid`.
 */
export function readGrade(work: string, grade: GradeNumber, route: GradeRoute, attempt: string, retry = 0): GradeResult {
  const job = jobName(grade, attempt, retry);
  const result = (state: GradeState, detail: string | null, summarySha: string | null = null, trial: GradeResult["trial"] = null): GradeResult => ({ grade, job, state, detail, summary_sha256: summarySha, trial });
  const file = join(work, "jobs", job, "summary.json");
  if (!existsSync(file)) return result("missing", "no controller summary");
  const bytes = readFileSync(file);
  const summarySha = sha256(bytes);
  let summary: unknown;
  try {
    summary = JSON.parse(bytes.toString("utf8"));
  } catch {
    return result("invalid", "the controller summary is not JSON", summarySha);
  }
  const controller = field(summary, "controller");
  const jobRecord = field(summary, "job");
  const trials = field(jobRecord, "trials");
  if (field(jobRecord, "kind") !== "judge_verify" || field(jobRecord, "name") !== job) return result("invalid", "the summary is not this grade's judge_verify job", summarySha);
  if (field(controller, "slot_key") !== "development" || field(controller, "pool_key") !== "development") return result("invalid", "the grade did not run on the development pool and slot", summarySha);
  if (field(controller, "backend") !== (grade === 1 ? "docker" : "sandbox")) return result("invalid", "the grade ran on the wrong backend", summarySha);
  if (!Array.isArray(trials) || trials.length !== 1 || trials[0] !== GRADED_TRIAL) return result("invalid", `the grade did not run ${GRADED_TRIAL} alone`, summarySha);

  const copies = field(summary, "copies");
  const copy = Array.isArray(copies) ? (copies as unknown[]).find((item) => field(item, "trial_id") === GRADED_TRIAL) : undefined;
  const imported = field(field(summary, "import"), "trials");
  const trialRecord = Array.isArray(imported) ? (imported as unknown[]).find((item) => field(item, "trial_id") === GRADED_TRIAL) : undefined;
  const trial = {
    status: str(field(trialRecord, "status")),
    added_verdict: str(field(trialRecord, "added_verdict")),
    original_executed: num(field(trialRecord, "original_executed")),
    original_failed: num(field(trialRecord, "original_failed")),
    placed_sha256: str(field(field(copy, "copy"), "placed_sha256")),
  };
  // A job that did not complete stopped on the slot, the ledger, the build, the launch or the copy,
  // before any verdict on the attempt, except an import refusal of the copy's records: records the
  // attempt's code may have touched are a failure, even when the slot release or the spend read then
  // failed too (the job ends with that stop reason instead of none). A job can also stop after the
  // verdict: an imported complete fixed-01 is then judged like a complete job's.
  const status = field(summary, "status");
  if (status !== "complete" && typeof field(field(summary, "import"), "refusal") === "string") {
    return result("failed", "the record set was refused at import", summarySha, trial);
  }
  const verdictImported = field(field(summary, "import"), "refusal") === null && trial.status === "complete" && trial.added_verdict !== null;
  if (status !== "complete" && !verdictImported) return result("infrastructure", `the grade job ended ${String(str(field(summary, "status")))} (${String(str(field(summary, "reason")))})`, summarySha, trial);
  if (trial.placed_sha256 !== route.attempt_sha256) return result("invalid", "the graded copy did not place the attempt's bytes", summarySha, trial);
  if (field(field(summary, "import"), "refusal") !== null) return result("failed", "the record set was refused at import", summarySha, trial);
  if (trialRecord === undefined) return result("failed", `no imported result for ${GRADED_TRIAL}`, summarySha, trial);
  const passed = trial.status === "complete" && trial.added_verdict === "match" && (trial.original_executed ?? 0) > 0 && trial.original_failed === 0;
  return result(passed ? "passed" : "failed", passed ? null : `${GRADED_TRIAL} imported ${String(trial.status)} with added verdict ${String(trial.added_verdict)}`, summarySha, trial);
}

export interface AttemptGrade {
  schema_version: 1;
  target_path: string;
  attempt_sha256: string;
  route: GradeRoute["route"];
  /** True when the attempt's bytes are the clean file's: graded through the reference fix, never as an alternative fix. */
  clean_equal: boolean;
  not_graded: { reason: string; detail: string } | null;
  grades: GradeResult[];
  /** Grade 2 (Sandbox) passed. */
  solved: boolean;
  /** Grade 2 stopped before a verdict: unsolved, reported apart from a wrong fix, and rerunnable. */
  infrastructure: boolean;
  /** Both grades reached a state other than infrastructure and the states differ; published with the attempt. */
  disagreement: boolean;
}

/** Combines the two grades: grade 2 decides; grade 1 only flags a disagreement. */
export function decide(target: GradeTarget, route: GradeRoute, grades: readonly GradeResult[]): AttemptGrade {
  const [first, second] = [grades.find((item) => item.grade === 1), grades.find((item) => item.grade === 2)];
  return {
    schema_version: 1,
    target_path: target.target_path,
    attempt_sha256: route.attempt_sha256,
    route: route.route,
    clean_equal: route.clean_equal,
    not_graded: route.route === "not_graded" ? { reason: route.reason, detail: route.detail } : null,
    grades: [...grades],
    solved: route.route !== "not_graded" && second?.state === "passed",
    infrastructure: second?.state === "infrastructure",
    disagreement: first !== undefined && second !== undefined && first.state !== "infrastructure" && second.state !== "infrastructure" && first.state !== second.state,
  };
}

export interface GradeDeps {
  /** Runs the controller with these `run` arguments; its exit code is not trusted, only its summary. */
  runController: (args: readonly string[]) => Promise<number>;
}

/** Runs one grade of a prepared attempt and reads its summary. */
export async function runGrade(route: GradeRoute, grade: GradeNumber, command: GradeCommand, deps: GradeDeps): Promise<GradeResult> {
  await deps.runController(gradeArgs(route, grade, command));
  return readGrade(command.work, grade, route, command.attempt, command.retry);
}

/** Decides the attempt from the grades that ran and writes `<work>/grade.json`. */
export function recordAttempt(target: GradeTarget, route: GradeRoute, grades: readonly GradeResult[], work: string): AttemptGrade {
  const decided = decide(target, route, grades);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "grade.json"), `${JSON.stringify(decided, null, 2)}\n`);
  return decided;
}

/**
 * Grades one attempt serially: route, grade 1 on Docker, grade 2 on Sandbox, then `<work>/grade.json`.
 * A runner with concurrent sessions calls prepareGrade, runGrade and recordAttempt itself instead, so
 * that grade 2 runs serially. Both commands are checked before any controller run.
 */
export async function gradeAttempt(attempt: Uint8Array, target: GradeTarget, command: GradeCommand, deps: GradeDeps): Promise<AttemptGrade> {
  const route = prepareGrade(attempt, target, join(command.work, "fix"));
  const grades: GradeResult[] = [];
  if (route.route !== "not_graded") {
    gradeArgs(route, 1, command);
    gradeArgs(route, 2, command);
    for (const grade of [1, 2] as const) grades.push(await runGrade(route, grade, command, deps));
  }
  return recordAttempt(target, route, grades, command.work);
}
