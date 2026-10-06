// run-copy: exactly one copy from a job directory and a trial ID, for a later hosted or cloud
// matrix to call. It reads the job with the driver's own reader, refuses an observation whose
// kit-check baseline is missing or does not match, derives and audits the trial's code state,
// runs the copy on Docker or on Vercel Sandbox, and writes the copy's summary beside its
// collected record set.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RecordError } from "@rbw/schema";
import type { JobKind } from "@rbw/schema";
import { RefusedInput, loadJob } from "@rbw/umami-driver";
import { CodeStateRefusal, deriveCodeStates } from "./code-states.ts";
import type { Clock } from "./clock.ts";
import { runCopy } from "./copy.ts";
import type { CopyResult } from "./copy.ts";
import type { Docker } from "./docker.ts";
import { loadCopyInputs } from "./inputs.ts";
import type { CopyInputOptions } from "./inputs.ts";
import { JOB_KINDS, JOB_LABELS, checkBaseline, runTag } from "./jobs.ts";
import type { JobLabel } from "./jobs.ts";
import { PlanError, copySummary, inspectImage, inspectRepoDigests, planCopy } from "./plan.ts";
import { ExportError, exportImage } from "./projection.ts";
import { runSandboxCopy } from "./sandbox.ts";
import type { SandboxReport, SandboxSdk } from "./sandbox.ts";
import { summaryBytes } from "./summary.ts";
import type { CopySummary } from "./summary.ts";

export interface RunCopyOptions extends CopyInputOptions {
  job: string;
  trial: string;
  /** The run directory the job's baseline key is resolved against; needed for an observation. */
  root: string | null;
  image: string;
  /** Must be absent or empty: the source export, the audit and the copy's own directories go here. */
  work: string;
  /** Where the copy runs; Docker when absent. */
  backend?: "docker" | "sandbox";
  /** For the sandbox backend: the kit image in VCR, pinned by digest, which must be one of `image`'s repository digests. */
  sandboxImage?: string | null;
}

export interface RunCopyDeps {
  docker: Docker;
  clock: Clock;
  /** Needed for the sandbox backend. */
  sandbox?: SandboxSdk;
}

export interface RunCopyOutcome {
  /** 0 when the copy completed, 1 when it did not or was refused. */
  exitCode: number;
  refusal: { reason: string; detail: string } | null;
  copy: CopySummary | null;
  /** The driver's record set for this trial, when its records count. */
  recordsDir: string | null;
}

function labelOf(kind: JobKind): JobLabel {
  const label = JOB_LABELS.find((item) => JOB_KINDS[item] === kind);
  if (label === undefined) throw new PlanError(`no runner job has kind ${kind}`);
  return label;
}

function refused(reason: string, detail: string): RunCopyOutcome {
  return { exitCode: 1, refusal: { reason, detail }, copy: null, recordsDir: null };
}

const VCR_DIGEST = /^[^\s@]+@(sha256:[0-9a-f]{64})$/;

export async function runCopyCommand(options: RunCopyOptions, deps: RunCopyDeps): Promise<RunCopyOutcome> {
  if (existsSync(options.work) && readdirSync(options.work).length > 0) return refused("work_not_empty", "the work directory must be absent or empty");
  let target: { sdk: SandboxSdk; image: string; digest: string } | null = null;
  if (options.backend === "sandbox") {
    const image = options.sandboxImage ?? "";
    const digest = VCR_DIGEST.exec(image)?.[1];
    if (digest === undefined || deps.sandbox === undefined) {
      return refused("sandbox_unavailable", "the sandbox backend needs the SDK and --sandbox-image as <repository>@sha256:<digest>");
    }
    target = { sdk: deps.sandbox, image, digest };
  }
  let job;
  try {
    job = loadJob(options.job, options.trial);
  } catch (error) {
    if (error instanceof RefusedInput || error instanceof RecordError) return refused("job_invalid", error.message);
    throw error;
  }
  const { request, trial } = job;
  if (request.kind === "observe" || request.baseline_evidence_key !== null) {
    if (options.root === null) return refused("baseline_missing", "an observation needs --root, the run directory that holds its kit-check baseline");
    const baseline = checkBaseline(options.root, request);
    if (!baseline.ok) return refused(baseline.reason, baseline.detail);
  }
  const inputs = loadCopyInputs(options);
  const label = labelOf(request.kind);
  const tag = runTag(request.root_execution_id);
  try {
    const digest = await inspectImage(deps.docker, options.image);
    if (digest !== request.image_digest) return refused("image_mismatch", `the job names ${request.image_digest} but ${options.image} is ${digest}`);
    if (target !== null) {
      const pushed = (await inspectRepoDigests(deps.docker, options.image)).some((item) => item.endsWith(`@${target.digest}`));
      if (!pushed) return refused("sandbox_image_mismatch", `${options.image} has no repository digest ${target.digest}, so the VCR image is not the job's image`);
    }
    const exported = await exportImage(deps.docker, { image: digest, container: `rbw-${tag}-${label}-${trial.trial_id}-export`, dest: join(options.work, "source") });
    const states = deriveCodeStates(readFileSync(join(exported.source_dir, inputs.probes.data.target_path)), inputs.probes, inputs.alternative);
    const plan = planCopy(trial, { tag, label, image: digest, work: options.work, jobDir: options.job, sourceDir: exported.source_dir, states, inputs });
    let result: CopyResult;
    let sandbox: SandboxReport | null = null;
    if (target !== null) {
      const ran = await runSandboxCopy(plan, { sdk: target.sdk, clock: deps.clock, image: target.image, attempt: randomUUID() });
      ({ sandbox, ...result } = ran);
    } else {
      result = await runCopy(plan, deps);
    }
    const copy = sandbox === null ? copySummary(result, trial.code_state, undefined) : { ...copySummary(result, trial.code_state, undefined), sandbox };
    writeFileSync(join(options.work, "copy-summary.json"), summaryBytes(copy));
    const done = result.status === "complete" && (sandbox === null || sandbox.stop_confirmed);
    return { exitCode: done ? 0 : 1, refusal: null, copy, recordsDir: result.records_dir };
  } catch (error) {
    if (error instanceof PlanError || error instanceof ExportError || error instanceof CodeStateRefusal) return refused("cannot_run", error.message);
    throw error;
  }
}
