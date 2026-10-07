// The trusted controller: one job (kit check, observation, admission or judge replay) end to end,
// one app copy at a time, against the spend ledger. It builds the job with the local runner's
// builders, runs each copy through the local runner's run-copy path (on Vercel Sandbox, or on
// Docker for local checks), imports the job's record set with @rbw/admission, and writes one
// summary. Per copy, it reserves the copy's priced envelope before the create, records the launch,
// the sandbox as a child resource and its confirmed stop, and settles from the measured lifetime.
// An uncertain launch stops the job with the slot and the reservation held. Nothing is retried.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toReserveRequest } from "@rbw/envelope";
import type { Rates } from "@rbw/envelope";
import {
  BASELINE_KEY,
  CodeStateRefusal,
  ExportError,
  InputsError,
  JobRefusal,
  PlanError,
  buildJob,
  containerName,
  deriveCodeStates,
  expectedVectors,
  exportImage,
  importJob,
  inspectImage,
  loadCopyInputs,
  mergeRecordSet,
  newRunIds,
  profileSha256,
  runCopy,
  runCopyCommand,
  runTag,
  summaryBytes,
  trialSummaries,
  utcSeconds,
  writeJobDir,
} from "@rbw/local-runner";
import type { BuiltJob, Clock, CopyResult, CopySummary, Docker, JobContext, JobLabel, RunCopyOutcome, RunIds, SandboxSdk, TrialSummary } from "@rbw/local-runner";
import { buildJobRequest, callName, canonicalDigest, operationId, parseCanonical, providerCallIdentity, sha256Hex } from "@rbw/schema";
import type { ExpectedTrial, JobKind } from "@rbw/schema";
import type { OperationState, Refusal, Result, Spend } from "@rbw/spend";
import { addedSuiteSha256, parseSuiteManifest } from "@rbw/umami-driver";
import { FIXTURE_FILE, loadFixture } from "@rbw/umami-fixture";
import { copyEnvelope, copySettlement } from "./envelope.ts";
import type { CopyEnvelope } from "./envelope.ts";
import { LaunchWatch, watchedDocker, watchedSandbox } from "./launch.ts";
import { JOB_LIMITS, launchDecision } from "./limits.ts";
import type { LedgerTarget } from "./limits.ts";

export type Backend = "docker" | "sandbox";
export type JobStatus = "complete" | "incomplete" | "needs_reconciliation" | "refused";
export type Launch = "not_launched" | "confirmed" | "uncertain";

export interface JobInputs {
  kind: JobKind;
  /** The run directory: the job goes in jobs/<name>/, and an observation's baseline is read from jobs/kit-check/. */
  work: string;
  /** The job's directory name and call-name segment (lowercase letters, digits and hyphens). */
  name: string;
  /** The local kit image, a tag or a digest. */
  image: string;
  manifest: string;
  terms: string;
  policy: string | null;
  kitStage: string;
  /** The driver's frozen original-suite manifest; when null, a local Docker freeze copy makes it. */
  originalSuite: string | null;
  probesDir?: string;
  /** The fix a judge replay grades as fixed-01 (the alternative-fix layout); the local runner's alternative fix by default. */
  alternativeDir?: string;
  backend: Backend;
  /** For the sandbox backend: the kit image in VCR, pinned by digest. */
  sandboxImage: string | null;
  /** A subset of the kind's trials, in profile order; null runs all of them. */
  trials: readonly string[] | null;
  ledger: LedgerTarget;
}

export interface ControllerDeps {
  docker: Docker;
  clock: Clock;
  uuid: () => string;
  spend: Spend;
  /** Whether the spend ledger is the database in DATABASE_URL or an in-memory one (Docker checks). */
  ledgerKind: "database" | "in_memory";
  rates: Rates;
  /** Needed for the sandbox backend. */
  sandbox?: SandboxSdk;
  log: (line: string) => void;
}

export interface CopyRecord {
  trial_id: string;
  code_state: string;
  operation_id: string;
  call_name: string;
  /** The copy's status from run-copy, or `not_run` when it never returned one. */
  status: string;
  reason: string | null;
  launch: Launch;
  child_resource_id: string | null;
  stop_confirmed: boolean | null;
  phases_ms: Record<string, number>;
  /** From the create call until run-copy returned after the stop: what the copy is settled from. */
  live_ms: number | null;
  reserved_microusd: number | null;
  settled_microusd: number | null;
  ledger_state: OperationState | null;
  ledger_detail: string | null;
  refusal: { reason: string; detail: string } | null;
  copy: CopySummary | null;
}

