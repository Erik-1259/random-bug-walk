// What the pages show, derived from the published records only. Every count here is a count of
// records in the results directory.
import type { Cell, Comparison, RuleOutcome } from "@rbw/admission";
import type { BucketCount, ObservedSymptom } from "@rbw/schema";
import type { AdmissionRecords, Results, Run } from "./release.ts";

export const NO_VALIDATED_RESULT = "No validated blind-spot example yet";
export const NOT_IN_RECORDS = "Not in this run's published records";

export type MatrixRow = "original" | "added";
export type MatrixColumn = "clean" | "planted" | "fixed";
export type MatrixStatus = Cell["state"] | "no_record";

export const MATRIX_ROWS: readonly MatrixRow[] = ["original", "added"];
export const MATRIX_COLUMNS: readonly MatrixColumn[] = ["clean", "planted", "fixed"];
export const ROW_LABEL: Record<MatrixRow, string> = { original: "Original API suite", added: "Added checks" };
export const COLUMN_LABEL: Record<MatrixColumn, string> = { clean: "clean copy", planted: "planted copy", fixed: "fixed copy" };

const STATUS_TEXT: Record<MatrixStatus, string> = {
  pass: "Pass",
  fail: "Fail",
  not_run: "Not run",
  invalid: "Invalid",
  incomplete: "Incomplete",
  no_record: "No record in this run",
};

export interface MatrixCell {
  row: MatrixRow;
  column: MatrixColumn;
  status: MatrixStatus;
  /** The status in words, with whether it matches the expectation when there is a record. */
  statusText: string;
  /** Executed and failing counts, or null without a record. */
  detail: string | null;
}

/** The cell's first trial per code state: the six cells come from clean-01, planted-01 and fixed-01 (ADM-08). */
const COLUMN_TRIAL: Record<MatrixColumn, string> = { clean: "clean-01", planted: "planted-01", fixed: "fixed-01" };

function cellDetail(cell: Cell): string {
  const executed = `${String(cell.executed_count)} of ${String(cell.expected_count)} executed`;
  if (cell.failing.length === 0) return executed;
  const ids = [...new Set(cell.failing.map((item) => item.id))].sort();
  return `${executed}; ${String(cell.failing.length)} failing ${cell.failing.length === 1 ? "result" : "results"}: ${ids.join(", ")}`;
}

/** The six cells, original-suite row first, then the added checks; columns clean, planted, fixed. */
export function suiteMatrix(admission: AdmissionRecords | null): MatrixCell[] {
  const cells = admission?.evidence.cells ?? null;
  return MATRIX_ROWS.flatMap((row) =>
    MATRIX_COLUMNS.map((column): MatrixCell => {
      const cell = cells?.find((item) => item.suite === row && item.trial_id === COLUMN_TRIAL[column]);
      if (cell === undefined) return { row, column, status: "no_record", statusText: STATUS_TEXT.no_record, detail: null };
      const expectation = cell.matches_expectation ? "as expected" : "not as expected";
      return { row, column, status: cell.state, statusText: `${STATUS_TEXT[cell.state]}, ${expectation}`, detail: cellDetail(cell) };
    }),
  );
}

/** The number of original tests the clean copy was expected to run, when the run published it. */
export function originalSuiteSize(admission: AdmissionRecords | null): number | null {
  const cell = admission?.evidence.cells?.find((item) => item.suite === "original" && item.trial_id === COLUMN_TRIAL.clean);
  return cell === undefined ? null : cell.expected_count;
}

export const COMPARISON_TEXT: Record<Comparison, string> = {
  invalid: "invalid",
  incomplete: "incomplete",
  not_demonstrated: "not demonstrated",
  caught_by_original_suite: "caught by the original suite",
  blind_spot_demonstrated: "blind spot demonstrated",
};

export const VERDICT_TEXT: Record<RuleOutcome, string> = { pass: "pass", reject: "reject", invalid: "invalid", incomplete: "incomplete" };

export interface CountRow {
  label: string;
  expected: number | null;
  observed: number | null;
  matches: boolean;
}

export interface CountExample {
  timezone: string;
  rows: CountRow[];
  differs: boolean;
}

