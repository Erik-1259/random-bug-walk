// Collecting one copy: the copy script writes its exit statuses and the driver's record set
// (`out/`) under the results directory, which the runner brings back. The record set holds the
// frozen job and this copy's one trial; it is imported with @rbw/admission, whose other two
// trials then show as result_missing, and only this copy's own trial is read.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ImportRefusal, importRecordSet } from "@rbw/admission";
import type { Cell, Evidence, ObservationEvidence, TrialEvidence } from "@rbw/admission";
import { sha256Hex } from "@rbw/schema";
import type { CellObservation, CollectedCopy, CopyPlan, CopyRecord, CopyRecordStatus, CopyRunOutcome, CopyState, ObservedOutcome, SuiteObservation } from "@rbw/factory-contract";
import { TIME_ZONE_FAILURE_CODE } from "./catalog.ts";
import { UmamiRefusal } from "./errors.ts";
import type { UmamiPins } from "./pins.ts";
import { TRIAL_OF_STATE, UMAMI_PROTOCOL } from "./protocol.ts";

export interface CopyResultsInput {
  state: CopyState;
  outcome: CopyRunOutcome;
  /** The copy's collected results directory (the copy script's output directory), or null. */
  resultsDir: string | null;
}

/** What a CopyRecord needs from the copy's own results; collect adds the run's identity and times. */
export interface CopyObservation {
  status: CopyRecordStatus;
  original_suite: SuiteObservation;
  verification: CellObservation;
}

/** The record set's directory under the copy script's output directory. */
export const RECORDS_DIR = "out";

/** The copy wrote what it liked, so a path that is missing, not reachable or not of the wanted kind counts as absent. */
const ABSENT = new Set(["ENOENT", "ENOTDIR", "EISDIR", "ELOOP"]);

function kindOf(path: string): "file" | "directory" | null {
  try {
    // lstat: a symbolic link in the collected results is never followed out of them.
    const stat = lstatSync(path);
    return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string" && ABSENT.has(error.code)) return null;
    throw error;
  }
}

/** A regular file's bytes, or null when the copy left no regular file there. */
function readRegular(path: string): Buffer | null {
  return kindOf(path) === "file" ? readFileSync(path) : null;
}

function readExit(dir: string, name: string): number | null {
  const text = readRegular(join(dir, name))?.toString("utf8").trim() ?? "";
  return /^\d{1,3}$/.test(text) ? Number(text) : null;
}

function emptySuite(pins: UmamiPins, observed: ObservedOutcome, runsTotal: number, detail: string): SuiteObservation {
  return {
    observed,
    runs_valid: 0,
    runs_total: runsTotal,
    failure_codes: [],
    detail,
    executed: 0,
    expected: pins.original_suite.test_count,
    failing_test_ids: [],
    suite_sha256: pins.original_suite.sha256,
  };
}

/**
 * A copy whose record set cannot be read: both cells error (invalid) or incomplete. `started`
 * says whether the copy's run began; one that never started counts no run.
 */
function unread(pins: UmamiPins, state: CopyState, status: "invalid" | "incomplete", detail: string, started = true): CopyObservation {
  const observed: ObservedOutcome = status === "invalid" ? "error" : "incomplete";
  return {
    status,
    original_suite: emptySuite(pins, observed, started ? 1 : 0, detail),
    verification: { observed, runs_valid: 0, runs_total: started ? UMAMI_PROTOCOL.per_state[state].rounds_per_copy : 0, failure_codes: [], detail },
  };
}

const OBSERVED_OF_CELL: Readonly<Record<Cell["state"], ObservedOutcome>> = { pass: "pass", fail: "fail", invalid: "error", incomplete: "incomplete", not_run: "incomplete" };

const valid = (observed: ObservedOutcome): boolean => observed === "pass" || observed === "fail";

function trialDetail(trial: TrialEvidence): string {
  return `${trial.trial_id} ${trial.status}${trial.reason === null ? "" : ` (${trial.reason})`}${trial.code === null ? "" : ` at ${trial.stage}: ${trial.code}`}`;
}