export interface ControllerSummary {
  schema_version: 1;
  label: "development_evidence";
  note: string;
  admission_claim: false;
  published: false;
  status: JobStatus;
  reason: string | null;
  detail: string | null;
  job: {
    name: string;
    kind: JobKind;
    execution_id: string;
    root_execution_id: string;
    task_revision: string | null;
    request_sha256: string | null;
    expected_trials_sha256: string | null;
    deadline_at: string | null;
    baseline: { key: string; sha256: string } | null;
    trials: string[];
  };
  controller: {
    backend: Backend;
    sandbox_image: string | null;
    ledger: "database" | "in_memory";
    pool_key: string;
    allocation_key: string | null;
    slot_key: string;
    controller_ms: number;
    ceiling_microusd: number;
    max_copies: number;
    copy_reserved_microusd: number | null;
    started_at: string;
    ended_at: string;
  };
  image: { reference: string; digest: string | null; kit_sha256: string | null };
  original_suite: { sha256: string; test_count: number; source: "file" | "freeze" } | null;
  copies: CopyRecord[];
  import: { refusal: string | null; evidence_sha256: string | null; decision_sha256: string | null; trials: TrialSummary[] };
  spend: { reserved_microusd: number; settled_microusd: number; open_microusd: number };
  slot: { key: string; acquired: boolean; released: boolean; blockers: { child_resources: string[]; operation_ids: string[] } | null };
}

export interface JobOutcome {
  /** 0 when the job is complete; 1 otherwise. */
  exitCode: number;
  /** True when the work directory already held this job and nothing ran. */
  replay: boolean;
  status: JobStatus;
  summary: ControllerSummary;
  work: string;
  jobDir: string;
}

const NOTE =
  "Development evidence from the trusted controller. It makes no admission claim and is not published, and the planted bug is synthetic. With the in-memory ledger (Docker checks), the amounts are what the same copies would reserve and settle on Vercel Sandbox.";
const ACTOR = "controller";
const COPY_KIND = "sandbox.copy";
const NOT_APPLICABLE = { verdict: "not_applicable", reason: "no_declared_change", report_sha256: null, findings: 0 } as const;

/** The local runner's job label for each kind; it names the copies' sandboxes and containers. */
const LABELS: Readonly<Record<JobKind, JobLabel>> = { kit_check: "kit-check", observe: "observe", admission: "admission", judge_verify: "alternative-fix" };

/** A ledger call that threw: the outcome of the call is unknown. Only the driver's error code is kept. */
class LedgerUnavailable extends Error {
  override name = "LedgerUnavailable";
}

async function ledger<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(error.code) ? error.code : "unknown";
    throw new LedgerUnavailable(`a spend ledger call failed (driver error code ${code})`);
  }
}

function refusalText(result: Refusal): string {
  return result.detail === undefined ? result.code : `${result.code}: ${result.detail}`;
}

interface Paths {
  base: string;
  state: string;
  summary: string;
  job: string;
  records: string;
  copies: string;
  stops: string;
}

function paths(work: string, name: string): Paths {
  const base = join(work, "jobs", name);
  return {
    base,
    state: join(base, "controller.json"),
    summary: join(base, "summary.json"),
    job: join(base, "job"),
    records: join(base, "records"),
    copies: join(base, "copies"),
    stops: join(base, "stops"),
  };
}

interface ControllerState {
  schema_version: 1;
  fingerprint: string;
  kind: JobKind;
  name: string;
  ids: RunIds;
  trials: string[] | null;
}

function exitCode(status: JobStatus): number {
  return status === "complete" ? 0 : 1;
}

/** The image's content digest, or null when Docker cannot inspect it (the build then refuses the job). */
async function imageDigest(docker: Docker, image: string): Promise<string | null> {
  try {
    return await inspectImage(docker, image);
  } catch (error) {
    if (error instanceof PlanError) return null;
    throw error;
  }
}

function fileSha(path: string | null): string | null {
  return path === null ? null : sha256Hex(readFileSync(path));
}

/** The copy's operation: its call name, operation ID and payload hash, derived from the job request. */
function copyOperation(built: BuiltJob, name: string, trialId: string, envelope: CopyEnvelope, target: string): { call_name: string; operation_id: string; payload_hash: string } {
  const request = built.request;
  const call = callName(COPY_KIND, name, trialId);
  const identity = providerCallIdentity({
    project_id: request.project_id,
    project_policy_sha256: request.project_policy_sha256,
    root_execution_id: request.root_execution_id,
    batch_id: request.batch_id,
    task_revision: request.task_revision,
    kind: COPY_KIND,
    runtime_profile_sha256: envelope.runtime_profile_sha256,
    attempt_ordinal: 1,
    call_name: call,
  });
  const payload = canonicalDigest({ job_request_sha256: built.requestSha256, trial_id: trialId, target, envelope: envelope.lines });
  return { call_name: call, operation_id: operationId(identity).sha256, payload_hash: payload.sha256 };
}

