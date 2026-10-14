// The run's summary, its report and the publisher's staging directory. Every number the report
// shows is in the summary or the analysis (the summary's each traced to an attempt record, and
// every spend figure to the ledger's settled operations under that record's executions; the
// analysis's to the rows), or is computed from their counts (the off-minus-on solve rate when the
// futility rule stopped the solve test, the observed off-arm rate, the tool-use share), or is one of
// the report's constants (the pre-registration's detectable-difference table and its arm size, the
// rerun limit, and the report's own low tool-use share of one half). The staging layout is the
// publisher's (inputs/, logs/, results/, report.md), with no local path in any staged file.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_NAMES, decimal } from "@rbw/solver";
import type { Arm, AttemptRow, BugAnalysis, ResultsRecord, Verdict } from "@rbw/solver";
import type { LedgerView } from "./allowance.ts";
import { MAX_INFRASTRUCTURE_RERUNS } from "./plan.ts";
import { attemptDirName, grade2Executions, isInfrastructure, ledgerSettled, settledTotals, writeJson } from "./records.ts";
import type { AttemptRecord, GradeTry, RunRecord, SeededRecord, StopRecord } from "./records.ts";

export interface RunSummary {
  schema_version: 1;
  kind: "uc1_run_summary";
  mode: RunRecord["mode"];
  label: string | null;
  case_id: string;
  model: string;
  model_id: string;
  runtime_profile_sha256: string;
  rate_sheet_sha256: string;
  root_execution_id: string;
  project_policy_sha256: string;
  plan: RunRecord["plan"];
  attempts: AttemptSummary[];
  seeded: { label: string; route: string; route_matches: boolean; grade1: string | null; grade2: string | null; grade2_settled_microusd: number }[];
  grade_disagreements: number[];
  spend: {
    cap_microusd: string;
    model_settled_microusd: number;
    grade2_settled_microusd: number;
    total_settled_microusd: number;
    /** Model spend per counted attempt: mean and largest, in micro-USD. */
    model_per_attempt_mean_microusd: number | null;
    model_per_attempt_max_microusd: number | null;
    /** This root's operations in the ledger when the summary was written: the source of every figure above. */
    ledger: { settled_microusd: string; open_microusd: string; uncertain: string[] };
    /** Every UC1 root under the runs directory (the roots the cap covers), from the ledger; null when not read. */
    uc1_roots: { roots: number; settled_microusd: string; open_microusd: string } | null;
  };
  /** Each arm's wall time and spend; its counts by tool, scope, contamination and infrastructure are the analysis's. */
  arms: Record<Arm, ArmTotals>;
  stops: StopRecord[];
  analysis: "results/analysis.json" | { error: string } | null;
}

export interface AttemptSummary {
  index: number;
  arm: string;
  seed: number;
  status: string;
  runs: number;
  attempt_key: string | null;
  outcome: string | null;
  infrastructure: string | null;
  cap: string | null;
  turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  tool_calls: Record<string, number> | null;
  contamination: number | null;
  wall_ms: number | null;
  session_wall_ms: number | null;
  model_settled_microusd: number | null;
  scope: string | null;
  route: string | null;
  grade1: string | null;
  grade2: string | null;
  grade2_settled_microusd: number;
  /**
   * Every run at this index that ended on an infrastructure error, with its cause (the final run's
   * too, when the index is one), and every run the process ended during that no pass has marked yet
   * (ended null), which the next pass marks as an infrastructure error and reruns under the same limit.
   */
  infrastructure_runs: { rerun: number; cause: string }[];
}

/** One arm's wall time and spend, which the analysis does not hold. */
export interface ArmTotals {
  /**
   * The solver's wall time over the arm's counted attempts, in milliseconds: from the session's open
   * to the attempt's end, the measure the wall cap limits. Null when no counted attempt has a result.
   */
  wall_ms: { attempts: number; total: number; median: number; max: number } | null;
  /** What the ledger settled for the arm's model calls: every run at its indexes, reruns included. */
  model_settled_microusd: number;
  /** What the ledger settled for the arm's grade 2 jobs: every try of every run at its indexes (not the seeded round trips'). */
  grade2_settled_microusd: number;
}

