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
// is never solved. A disagreement between the two grades is recorded for publication.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { structuredPatch } from "diff";
import { CodeStateRefusal, applyPatchChecked } from "@rbw/local-runner";
import { sha256Hex } from "@rbw/schema";

export const GRADED_TRIAL = "fixed-01";
export const ALTERNATIVE_RECORD = "alternative-fix.json";
export const ALTERNATIVE_PATCH = "alternative-fix.patch";
/** The controller options the grade sets itself; the caller's base options may not repeat them. */
export const RESERVED_OPTIONS = ["--job-kind", "--ledger", "--trials", "--backend", "--sandbox-image", "--name", "--work", "--fix", "--judge-fixed", "--prebuilt"] as const;

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
  /** The case's controller options: --image, --manifest, --terms, --kit-stage, --original-suite, and any the case needs. */
  base: readonly string[];
  /** Grade 2's kit image in VCR, pinned by digest. */
  sandboxImage: string;
  /**
   * For the clean-equal route: the case's committed alternative fix (`--fix`), which the controller
   * derives (and refuses if invalid) even when fixed-01 grades the reference fix. Absent, the local
   * runner's default, which only fits the time-zone case.
   */
  referenceFix?: string;
}

export function jobName(grade: GradeNumber): string {
  return grade === 1 ? "grade-1-docker" : "grade-2-sandbox";
}

/** The controller's `run` arguments for one grade: judge_verify, fixed-01 only, on the development ledger. */
export function gradeArgs(route: GradeRoute, grade: GradeNumber, command: GradeCommand): string[] {
  if (route.route === "not_graded") throw new Error("an attempt that is not graded has no grade command");
  const reserved = command.base.find((arg) => (RESERVED_OPTIONS as readonly string[]).includes(arg.split("=")[0] ?? ""));
  if (reserved !== undefined) throw new Error(`the base options may not set ${reserved}; the grade sets it`);
  const backend = grade === 1 ? ["--backend", "docker"] : ["--backend", "sandbox", "--sandbox-image", command.sandboxImage];
  const fix =
    route.route === "clean_equal"
      ? ["--judge-fixed", "fixed", ...(command.referenceFix === undefined ? [] : ["--fix", command.referenceFix])]
      : ["--judge-fixed", "alternative_fix", "--fix", route.fix_dir];
  return ["run", "--job-kind", "judge_verify", "--ledger", "development", "--trials", GRADED_TRIAL, "--name", jobName(grade), "--work", command.work, ...backend, ...fix, ...command.base];
}

export type GradeState = "passed" | "failed" | "missing" | "invalid";

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
export function readGrade(work: string, grade: GradeNumber, route: GradeRoute): GradeResult {
  const job = jobName(grade);
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
  if (field(summary, "status") !== "complete") return result("failed", `the grade job ended ${String(str(field(summary, "status")))} (${String(str(field(summary, "reason")))})`, summarySha, trial);
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
  /** Both grades ran and reached different states; published with the attempt. */
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
    disagreement: first !== undefined && second !== undefined && first.state !== second.state,
  };
}

export interface GradeDeps {
  /** Runs the controller with these `run` arguments; its exit code is not trusted, only its summary. */
  runController: (args: readonly string[]) => Promise<number>;
}

/** Grades one attempt: route, grade 1 on Docker, grade 2 on Sandbox, then `<work>/grade.json`. */
export async function gradeAttempt(attempt: Uint8Array, target: GradeTarget, command: GradeCommand, deps: GradeDeps): Promise<AttemptGrade> {
  const route = prepareGrade(attempt, target, join(command.work, "fix"));
  const grades: GradeResult[] = [];
  if (route.route !== "not_graded") {
    for (const grade of [1, 2] as const) {
      await deps.runController(gradeArgs(route, grade, command));
      grades.push(readGrade(command.work, grade, route));
    }
  }
  const decided = decide(target, route, grades);
  mkdirSync(command.work, { recursive: true });
  writeFileSync(join(command.work, "grade.json"), `${JSON.stringify(decided, null, 2)}\n`);
  return decided;
}
