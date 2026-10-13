// What the pages show, derived from the published records only. Every count here is a count of
// records in the results directory.
import type { Cell, Comparison, RuleOutcome } from "@rbw/admission";
import type { BucketCount, ObservedSymptom, RootRunKind } from "@rbw/schema";
import type { AdmissionRecords, Results, Run } from "./release.ts";

export const NO_VALIDATED_RESULT = "No validated blind-spot example yet";
export const VALIDATED_RESULT = "Validated blind-spot example";
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

/** How each root kind is named on the pages: judge replays are verification runs, never factory runs. */
export const RUN_KIND_TEXT: Record<RootRunKind, string> = { factory: "Factory run", kit_check: "Kit check", judge_replay: "Verification replay (judge)" };

/** The factory runs: the funnel counts only these, and kit checks and judge replays apart (otherRuns). */
export function factoryRuns(results: Results): Run[] {
  return results.runs.filter((run) => run.kind === "factory");
}

export function funnel(results: Results): FunnelStep[] {
  const runs = factoryRuns(results);
  const decided = runs.flatMap((run) => (run.admission === null ? [] : [run.admission.decision]));
  return [
    { label: "Factory runs recorded", count: runs.length },
    { label: "Factory runs finished", count: runs.filter((run) => run.status === "terminal").length },
    { label: "Factory runs published", count: runs.filter((run) => run.manifest !== null).length },
    { label: "Factory runs with an observed symptom", count: runs.filter((run) => run.symptom !== null).length },
    { label: "Factory runs with an admission decision", count: decided.length },
    { label: "Admission verdict pass", count: decided.filter((decision) => decision.outcome_verdict === "pass").length },
    { label: "Blind spot demonstrated (ADM-08)", count: decided.filter((decision) => decision.comparison?.classification === "blind_spot_demonstrated").length },
    { label: "Validated releases (ADM-09)", count: results.release === null ? 0 : 1 },
  ];
}

/** Published judge replays, which the case page lists apart from the diagnostic archive. */
export function verificationReplays(results: Results): Run[] {
  return results.runs.filter((run) => run.kind === "judge_replay" && run.manifest !== null);
}

/**
 * Why the replay lines count outcomes, not verdicts: a published judge_replay run's decision.json has
 * no outcome_verdict, and its verified or not-reproduced state is not in the public records.
 */
export const REPLAY_VERDICT_NOTE =
  "A replay's published records do not include its verdict (verified or not reproduced), so the replay lines count each replay's recorded outcome only: completed means the replay's run ended, not that it reproduced the release.";

/**
 * The runs counted apart from the factory funnel: every judge replay, with a line for each recorded
 * outcome that some replay has (and for replays not finished yet), then the kit checks when there are any.
 */
export function otherRuns(results: Results): FunnelStep[] {
  const replays = results.runs.filter((run) => run.kind === "judge_replay");
  const outcomes = (Object.keys(OUTCOME_WORDS) as (keyof typeof OUTCOME_WORDS)[]).map((outcome) => ({
    label: `Replays ${OUTCOME_WORDS[outcome].toLowerCase()}`,
    count: replays.filter((run) => run.outcome === outcome).length,
  }));
  const unfinished = { label: "Replays not finished", count: replays.filter((run) => run.outcome === null).length };
  const kitChecks = { label: "Kit checks", count: results.runs.filter((run) => run.kind === "kit_check").length };
  return [{ label: "Verification replays (judge)", count: replays.length }, ...[...outcomes, unfinished, kitChecks].filter((step) => step.count > 0)];
}

/** The replay control's states (design note section 6). Every state is written in text; color only repeats it. */
export type ReplayStateName = "disabled" | "ready" | "starting" | "running" | "verified" | "not_reproduced" | "incomplete" | "needs_reconciliation" | "unavailable" | "unknown";