/** The job request with the reservation the controller actually makes for it. */
function withReservation(built: BuiltJob, reservation: number): BuiltJob {
  // The builder computes operation_id and payload_hash again, so the copied values are replaced.
  const rebuilt = buildJobRequest({ ...built.request, reservation_microusd: reservation });
  return { ...built, request: rebuilt.request, requestBytes: rebuilt.bytes, requestSha256: rebuilt.sha256 };
}

/** run-copy's summary in the shape the local runner's merge reads. */
function asCopyResult(job: string, copy: CopySummary, recordsDir: string | null, workDir: string): CopyResult {
  return {
    job,
    trial_id: copy.trial_id,
    state: copy.state,
    container: copy.container,
    work_dir: workDir,
    status: copy.status,
    reason: copy.reason,
    audit: copy.audit,
    placed_sha256: copy.placed_sha256,
    freeze_exit: copy.freeze_exit,
    driver_exit: copy.driver_exit,
    container_exit: copy.container_exit,
    timed_out: copy.timed_out,
    collected_dir: null,
    records_dir: recordsDir,
    phases: Object.entries(copy.phases_ms).map(([name, durationMs]) => ({ name, duration_ms: durationMs })),
  };
}

/** From the create call to the confirmed stop (or removal): every phase after the audit. */
function lifetimeMs(copy: CopySummary | null): number {
  if (copy === null) return 0;
  return Object.entries(copy.phases_ms).reduce((sum, [name, ms]) => (name === "audit" ? sum : sum + ms), 0);
}

function selectTrials(all: readonly ExpectedTrial[], wanted: readonly string[] | null): ExpectedTrial[] {
  if (wanted === null) return [...all];
  const unknown = wanted.filter((id) => !all.some((trial) => trial.trial_id === id));
  if (unknown.length > 0) throw new JobRefusal(`the job has no trial ${unknown.join(", ")}`);
  return all.filter((trial) => wanted.includes(trial.trial_id));
}

function emptySummary(inputs: JobInputs, deps: ControllerDeps, state: ControllerState, startedAt: string): ControllerSummary {
  const limits = JOB_LIMITS[inputs.kind];
  return {
    schema_version: 1,
    label: "development_evidence",
    note: NOTE,
    admission_claim: false,
    published: false,
    status: "refused",
    reason: null,
    detail: null,
    job: {
      name: inputs.name,
      kind: inputs.kind,
      execution_id: state.ids.executions[LABELS[inputs.kind]],
      root_execution_id: state.ids.root_execution_id,
      task_revision: null,
      request_sha256: null,
      expected_trials_sha256: null,
      deadline_at: null,
      baseline: null,
      trials: [],
    },
    controller: {
      backend: inputs.backend,
      sandbox_image: inputs.sandboxImage,
      ledger: deps.ledgerKind,
      pool_key: inputs.ledger.pool_key,
      allocation_key: inputs.ledger.allocation_key,
      slot_key: inputs.ledger.slot_key,
      controller_ms: limits.controller_ms,
      ceiling_microusd: limits.ceiling_microusd,
      max_copies: limits.max_copies,
      copy_reserved_microusd: null,
      started_at: startedAt,
      ended_at: startedAt,
    },
    image: { reference: inputs.image, digest: null, kit_sha256: null },
    original_suite: null,
    copies: [],
    import: { refusal: null, evidence_sha256: null, decision_sha256: null, trials: [] },
    spend: { reserved_microusd: 0, settled_microusd: 0, open_microusd: 0 },
    slot: { key: inputs.ledger.slot_key, acquired: false, released: false, blockers: null },
  };
}

interface Built {
  job: BuiltJob;
  trials: ExpectedTrial[];
  digest: string;
  envelope: CopyEnvelope;
}

