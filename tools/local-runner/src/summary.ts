// The run's one summary: canonical JSON (the shared schema's encoder) and a short text table.
// Everything in it is development evidence: it makes no admission claim and is not published.
import { encodeCanonical } from "@rbw/schema";
import type { CodeState } from "@rbw/schema";
import type { StateKey } from "./code-states.ts";
import type { AuditResult, CopyStatus } from "./copy.ts";
import type { PhaseSummary } from "./records.ts";
import type { SandboxReport } from "./sandbox.ts";

export const SUMMARY_NOTE =
  "Development evidence from a local run on Docker. It makes no admission claim, is not published, and the planted bug is synthetic.";

export interface KnownLimit {
  applies: boolean;
  days: string;
  note: string;
}

/** The driver README's known limit: two upstream revenue tests fail on a clean copy run on the 2nd to the 5th of a month. */
export function revenueKnownLimit(ms: number): KnownLimit {
  const day = new Date(ms).getUTCDate();
  return {
    applies: day >= 2 && day <= 5,
    days: "2nd to 5th of a month, UTC",
    note: "two upstream revenue tests fail on a clean copy on these days (packages/umami-driver README, Known limits); recorded, not refused",
  };
}

export interface CopySummary {
  trial_id: string;
  state: StateKey;
  code_state: CodeState;
  container: string;
  status: CopyStatus;
  reason: string | null;
  audit: AuditResult;
  placed_sha256: string | null;
  freeze_exit: number | null;
  driver_exit: number | null;
  container_exit: number | null;
  timed_out: boolean;
  merged: boolean;
  phases_ms: Record<string, number>;
  driver_phases: PhaseSummary[];
  tests_phase: { duration_ms: number; limit_ms: number; within_limit: boolean } | null;
  artifact_bytes: { total: number; limit: number; within_limit: boolean } | null;
  /** Only for a copy on Vercel Sandbox: its name, the stop confirmation and the SDK call counts. */
  sandbox?: SandboxReport;
}

export interface TrialSummary {
  trial_id: string;
  code_state: string;
  status: string;
  stage: string;
  reason: string | null;
  code: string | null;
  added_verdict: string | null;
  original_executed: number;
  original_failed: number;
  failed_test_ids: string[];
}

export interface JobSummary {
  label: string;
  kind: string;
  execution_id: string;
  task_revision: string;
  request_sha256: string;
  expected_trials_sha256: string;
  baseline: { key: string; sha256: string } | null;
  refusal: { reason: string; detail: string } | null;
  copies: CopySummary[];
  import: { refusal: string | null; evidence_sha256: string | null; decision_sha256: string | null; trials: TrialSummary[] };
}

export interface AdmissionSummary {
  decisions: Record<string, string>;
  comparison: string | null;
  outcome_verdict: string | null;
  cells: unknown[];
}

export type CandidateTextSummary =
  | {
      status: "complete";
      provenance: string[];
      card: unknown;
      issue: unknown;
      search: { call_name: string; outcome: string; reason: string | null; urls: string[]; completed_at: string; sha256: string }[];
      novelty: string;
      ledger: unknown;
    }
  | { status: "failed"; code: string; detail: string };

export interface Summary {
  schema_version: 1;
  label: "development_evidence";
  note: string;
  admission_claim: false;
  published: false;
  run: {
    run_tag: string;
    root_execution_id: string;
    started_at: string;
    ended_at: string;
    run_date_utc: string;
    revenue_tests_known_limit: KnownLimit;
    concurrency: number;
    copy_outer_limit_ms: number;
    kill_grace_ms: number;
  };
  image: { reference: string; digest: string | null; kit_sha256: string | null };
  inputs: Record<string, string | Record<string, string> | null>;
  original_suite: { sha256: string; test_count: number } | null;
  code_states: { state: StateKey; code_state: CodeState; sha256: string; patch_sha256: string | null }[];
  failure: { step: string; detail: string } | null;
  jobs: JobSummary[];
  admission: AdmissionSummary | null;
  alternative_fix: { trial_id: string; status: string; added_verdict: string | null; original_failed: number; passes_every_check: boolean } | null;
  candidate_text: CandidateTextSummary | null;
}

export function summaryBytes(summary: unknown): Uint8Array {
  return encodeCanonical(summary);
}

function cell(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "-" : String(value);
}

/** A short text table: one line per copy, then the decisions. */
export function summaryText(summary: Summary): string {
  const lines = [
    `Random Bug Walk local run: development evidence (no admission claim, nothing published; the planted bug is synthetic)`,
    `run ${summary.run.run_tag} started ${summary.run.started_at} ended ${summary.run.ended_at} concurrency ${String(summary.run.concurrency)}`,
    `date ${summary.run.run_date_utc} revenue_known_limit ${summary.run.revenue_tests_known_limit.applies ? "applies" : "does_not_apply"}`,
    `image ${cell(summary.image.digest)}`,
  ];
  if (summary.failure !== null) lines.push(`stopped at ${summary.failure.step}: ${summary.failure.detail}`);
  for (const job of summary.jobs) {
    lines.push(`job ${job.label} ${job.kind} evidence ${cell(job.import.evidence_sha256)} decision ${cell(job.import.decision_sha256)}${job.refusal === null ? "" : ` refused ${job.refusal.reason}`}`);
    for (const copy of job.copies) {
      const trial = job.import.trials.find((item) => item.trial_id === copy.trial_id);
      lines.push(
        [
          job.label,
          copy.trial_id,
          copy.status,
          cell(copy.reason),
          `audit=${copy.audit.verdict}`,
          `imported=${trial === undefined ? "-" : `${trial.status}/${trial.stage}`}`,
          `added=${cell(trial?.added_verdict)}`,
          `original_failed=${cell(trial?.original_failed)}/${cell(trial?.original_executed)}`,
          `tests_ms=${cell(copy.tests_phase?.duration_ms)}/${cell(copy.tests_phase?.limit_ms)}`,
          `bytes=${cell(copy.artifact_bytes?.total)}/${cell(copy.artifact_bytes?.limit)}`,
          `run_ms=${cell(copy.phases_ms.run)}`,
        ].join(" "),
      );
    }
  }
  if (summary.admission !== null) {
    lines.push(`decisions ${Object.entries(summary.admission.decisions).map(([rule, decision]) => `${rule} ${decision}`).join(" ")}`);
    lines.push(`comparison ${cell(summary.admission.comparison)}`, `outcome_verdict ${cell(summary.admission.outcome_verdict)}`);
  }
  if (summary.alternative_fix !== null) lines.push(`alternative fix ${summary.alternative_fix.status} passes_every_check=${summary.alternative_fix.passes_every_check ? "yes" : "no"}`);
  if (summary.candidate_text !== null) {
    lines.push(summary.candidate_text.status === "complete" ? `candidate text complete novelty ${summary.candidate_text.novelty}` : `candidate text failed ${summary.candidate_text.code}`);
  }
  return `${lines.join("\n")}\n`;
}
