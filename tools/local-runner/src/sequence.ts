// The first local sequence, the local stand-in for the hosted controller: the kit check, the
// observation and admission, each as one job of copies through the kit image and the protected
// driver, plus one alternative-fix copy as development evidence. Each job's record set is
// imported with @rbw/admission, then the card, the issue and the phrase searches run in recorded
// mode, and one summary is written. Nothing here makes an admission claim or publishes anything.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@rbw/schema";
import type { ExpectedTrial } from "@rbw/schema";
import { parseSuiteManifest } from "@rbw/umami-driver";
import { CodeStateRefusal, STATE_KEYS, deriveCodeStates } from "./code-states.ts";
import type { CodeStates } from "./code-states.ts";
import type { Clock } from "./clock.ts";
import { utcSeconds } from "./clock.ts";
import { COPY_OUTER_LIMIT_MS, KILL_GRACE_MS, runCopies, runCopy } from "./copy.ts";
import type { CopyPlan, CopyResult } from "./copy.ts";
import type { Docker } from "./docker.ts";
import { InputsError, inputHashes, loadRunInputs } from "./inputs.ts";
import type { RunInputOptions, RunInputs } from "./inputs.ts";
import { BASELINE_KEY, JobRefusal, buildJob, checkBaseline, expectedVectors, newRunIds, writeJobDir } from "./jobs.ts";
import type { BuiltJob, JobContext, JobLabel, RunIds } from "./jobs.ts";
import { PlanError, containerName, copySummary, inspectImage, planCopy, profileSha256, trialSummaries } from "./plan.ts";
import { ExportError, exportImage } from "./projection.ts";
import { RecordedModeError, runRecorded } from "./recorded.ts";
import { importJob, mergeRecordSet } from "./records.ts";
import type { ImportOutcome } from "./records.ts";
import { revenueKnownLimit, SUMMARY_NOTE, summaryBytes, summaryText } from "./summary.ts";
import type { AdmissionSummary, CandidateTextSummary, JobSummary, Summary } from "./summary.ts";

export interface SequenceOptions extends RunInputOptions {
  /** The kit image: a tag or a digest. Copies run by the digest it resolves to. */
  image: string;
  /** Must be absent or empty. */
  work: string;
  concurrency: number;
}

export interface SequenceDeps {
  docker: Docker;
  clock: Clock;
  uuid: () => string;
  log: (line: string) => void;
}

export interface SequenceResult {
  summary: Summary;
  summaryPath: string;
  summarySha256: string;
  textPath: string;
  /** 0 when every copy completed and every step ran; 1 otherwise. The summary is written either way. */
  exitCode: number;
}

const NOT_APPLICABLE = { verdict: "not_applicable", reason: "no_declared_change", report_sha256: null, findings: 0 } as const;

interface Env {
  options: SequenceOptions;
  deps: SequenceDeps;
  inputs: RunInputs;
  ids: RunIds;
  digest: string;
  sourceDir: string;
  states: CodeStates;
}

function jobPaths(work: string, label: JobLabel) {
  const base = join(work, "jobs", label);
  return { base, job: join(base, "job"), records: join(base, "records") };
}

function plansFor(env: Env, job: BuiltJob, trials: readonly ExpectedTrial[]): CopyPlan[] {
  return trials.map((trial) =>
    planCopy(trial, {
      tag: env.ids.run_tag,
      label: job.label,
      image: env.digest,
      work: env.options.work,
      jobDir: jobPaths(env.options.work, job.label).job,
      sourceDir: env.sourceDir,
      states: env.states,
      inputs: env.inputs,
    }),
  );
}