/** The cause of a run the process ended during, before a pass marks it an infrastructure error. */
const INTERRUPTED_CAUSE = "interrupted (not yet marked)";

function state(tries: readonly GradeTry[]): string | null {
  return tries.at(-1)?.result.state ?? null;
}

/**
 * The summary. Every spend figure is read from `ledger` (this root's view) by execution_id, never
 * from the records' in-memory results, so a run the process lost before its result was saved still
 * shows what it settled.
 */
export function buildSummary(run: RunRecord, records: readonly AttemptRecord[], seeded: readonly SeededRecord[], stops: readonly StopRecord[], ledger: LedgerView, analysis: RunSummary["analysis"], allRoots: { roots: number; view: LedgerView } | null = null): RunSummary {
  const byExecution = ledger.settled_by_execution;
  const sum = (tries: readonly GradeTry[]): number => ledgerSettled(byExecution, grade2Executions(tries));
  const attempts = run.plan.map((item): AttemptSummary => {
    const record = records.find((entry) => entry.index === item.index);
    const final = record?.runs.at(-1);
    const result = final?.result ?? null;
    return {
      index: item.index,
      arm: item.arm,
      seed: item.seed,
      status: record?.status ?? "pending",
      runs: record?.runs.length ?? 0,
      attempt_key: final?.attempt_key ?? null,
      outcome: final?.ended ?? null,
      infrastructure: final?.infrastructure ?? null,
      cap: result?.cap ?? null,
      turns: result?.turns ?? null,
      input_tokens: result?.input_tokens ?? null,
      output_tokens: result?.output_tokens ?? null,
      tool_calls: result === null ? null : { ...result.tool_calls },
      contamination: result === null ? null : result.contamination.length,
      wall_ms: result?.wall_ms ?? null,
      session_wall_ms: final?.session_wall_ms ?? null,
      model_settled_microusd: record === undefined ? null : ledgerSettled(byExecution, record.runs.map((entry) => entry.execution_id)),
      scope: final?.submission?.scope ?? null,
      route: final?.route?.route ?? null,
      grade1: final === undefined ? null : state(final.grade1),
      grade2: final === undefined ? null : state(final.grade2),
      grade2_settled_microusd: final === undefined ? 0 : sum(final.grade2),
      infrastructure_runs: (record?.runs ?? []).filter(isInfrastructure).map((entry) => ({ rerun: entry.rerun, cause: entry.ended === null ? INTERRUPTED_CAUSE : (entry.infrastructure ?? "infrastructure_error") })),
    };
  });
  const armTotals = (arm: Arm): ArmTotals => {
    const runs = records.filter((record) => record.arm === arm).flatMap((record) => record.runs);
    const walls = attempts
      .filter((item) => item.arm === arm && item.status === "counted")
      .flatMap((item) => (item.wall_ms === null ? [] : [item.wall_ms]))
      .sort((a, b) => a - b);
    const middle = Math.floor(walls.length / 2);
    const median = walls.length % 2 === 1 ? (walls[middle] ?? 0) : ((walls[middle - 1] ?? 0) + (walls[middle] ?? 0)) / 2;
    return {
      wall_ms: walls.length === 0 ? null : { attempts: walls.length, total: walls.reduce((a, b) => a + b, 0), median, max: walls.at(-1) ?? 0 },
      model_settled_microusd: ledgerSettled(byExecution, runs.map((run) => run.execution_id)),
      grade2_settled_microusd: ledgerSettled(byExecution, runs.flatMap((run) => grade2Executions(run.grade2))),
    };
  };
  const totals = settledTotals(records, seeded, byExecution);
  const counted = attempts.filter((item) => item.status === "counted" && item.model_settled_microusd !== null);
  const perAttempt = counted.map((item) => item.model_settled_microusd ?? 0);
  const terminal = new Set(["passed", "failed", "missing", "invalid"]);
  return {
    schema_version: 1,
    kind: "uc1_run_summary",
    mode: run.mode,
    label: run.label,
    case_id: run.case_id,
    model: run.model,
    model_id: run.model_id,
    runtime_profile_sha256: run.runtime_profile_sha256,
    rate_sheet_sha256: run.rate_sheet_sha256,
    root_execution_id: run.root_execution_id,
    project_policy_sha256: run.project_policy_sha256,
    plan: run.plan,
    attempts,
    seeded: seeded.map((item) => ({ label: item.label, route: item.route.route, route_matches: item.route_matches, grade1: state(item.grade1), grade2: state(item.grade2), grade2_settled_microusd: sum(item.grade2) })),
    grade_disagreements: attempts.filter((item) => item.grade1 !== null && item.grade2 !== null && terminal.has(item.grade1) && terminal.has(item.grade2) && item.grade1 !== item.grade2).map((item) => item.index),
    spend: {
      cap_microusd: run.cap_microusd,
      model_settled_microusd: totals.model,
      grade2_settled_microusd: totals.grade2,
      total_settled_microusd: totals.model + totals.grade2,
      model_per_attempt_mean_microusd: perAttempt.length === 0 ? null : Math.round(perAttempt.reduce((a, b) => a + b, 0) / perAttempt.length),
      model_per_attempt_max_microusd: perAttempt.length === 0 ? null : Math.max(...perAttempt),
      ledger: { settled_microusd: ledger.settled_microusd.toString(), open_microusd: ledger.open_microusd.toString(), uncertain: ledger.uncertain },
      uc1_roots: allRoots === null ? null : { roots: allRoots.roots, settled_microusd: allRoots.view.settled_microusd.toString(), open_microusd: allRoots.view.open_microusd.toString() },
    },
    arms: { off: armTotals("off"), on: armTotals("on") },
    stops: [...stops],
    analysis,
  };
}