function countRows(expected: BucketCount[], observed: BucketCount[]): CountRow[] {
  const labels = [...expected.map((item) => item.bucket_label)];
  for (const item of observed) if (!labels.includes(item.bucket_label)) labels.push(item.bucket_label);
  return labels.map((label) => {
    const want = expected.find((item) => item.bucket_label === label)?.count ?? null;
    const got = observed.find((item) => item.bucket_label === label)?.count ?? null;
    return { label, expected: want, observed: got, matches: want === got };
  });
}

/** The primary example, then each follow-up example, as expected-versus-observed rows. */
export function countExamples(symptom: ObservedSymptom): CountExample[] {
  return [{ timezone: symptom.timezone, expected: symptom.expected, observed: symptom.observed }, ...symptom.follow_up_examples].map((example) => {
    const rows = countRows(example.expected, example.observed);
    return { timezone: example.timezone, rows, differs: rows.some((row) => !row.matches) };
  });
}

export interface FunnelStep {
  label: string;
  count: number;
}

export function funnel(results: Results): FunnelStep[] {
  const decided = results.runs.flatMap((run) => (run.admission === null ? [] : [run.admission.decision]));
  return [
    { label: "Runs recorded", count: results.runs.length },
    { label: "Runs finished", count: results.runs.filter((run) => run.status === "terminal").length },
    { label: "Runs published", count: results.runs.filter((run) => run.manifest !== null).length },
    { label: "Runs with an observed symptom", count: results.runs.filter((run) => run.symptom !== null).length },
    { label: "Runs with an admission decision", count: decided.length },
    { label: "Admission verdict pass", count: decided.filter((decision) => decision.outcome_verdict === "pass").length },
    { label: "Blind spot demonstrated (ADM-08)", count: decided.filter((decision) => decision.comparison?.classification === "blind_spot_demonstrated").length },
    // Releases (ADM-09) have no record format yet, so no record can count here (Results.release).
    { label: "Validated releases (ADM-09, planned)", count: 0 },
  ];
}

export type ReplayStateName = "disabled" | "ready" | "starting" | "running" | "passed" | "failed";

/** Every state the replay control can show. Only "disabled" is reachable until the judge action exists. */
export const REPLAY_STATE_TEXT: Record<ReplayStateName, string> = {
  disabled: "Disabled",
  ready: "Ready to start",
  starting: "Starting",
  running: "Running",
  passed: "Finished: the replay reproduced the published result",
  failed: "Finished: the replay did not reproduce the published result",
};

export interface ReplayState {
  state: ReplayStateName;
  reason: string;
}

/** The replay control's state: disabled while there is no validated release (Results.release). */
export const REPLAY_STATE: ReplayState = { state: "disabled", reason: "There is no validated release to replay." };

/** Published runs whose files remain downloadable as diagnostic archives. */
export function diagnosticArchives(results: Results): Run[] {
  return results.runs.filter((run) => run.manifest !== null);
}

const PUBLICATION_TEXT = { prepared: "Prepared", published: "Published", blocked: "Blocked", failed: "Publication failed" } as const;
const STATUS_WORDS = { prepared: "Prepared", running: "Running", terminal: "Terminal", needs_reconciliation: "Needs reconciliation" } as const;
const OUTCOME_WORDS = { completed: "Completed", failed: "Failed", incomplete: "Incomplete", cancelled: "Cancelled" } as const;

export function runStatusText(run: Run): { status: string; outcome: string; publication: string } {
  return {
    status: STATUS_WORDS[run.status],
    outcome: run.outcome === null ? "None yet" : OUTCOME_WORDS[run.outcome],
    publication: run.publicationStatus === null ? "Not published" : PUBLICATION_TEXT[run.publicationStatus],
  };
}

export const ENTRY_OUTCOME_TEXT = { published: "Published", truncated: "Truncated", not_produced: "Not produced", withheld_private: "Withheld (private)" } as const;

/** A link to a published file: the site's copy of a repository file, or the store's URI of a large one. */
export function fileHref(root: string, path: string, publicUri: string | null): string {
  return publicUri ?? `/runs/${root}/${path}`;
}