function observationLine(item: ObservationEvidence): string {
  return `${item.check_id}#${String(item.repeat_index)} ${item.observed}${item.failure_code === null ? "" : ` ${item.failure_code}`} (${item.classification})`;
}

/**
 * The criterion's code is reported on the buggy copy only when every declared check (expected to
 * fail) failed with that code and every control (expected to pass, the UTC check) passed. Any other
 * outcome reports no code, so it never counts as a detection.
 */
export function demonstratedCodes(state: CopyState, trial: TrialEvidence): string[] {
  if (state !== "buggy" || trial.status !== "complete" || trial.added === null) return [];
  const declared = trial.added.observations.filter((item) => item.expected === "assertion_fail");
  const controls = trial.added.observations.filter((item) => item.expected === "pass");
  const detected =
    declared.length > 0 &&
    controls.length > 0 &&
    declared.every((item) => item.expected_failure_code === TIME_ZONE_FAILURE_CODE && item.observed === "assertion_fail" && item.failure_code === TIME_ZONE_FAILURE_CODE) &&
    controls.every((item) => item.observed === "pass");
  return detected ? [TIME_ZONE_FAILURE_CODE] : [];
}

/**
 * Why a complete buggy copy is still invalid (an unrelated failure), or null: a control (the UTC
 * check) failed, or a check failed for another reason than the criterion's code (another assertion
 * code, or a setup failure). The importer reports a rejection, such as a declared check that
 * passed, before an invalid observation, so its trial can be complete; the copy is invalid anyway
 * and never a fail or a detection.
 */
export function unrelatedFailure(state: CopyState, trial: TrialEvidence): string | null {
  if (state !== "buggy" || trial.status !== "complete" || trial.added === null) return null;
  const { observations } = trial.added;
  const control = observations.find((item) => item.expected === "pass" && item.observed === "assertion_fail");
  if (control !== undefined) return `unrelated_failure: the control ${control.check_id} failed with ${control.failure_code ?? "no failure code"}`;
  const other = observations.find((item) => item.classification === "invalid");
  if (other === undefined) return null;
  return `unrelated_failure: ${other.check_id} ${other.observed === "assertion_fail" ? "failed with" : `ended ${other.observed}:`} ${other.failure_code ?? "no failure code"}`;
}

function fromEvidence(pins: UmamiPins, state: CopyState, trial: TrialEvidence, original: Cell, added: Cell): CopyObservation {
  const unrelated = unrelatedFailure(state, trial);
  const detail = trialDetail(trial);
  const suiteObserved = OBSERVED_OF_CELL[original.state];
  const checksObserved = unrelated === null ? OBSERVED_OF_CELL[added.state] : "error";
  const rounds = UMAMI_PROTOCOL.per_state[state].rounds_per_copy;
  return {
    status: unrelated === null ? trial.status : "invalid",
    original_suite: {
      observed: suiteObserved,
      runs_valid: valid(suiteObserved) ? 1 : 0,
      runs_total: 1,
      failure_codes: [],
      detail: `${detail}; original suite ${String(original.executed_count)}/${String(original.expected_count)} executed, ${String(original.failing.length)} failing`,
      executed: original.executed_count,
      expected: original.expected_count,
      failing_test_ids: original.failing.map((item) => item.id),
      suite_sha256: original.suite_sha256 ?? pins.original_suite.sha256,
    },
    verification: {
      observed: checksObserved,
      runs_valid: valid(checksObserved) ? rounds : 0,
      runs_total: rounds,
      failure_codes: unrelated === null ? demonstratedCodes(state, trial) : [],
      detail: `${detail}${unrelated === null ? "" : `; ${unrelated}`}; checks: ${(trial.added?.observations ?? []).map(observationLine).join(", ") || "none read"}`,
    },
  };
}

/** The imported evidence, or the importer's request-level refusal code. */
function importOrRefusal(recordsDir: string): Evidence | string {
  try {
    return importRecordSet(recordsDir);
  } catch (error) {
    if (error instanceof ImportRefusal) return error.code;
    throw error;
  }
}