function usd(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(4)}`;
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** The turns outcome, the third co-primary outcome, which the analyzer's statement leaves out. */
function turnsSentence(turns: ResultsRecord["bugs"][number]["turns"]): string {
  if (turns === null) return "Turns were not tested: an arm has no counted attempt.";
  const approximate = turns.interval_coverage_approximate ? " (approximate with ties)" : "";
  const detail = `Turns: shift on minus off ${turns.hodges_lehmann_on_minus_off}, interval ${turns.interval_on_minus_off[0]} to ${turns.interval_on_minus_off[1]} at level ${turns.interval_level}${approximate}, Mann-Whitney p ${turns.mann_whitney_p}, Holm-adjusted p ${turns.holm_p}`;
  if (!turns.holm_reject) return `${detail}; inconclusive at this sample size.`;
  return `${detail}; the on arm took ${Number(turns.hodges_lehmann_on_minus_off) > 0 ? "more" : "fewer"} turns.`;
}

/** Both arms need this many counted attempts for the pre-registered detectable-difference table to apply. */
export const TABLE_ARM_SIZE = 20;

/**
 * The pre-registration's generated solve table (docs/uc1-preregistration.md, "Detectable
 * difference"): the smallest detectable difference in percentage points at 80% power, k = 20 per
 * arm, at alpha 0.05 and 0.0167, indexed by the off arm's solved count (0 to 20, so the off-arm
 * rate is 5 times the index, already on the table's 5-point grid). `none` means no difference is
 * detectable in that direction. The tests check it against the document's table.
 */
export const DETECTABLE_DIFFERENCE: readonly { increase: readonly [string, string]; decrease: readonly [string, string] }[] = [
  { increase: ["34", "43"], decrease: ["none", "none"] },
  { increase: ["40", "48"], decrease: ["none", "none"] },
  { increase: ["43", "51"], decrease: ["none", "none"] },
  { increase: ["46", "53"], decrease: ["none", "none"] },
  { increase: ["48", "54"], decrease: ["none", "none"] },
  { increase: ["49", "54"], decrease: ["none", "none"] },
  { increase: ["48", "54"], decrease: ["none", "none"] },
  { increase: ["47", "53"], decrease: ["35", "none"] },
  { increase: ["46", "51"], decrease: ["38", "none"] },
  { increase: ["44", "49"], decrease: ["40", "44"] },
  { increase: ["42", "47"], decrease: ["42", "47"] },
  { increase: ["40", "44"], decrease: ["44", "49"] },
  { increase: ["38", "none"], decrease: ["46", "51"] },
  { increase: ["35", "none"], decrease: ["47", "53"] },
  { increase: ["none", "none"], decrease: ["48", "54"] },
  { increase: ["none", "none"], decrease: ["49", "54"] },
  { increase: ["none", "none"], decrease: ["48", "54"] },
  { increase: ["none", "none"], decrease: ["46", "53"] },
  { increase: ["none", "none"], decrease: ["43", "51"] },
  { increase: ["none", "none"], decrease: ["40", "48"] },
  { increase: ["none", "none"], decrease: ["34", "43"] },
];

function direction(name: "an increase" | "a decrease", [low, high]: readonly [string, string]): string | null {
  if (low === "none") return null;
  return `${name} of ${low} percentage points at alpha 0.05 and ${high} at alpha 0.0167`;
}

/**
 * The sentence after a counted run's headline: the detectable difference for the observed off-arm
 * rate when both arms have 20 counted attempts, or the note that it is omitted.
 */
export function detectableSentence(offSolved: number, offCounted: number, onCounted: number): string {
  const entry = DETECTABLE_DIFFERENCE[offSolved];
  if (offCounted !== TABLE_ARM_SIZE || onCounted !== TABLE_ARM_SIZE || entry === undefined) {
    return `The detectable difference is omitted: the pre-registered table assumes ${String(TABLE_ARM_SIZE)} counted attempts per arm.`;
  }
  const increase = direction("an increase", entry.increase);
  const decrease = direction("a decrease", entry.decrease);
  const detectable =
    increase !== null && decrease !== null ? `${increase}, or ${decrease}` : increase !== null ? `${increase}; no decrease is detectable` : decrease !== null ? `no increase is detectable; ${decrease}` : "no difference is detectable";
  return `Detectable difference (calculated, 80% power, ${String(TABLE_ARM_SIZE)} counted attempts per arm) at the observed off-arm rate of ${String(offSolved * 5)}% (${String(offSolved)}/${String(offCounted)}): ${detectable}.`;
}

type ArmResult = ResultsRecord["bugs"][number]["arms"]["off"];

/** One arm's solve count over its counted attempts, with its 95% Clopper–Pearson interval. */
function armSolves(name: string, arm: ArmResult): string {
  const interval = arm.clopper_pearson_95 === null ? "no counted attempts" : `${arm.clopper_pearson_95[0]} to ${arm.clopper_pearson_95[1]}`;
  return `${name} ${String(arm.solved)}/${String(arm.counted)} (${interval})`;
}

/**
 * Each arm's solve count over all its counted attempts with a 95% Clopper–Pearson interval, as the
 * pre-registration reports per arm; it is also the futility rule's all-attempt solve outcome.
 */
function solvesSentence(off: ArmResult, on: ArmResult): string {
  return `Solves over all counted attempts (grade 2), with 95% Clopper–Pearson intervals: ${armSolves("off", off)}; ${armSolves("on", on)}.`;
}

/** Below this share of on-arm attempts calling server_logs, the report flags a low share. The pre-registration sets no cutoff. */
export const LOW_TOOL_USE_SHARE = 0.5;

/**
 * The pre-registration's tool-use and contamination checks ("Checks"): the share of on-arm
 * attempts that called `server_logs`, with the call count and a warning when the share is low, and
 * each arm's contaminated attempts.
 */
function checksSentences(off: ArmResult, on: ArmResult): string[] {
  const calls = on.tool_calls.server_logs;
  const share = on.counted === 0 ? null : on.used_server_logs / on.counted;
  const toolUse =
    share === null
      ? "Tool use: the on arm has no counted attempts."
      : `Tool use: ${String(on.used_server_logs)} of ${String(on.counted)} counted on-arm attempts (${String(Math.round(share * 100))}%) called \`server_logs\` at least once, ${String(calls)} call${calls === 1 ? "" : "s"} in all.${
          share < LOW_TOOL_USE_SHARE ? " This is a low share (under half, the report's reading; the pre-registration sets no cutoff): an unused tool cannot help, so the result says little about the tool's effect." : ""
        }`;
  const contamination = `Contamination (attempts that started their own server process or read the app's or the database's process output other than through \`server_logs\`): off ${String(off.contaminated)}/${String(off.counted)}, on ${String(on.contaminated)}/${String(on.counted)}. A high off-arm rate weakens the claim.`;
  return [toolUse, contamination];
}

