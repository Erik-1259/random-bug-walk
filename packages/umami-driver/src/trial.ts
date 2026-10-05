// One trial for one app copy: build, start and wait for readiness, the original suite, a reset and
// the added-check rounds, stop, then the records. Status is evidence, never a verdict: the first
// problem, in phase order, decides it, and an unexpected pass or failure is simply recorded.
//
// The output directory is a record set as the admission importer reads it: request.json, the
// expected trials at the request's key, and results/<trial_id>/ with the trial result, its
// observations, its artifact manifest and every listed artifact. Every key is relative to the
// output directory, and every record is checked with the shared schema before it is written.
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertRecord, encodeCanonical, sha256Hex } from "@rbw/schema";
import type { ArtifactManifest, CheckObservation, TrialObservations, TrialReason, TrialResult } from "@rbw/schema";
import { ArtifactStore } from "./artifacts.ts";
import { checkSuiteIsolation, closureIntegrity, integrityProblems, prepareSuiteCopy, probeAnalyticsQuery } from "./closure.ts";
import type { ClosureIntegrity, ImportProbe } from "./closure.ts";
import { compareSuiteRun } from "./compare.ts";
import { suiteEnvironmentManifest, suiteProcessEnv } from "./environment.ts";
import type { VerifiedIdentity } from "./environment.ts";
import { fixtureCommand } from "./fixture.ts";
import type { AdminCredentials } from "./fixture.ts";
import { harnessFiles, harnessHashes } from "./harness.ts";
import { REQUEST_KEY, RefusedInput } from "./job.ts";
import type { JobInput } from "./job.ts";
import { DEFAULT_PHASE_LIMITS, createBudget, iso } from "./limits.ts";
import type { LimitsMode, PhaseHandle, PhaseLimits, PhaseTiming, Timers } from "./limits.ts";
import { ManifestError, parseSuiteManifest } from "./manifest.ts";
import type { SuiteManifest } from "./manifest.ts";
import { ReportError, parsePlaywrightReport } from "./playwright-report.ts";
import type { ParsedReport } from "./playwright-report.ts";
import { STREAM_LIMIT_BYTES } from "./process.ts";
import type { CommandResult, ProcessRunner, StopRecord } from "./process.ts";
import { notRun, runAddedRounds } from "./rounds.ts";
import type { Problem } from "./rounds.ts";
import { startSampler } from "./samples.ts";
import type { SampleSources } from "./samples.ts";
import { statusForReason } from "./status.ts";

/** The record keys of one trial, relative to the record set's root. */
export function trialKeys(trialId: string) {
  const base = `results/${trialId}`;
  return {
    result: `${base}/trial-result.json`,
    observations: `${base}/observations.json`,
    artifacts: `${base}/artifacts.json`,
    artifactDir: `${base}/artifacts`,
  };
}

/** The kind of the per-test outcomes artifact, in the format @rbw/admission reads (src/original-suite.ts). */
export const ORIGINAL_SUITE_OUTCOMES_KIND = "original_suite_outcomes";

export interface StepResult {
  reason: TrialReason | null;
  detail: string;
  logs: { name: string; result: CommandResult }[];
}

export interface StopReport {
  /** True only when every process the stack started was stopped and confirmed gone. */
  ok: boolean;
  records: StopRecord[];
  logs: StepResult["logs"];
}

/** The app copy's processes. The kit stack runs the kit's own scripts; tests use a fake. */
export interface AppStack {
  readonly kind: "kit" | "external";
  readonly baseUrl: string;
  build(signal: AbortSignal): Promise<StepResult>;
  /** Starts Postgres and Umami, waits for /api/heartbeat, and prepares the fixture's reset. */
  start(signal: AbortSignal): Promise<StepResult>;
  verifyIdentity(): Promise<VerifiedIdentity | null>;
  /** Resets the fixture to a clean migrated baseline before a round. */
  resetFixture(repeatIndex: number, signal: AbortSignal): Promise<StepResult>;
  /** Stops every process the stack started and confirms each has ended. */
  stop(): Promise<StopReport>;
  /** Log files the stack's processes write, kept as artifacts up to the stream limit. */
  logFiles(): { name: string; path: string }[];
}

export interface FixtureOptions {
  dir: string;
  configPath: string;
  admin: AdminCredentials;
}