/** Reads one copy's results into its cells (rules umami.frozen-job, admission-import, own-trial-only, original-suite-identity, declared-failure-code). */
export function readCopyResults(pins: UmamiPins, input: CopyResultsInput): CopyObservation {
  const { state, outcome, resultsDir } = input;
  // A copy that could not be set up is invalid and one that reached its time limit is incomplete,
  // whatever it left behind: neither is ever a pass, a fail or a detection.
  if (outcome === "setup_failed") return unread(pins, state, "invalid", "the copy could not be prepared or started", false);
  if (outcome === "timed_out") return unread(pins, state, "incomplete", "the copy reached its time limit");
  const freezeExit = resultsDir === null ? null : readExit(resultsDir, "freeze.exit");
  const driverExit = resultsDir === null ? null : readExit(resultsDir, "run.exit");
  // The driver's records count only when it finished: exit 0, or 3 for its own internal error.
  if (resultsDir === null || (driverExit !== 0 && driverExit !== 3)) {
    if (resultsDir === null) return unread(pins, state, "invalid", "nothing was collected from the copy");
    if (freezeExit !== 0) return unread(pins, state, "invalid", "the in-copy freeze of the original suite failed");
    if (driverExit === 2) return unread(pins, state, "invalid", "the driver refused the job for this image");
    return unread(pins, state, "invalid", driverExit === null ? "the driver did not finish" : `the driver exited ${String(driverExit)}`);
  }
  const recordsDir = join(resultsDir, RECORDS_DIR);
  if (kindOf(recordsDir) !== "directory") return unread(pins, state, "invalid", "the copy left no record set directory");
  const request = readRegular(join(recordsDir, "request.json"));
  if (request === null || sha256Hex(request) !== pins.job.request_sha256) return unread(pins, state, "invalid", "the record set does not carry the frozen job");
  const evidence = importOrRefusal(recordsDir);
  if (typeof evidence === "string") return unread(pins, state, "invalid", `the importer refused the record set (${evidence})`);
  const trialId = TRIAL_OF_STATE[state];
  const trial = evidence.trials.find((item) => item.trial_id === trialId);
  const original = evidence.cells?.find((cell) => cell.trial_id === trialId && cell.suite === "original");
  const added = evidence.cells?.find((cell) => cell.trial_id === trialId && cell.suite === "added");
  if (trial === undefined || original === undefined || added === undefined) return unread(pins, state, "invalid", `the record set has no ${trialId} trial`);
  const others = evidence.trials.filter((item) => item.trial_id !== trialId && item.code !== "import:result_missing");
  if (others.length > 0 || evidence.unexpected_results.length > 0) return unread(pins, state, "invalid", "the record set holds results of another copy");
  return fromEvidence(pins, state, trial, original, added);
}

/**
 * HostAdapter.collect: one copy's CopyRecord from what the runner brought back. Only the plan's
 * results directory is read. A copy that ran another image is invalid; one that brought back no
 * results has no evidence hash and is never complete. Throws `copy_mismatch` when the collected
 * copy is not the plan's.
 */
export function collectCopy(pins: UmamiPins, plan: CopyPlan, collected: CollectedCopy): CopyRecord {
  if (plan.host_id !== "umami" || collected.copy_id !== plan.copy_id) throw new UmamiRefusal("copy_mismatch", `the collected copy ${collected.copy_id} is not the plan's ${plan.copy_id}`);
  const resultsDir = collected.results_sha256 === null ? null : collected.results_dir;
  const read =
    collected.outcome === "ran" && plan.image.digest !== null && collected.image_digest !== plan.image.digest
      ? unread(pins, plan.state, "invalid", "the copy ran another image than the plan's")
      : readCopyResults(pins, { state: plan.state, outcome: collected.outcome, resultsDir });
  return {
    copy_id: plan.copy_id,
    state: plan.state,
    status: read.status,
    original_suite: read.original_suite,
    verification: read.verification,
    image_digest: collected.image_digest,
    architecture: collected.architecture,
    started_at: collected.started_at,
    finished_at: collected.finished_at,
    evidence_sha256: collected.results_sha256,
  };
}