/**
 * What the pre-registration reports per arm without tests ("Outcomes"): the counts by tool, the
 * out_of_scope and prohibited-edit counts, the contaminated attempts and the infrastructure errors
 * and reruns, all from the analysis over each arm's rows; then wall time and spend, from the summary.
 */
function perArmLines(summary: RunSummary, bug: BugAnalysis | undefined): string[] {
  const rows: string[] = [];
  const row = (label: string, off: string, on: string): void => {
    rows.push(`| ${label} | ${off} | ${on} |`);
  };
  if (bug !== undefined) {
    const count = (label: string, pick: (arm: ArmResult) => number): void => {
      row(label, String(pick(bug.arms.off)), String(pick(bug.arms.on)));
    };
    count("Counted attempts", (arm) => arm.counted);
    count("Infrastructure errors (excluded from every outcome)", (arm) => arm.infrastructure_errors);
    count("Infrastructure reruns", (arm) => arm.reruns);
    count("Out of scope (unsolved, not graded)", (arm) => arm.out_of_scope);
    count("Prohibited edits (changed files besides the target)", (arm) => arm.prohibited_edits);
    count("Contaminated attempts", (arm) => arm.contaminated);
    count("Attempts that called `server_logs`", (arm) => arm.used_server_logs);
    for (const tool of TOOL_NAMES) count(`\`${tool}\` calls`, (arm) => arm.tool_calls[tool]);
  }
  const wall = ({ wall_ms: wall }: ArmTotals) => (wall === null ? "-" : `${minutes(wall.total)}; ${minutes(wall.median)}; ${minutes(wall.max)}`);
  const { off, on } = summary.arms;
  row("Wall time over counted attempts (total; median; largest)", wall(off), wall(on));
  row("Model spend, every run at the arm's indexes", usd(off.model_settled_microusd), usd(on.model_settled_microusd));
  row("Grade 2 spend, every try", usd(off.grade2_settled_microusd), usd(on.grade2_settled_microusd));
  const counts =
    bug === undefined
      ? ""
      : "Counts are over each arm's counted attempts (from the analysis), except the infrastructure errors and reruns, which cover only the indexes with a final status (counted, or excluded after their reruns): an index with a rerun due is not in them yet. ";
  const lines = [
    "## Per arm",
    "",
    `${counts}Wall time is the solver's, from the session's open to the attempt's end. Spend is what the ledger settled, reruns included. Grade 2 spend per arm leaves out the seeded round trips, so in a pilot the two arms do not add up to the grade 2 total under Spend.`,
    "",
    "| Measure | Off | On |",
    "|---|---|---|",
    ...rows,
    "",
  ];
  if (bug === undefined) lines.push("The counts by tool, scope, contamination and infrastructure are not shown: the analysis was not computed.", "");
  return lines;
}