/** Inspects and exports the image, freezes the original suite when none is given, and builds the job with the local runner's builders. */
async function build(inputs: JobInputs, deps: ControllerDeps, state: ControllerState, p: Paths, summary: ControllerSummary, deadlineMs: number): Promise<Built> {
  const copyInputs = loadCopyInputs(inputs);
  const envelope = copyEnvelope(deps.rates);
  if (!envelope.ok) throw new JobRefusal(`the copy envelope was refused (${envelope.code})`);
  const tag = runTag(state.ids.root_execution_id);
  const digest = await inspectImage(deps.docker, inputs.image);
  summary.image.digest = digest;
  const exported = await exportImage(deps.docker, { image: digest, container: containerName(tag, inputs.name, "export"), dest: join(p.base, "source") });
  const kitSha256 = sha256Hex(exported.image_manifest);
  summary.image.kit_sha256 = kitSha256;
  const states = deriveCodeStates(readFileSync(join(exported.source_dir, copyInputs.probes.data.target_path)), copyInputs.probes, copyInputs.alternative);

  let suiteBytes: Buffer;
  if (inputs.originalSuite === null) {
    const freeze = await runCopy(
      {
        job: "freeze",
        trial_id: "freeze",
        state: "clean",
        container: containerName(tag, inputs.name, "freeze"),
        image: digest,
        mode: "freeze",
        work_dir: join(p.base, "freeze"),
        job_dir: null,
        placement: null,
        audit: () => Promise.resolve(NOT_APPLICABLE),
      },
      { docker: deps.docker, clock: deps.clock },
    );
    if (freeze.status !== "complete" || freeze.collected_dir === null) throw new PlanError(`the freeze copy ended ${freeze.status} (${freeze.reason ?? "-"})`);
    suiteBytes = readFileSync(join(freeze.collected_dir, "original-suite.json"));
  } else {
    suiteBytes = readFileSync(inputs.originalSuite);
  }
  const suite = parseSuiteManifest(suiteBytes);
  summary.original_suite = { sha256: sha256Hex(suiteBytes), test_count: suite.tests.length, source: inputs.originalSuite === null ? "freeze" : "file" };

  const fixtureDir = join(inputs.kitStage, "umami-fixture");
  if (!existsSync(fixtureDir)) throw new InputsError("the kit stage has no umami-fixture directory (run the driver's stage-kit.ts)");
  const ctx: JobContext = {
    ids: state.ids,
    imageDigest: digest,
    kitSha256,
    fixtureSha256: sha256Hex(readFileSync(FIXTURE_FILE)),
    addedSuiteSha256: await addedSuiteSha256(fixtureDir),
    originalSuite: { sha256: sha256Hex(suiteBytes), testIds: suite.tests.map((test) => test.id) },
    states,
    vectors: expectedVectors(loadFixture(), copyInputs.probes),
    profileSha256: profileSha256(),
    deadlineAt: utcSeconds(deadlineMs),
  };
  let baseline: { key: string; sha256: string } | null = null;
  if (inputs.kind === "observe") {
    const path = join(inputs.work, ...BASELINE_KEY.split("/"));
    if (!existsSync(path)) throw new JobRefusal(`baseline_missing: no kit-check evidence at ${BASELINE_KEY} in the run directory`);
    baseline = { key: BASELINE_KEY, sha256: sha256Hex(readFileSync(path)) };
  }
  const first = buildJob(LABELS[inputs.kind], ctx, baseline);
  const trials = selectTrials(first.expected.trials, inputs.trials);
  const limits = JOB_LIMITS[inputs.kind];
  if (trials.length > limits.max_copies) throw new JobRefusal(`too_many_copies: ${String(trials.length)} copies, at most ${String(limits.max_copies)}`);
  const reservation = envelope.reserved_microusd * BigInt(trials.length);
  if (reservation > BigInt(limits.ceiling_microusd)) throw new JobRefusal(`ceiling_exceeded: ${reservation.toString()} micro-USD for ${String(trials.length)} copies, ceiling ${String(limits.ceiling_microusd)}`);
  const job = withReservation(first, Number(reservation));
  writeJobDir(p.job, job);
  return { job, trials, digest, envelope };
}

interface Run {
  inputs: JobInputs;
  deps: ControllerDeps;
  p: Paths;
  built: Built;
  tag: string;
  deadline: number;
  summary: ControllerSummary;
  /** Set when the ledger may not be what the controller believes, or a resource may still run. */
  reconcile: boolean;
  /** Each copy that ran, with its record set when its records count. */
  copyResults: { record: CopyRecord; recordsDir: string | null }[];
}

function stopEvidence(run: Run, trialId: string, copy: CopySummary | null, resource: string): { key: string; sha256: string } {
  mkdirSync(run.p.stops, { recursive: true });
  const bytes = summaryBytes({ trial_id: trialId, resource_id: resource, backend: run.inputs.backend, phases_ms: copy?.phases_ms ?? {}, sandbox: copy?.sandbox ?? null });
  const file = join(run.p.stops, `${trialId}.json`);
  writeFileSync(file, bytes);
  return { key: ["jobs", run.inputs.name, "stops", `${trialId}.json`].join("/"), sha256: sha256Hex(bytes) };
}

