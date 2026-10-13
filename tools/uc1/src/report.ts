// The run's summary, its report and the publisher's staging directory. The summary holds every
// number the report shows, each traced to an attempt record; the staging layout is the
// publisher's (inputs/, logs/, results/, report.md), with no local path in any staged file.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptRow, ResultsRecord } from "@rbw/solver";
import type { LedgerView } from "./allowance.ts";
import { attemptDirName, settledTotals, writeJson } from "./records.ts";
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
    /** This root's operations in the ledger when the summary was written; null when not read. */
    ledger: { settled_microusd: string; open_microusd: string; uncertain: string[] } | null;
    /** Every UC1 root under the runs directory (the roots the cap covers), from the ledger; null when not read. */
    uc1_roots: { roots: number; settled_microusd: string; open_microusd: string } | null;
  };
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
}

function state(tries: readonly GradeTry[]): string | null {
  return tries.at(-1)?.result.state ?? null;
}

function sum(tries: readonly GradeTry[]): number {
  return tries.reduce((total, item) => total + (item.settled_microusd ?? 0), 0);
}

export function buildSummary(run: RunRecord, records: readonly AttemptRecord[], seeded: readonly SeededRecord[], stops: readonly StopRecord[], ledger: LedgerView | null, analysis: RunSummary["analysis"], allRoots: { roots: number; view: LedgerView } | null = null): RunSummary {
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
      model_settled_microusd: record === undefined ? null : record.runs.reduce((total, entry) => total + (entry.result?.settled_microusd ?? 0), 0),
      scope: final?.submission?.scope ?? null,
      route: final?.route?.route ?? null,
      grade1: final === undefined ? null : state(final.grade1),
      grade2: final === undefined ? null : state(final.grade2),
      grade2_settled_microusd: final === undefined ? 0 : sum(final.grade2),
    };
  });
  const totals = settledTotals(records, seeded);
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
      ledger: ledger === null ? null : { settled_microusd: ledger.settled_microusd.toString(), open_microusd: ledger.open_microusd.toString(), uncertain: ledger.uncertain },
      uc1_roots: allRoots === null ? null : { roots: allRoots.roots, settled_microusd: allRoots.view.settled_microusd.toString(), open_microusd: allRoots.view.open_microusd.toString() },
    },
    stops: [...stops],
    analysis,
  };
}

function usd(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(4)}`;
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
  if (summary.spend.ledger !== null) lines.push(`- Ledger under this root: settled ${usd(Number(summary.spend.ledger.settled_microusd))}, open ${usd(Number(summary.spend.ledger.open_microusd))}, uncertain operations ${String(summary.spend.ledger.uncertain.length)}.`);
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
      lines.push(summary.mode === "pilot" ? `Harness pilot, k = ${String(off.counted)} off and ${String(on.counted)} on; not a UC1 result.` : `Illustration on 1 bug, k = ${String(off.counted)} off and ${String(on.counted)} on.`, "");
      lines.push(bug.made_worse.statement, "");
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
  writeFileSync(join(staging, "report.md"), input.report);
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