/**
 * Every run that ended on an infrastructure error (or that the process ended during, not yet
 * marked), with its cause, apart from the failures ("Reruns and infrastructure errors").
 */
function infrastructureLines(summary: RunSummary): string[] {
  const items = summary.attempts.flatMap((item) =>
    item.infrastructure_runs.map((run) => {
      const then = run.rerun < item.runs - 1 ? "rerun at the same index" : item.status === "infrastructure_error" ? "excluded from every outcome after its reruns" : "a rerun is due";
      const cause = run.cause.replace(/\s+/g, " ").trim().replace(/\.+$/, "");
      return `- Index ${String(item.index)} (${item.arm}), run r${String(run.rerun)}: ${cause}; ${then}.`;
    }),
  );
  if (items.length === 0) return [];
  return [
    "## Infrastructure errors and reruns",
    "",
    `Each run that ended on an infrastructure error, with its cause. These are not failures: such a run is rerun from scratch at the same index, up to ${String(MAX_INFRASTRUCTURE_RERUNS)} times, and an index whose reruns all fail is excluded from every outcome.`,
    "",
    ...items,
    "",
  ];
}

/** The pre-registration's only reading of a non-detection. */
const INCONCLUSIVE = "whether the tool made this bug worse is inconclusive at this sample size";