/** Records the copy's outcome in the ledger; returns false when the job must stop. */
async function recordOutcome(run: Run, record: CopyRecord, watch: LaunchWatch, outcome: RunCopyOutcome | null): Promise<boolean> {
  const { spend } = run.deps;
  const { slot_key: slotKey } = run.inputs.ledger;
  const root = run.summary.job.root_execution_id;
  const opId = record.operation_id;
  const transition = (from: OperationState, to: OperationState, extra: Record<string, string>) =>
    ledger(() => spend.transition({ operation_id: opId, from_state: from, to_state: to, actor_role: ACTOR, ...extra }));
  const refused = (result: Refusal, state: OperationState): boolean => {
    record.ledger_state = state;
    record.ledger_detail = refusalText(result);
    run.reconcile = true;
    return false;
  };
  const copy = outcome?.copy ?? null;
  const report = copy?.sandbox;
  const resource = containerName(run.tag, LABELS[run.inputs.kind], record.trial_id);

  if (!watch.createCalled) {
    record.launch = "not_launched";
    const terminal = await transition("launching", "terminal", { terminal_status: "cancelled" });
    if (!terminal.ok) return refused(terminal, "launching");
    const settled = await ledger(() => spend.settle(copySettlement(run.built.envelope, opId, { launched: false, lifetime_ms: 0 }, null)));
    if (!settled.ok) return refused(settled, "terminal");
    record.ledger_state = settled.state;
    return true;
  }

  const obtained = run.inputs.backend === "sandbox" ? watch.created || report?.recovered_by_name === true : watch.created;
  // Without the copy's own summary its lifetime is unknown, so the launch counts as uncertain on either backend.
  const confirmed = obtained && copy !== null && (run.inputs.backend === "sandbox" ? report?.stop_confirmed === true : watch.removed === true);
  record.launch = "uncertain";
  record.stop_confirmed = obtained ? confirmed : null;
  record.child_resource_id = obtained ? resource : null;
  if (obtained) {
    const running = await transition("launching", "running", { provider_resource_id: resource });
    if (!running.ok) return refused(running, "launching");
  }
  if (!confirmed) {
    record.launch = "uncertain";
    const uncertain = obtained ? await transition("running", "uncertain", { uncertainty: "unknown_status" }) : await transition("launching", "uncertain", { uncertainty: "lost_response" });
    run.reconcile = true;
    if (!uncertain.ok) return refused(uncertain, obtained ? "running" : "launching");
    record.ledger_state = "uncertain";
    return false;
  }

  record.launch = "confirmed";
  const status = copy.status === "complete" ? "completed" : "failed";
  const evidence = stopEvidence(run, record.trial_id, copy, resource);
  const child = await ledger(() =>
    spend.confirmChild({ slot_key: slotKey, root_execution_id: root, provider: run.inputs.backend === "sandbox" ? "vercel-sandbox" : "docker", resource_id: resource, terminal_status: status, evidence, actor_role: ACTOR }),
  );
  if (!child.ok) return refused(child, "running");
  const terminal = await transition("running", "terminal", { terminal_status: status });
  if (!terminal.ok) return refused(terminal, "running");
  const settled = await ledger(() => spend.settle(copySettlement(run.built.envelope, opId, { launched: true, lifetime_ms: record.live_ms ?? lifetimeMs(copy) }, evidence)));
  if (!settled.ok) return refused(settled, "terminal");
  record.ledger_state = settled.state;
  if (settled.over_envelope) {
    record.ledger_detail = "over_envelope: the settlement exceeded the copy's envelope and halted new work";
    run.reconcile = true;
    return false;
  }
  return true;
}