export const REPLAY_STATE_TEXT: Record<ReplayStateName, string> = {
  disabled: "Disabled",
  ready: "Ready to start",
  starting: "Starting",
  running: "Running",
  verified: "Verified: the replay reproduced the released result",
  not_reproduced: "Not reproduced: the replay did not reproduce the released result",
  incomplete: "Incomplete: the replay ended without a result",
  needs_reconciliation: "Needs reconciliation: the replay's end is not confirmed, and the operator checks it",
  unavailable: "Unavailable",
  unknown: "No replay with this request",
};

/** What a terminal or uncertain state means for the judge, shown under the status line. */
export const REPLAY_STATE_HELP: Partial<Record<ReplayStateName, string>> = {
  not_reproduced: "The three fresh copies did not show the released result. After two such replays in a row, replays are held until the operator has inspected the case.",
  incomplete: "The replay stopped before it had a result for every copy, so it gives no verdict either way. You can start another replay.",
  needs_reconciliation: "The operator checks the spend ledger to confirm how this replay ended. Please try again later.",
  unknown: "The server has no replay for the request this browser remembers. You can start a new replay.",
};

/** Why the routes answer unavailable; each message is the page's explanation. */
export const REPLAY_UNAVAILABLE_TEXT = {
  busy: "Busy: another replay is running. Try again shortly.",
  budget: "Unavailable: the judge budget cannot cover a replay.",
  error: "Unavailable: the replay could not start. Try again shortly.",
  held: "Held for inspection: the last two replays did not reproduce the released result, so the operator checks the case before another replay starts.",
  release: "Unavailable: this site's release is not the configured release.",
  token: "Unavailable: the site could not get a fresh access token for a replay. Try again shortly.",
  ledger: "Unavailable: the spend ledger can't be reached right now. Try again shortly.",
  halted: "Paused: spending is halted for an operator check. Try again later.",
} as const;

export type UnavailableReason = keyof typeof REPLAY_UNAVAILABLE_TEXT;

export interface ReplayState {
  state: ReplayStateName;
  reason: string;
}

/** The replay control's state without a validated release (Results.release). */
export const REPLAY_STATE: ReplayState = { state: "disabled", reason: "There is no validated release to replay." };

/** With a release, the control is ready when the judge routes are configured for it, and disabled otherwise. */
export function replayState(results: Results, judgeEnabled = false): ReplayState {
  if (results.release === null) return REPLAY_STATE;
  return judgeEnabled ? { state: "ready", reason: "A replay runs three fresh copies of the released case, with a hard cap of 35 minutes." } : { state: "disabled", reason: "Verified replay is not enabled on this site." };
}

/** One of the replay's six cells, with its per-cell outcomes from the replay's evidence. */
export interface ReplayCell {
  suite: "original" | "added";
  trial_id: string;
  state: string;
  matches_expectation: boolean;
  executed_count: number;
  expected_count: number;
  failing: { id: string; repeat_index: number | null; failure_code: string | null }[];
}

/** What the status route returns: no resource IDs, operation IDs, keys or paths. */
export interface ReplayStatus {
  state: Exclude<ReplayStateName, "disabled" | "ready">;
  request_id: string;
  message: string;
  /** The Dec 2–5 condition explains the only unexpected cells. */
  known_condition: boolean;
  release_id: string;
  release_created_at: string;
  created_at: string | null;
  ended_at: string | null;
  /** Measured from the create; shown apart from the hard cap. */
  elapsed_seconds: number | null;
  hard_cap_seconds: number;
  copies: { trial_id: string; status: "not_started" | "running" | "done"; started_at: string | null }[];
  cells: ReplayCell[];
}

/** Published runs whose files remain downloadable as diagnostic archives: every one but the released run and the judge replays. */
export function diagnosticArchives(results: Results): Run[] {
  const released = results.release?.record.run.root_execution_id;
  return results.runs.filter((run) => run.manifest !== null && run.kind !== "judge_replay" && run.rootExecutionId !== released);
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

/** A link to a file of the published release. */
export function releaseHref(releaseId: string, path: string): string {
  return `/releases/${releaseId}/${path}`;
}

/** A link to a published file: the site's copy of a repository file, or the store's URI of a large one. */
export function fileHref(root: string, path: string, publicUri: string | null): string {
  return publicUri ?? `/runs/${root}/${path}`;
}