const VERDICT_CLAUSES: Record<"solves" | "tokens", Record<Verdict, string>> = {
  solves: {
    worse: "the tool made this bug worse: the on arm solved fewer attempts",
    not_worse: "the tool did not make this bug worse: the on arm solved more attempts",
    inconclusive: INCONCLUSIVE,
    not_tested: "the solve test did not run, so this report does not say whether the tool made this bug worse on solves",
  },
  tokens: {
    worse: "the tool made this bug worse: the on arm used more tokens",
    not_worse: "the tool did not make this bug worse: the on arm used fewer tokens",
    inconclusive: INCONCLUSIVE,
    not_tested: "the token test did not run, so this report does not say whether the tool made this bug worse on tokens",
  },
};

/**
 * The solve verdict's clause. A solve test the futility rule stopped is fixed at p = 1, a
 * non-detection, so it reads as inconclusive at this sample size, with the extreme that stopped it.
 */
function solveClause(bug: BugAnalysis): string {
  if (bug.futility.triggered) return `${INCONCLUSIVE} (the futility rule stopped the solve test at the ${bug.futility.extreme})`;
  return VERDICT_CLAUSES.solves[bug.made_worse.solve];
}

/** The token ratio, on over off from the Hodges–Lehmann shift on log tokens, with its interval. */
function tokenRatio(tokens: BugAnalysis["tokens"]): string {
  if (tokens === null) return "token ratio not tested";
  const approximate = tokens.interval_coverage_approximate ? " (approximate with ties)" : "";
  return `token ratio (on over off, Hodges–Lehmann) ${tokens.ratio_on_over_off}, interval ${tokens.ratio_interval_on_over_off[0]} to ${tokens.ratio_interval_on_over_off[1]} at level ${tokens.interval_level}${approximate}`;
}

/**
 * The pre-registration's "made worse" statement ("Claim wording"), complete on its own: the
 * off-minus-on solve rate and the token ratio with its interval, then plainly whether the tool made
 * this bug worse on each outcome, from the analysis's verdicts. When the futility rule stopped the
 * solve test the analysis holds no solve result, so the rate is computed from its counts.
 */
function madeWorseSentence(bug: BugAnalysis): string {
  const { off, on } = bug.arms;
  if (off.counted === 0 || on.counted === 0) return "Made worse: not tested, since an arm has no counted attempt.";
  const rate = bug.solve?.off_minus_on_rate ?? decimal(off.solved / off.counted - on.solved / on.counted);
  return `Made worse: off-minus-on solve rate ${rate}; ${tokenRatio(bug.tokens)}. On solves, ${solveClause(bug)}. On tokens, ${VERDICT_CLAUSES.tokens[bug.made_worse.tokens]}.`;
}