/** One copy: the deadline check, the reservation and launch record, the copy itself, and its ledger outcome. Returns false when the job must stop. */
async function runOneCopy(run: Run, trial: ExpectedTrial): Promise<{ go: boolean; stop: { reason: string; detail: string } | null }> {
  const { inputs, deps, built } = run;
  const decision = launchDecision(run.deadline - deps.clock.now());
  if (!decision.launch) return { go: false, stop: { reason: decision.reason, detail: `no copy started at ${trial.trial_id}: the child deadline would be ${String(decision.child_ms ?? 0)} ms` } };
  const target = inputs.backend === "sandbox" ? (inputs.sandboxImage ?? "") : built.digest;
  const op = copyOperation(built.job, inputs.name, trial.trial_id, built.envelope, target);
  const record: CopyRecord = {
    trial_id: trial.trial_id,
    code_state: trial.code_state,
    operation_id: op.operation_id,
    call_name: op.call_name,
    status: "not_run",
    reason: null,
    launch: "not_launched",
    child_resource_id: null,
    stop_confirmed: null,
    phases_ms: {},
    live_ms: null,
    reserved_microusd: null,
    settled_microusd: null,
    ledger_state: null,
    ledger_detail: null,
    refusal: null,
    copy: null,
  };
  const request = built.job.request;
  let reserved: Awaited<ReturnType<Spend["reserve"]>>;
  try {
    reserved = await ledger(() =>
    deps.spend.reserve(
      toReserveRequest(built.envelope, {
        ...op,
        attempt_ordinal: 1,
        previous_operation_id: null,
        project_id: request.project_id,
        project_policy_sha256: request.project_policy_sha256,
        batch_id: request.batch_id,
        task_revision: request.task_revision,
        root_execution_id: request.root_execution_id,
        execution_id: request.execution_id,
        parent_execution_id: request.parent_execution_id,
        kind: COPY_KIND,
        provider: inputs.backend === "sandbox" ? "vercel-sandbox" : "docker",
        provider_replay_key: containerName(run.tag, LABELS[inputs.kind], trial.trial_id),
        pool_key: inputs.ledger.pool_key,
        allocation_key: inputs.ledger.allocation_key,
      }),
    ),
  );
  } catch (error) {
    // The reservation may have committed: keep its operation in the summary for reconciliation.
    if (error instanceof LedgerUnavailable) {
      record.ledger_detail = "the reservation's outcome is unknown";
      run.summary.copies.push(record);
    }
    throw error;
  }
  if (!reserved.ok) return { go: false, stop: { reason: `reserve_${reserved.code}`, detail: refusalText(reserved) } };
  run.summary.copies.push(record);
  record.reserved_microusd = Number(reserved.reserved_microusd);
  record.ledger_state = reserved.state;
  if (reserved.replay) {
    record.ledger_detail = "the reservation already existed, so the copy was not launched";
    run.reconcile = true;
    return { go: false, stop: { reason: "operation_exists", detail: `operation ${op.operation_id} was already reserved` } };
  }
  const launching = await ledger(() => deps.spend.transition({ operation_id: op.operation_id, from_state: "prepared", to_state: "launching", actor_role: ACTOR, slot_key: inputs.ledger.slot_key }));
  if (!launching.ok) {
    record.ledger_detail = refusalText(launching);
    run.reconcile = true;
    return { go: false, stop: { reason: `launch_${launching.code}`, detail: refusalText(launching) } };
  }
  record.ledger_state = "launching";

  const watch = new LaunchWatch(() => launchDecision(run.deadline - deps.clock.now()).launch, () => deps.clock.now());
  let outcome: RunCopyOutcome | null = null;
  let failure: string | null = null;
  try {
    outcome = await runCopyCommand(
      {
        job: run.p.job,
        trial: trial.trial_id,
        root: inputs.work,
        image: inputs.image,
        manifest: inputs.manifest,
        terms: inputs.terms,
        policy: inputs.policy,
        ...(inputs.probesDir === undefined ? {} : { probesDir: inputs.probesDir }),
        ...(inputs.alternativeDir === undefined ? {} : { alternativeDir: inputs.alternativeDir }),
        work: join(run.p.copies, trial.trial_id),
        backend: inputs.backend,
        sandboxImage: inputs.sandboxImage,
      },
      { docker: watchedDocker(deps.docker, watch), clock: deps.clock, ...(deps.sandbox === undefined ? {} : { sandbox: watchedSandbox(deps.sandbox, watch) }) },
    );
  } catch (error) {
    // The copy may have made a resource before the error; the ledger records that below, and the job stops.
    if (!(error instanceof Error)) throw error;
    failure = `${error.name}: ${error.message}`;
  }
  record.copy = outcome?.copy ?? null;
  record.refusal = outcome?.refusal ?? null;
  record.status = outcome?.copy?.status ?? (outcome?.refusal === null || outcome === null ? "not_run" : "refused");
  record.reason = outcome?.copy?.reason ?? outcome?.refusal?.reason ?? (failure === null ? null : "copy_error");
  record.phases_ms = outcome?.copy?.phases_ms ?? {};
  // run-copy returns only after the stop, so this covers every untimed step between the phases.
  if (watch.createdAtMs !== null) record.live_ms = Math.max(deps.clock.now() - watch.createdAtMs, lifetimeMs(record.copy));
  run.copyResults.push({ record, recordsDir: outcome?.recordsDir ?? null });
  deps.log(`${inputs.name} ${trial.trial_id} ${record.status}${record.reason === null ? "" : ` ${record.reason}`}`);

  const fine = await recordOutcome(run, record, watch, outcome);
  if (!fine) return { go: false, stop: { reason: record.launch === "uncertain" ? "uncertain_launch" : "ledger_refused", detail: record.ledger_detail ?? `${trial.trial_id}: the launch outcome is not known` } };
  if (failure !== null) return { go: false, stop: { reason: "copy_error", detail: failure } };
  if (watch.refusedAtCreate) {
    const late = launchDecision(run.deadline - deps.clock.now());
    return { go: false, stop: { reason: late.launch ? "child_deadline_short" : late.reason, detail: `the create of ${trial.trial_id} was refused: the child deadline no longer allowed the copy` } };
  }
  return { go: true, stop: null };
}

