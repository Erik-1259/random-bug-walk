// The screen record: the `uc1-static-headroom-screen` record, version 1, as the written screen
// records in docs/uc1-screen/ use it. A written record holds a judgment and states
// `optional_static_probe` as text; this package writes the same record with the probe run, so
// `optional_static_probe` is an object with the attempts, hits and cost. The schema accepts both.
import { z } from "zod";
import type { ScreenSubject } from "./inputs.ts";
import { SCORING } from "./score.ts";
import { siteLabel } from "./site.ts";
import type { AttemptOutcome, Verdict } from "./score.ts";

export const RECORD_NAME = "uc1-static-headroom-screen";
export const RECORD_VERSION = 1;
export const CRITERION = "Skip a UC1 candidate whose omission is plain from the pre-fix source alone.";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Microusd = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const StaticTell = z.strictObject({ location: z.string().min(1), kind: z.string().min(1), detail: z.string().min(1) });

export const AttemptSchema = z.strictObject({
  attempt: z.number().int().positive(),
  operation_id: z.string(),
  call_name: z.string(),
  status: z.enum(["completed", "failed", "uncertain"]),
  failure: z.enum(["http_status", "invalid_output", "request_not_sent", "lost_response"]).nullable(),
  http_status: z.number().int().nullable(),
  outcome: z.enum(["located_and_fixed", "located", "fixed", "miss", "no_answer"]),
  miss_kind: z.enum(["other_file", "invalid_range", "range_too_wide", "other_lines"]).nullable(),
  /** The answer's range, kept for hits only: a miss can point anywhere in the host, so it is not recorded. */
  hit_range: z.strictObject({ file: z.string(), start_line: z.number().int(), end_line: z.number().int() }).nullable(),
  input_token_bound: z.number().int().nonnegative(),
  prompt_tokens: z.number().int().nonnegative().nullable(),
  completion_tokens: z.number().int().nonnegative().nullable(),
  prompt_within_bound: z.boolean().nullable(),
  reserved_microusd: Microusd,
  settled_microusd: Microusd.nullable(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const StoppedSchema = z.strictObject({
  reason: z.enum(["verdict_decided", "refused", "prompt_too_large", "uncertain", "ledger_refusal", "bound_exceeded", "error"]),
  attempt: z.number().int().positive().nullable(),
  operation_id: z.string().nullable(),
  detail: z.string(),
});
export type Stopped = z.infer<typeof StoppedSchema>;

export const StaticProbeSchema = z.strictObject({
  status: z.literal("run"),
  tool: z.literal("@rbw/screen"),
  model: z.string(),
  service: z.string(),
  runtime_profile_sha256: Sha256,
  rate_sheet_sha256: Sha256,
  prompt_sha256: Sha256,
  files_shown: z.array(z.string()),
  symptom_sha256: Sha256,
  root_execution_id: z.string(),
  attempts_planned: z.number().int().positive(),
  attempts_run: z.number().int().nonnegative(),
  answered: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  fail_at_hits: z.number().int().positive(),
  scoring: z.strictObject({
    line_tolerance: z.number().int(),
    max_claim_lines: z.number().int(),
    located: z.string(),
    fixed: z.string(),
    hit: z.string(),
  }),
  cost: z.strictObject({
    budget_microusd: Microusd,
    worst_case_microusd_per_call: Microusd,
    reserved_microusd: Microusd,
    settled_microusd: Microusd,
    /**
     * Launched calls without a settlement, plus an operation interrupted after its reservation was
     * requested; their cost is not in settled_microusd, and the interrupted one's is not in reserved_microusd.
     */
    unsettled_operation_ids: z.array(z.string()),
  }),
  stopped: StoppedSchema.nullable(),
  attempts: z.array(AttemptSchema),
});
export type StaticProbe = z.infer<typeof StaticProbeSchema>;

export const ScreenRecordSchema = z.looseObject({
  record: z.literal(RECORD_NAME),
  record_version: z.literal(RECORD_VERSION),
  case: z.string().min(1),
  case_status: z.string().min(1),
  shape: z.string().min(1),
  screen: z.strictObject({
    source: z.string().min(1),
    criterion: z.string().min(1),
    binding: z.boolean(),
    judged_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    judged_by: z.string().min(1),
  }),
  subject: z.looseObject({
    host: z.string().min(1),
    host_commit: z.string().regex(/^[0-9a-f]{40}$/),
    target_file: z.string().min(1),
    clean_sha256: Sha256,
    planted_sha256: Sha256,
  }),
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  verdict_summary: z.string().min(1),
  static_tells: z.array(StaticTell),
  consequences: z.array(z.string()).optional(),
  optional_static_probe: z.union([z.string().min(1), StaticProbeSchema]),
});
export type ScreenRecord = z.infer<typeof ScreenRecordSchema>;

export interface RecordInputs {
  subject: ScreenSubject;
  probe: StaticProbe;
  verdict: Verdict;
  binding: boolean;
  judgedOn: Date;
}

const OUTCOME_KIND: Record<Exclude<AttemptOutcome, "miss" | "no_answer">, string> = {
  located_and_fixed: "model located the site and its fix gives the clean file",
  located: "model located the site",
  fixed: "model fix gives the clean file",
};

function summary(verdict: Verdict, probe: StaticProbe, target: string): string {
  const of = `${String(probe.attempts_run)} of ${String(probe.attempts_planned)} planned attempts`;
  const counted = `${String(probe.hits)} hit${probe.hits === 1 ? "" : "s"} in ${of} (${probe.model}, source and symptom only)`;
  switch (verdict) {
    case "fail":
      return `The planted site in ${target} is findable from the source alone: ${counted}, at or above the failing count of ${String(probe.fail_at_hits)}. The case fails the static-headroom screen.`;
    case "pass":
      return `No attempt found the planted site often enough to fail: ${counted}, below the failing count of ${String(probe.fail_at_hits)}, with every attempt answered. The case passes the automated screen.`;
    case "inconclusive":
      return `Too few answers to decide: ${counted}, ${String(probe.answered)} answered${probe.stopped === null ? "" : `; the run stopped (${probe.stopped.reason})`}. Neither pass nor fail.`;
  }
}

const CONSEQUENCES: Record<Verdict, string> = {
  fail: "Do not use this case as a UC1 paired-comparison subject; it remains usable as a factory case.",
  pass: "The automated probe did not find the site; this alone does not make the case a UC1 subject.",
  inconclusive: "Rerun the screen or judge the case in writing before using it as a UC1 subject.",
};

/**
 * The record for one finished or stopped run. Every sentence is written by code. It names the planted
 * site by line range but holds no line of the clean or planted form, so the patch stays out of it.
 */
export function buildRecord(inputs: RecordInputs): ScreenRecord {
  const { subject, probe, verdict } = inputs;
  const { site } = subject;
  const target = subject.input.target_path;
  const tells = probe.attempts.flatMap((attempt) => {
    if (attempt.hit_range === null || attempt.outcome === "miss" || attempt.outcome === "no_answer") {
      return [];
    }
    return [
      {
        location: `${attempt.hit_range.file}:${String(attempt.hit_range.start_line)}-${String(attempt.hit_range.end_line)}`,
        kind: OUTCOME_KIND[attempt.outcome],
        detail: `Attempt ${String(attempt.attempt)} of ${String(probe.attempts_planned)} answered with this range from the shown files and the symptom alone; the planted site is ${siteLabel(target, site)}.`,
      },
    ];
  });
  return ScreenRecordSchema.parse({
    record: RECORD_NAME,
    record_version: RECORD_VERSION,
    case: subject.input.case,
    case_status: subject.input.case_status,
    shape: subject.input.shape,
    screen: {
      source: "Automated static-headroom screen (@rbw/screen), criterion stated in full in `criterion`",
      criterion: CRITERION,
      binding: inputs.binding,
      judged_on: inputs.judgedOn.toISOString().slice(0, 10),
      judged_by: `Automated static probe: up to ${String(probe.attempts_planned)} bounded calls to ${probe.model} given only the shown files and the symptom, each answer scored by code against the planted site`,
    },
    subject: {
      host: subject.input.host,
      host_commit: subject.input.host_commit,
      source_read_from: subject.input.source_read_from,
      target_file: target,
      clean_sha256: subject.clean_sha256,
      planted_sha256: subject.planted_sha256,
      planted_site: siteLabel(target, site),
      planted_hunks: site.hunks.map((hunk) => ({ start_line: hunk.start_line, end_line: hunk.end_line })),
    },
    verdict,
    verdict_summary: summary(verdict, probe, target),
    static_tells: tells,
    consequences: [CONSEQUENCES[verdict]],
    optional_static_probe: probe,
  });
}

export function scoringRecord(): StaticProbe["scoring"] {
  return { ...SCORING };
}
