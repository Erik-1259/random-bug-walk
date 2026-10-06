// Each job's record set: the job's request and expected trials, plus each copy's own
// results/<trial_id>/ as the driver wrote it. The set is imported with @rbw/admission's own
// command, which writes the evidence before it derives the decision.
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "@rbw/admission";
import type { Decision, Evidence } from "@rbw/admission";
import { parseRecord, sha256Hex } from "@rbw/schema";
import { DEFAULT_PHASE_LIMITS, trialKeys } from "@rbw/umami-driver";
import type { CopyResult } from "./copy.ts";
import { writeJobDir } from "./jobs.ts";
import type { BuiltJob } from "./jobs.ts";

/** The driver's per-trial artifact limit (its README, Limits). */
export const ARTIFACT_LIMIT_BYTES = 64 * 1024 * 1024;
export const TESTS_PHASE_LIMIT_MS = DEFAULT_PHASE_LIMITS.tests_ms;

export interface MergedTrial {
  trial_id: string;
  merged: boolean;
  /** Why a copy's records were not merged; null when they were, or when the copy left none. */
  reason: string | null;
}

/** Writes the job's record set: its two job files, then each copy's trial directory whose records count. */
export function mergeRecordSet(job: BuiltJob, copies: readonly CopyResult[], dir: string): MergedTrial[] {
  writeJobDir(dir, job);
  return copies.map((copy): MergedTrial => {
    if (copy.records_dir === null) return { trial_id: copy.trial_id, merged: false, reason: null };
    const sameJob =
      existsSync(join(copy.records_dir, "request.json")) &&
      readFileSync(join(copy.records_dir, "request.json")).equals(Buffer.from(job.requestBytes)) &&
      existsSync(join(copy.records_dir, ...job.request.expected_trials_key.split("/"))) &&
      readFileSync(join(copy.records_dir, ...job.request.expected_trials_key.split("/"))).equals(Buffer.from(job.expectedBytes));
    if (!sameJob) return { trial_id: copy.trial_id, merged: false, reason: "record_set_of_another_job" };
    const trialDir = join(copy.records_dir, "results", copy.trial_id);
    if (!existsSync(trialDir)) return { trial_id: copy.trial_id, merged: false, reason: null };
    mkdirSync(join(dir, "results"), { recursive: true });
    cpSync(trialDir, join(dir, "results", copy.trial_id), { recursive: true, verbatimSymlinks: true });
    return { trial_id: copy.trial_id, merged: true, reason: null };
  });
}

export interface ImportOutcome {
  /** The importer's request-level refusal code, or a failure to write; null when a decision was written. */
  refusal: string | null;
  evidence_sha256: string | null;
  decision_sha256: string | null;
  evidence: Evidence | null;
  decision: Decision | null;
}

/** Runs `@rbw/admission`'s import over a record set, writing evidence.json, evidence.sha256 and decision.json in `outDir`. */
export function importJob(recordsDir: string, outDir: string): ImportOutcome {
  mkdirSync(outDir, { recursive: true });
  const result = runCli(["import", "--records", recordsDir, "--out", outDir]);
  if (result.code !== 0) {
    const refusal = /^refused (\S+)/.exec(result.stderr)?.[1] ?? `import_exit_${String(result.code)}`;
    return { refusal, evidence_sha256: null, decision_sha256: null, evidence: null, decision: null };
  }
  const evidenceBytes = readFileSync(join(outDir, "evidence.json"));
  const decisionBytes = readFileSync(join(outDir, "decision.json"));
  return {
    refusal: null,
    evidence_sha256: sha256Hex(evidenceBytes),
    decision_sha256: sha256Hex(decisionBytes),
    evidence: JSON.parse(evidenceBytes.toString("utf8")) as Evidence,
    decision: JSON.parse(decisionBytes.toString("utf8")) as Decision,
  };
}

export interface PhaseSummary {
  name: string;
  duration_ms: number;
  limit_ms: number | null;
  outcome: string;
}

export interface Measurements {
  driver_phases: PhaseSummary[];
  tests_phase: { duration_ms: number; limit_ms: number; within_limit: boolean } | null;
  artifact_bytes: { total: number; limit: number; within_limit: boolean } | null;
}

interface Timings {
  phases?: { name: string; repeat_index: number | null; duration_ms: number; limit_ms: number | null; outcome: string }[];
}

/** The driver's phase timings and artifact bytes for one trial, read from its own record set. */
export function measure(recordsDir: string | null, trialId: string): Measurements {
  const none: Measurements = { driver_phases: [], tests_phase: null, artifact_bytes: null };
  if (recordsDir === null) return none;
  const manifestPath = join(recordsDir, trialKeys(trialId).artifacts);
  if (!existsSync(manifestPath)) return none;
  const manifest = parseRecord("ArtifactManifest", readFileSync(manifestPath));
  const total = manifest.entries.reduce((sum, entry) => sum + entry.size_bytes, 0);
  const timingsEntry = manifest.entries.find((entry) => entry.kind === "phase_timings");
  const timingsPath = timingsEntry === undefined ? null : join(recordsDir, ...timingsEntry.key.split("/"));
  const timings = timingsPath !== null && existsSync(timingsPath) ? (JSON.parse(readFileSync(timingsPath, "utf8")) as Timings) : {};
  const phases = (timings.phases ?? []).filter((phase) => phase.repeat_index === null && phase.limit_ms !== null);
  const tests = phases.find((phase) => phase.name === "tests");
  return {
    driver_phases: phases.map((phase) => ({ name: phase.name, duration_ms: phase.duration_ms, limit_ms: phase.limit_ms, outcome: phase.outcome })),
    tests_phase: tests === undefined ? null : { duration_ms: tests.duration_ms, limit_ms: TESTS_PHASE_LIMIT_MS, within_limit: tests.duration_ms <= TESTS_PHASE_LIMIT_MS },
    artifact_bytes: { total, limit: ARTIFACT_LIMIT_BYTES, within_limit: total <= ARTIFACT_LIMIT_BYTES },
  };
}