function jobSummary(job: BuiltJob, copies: readonly CopyResult[], merged: ReturnType<typeof mergeRecordSet>, imported: ImportOutcome | null, refusal: JobSummary["refusal"] = null): JobSummary {
  const codeState = (trialId: string) => job.expected.trials.find((trial) => trial.trial_id === trialId)?.code_state ?? "clean";
  return {
    label: job.label,
    kind: job.kind,
    execution_id: job.request.execution_id,
    task_revision: job.request.task_revision,
    request_sha256: job.requestSha256,
    expected_trials_sha256: job.expectedSha256,
    baseline:
      job.request.baseline_evidence_key === null || job.request.baseline_evidence_sha256 === null
        ? null
        : { key: job.request.baseline_evidence_key, sha256: job.request.baseline_evidence_sha256 },
    refusal,
    copies: copies.map((copy) => copySummary(copy, codeState(copy.trial_id), merged.find((item) => item.trial_id === copy.trial_id))),
    import: {
      refusal: imported?.refusal ?? null,
      evidence_sha256: imported?.evidence_sha256 ?? null,
      decision_sha256: imported?.decision_sha256 ?? null,
      trials: trialSummaries(imported?.evidence ?? null),
    },
  };
}

/** Merges and imports one job's copies. */
function finishJob(env: Env, job: BuiltJob, copies: readonly CopyResult[]): { summary: JobSummary; imported: ImportOutcome } {
  const paths = jobPaths(env.options.work, job.label);
  const merged = mergeRecordSet(job, copies, paths.records);
  const imported = importJob(paths.records, paths.base);
  for (const copy of copies) env.deps.log(`${job.label} ${copy.trial_id} ${copy.status}${copy.reason === null ? "" : ` ${copy.reason}`}`);
  env.deps.log(`${job.label} imported evidence ${imported.evidence_sha256 ?? `refused ${imported.refusal ?? "-"}`}`);
  return { summary: jobSummary(job, copies, merged, imported), imported };
}

function admissionSummary(imported: ImportOutcome): AdmissionSummary | null {
  const { decision, evidence } = imported;
  if (decision === null || evidence === null) return null;
  return {
    decisions: Object.fromEntries(Object.entries(decision.decisions ?? {}).map(([rule, value]) => [rule, value.decision])),
    comparison: decision.comparison?.classification ?? null,
    outcome_verdict: decision.outcome_verdict,
    cells: evidence.cells ?? [],
  };
}

async function candidateText(env: Env, admission: BuiltJob): Promise<CandidateTextSummary> {
  const context = {
    project_id: env.ids.project_id,
    project_policy_sha256: admission.request.project_policy_sha256,
    batch_id: env.ids.batch_id,
    task_revision: admission.request.task_revision,
    root_execution_id: env.ids.root_execution_id,
    execution_id: env.ids.executions["candidate-text"],
    parent_execution_id: env.ids.root_execution_id,
  };
  try {
    const evidence = await runRecorded(env.inputs.recorded, context, { clock: env.deps.clock });
    const dir = join(env.options.work, "candidate-text");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "recorded-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    return {
      status: "complete",
      provenance: evidence.provenance,
      card: evidence.card,
      issue: evidence.issue,
      search: evidence.search.records.map((record) => ({
        call_name: record.call_name,
        outcome: record.outcome,
        reason: record.reason,
        urls: record.results.flatMap((item) => ("url" in item ? [item.url] : [])),
        completed_at: record.completed_at,
        sha256: record.sha256,
      })),
      novelty: evidence.search.novelty.status,
      ledger: evidence.ledger,
    };
  } catch (error) {
    if (error instanceof RecordedModeError) return { status: "failed", code: error.code, detail: error.message };
    throw error;
  }
}

function writeSummary(work: string, summary: Summary): { summaryPath: string; summarySha256: string; textPath: string } {
  const summaryPath = join(work, "summary.json");
  const textPath = join(work, "summary.txt");
  const bytes = summaryBytes(summary);
  writeFileSync(summaryPath, bytes);
  writeFileSync(textPath, summaryText(summary));
  return { summaryPath, summarySha256: sha256Hex(bytes), textPath };
}