export interface TrialOptions {
  job: JobInput;
  /** The record set's root. It must be absent or empty. */
  outDir: string;
  /** The frozen suite manifest's bytes and SHA-256. */
  suite: { bytes: Uint8Array; sha256: string };
  /** The verifier's staged closure. */
  closureDir: string;
  /** The verifier's package.json, copied into each suite copy as its module marker. */
  markerFile: string;
  verifierNodeModules: string;
  verifierLockFile: string;
  appDir: string;
  /** The verifier's own Node, which runs Playwright. */
  nodePath: string;
  nodeVersion: string;
  limitsMode: LimitsMode;
  limits?: PhaseLimits | undefined;
  /** A development run (an external app, or another app or verifier directory); recorded in the phase timings. */
  development: boolean;
  /** Null only in development, when the added checks are not run. */
  fixture: FixtureOptions | null;
  /** The fixture package's computed hash; null when no fixture is used. */
  addedSuiteSha256: string | null;
  artifactLimitBytes?: number | undefined;
  samples: { sources: SampleSources; cgroupDir: string; paths: string[] };
}

export interface TrialDeps {
  timers: Timers;
  runner: ProcessRunner;
  stack: AppStack;
}

export interface TrialOutcome {
  result: TrialResult;
  observations: TrialObservations;
  artifacts: ArtifactManifest;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameCanonical(a: unknown, b: unknown): boolean {
  return Buffer.from(encodeCanonical(a)).equals(Buffer.from(encodeCanonical(b)));
}

async function checkInput(options: TrialOptions, stack: AppStack, marker: Uint8Array): Promise<SuiteManifest> {
  const { suite } = options;
  const trial = options.job.trial;
  if (sha256Hex(suite.bytes) !== suite.sha256) throw new RefusedInput("the suite manifest's bytes do not match its hash");
  let manifest: SuiteManifest;
  try {
    manifest = parseSuiteManifest(suite.bytes);
  } catch (error) {
    if (error instanceof ManifestError) throw new RefusedInput(error.message);
    throw error;
  }
  if (trial.original_suite_sha256 !== null) {
    if (trial.original_suite_sha256 !== suite.sha256) {
      throw new RefusedInput("the trial's original_suite_sha256 differs from the frozen manifest's SHA-256");
    }
    if (!sameIds(trial.original_test_ids, manifest.tests.map((test) => test.id))) {
      throw new RefusedInput("the trial's original_test_ids differ from the frozen manifest's tests");
    }
  }
  const environment = suiteEnvironmentManifest({ baseUrl: stack.baseUrl, nodeVersion: options.nodeVersion });
  if (!sameCanonical(environment, manifest.environment)) {
    throw new RefusedInput("this run's runner environment differs from the frozen manifest's (base URL or Node version)");
  }
  if (!sameCanonical(harnessHashes(marker), manifest.harness)) {
    throw new RefusedInput("the harness files (wrapper config or module marker) differ from the frozen manifest's");
  }
  if (sha256Hex(await readFile(options.verifierLockFile)) !== manifest.verifier_lock_sha256) {
    throw new RefusedInput("the verifier dependency lock differs from the frozen manifest's");
  }
  if (options.fixture !== null && options.addedSuiteSha256 !== trial.added_suite_sha256) {
    throw new RefusedInput("the trial's added_suite_sha256 differs from the fixture package's hash");
  }
  if (existsSync(options.outDir) && readdirSync(options.outDir).length > 0) {
    throw new RefusedInput("the output directory is not empty");
  }
  return manifest;
}

interface SuiteDiagnostics {
  closure_integrity: ClosureIntegrity | null;
  isolation: string[];
  analytics_query: ImportProbe | null;
  missing_tests: string[];
  skipped_tests: string[];
  unlisted_tests: string[];
}

async function runOriginalSuite(
  options: TrialOptions,
  deps: TrialDeps,
  context: { manifest: SuiteManifest; marker: Uint8Array; workDir: string },
  store: ArtifactStore,
  signal: AbortSignal,
  diagnostics: SuiteDiagnostics,
): Promise<Problem[]> {
  const phase = "original_suite";
  const { manifest, workDir } = context;
  const trial = options.job.trial;
  const suiteDir = join(workDir, "suite");
  const reportFile = join(workDir, "original-report.json");
  const harness = harnessFiles(context.marker);
  await prepareSuiteCopy({
    closureDir: options.closureDir,
    suiteDir,
    verifierNodeModules: options.verifierNodeModules,
    closurePaths: Object.keys(manifest.closure),
    harness,
  });
  const integrity = await closureIntegrity(suiteDir, manifest.closure, harness);
  diagnostics.closure_integrity = integrity;
  diagnostics.isolation = checkSuiteIsolation({ suiteDir, appDir: options.appDir, verifierNodeModules: options.verifierNodeModules });
  diagnostics.analytics_query = probeAnalyticsQuery(suiteDir);
  if (diagnostics.isolation.length > 0) {
    return [{ phase, reason: "unrelated_failure", detail: "the suite copy is not isolated from the app copy; the suite was not run" }];
  }
  const identity = await deps.stack.verifyIdentity();
  if (identity === null) {
    return [{ phase, reason: "startup_failed", detail: "the app copy's identity check failed; the suite was not run" }];
  }
  const env = suiteProcessEnv(manifest.environment, { suite_dir: suiteDir, report_file: reportFile }, identity);
  const result = await deps.runner.run({
    command: options.nodePath,
    args: [join(suiteDir, manifest.environment.playwright_cli), ...manifest.environment.run_args],
    cwd: suiteDir,
    env,
    signal,
  });
  await store.addStream("stdout", "original/runner.stdout.txt", result.stdout);
  await store.addStream("stderr", "original/runner.stderr.txt", result.stderr);
  await store.addBytes(
    "environment",
    "original/environment.json",
    encodeCanonical({
      manifest: manifest.environment,
      identity: { kind: identity.kind, base_url: identity.base_url, host: identity.host, port: identity.port, pid: identity.pid },
      analytics_query: diagnostics.analytics_query,
    }),
    "application/json",
  );
  const problems: Problem[] = [];
  const file = await store.addFile("test_report", "original/report.json", reportFile, "application/json");
  let report: ParsedReport | null = null;
  if (file.status === "refused") {
    problems.push({ phase, reason: "limit_exceeded", detail: "the suite report was refused by the size limit" });
  } else if (file.bytes === null) {
    problems.push({ phase, reason: "artifact_missing", detail: "the suite wrote no report" });
  } else {
    try {
      report = parsePlaywrightReport(file.bytes.toString("utf8"), "tests/api/");
    } catch (error) {
      if (!(error instanceof ReportError)) throw error;
      problems.push({ phase, reason: "artifact_missing", detail: `the suite report is unreadable (${error.message})` });
    }
  }
  const comparison = compareSuiteRun(manifest.tests, report ?? { tests: [], error_count: 0 });
  diagnostics.missing_tests = comparison.missing;
  diagnostics.skipped_tests = comparison.skipped;
  diagnostics.unlisted_tests = comparison.unlisted;
  // Only executed and skipped tests are listed; a test that did not execute is absent, never passed.
  const tests = comparison.outcomes
    .flatMap((outcome) => (outcome.outcome === "not_executed" ? [] : [{ test_id: outcome.id, outcome: outcome.outcome }]))
    .sort((a, b) => (a.test_id < b.test_id ? -1 : a.test_id > b.test_id ? 1 : 0));
  await store.addBytes(
    ORIGINAL_SUITE_OUTCOMES_KIND,
    "original/outcomes.json",
    encodeCanonical({ schema_version: 1, trial_id: trial.trial_id, original_suite_sha256: trial.original_suite_sha256, tests }),
    "application/json",
  );
  if (report !== null && comparison.reason !== null) {
    problems.push({
      phase,
      reason: comparison.reason,
      detail: `${String(comparison.missing.length)} manifest tests missing, ${String(comparison.skipped.length)} skipped`,
    });
  }
  if (integrityProblems(integrity) > 0) {
    problems.push({ phase, reason: "artifact_hash_mismatch", detail: "the suite copy differs from the frozen closure" });
  }
  return problems;
}

async function storeLogs(store: ArtifactStore, phase: string, logs: StepResult["logs"]): Promise<void> {
  for (const log of logs) {
    await store.addStream("stdout", `${phase}/${log.name}.stdout.txt`, log.result.stdout);
    await store.addStream("stderr", `${phase}/${log.name}.stderr.txt`, log.result.stderr);
  }
}

/** Every expected check in every round as not run, for a trial whose rounds never ran. */
function allNotRun(options: TrialOptions): CheckObservation[] {
  const trial = options.job.trial;
  return Array.from({ length: trial.added_repeat_count }, (_, index) =>
    trial.expected_checks.map((check) => notRun(check.check_id, index + 1)),
  ).flat();
}

/** The shared record's order: by repeat_index, then check_id in code point order. */
function sortObservations(observations: CheckObservation[]): CheckObservation[] {
  return [...observations].sort(
    (a, b) => a.repeat_index - b.repeat_index || (a.check_id < b.check_id ? -1 : a.check_id > b.check_id ? 1 : 0),
  );
}

/**
 * Ends a phase and records a timeout or overrun as the phase's first problem. Returns true when
 * later phases must not run: the phase failed or was stopped. A record-only overrun is recorded
 * but does not block, since that mode exists to measure the true duration of every phase.
 */
function endPhase(handle: PhaseHandle, failed: boolean, timings: PhaseTiming[], problems: Problem[], phaseProblems: Problem[]): boolean {
  const timing = handle.end(failed ? "failed" : "ok");
  timings.push(timing);
  if (timing.outcome === "timeout" || timing.outcome === "overrun") {
    const how = timing.outcome === "timeout" ? "was stopped at" : "ran past";
    problems.push({
      phase: timing.name,
      reason: "timeout",
      detail: `${timing.name} ${how} its deadline after ${String(timing.duration_ms)} ms (limit ${String(timing.limit_ms)} ms)`,
    });
  }
  problems.push(...phaseProblems);
  return phaseProblems.length > 0 || timing.outcome === "timeout";
}

async function writeKey(outDir: string, key: string, bytes: Uint8Array): Promise<void> {
  const path = join(outDir, ...key.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { mode: 0o600 });
}

export async function runTrial(options: TrialOptions, deps: TrialDeps): Promise<TrialOutcome> {
  const { job, outDir } = options;
  const { request, trial } = job;
  const { timers, stack } = deps;
  const marker = await readFile(options.markerFile);
  const manifest = await checkInput(options, stack, marker);
  const limits = options.limits ?? DEFAULT_PHASE_LIMITS;
  const keys = trialKeys(trial.trial_id);
  const workDir = join(outDir, "work", trial.trial_id);
  const store = new ArtifactStore(outDir, keys.artifactDir, options.artifactLimitBytes);
  const budget = createBudget({ timers, mode: options.limitsMode, totalMs: limits.total_ms });
  const sampler = startSampler({ timers, ...options.samples });
  const problems: Problem[] = [];
  const timings: PhaseTiming[] = [];
  const diagnostics: SuiteDiagnostics = {
    closure_integrity: null,
    isolation: [],
    analytics_query: null,
    missing_tests: [],
    skipped_tests: [],
    unlisted_tests: [],
  };
  let observations: CheckObservation[] | null = null;

  if (trial.original_suite_sha256 !== null) {
    await store.addBytes("suite_manifest", "original/suite-manifest.json", options.suite.bytes, "application/json");
  }

  try {
    const build = budget.begin("build", limits.build_ms);
    const built = await stack.build(build.signal);
    await storeLogs(store, "build", built.logs);
    let blocked = endPhase(build, built.reason !== null, timings, problems, built.reason === null ? [] : [{ phase: "build", reason: built.reason, detail: built.detail }]);

    if (!blocked) {
      const readiness = budget.begin("readiness", limits.readiness_ms);
      const started = await stack.start(readiness.signal);
      await storeLogs(store, "readiness", started.logs);
      blocked = endPhase(readiness, started.reason !== null, timings, problems, started.reason === null ? [] : [{ phase: "readiness", reason: started.reason, detail: started.detail }]);
    }

    if (!blocked) {
      const tests = budget.begin("tests", limits.tests_ms);
      const phaseProblems: Problem[] = [];
      if (trial.original_suite_sha256 !== null) {
        const suite = budget.begin("original_suite", null);
        const suiteProblems = await runOriginalSuite(options, deps, { manifest, marker, workDir }, store, tests.signal, diagnostics);
        timings.push(suite.end(suiteProblems.length === 0 ? "ok" : "failed"));
        phaseProblems.push(...suiteProblems);
      }
      const fixture = options.fixture;
      if (fixture === null) {
        observations = allNotRun(options);
        phaseProblems.push({ phase: "tests", reason: "artifact_missing", detail: "the added checks were not run (development run without a fixture)" });
      } else {
        const rounds = await runAddedRounds({
          checks: trial.expected_checks,
          repeatCount: trial.added_repeat_count,
          workDir: join(workDir, "added"),
          store,
          signal: tests.signal,
          timers,
          reset: async (repeatIndex, signal) => {
            const step = await stack.resetFixture(repeatIndex, signal);
            await storeLogs(store, `added/reset-${String(repeatIndex).padStart(2, "0")}`, step.logs);
            return step.reason;
          },
          runRound: (repeatIndex, dirs, signal) =>
            deps.runner.run({
              ...fixtureCommand({
                nodePath: options.nodePath,
                verifierNodeModules: options.verifierNodeModules,
                configPath: fixture.configPath,
                cwd: fixture.dir,
                baseUrl: stack.baseUrl,
                repeatIndex,
                outputDir: dirs.output,
                tmpDir: dirs.tmp,
                admin: fixture.admin,
              }),
              signal,
            }),
        });
        observations = rounds.observations;
        timings.push(...rounds.rounds);
        phaseProblems.push(...rounds.problems);
      }
      endPhase(tests, false, timings, problems, phaseProblems);
    }
  } catch (error) {
    // An unexpected error writes no records, but the app copy's processes must still be stopped.
    await stack.stop();
    await sampler.stop();
    budget.close();
    throw error;
  }

  const stop = budget.begin("stop", limits.finish_ms);
  const stopped = await stack.stop();
  endPhase(stop, !stopped.ok, timings, problems, []);
  await storeLogs(store, "stop", stopped.logs);
  for (const log of stack.logFiles()) {
    await store.addFile("log", `processes/${log.name}.log`, log.path, "text/plain", STREAM_LIMIT_BYTES);
  }
  const samples = await sampler.stop();
  await rm(join(outDir, "work"), { recursive: true, force: true });

  observations ??= allNotRun(options);
  if (store.limitExceeded() && !problems.some((problem) => problem.reason === "limit_exceeded")) {
    problems.push({ phase: "records", reason: "limit_exceeded", detail: "artifacts were refused by the per-trial size limit" });
  }

  const development = options.development || options.limitsMode === "record-only";
  await store.addBytes(
    "phase_timings",
    "phase-timings.json",
    encodeCanonical({
      app: stack.kind,
      copy: budget.copy(),
      development_measurement: development,
      limits,
      limits_mode: options.limitsMode,
      phases: timings,
      sample_interval_ms: 30000,
      samples,
    }),
    "application/json",
    true,
  );
  await store.addBytes(
    "diagnostics",
    "diagnostics.json",
    encodeCanonical({
      ...diagnostics,
      problems,
      refused_artifacts: store.refused(),
      stops: stopped.records,
      truncated_artifacts: store.truncated(),
    }),
    "application/json",
    true,
  );

  const observationsRecord = assertRecord(
    "TrialObservations",
    { schema_version: 1, execution_id: request.execution_id, trial_id: trial.trial_id, observations: sortObservations(observations) },
    { request },
  );
  const observationBytes = encodeCanonical(observationsRecord);
  const artifacts = assertRecord(
    "ArtifactManifest",
    {
      schema_version: 1,
      project_policy_sha256: request.project_policy_sha256,
      root_execution_id: request.root_execution_id,
      execution_id: request.execution_id,
      task_revision: request.task_revision,
      trial_id: trial.trial_id,
      entries: store.entries(),
    },
    { request },
  );
  const artifactBytes = encodeCanonical(artifacts);
  const reason = problems[0]?.reason ?? null;
  const result = assertRecord(
    "TrialResult",
    {
      schema_version: 1,
      project_policy_sha256: request.project_policy_sha256,
      root_execution_id: request.root_execution_id,
      execution_id: request.execution_id,
      task_revision: request.task_revision,
      trial_id: trial.trial_id,
      code_state: trial.code_state,
      status: statusForReason(reason),
      expected_trials_sha256: request.expected_trials_sha256,
      observations_key: keys.observations,
      observations_sha256: sha256Hex(observationBytes),
      artifacts_key: keys.artifacts,
      artifacts_sha256: sha256Hex(artifactBytes),
      invalid_reason: reason,
      started_at: budget.copy().started_at,
      ended_at: iso(timers.now()),
    },
    { request },
  );
  await writeKey(outDir, REQUEST_KEY, job.requestBytes);
  await writeKey(outDir, request.expected_trials_key, job.expectedTrialsBytes);
  await writeKey(outDir, keys.observations, observationBytes);
  await writeKey(outDir, keys.artifacts, artifactBytes);
  await writeKey(outDir, keys.result, encodeCanonical(result));
  return { result, observations: observationsRecord, artifacts };
}