/** Reads each copy's operation back from the ledger, for its state and the job's spend totals. */
async function readSpend(run: Run): Promise<void> {
  const totals = { reserved_microusd: 0, settled_microusd: 0, open_microusd: 0 };
  for (const record of run.summary.copies) {
    const status = await ledger(() => run.deps.spend.operationStatus({ operation_id: record.operation_id }));
    if (!status.ok) continue;
    record.ledger_state = status.state;
    record.settled_microusd = Number(status.settled_microusd);
    totals.reserved_microusd += Number(status.reserved_microusd);
    totals.settled_microusd += Number(status.settled_microusd);
    totals.open_microusd += Number(status.open_microusd);
  }
  run.summary.spend = totals;
}

function writeSummary(p: Paths, summary: ControllerSummary): ControllerSummary {
  const bytes = summaryBytes(summary);
  writeFileSync(p.summary, bytes);
  return parseCanonical(bytes) as unknown as ControllerSummary;
}

/** A job directory with a controller record but no summary: an earlier run stopped part-way, or is still running. Nothing is launched. */
async function interrupted(inputs: JobInputs, deps: ControllerDeps, state: ControllerState): Promise<ControllerSummary> {
  const summary = emptySummary(inputs, deps, state, utcSeconds(deps.clock.now()));
  summary.status = "needs_reconciliation";
  summary.reason = "interrupted";
  summary.detail = "an earlier run of this job has no summary: it stopped part-way or is still running; nothing was launched";
  const slot = await ledger(() => deps.spend.slotStatus({ slot_key: inputs.ledger.slot_key }));
  if (slot.ok) {
    summary.slot.acquired = slot.holder === state.ids.root_execution_id;
    summary.slot.blockers = { child_resources: slot.release_blockers.child_resources.map((child) => child.resource_id), operation_ids: slot.release_blockers.operation_ids };
  }
  return summary;
}

