// What the sequence, run-copy and the dry run share: container names, each copy's plan, the copy
// profile that every job names by hash, the image digest, and the per-copy and per-trial summaries.
import { join } from "node:path";
import type { Evidence } from "@rbw/admission";
import { canonicalDigest } from "@rbw/schema";
import type { CodeState } from "@rbw/schema";
import { DEFAULT_PHASE_LIMITS } from "@rbw/umami-driver";
import { stateForPatch } from "./code-states.ts";
import type { CodeStates, StateFile } from "./code-states.ts";
import { COPY_OUTER_LIMIT_MS, COPY_RESOURCES, KILL_GRACE_MS } from "./copy.ts";
import type { CopyPlan, CopyResult } from "./copy.ts";
import type { Docker } from "./docker.ts";
import type { CopyInputs } from "./inputs.ts";
import type { JobLabel } from "./jobs.ts";
import { auditCopy } from "./projection.ts";
import { measure } from "./records.ts";
import type { MergedTrial } from "./records.ts";
import type { CopySummary, TrialSummary } from "./summary.ts";

export class PlanError extends Error {
  override name = "PlanError";
}

export function containerName(tag: string, label: string, trialId: string): string {
  return `rbw-${tag}-${label}-${trialId}`;
}

/** The copy profile: the container's resources and isolation and every time limit. Jobs name it by hash. */
export const COPY_PROFILE = {
  container_args: [...COPY_RESOURCES],
  copy_outer_limit_ms: COPY_OUTER_LIMIT_MS,
  driver_phase_limits: DEFAULT_PHASE_LIMITS,
  kill_grace_ms: KILL_GRACE_MS,
};

export function profileSha256(): string {
  return canonicalDigest(COPY_PROFILE).sha256;
}

/** The image's content digest (`docker image inspect`), which every copy then runs by. */
export async function inspectImage(docker: Docker, reference: string): Promise<string> {
  const result = await docker.run(["image", "inspect", "--format", "{{.Id}}", reference], { timeoutMs: 60_000 });
  const digest = result.stdout.toString("utf8").trim();
  if (result.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new PlanError(`docker cannot inspect the image ${reference}`);
  return digest;
}

export interface TrialRef {
  trial_id: string;
  code_state: CodeState;
  patch_sha256: string | null;
}

export interface CopyPlanInputs {
  tag: string;
  label: JobLabel;
  image: string;
  work: string;
  jobDir: string;
  sourceDir: string;
  states: CodeStates;
  inputs: CopyInputs;
}

/** The state a trial names by its code state and patch hash; a job naming an unknown patch is refused. */
export function trialState(states: CodeStates, trial: TrialRef): StateFile {
  const state = stateForPatch(states, trial.code_state, trial.patch_sha256);
  if (state === null) throw new PlanError(`trial ${trial.trial_id} names a ${trial.code_state} patch this runner did not derive`);
  return state;
}

/** One copy's plan: its own container name and directories, and the audit of exactly the bytes it receives. */
export function planCopy(trial: TrialRef, p: CopyPlanInputs): CopyPlan {
  const state = trialState(p.states, trial);
  return {
    job: p.label,
    trial_id: trial.trial_id,
    state: state.key,
    container: containerName(p.tag, p.label, trial.trial_id),
    image: p.image,
    mode: "trial",
    work_dir: join(p.work, "copies", p.label, trial.trial_id),
    job_dir: p.jobDir,
    placement: state.key === "clean" ? null : { path: state.path, bytes: state.bytes, sha256: state.sha256 },
    audit: () =>
      Promise.resolve(
        auditCopy({
          sourceDir: p.sourceDir,
          workDir: join(p.work, "audits", p.label, trial.trial_id),
          state,
          manifestPath: p.inputs.manifestPath,
          termsPath: p.inputs.termsPath,
          policyPath: p.inputs.policyPath,
        }),
      ),
  };
}

export function copySummary(copy: CopyResult, codeState: CodeState, merged: MergedTrial | undefined): CopySummary {
  const measured = measure(copy.records_dir, copy.trial_id);
  return {
    trial_id: copy.trial_id,
    state: copy.state,
    code_state: codeState,
    container: copy.container,
    status: copy.status,
    reason: copy.reason,
    audit: copy.audit,
    placed_sha256: copy.placed_sha256,
    freeze_exit: copy.freeze_exit,
    driver_exit: copy.driver_exit,
    container_exit: copy.container_exit,
    timed_out: copy.timed_out,
    merged: merged?.merged ?? false,
    phases_ms: Object.fromEntries(copy.phases.map((phase) => [phase.name, phase.duration_ms])),
    driver_phases: measured.driver_phases,
    tests_phase: measured.tests_phase,
    artifact_bytes: measured.artifact_bytes,
  };
}

export function trialSummaries(evidence: Evidence | null): TrialSummary[] {
  return (evidence?.trials ?? []).map((trial) => ({
    trial_id: trial.trial_id,
    code_state: trial.code_state,
    status: trial.status,
    stage: trial.stage,
    reason: trial.reason,
    code: trial.code,
    added_verdict: trial.added?.verdict ?? null,
    original_executed: trial.original?.tests.length ?? 0,
    original_failed: trial.original?.failed_test_ids.length ?? 0,
    failed_test_ids: trial.original?.failed_test_ids ?? [],
  }));
}