/** The run's report: the label, the plan, every attempt, both grades, spend and the analysis statements. */
export function reportMarkdown(summary: RunSummary, analysis: ResultsRecord | null): string {
  const lines: string[] = [];
  lines.push(`# UC1 ${summary.mode === "pilot" ? "harness pilot" : "paired comparison"}: ${summary.case_id}`, "");
  if (summary.label !== null) lines.push(`**${summary.label}**`, "");
  lines.push(
    `Root execution \`${summary.root_execution_id}\`, model \`${summary.model_id}\` (runtime profile \`${summary.runtime_profile_sha256}\`, rate sheet \`${summary.rate_sheet_sha256}\`). Attempt indexes follow ABBA blocks fixed in advance; each index's seed is the index. The arms differ only in the \`server_logs\` tool.`,
    "",
  );
  lines.push("## Attempts", "");
  lines.push("| Index | Arm | Seed | Status | Runs | Outcome | Cap | Turns | Tokens (in + out) | server_logs calls | Scope | Grade 1 | Grade 2 | Model spend |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const item of summary.attempts) {
    const tokens = item.input_tokens === null || item.output_tokens === null ? "-" : `${String(item.input_tokens)} + ${String(item.output_tokens)}`;
    lines.push(
      `| ${String(item.index)} | ${item.arm} | ${String(item.seed)} | ${item.status} | ${String(item.runs)} | ${item.outcome ?? "-"} | ${item.cap ?? "-"} | ${item.turns === null ? "-" : String(item.turns)} | ${tokens} | ${item.tool_calls === null ? "-" : String(item.tool_calls.server_logs ?? 0)} | ${item.scope ?? "-"} | ${item.grade1 ?? "-"} | ${item.grade2 ?? "-"} | ${item.model_settled_microusd === null ? "-" : usd(item.model_settled_microusd)} |`,
    );
  }
  lines.push("");
  lines.push(...perArmLines(summary, analysis?.bugs.find((bug) => bug.bug_id === summary.case_id)));
  lines.push(...infrastructureLines(summary));
  if (summary.seeded.length > 0) {
    lines.push("## Seeded grade round trips (no model)", "");
    lines.push("| Round trip | Route | Expected route taken | Grade 1 | Grade 2 |", "|---|---|---|---|---|");
    for (const item of summary.seeded) lines.push(`| ${item.label} | ${item.route} | ${item.route_matches ? "yes" : "no"} | ${item.grade1 ?? "-"} | ${item.grade2 ?? "-"} |`);
    lines.push("");
  }
  lines.push("## Grades", "");
  lines.push("Grade 1 is a local Docker judge_verify run on a fresh copy; grade 2 is the protected fresh-copy regrade on Vercel Sandbox and is authoritative. Both are charged to the development pool and slot.", "");
  lines.push(summary.grade_disagreements.length === 0 ? "No attempt's grades disagree." : `Grades disagree on attempt indexes ${summary.grade_disagreements.join(", ")}.`, "");
  lines.push("## Spend", "");
  lines.push(`- This run's model calls settled: ${usd(summary.spend.model_settled_microusd)}; grade 2 jobs settled: ${usd(summary.spend.grade2_settled_microusd)}; total ${usd(summary.spend.total_settled_microusd)}.`);
  const all = summary.spend.uc1_roots;
  lines.push(
    all === null
      ? `- The UC1 cap of ${usd(Number(summary.spend.cap_microusd))} covers every UC1 root; the spend across all roots was not read.`
      : `- Every UC1 root under the runs directory (${String(all.roots)}, this one included): settled ${usd(Number(all.settled_microusd))}, open ${usd(Number(all.open_microusd))}, against the UC1 cap of ${usd(Number(summary.spend.cap_microusd))}.`,
  );
  if (summary.spend.model_per_attempt_mean_microusd !== null) lines.push(`- Model spend per counted attempt: mean ${usd(summary.spend.model_per_attempt_mean_microusd)}, largest ${usd(summary.spend.model_per_attempt_max_microusd ?? 0)}.`);
  lines.push(`- Ledger under this root: settled ${usd(Number(summary.spend.ledger.settled_microusd))}, open ${usd(Number(summary.spend.ledger.open_microusd))}, uncertain operations ${String(summary.spend.ledger.uncertain.length)}.`);
  lines.push("");
  if (summary.stops.length > 0) {
    lines.push("## Stops", "");
    for (const stop of summary.stops) lines.push(`- ${stop.at}: ${stop.reason}: ${stop.detail}`);
    lines.push("");
  }
  lines.push("## Analysis", "");
  if (analysis === null) {
    lines.push(typeof summary.analysis === "object" && summary.analysis !== null ? `Not computed: ${summary.analysis.error}` : "Not computed.", "");
  } else {
    for (const bug of analysis.bugs) {
      const off = bug.arms.off;
      const on = bug.arms.on;
      if (summary.mode === "pilot") lines.push(`Harness pilot, k = ${String(off.counted)} off and ${String(on.counted)} on; not a UC1 result.`, "");
      else lines.push(`Illustration on 1 bug, k = ${String(off.counted)} off and ${String(on.counted)} on.`, "", detectableSentence(off.solved, off.counted, on.counted), "");
      lines.push(bug.made_worse.statement, "");
      if (summary.mode !== "pilot") {
        lines.push(madeWorseSentence(bug), "");
        lines.push(solvesSentence(off, on), "");
        for (const sentence of checksSentences(off, on)) lines.push(sentence, "");
      }
      lines.push(turnsSentence(bug.turns), "");
    }
    lines.push(analysis.claim_scope, "");
  }
  if (summary.mode === "pilot") lines.push("The pilot is excluded from every UC1 result. It checks the harness, the tool calling and the cost per attempt.", "");
  return `${lines.join("\n")}\n`;
}