/** Runs one job end to end, or returns the job its work directory already holds. */
export async function runJob(inputs: JobInputs, deps: ControllerDeps): Promise<JobOutcome> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(inputs.name)) throw new InputsError("the job name must be lowercase letters, digits and single hyphens");
  if (inputs.backend === "sandbox" && (deps.sandbox === undefined || inputs.sandboxImage === null)) throw new InputsError("the sandbox backend needs the SDK and --sandbox-image");
  const p = paths(inputs.work, inputs.name);
  const copyInputs = loadCopyInputs(inputs);
  const fixtureDir = join(inputs.kitStage, "umami-fixture");
  const baselinePath = join(inputs.work, ...BASELINE_KEY.split("/"));
  const fingerprint = canonicalDigest({
    kind: inputs.kind,
    name: inputs.name,
    image: inputs.image,
    image_digest: await imageDigest(deps.docker, inputs.image),
    fixture_sha256: sha256Hex(readFileSync(FIXTURE_FILE)),
    added_suite_sha256: existsSync(fixtureDir) ? await addedSuiteSha256(fixtureDir) : null,
    baseline_sha256: inputs.kind === "observe" && existsSync(baselinePath) ? fileSha(baselinePath) : null,
    backend: inputs.backend,
    sandbox_image: inputs.sandboxImage,
    trials: inputs.trials,
    ledger: inputs.ledger,
    manifest_sha256: copyInputs.manifestSha256,
    terms_sha256: copyInputs.termsSha256,
    policy_sha256: copyInputs.policySha256,
    probes_json_sha256: copyInputs.probesJsonSha256,
    probe_patches_sha256: copyInputs.probePatchesSha256,
    alternative_record_sha256: copyInputs.alternative.record_sha256,
    alternative_patch_sha256: copyInputs.alternative.patch_sha256,
    original_suite_sha256: fileSha(inputs.originalSuite),
  }).sha256;

  if (existsSync(p.state)) {
    const state = JSON.parse(readFileSync(p.state, "utf8")) as ControllerState;
    if (state.fingerprint !== fingerprint) throw new InputsError(`jobs/${inputs.name} holds another job (different inputs); give another --work or --name`);
    if (existsSync(p.summary)) {
      const summary = parseCanonical(readFileSync(p.summary)) as unknown as ControllerSummary;
      return { exitCode: exitCode(summary.status), replay: true, status: summary.status, summary, work: inputs.work, jobDir: p.base };
    }
    const summary = await interrupted(inputs, deps, state);
    return { exitCode: 1, replay: true, status: summary.status, summary, work: inputs.work, jobDir: p.base };
  }
  if (existsSync(p.base) && readdirSync(p.base).length > 0) throw new InputsError(`jobs/${inputs.name} is not empty and holds no controller record`);

  const startedMs = deps.clock.now();
  const deadline = startedMs + JOB_LIMITS[inputs.kind].controller_ms;
  const state: ControllerState = { schema_version: 1, fingerprint, kind: inputs.kind, name: inputs.name, ids: newRunIds(deps.uuid), trials: inputs.trials === null ? null : [...inputs.trials] };
  mkdirSync(p.base, { recursive: true });
  writeFileSync(p.state, `${JSON.stringify(state, null, 2)}\n`);
  const summary = emptySummary(inputs, deps, state, utcSeconds(startedMs));
  const finish = (): JobOutcome => {
    summary.controller.ended_at = utcSeconds(deps.clock.now());
    const written = writeSummary(p, summary);
    return { exitCode: exitCode(written.status), replay: false, status: written.status, summary: written, work: inputs.work, jobDir: p.base };
  };

  let built: Built;
  try {
    built = await build(inputs, deps, state, p, summary, deadline);
  } catch (error) {
    if (!(error instanceof PlanError || error instanceof ExportError || error instanceof CodeStateRefusal || error instanceof JobRefusal || error instanceof InputsError)) throw error;
    summary.reason = "cannot_build";
    summary.detail = error.message;
    return finish();
  }
  summary.job = {
    ...summary.job,
    task_revision: built.job.request.task_revision,
    request_sha256: built.job.requestSha256,
    expected_trials_sha256: built.job.expectedSha256,
    deadline_at: built.job.request.deadline_at,
    baseline:
      built.job.request.baseline_evidence_key === null || built.job.request.baseline_evidence_sha256 === null
        ? null
        : { key: built.job.request.baseline_evidence_key, sha256: built.job.request.baseline_evidence_sha256 },
    trials: built.trials.map((trial) => trial.trial_id),
  };
  summary.controller.copy_reserved_microusd = Number(built.envelope.reserved_microusd);

  const run: Run = { inputs, deps, p, built, tag: runTag(state.ids.root_execution_id), deadline, summary, reconcile: false, copyResults: [] };
  let hold: Awaited<ReturnType<Spend["acquireSlot"]>>;
  try {
    hold = await ledger(() => deps.spend.acquireSlot({ slot_key: inputs.ledger.slot_key, root_execution_id: state.ids.root_execution_id, actor_role: ACTOR }));
  } catch (error) {
    if (!(error instanceof LedgerUnavailable)) throw error;
    // The acquisition may have committed, so the slot may be held: the operator reconciles.
    summary.status = "needs_reconciliation";
    summary.reason = "ledger_unavailable";
    summary.detail = error.message;
    return finish();
  }
  if (!hold.ok) {
    summary.reason = hold.code;
    summary.detail = refusalText(hold);
    return finish();
  }
  summary.slot.acquired = true;

  let stop: { reason: string; detail: string } | null = null;
  try {
    for (const trial of built.trials) {
      const step = await runOneCopy(run, trial);
      if (!step.go) {
        stop = step.stop;
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof LedgerUnavailable)) throw error;
    run.reconcile = true;
    stop = { reason: "ledger_unavailable", detail: error.message };
  }

  const results = run.copyResults.flatMap(({ record, recordsDir }) => (record.copy === null ? [] : [asCopyResult(inputs.name, record.copy, recordsDir, join(p.copies, record.trial_id))]));
  mergeRecordSet(built.job, results, p.records);
  const imported = importJob(p.records, p.base);
  summary.import = { refusal: imported.refusal, evidence_sha256: imported.evidence_sha256, decision_sha256: imported.decision_sha256, trials: trialSummaries(imported.evidence) };

  try {
    if (!run.reconcile) {
      const released = await ledger(() => deps.spend.releaseSlot({ slot_key: inputs.ledger.slot_key, root_execution_id: state.ids.root_execution_id, actor_role: ACTOR, evidence: null, reason: null }));
      summary.slot.released = released.ok;
      if (!released.ok) {
        run.reconcile = true;
        stop ??= { reason: "slot_release_blocked", detail: refusalText(released) };
        summary.slot.blockers = { child_resources: (released.blocking_child_resources ?? []).map((child) => child.resource_id), operation_ids: released.blocking_operation_ids ?? [] };
      }
    }
    await readSpend(run);
  } catch (error) {
    if (!(error instanceof LedgerUnavailable)) throw error;
    run.reconcile = true;
    stop ??= { reason: "ledger_unavailable", detail: error.message };
  }

  const allComplete = summary.copies.length === built.trials.length && summary.copies.every((copy) => copy.status === "complete");
  summary.status = run.reconcile ? "needs_reconciliation" : stop === null && allComplete && imported.refusal === null ? "complete" : "incomplete";
  summary.reason = stop?.reason ?? (allComplete ? null : "copy_not_complete");
  summary.detail = stop?.detail ?? null;
  if (summary.status === "complete") summary.reason = null;
  deps.log(`${inputs.name} ${summary.status}${summary.reason === null ? "" : ` ${summary.reason}`}`);
  return finish();
}