export async function runSequence(options: SequenceOptions, deps: SequenceDeps): Promise<SequenceResult> {
  if (existsSync(options.work) && readdirSync(options.work).length > 0) throw new InputsError("the work directory must be absent or empty");
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new InputsError("--concurrency must be a positive integer");
  const started = deps.clock.now();
  const inputs = await loadRunInputs(options);
  const ids = newRunIds(deps.uuid);
  mkdirSync(options.work, { recursive: true });

  const summary: Summary = {
    schema_version: 1,
    label: "development_evidence",
    note: SUMMARY_NOTE,
    admission_claim: false,
    published: false,
    run: {
      run_tag: ids.run_tag,
      root_execution_id: ids.root_execution_id,
      started_at: utcSeconds(started),
      ended_at: utcSeconds(started),
      run_date_utc: new Date(started).toISOString().slice(0, 10),
      revenue_tests_known_limit: revenueKnownLimit(started),
      concurrency: options.concurrency,
      copy_outer_limit_ms: COPY_OUTER_LIMIT_MS,
      kill_grace_ms: KILL_GRACE_MS,
    },
    image: { reference: options.image, digest: null, kit_sha256: null },
    inputs: inputHashes(inputs, { kitSha256: null, originalSuiteSha256: null }),
    original_suite: null,
    code_states: [],
    failure: null,
    jobs: [],
    admission: null,
    alternative_fix: null,
    candidate_text: null,
  };
  let complete = true;
  const finish = (): SequenceResult => {
    summary.run.ended_at = utcSeconds(deps.clock.now());
    const written = writeSummary(options.work, summary);
    const copiesComplete = summary.jobs.every((job) => job.refusal === null && job.import.refusal === null && job.copies.every((copy) => copy.status === "complete"));
    const exitCode = complete && summary.failure === null && copiesComplete && summary.candidate_text?.status === "complete" ? 0 : 1;
    return { summary, ...written, exitCode };
  };
  const fail = (step: string, error: unknown): SequenceResult => {
    if (!(error instanceof PlanError || error instanceof ExportError || error instanceof CodeStateRefusal || error instanceof JobRefusal)) throw error;
    summary.failure = { step, detail: error.message };
    deps.log(`stopped at ${step}: ${error.message}`);
    return finish();
  };

  let digest: string;
  let states: CodeStates;
  let sourceDir: string;
  let kitSha256: string;
  try {
    digest = await inspectImage(deps.docker, options.image);
    summary.image.digest = digest;
    deps.log(`image ${digest}`);
    const exported = await exportImage(deps.docker, { image: digest, container: containerName(ids.run_tag, "source", "export"), dest: join(options.work, "source") });
    sourceDir = exported.source_dir;
    kitSha256 = sha256Hex(exported.image_manifest);
    summary.image.kit_sha256 = kitSha256;
    states = deriveCodeStates(readFileSync(join(sourceDir, inputs.probes.data.target_path)), inputs.probes, inputs.alternative);
    summary.code_states = STATE_KEYS.flatMap((key) => {
      const state = states.get(key);
      return state === undefined ? [] : [{ state: key, code_state: state.code_state, sha256: state.sha256, patch_sha256: state.patch_sha256 }];
    });
  } catch (error) {
    return fail("export", error);
  }
  const env: Env = { options, deps, inputs, ids, digest, sourceDir, states };

  const freeze = await runCopy(
    {
      job: "freeze",
      trial_id: "freeze",
      state: "clean",
      container: containerName(ids.run_tag, "source", "freeze"),
      image: digest,
      mode: "freeze",
      work_dir: join(options.work, "freeze"),
      job_dir: null,
      placement: null,
      audit: () => Promise.resolve(NOT_APPLICABLE),
    },
    deps,
  );
  if (freeze.status !== "complete" || freeze.collected_dir === null) return fail("freeze", new PlanError(`the freeze copy ended ${freeze.status} (${freeze.reason ?? "-"})`));
  const suiteBytes = readFileSync(join(freeze.collected_dir, "original-suite.json"));
  const suite = parseSuiteManifest(suiteBytes);
  const suiteSha = sha256Hex(suiteBytes);
  summary.original_suite = { sha256: suiteSha, test_count: suite.tests.length };
  summary.inputs = inputHashes(inputs, { kitSha256, originalSuiteSha256: suiteSha });
  deps.log(`original suite ${suiteSha} tests ${String(suite.tests.length)}`);

  try {
    const ctx: JobContext = {
      ids,
      imageDigest: digest,
      kitSha256,
      fixtureSha256: inputs.fixtureSha256,
      addedSuiteSha256: inputs.addedSuiteSha256,
      originalSuite: { sha256: suiteSha, testIds: suite.tests.map((test) => test.id) },
      states,
      vectors: expectedVectors(inputs.fixture, inputs.probes),
      profileSha256: profileSha256(),
      deadlineAt: utcSeconds(started + 86_400_000),
    };
    const kit = buildJob("kit-check", ctx);
    writeJobDir(jobPaths(options.work, "kit-check").job, kit);
    const kitCopies = await runCopies(plansFor(env, kit, kit.expected.trials), options.concurrency, deps);
    const kitDone = finishJob(env, kit, kitCopies);
    summary.jobs.push(kitDone.summary);

    const baselineSha = kitDone.imported.evidence_sha256;
    if (baselineSha === null) {
      complete = false;
      deps.log("observe refused: the kit check's records did not import, so there is no baseline");
    } else {
      const observe = buildJob("observe", ctx, { key: BASELINE_KEY, sha256: baselineSha });
      writeJobDir(jobPaths(options.work, "observe").job, observe);
      const baseline = checkBaseline(options.work, observe.request);
      if (baseline.ok) {
        const observeCopies = await runCopies(plansFor(env, observe, observe.expected.trials), options.concurrency, deps);
        summary.jobs.push(finishJob(env, observe, observeCopies).summary);
      } else {
        deps.log(`observe refused: ${baseline.detail}`);
        summary.jobs.push(jobSummary(observe, [], [], null, { reason: baseline.reason, detail: baseline.detail }));
      }
    }

    const admission = buildJob("admission", ctx);
    const alternative = buildJob("alternative-fix", ctx);
    writeJobDir(jobPaths(options.work, "admission").job, admission);
    writeJobDir(jobPaths(options.work, "alternative-fix").job, alternative);
    const alternativeTrials = alternative.expected.trials.filter((trial) => trial.trial_id === "fixed-01");
    const plans = [...plansFor(env, admission, admission.expected.trials), ...plansFor(env, alternative, alternativeTrials)];
    const copies = await runCopies(plans, options.concurrency, deps);
    const admissionDone = finishJob(env, admission, copies.filter((copy) => copy.job === "admission"));
    const alternativeDone = finishJob(env, alternative, copies.filter((copy) => copy.job === "alternative-fix"));
    summary.jobs.push(admissionDone.summary, alternativeDone.summary);
    summary.admission = admissionSummary(admissionDone.imported);
    const alternativeTrial = alternativeDone.summary.import.trials.find((trial) => trial.trial_id === "fixed-01");
    summary.alternative_fix =
      alternativeTrial === undefined
        ? null
        : {
            trial_id: alternativeTrial.trial_id,
            status: alternativeTrial.status,
            added_verdict: alternativeTrial.added_verdict,
            original_failed: alternativeTrial.original_failed,
            passes_every_check:
              alternativeTrial.status === "complete" && alternativeTrial.added_verdict === "match" && alternativeTrial.original_executed > 0 && alternativeTrial.original_failed === 0,
          };
    summary.candidate_text = await candidateText(env, admission);
    deps.log(`candidate text ${summary.candidate_text.status}`);
  } catch (error) {
    return fail("jobs", error);
  }
  return finish();
}