/** Replaces every occurrence of the run directory in a record with a relative marker, recursively. */
export function withoutLocalPaths(value: unknown, runDir: string): unknown {
  if (typeof value === "string") return value.split(runDir).join(".");
  if (Array.isArray(value)) return value.map((item) => withoutLocalPaths(item, runDir));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutLocalPaths(item, runDir)]));
  return value;
}

/**
 * The publisher's staging directory: report.md, results/ (the rows, the analysis, the summary,
 * each attempt record and each seeded round trip), logs/ (each run's transcript) and inputs/
 * (the screen record).
 */
export function writeStaging(runDir: string, input: { run: RunRecord; records: readonly AttemptRecord[]; seeded: readonly SeededRecord[]; rows: readonly AttemptRow[]; analysisJson: string | null; summary: RunSummary; report: string; screenRecord: string }): string {
  const staging = join(runDir, "staging");
  for (const dir of ["inputs", "logs", "results"]) mkdirSync(join(staging, dir), { recursive: true });
  writeFileSync(join(staging, "report.md"), input.report.split(runDir).join("."));
  writeJson(join(staging, "results", "rows.json"), input.rows);
  writeJson(join(staging, "results", "summary.json"), withoutLocalPaths(input.summary, runDir));
  if (input.analysisJson !== null) writeFileSync(join(staging, "results", "analysis.json"), input.analysisJson);
  for (const record of input.records) {
    writeJson(join(staging, "results", `attempt-${attemptDirName(record)}.json`), withoutLocalPaths(record, runDir));
    for (const run of record.runs) {
      const transcript = join(runDir, "attempts", attemptDirName(record), `r${String(run.rerun)}`, "transcript.jsonl");
      if (existsSync(transcript)) copyFileSync(transcript, join(staging, "logs", `transcript-${run.attempt_key}.jsonl`));
    }
  }
  for (const item of input.seeded) writeJson(join(staging, "results", `seeded-${item.label}.json`), withoutLocalPaths(item, runDir));
  writeFileSync(join(staging, "inputs", "screen-record.json"), readFileSync(input.screenRecord));
  return staging;
}
