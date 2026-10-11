// The judge controller (design note sections 5 and 6): it runs inside the controller sandbox the
// judge route started, with no Docker. It reads the frozen judge job from the private store and
// checks the index against the release and each file against the index, overlays the replay's IDs
// and deadline, and runs the job's three copies through runJob in prebuilt mode. It keeps
// judge/<root>/progress.json current, decides the replay's verdict, and ends in a fixed order:
// the run files, the final progress.json and the terminal root-run.json first, then its own
// operation running → terminal, then its settlement in full, then the slot release, then the stop
// of its own sandbox, which it cannot confirm (the accepted deviation in section 2).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { extract } from "tar-stream";
import type { Evidence } from "@rbw/admission";
import type { BuiltJob, Docker, RunIds } from "@rbw/local-runner";
import { runTag, utcSeconds } from "@rbw/local-runner";
import { StoreError } from "@rbw/publisher/private-store";
import type { PrivateStore } from "@rbw/publisher/private-store";
import { assertRecord, buildJobRequest, canonicalDigest, encodeCanonical, parseRecord, sha256Hex } from "@rbw/schema";
import type { JobRequest, JobRequestFields, Release, RootRun } from "@rbw/schema";
import { parseSuiteManifest } from "@rbw/umami-driver";
import { refusedSummary, runJob } from "./controller.ts";
import type { ControllerDeps, ControllerSummary, JobInputs } from "./controller.ts";
import { controllerEnvelope } from "./envelope.ts";
import type { CopyEnvelope } from "./envelope.ts";
import {
  JUDGE_JOB_NAME,
  controllerSandboxName,
  controllerSettlement,
  judgeIds,
  judgeKeys,
  judgeOperation,
  judgeRelease,
  newProgress,
  parseProgress,
  progressBytes,
  replayRootRun,
  replayVerdict,
} from "./judge.ts";
import type { JudgeOperation, ReplayOutcome, ReplayProgress } from "./judge.ts";
import { JUDGE } from "./limits.ts";

const ACTOR = "judge-controller";
const JSON_TYPE = "application/json";
const INDEX_LIMIT_BYTES = 1024 * 1024;
/** The largest frozen file read back; source.tar is the largest. */
const FILE_LIMIT_BYTES = 1024 * 1024 * 1024;
const PROGRESS_LIMIT_BYTES = 1024 * 1024;
/** The files a judge job's index must list (tools/release, "The judge job"). */
const JOB_FILES = ["audit-policy.json", "expected-trials.json", "original-suite.json", "projection-manifest.json", "request.json", "source.tar", "strict-terms.txt"] as const;
/** What run/jobs/judge/ holds in the private store; never copies/ or the source. */
const RUN_FILES = ["summary.json", "evidence.json", "decision.json", "job", "records"] as const;

/** The Docker layer in prebuilt mode: there is no Docker in the controller sandbox, so any call is an error. */
export const NO_DOCKER: Docker = {
  run: () => Promise.reject(new Error("prebuilt mode makes no Docker call")),
};

function requestFields(request: JobRequest): JobRequestFields {
  return Object.fromEntries(Object.entries(request).filter(([key]) => key !== "operation_id" && key !== "payload_hash")) as JobRequestFields;
}

/**
 * The per-replay overlay (design note section 5): the request's batch, execution, root and parent
 * IDs from judgeIds, the deadline, and the expected trials' key and hash, with operation_id and
 * payload_hash recomputed by buildJobRequest; the expected trials' execution ID. Nothing else changes.
 */
export function overlayJudgeJob(frozen: { request: Uint8Array; expected: Uint8Array }, overlay: { request_id: string; deadline_at: string }): BuiltJob {
  const request = parseRecord("JobRequest", frozen.request);
  const ids = judgeIds(overlay.request_id);
  const expected = assertRecord("ExpectedTrials", { ...parseRecord("ExpectedTrials", frozen.expected), execution_id: ids.execution });
  const expectedDigest = canonicalDigest(expected);
  const built = buildJobRequest({
    ...requestFields(request),
    batch_id: ids.batch,
    execution_id: ids.execution,
    root_execution_id: ids.root,
    parent_execution_id: ids.root,
    deadline_at: overlay.deadline_at,
    expected_trials_key: `jobs/${ids.execution}/expected-trials.json`,
    expected_trials_sha256: expectedDigest.sha256,
  });
  return {
    label: "alternative-fix",
    kind: "judge_verify",
    request: built.request,
    requestBytes: built.bytes,
    requestSha256: built.sha256,
    expected,
    expectedBytes: expectedDigest.bytes,
    expectedSha256: expectedDigest.sha256,
  };
}

type Fetched = { ok: true; indexSha256: string } | { ok: false; detail: string };

/** Reads the index into `dir` and checks it against the release, then each file against the index. */
async function fetchJudgeJob(store: PrivateStore, release: Release, dir: string): Promise<Fetched> {
  const { index_key: indexKey, index_sha256: indexSha256 } = release.judge_job;
  const index = await store.get(indexKey, INDEX_LIMIT_BYTES);
  if (index === null) return { ok: false, detail: "the judge job's index is missing" };
  if (sha256Hex(index) !== indexSha256) return { ok: false, detail: "the index's SHA-256 is not the release's" };
  const parsed = JSON.parse(Buffer.from(index).toString("utf8")) as { release_id?: unknown; files?: unknown };
  const files = Array.isArray(parsed.files) ? (parsed.files as { path?: unknown; sha256?: unknown }[]) : [];
  if (parsed.release_id !== release.release_id) return { ok: false, detail: "the index names another release" };
  const prefix = indexKey.slice(0, indexKey.lastIndexOf("/") + 1);
  mkdirSync(dir, { recursive: true });
  for (const name of JOB_FILES) {
    const listed = files.find((file) => file.path === name);
    if (typeof listed?.sha256 !== "string") return { ok: false, detail: `the index does not list ${name}` };
    const bytes = await store.get(`${prefix}${name}`, FILE_LIMIT_BYTES);
    if (bytes === null) return { ok: false, detail: `${name} is missing` };
    if (sha256Hex(bytes) !== listed.sha256) return { ok: false, detail: `${name}'s SHA-256 is not the index's` };
    writeFileSync(join(dir, name), bytes);
  }
  return { ok: true, indexSha256 };
}

/** Writes the frozen source archive's files, directories and symbolic links under `dest`. */
async function extractSource(bytes: Uint8Array, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const archive = extract();
  const state: { failure: Error | null } = { failure: null };
  archive.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)));
    stream.on("end", () => {
      const path = posix.normalize(header.name);
      if (state.failure === null && (path.startsWith("/") || path === ".." || path.startsWith("../"))) state.failure = new Error("the source archive has an entry outside it");
      if (state.failure === null) {
        const target = join(dest, ...path.split("/"));
        mkdirSync(header.type === "directory" ? target : dirname(target), { recursive: true });
        if (header.type === "file") writeFileSync(target, Buffer.concat(chunks), { mode: (header.mode & 0o111) !== 0 ? 0o755 : 0o644 });
        else if (header.type === "symlink") symlinkSync(header.linkname, target);
        else if (header.type !== "directory") state.failure = new Error(`the source archive holds a ${header.type} entry`);
      }
      next();
    });
    stream.resume();
  });
  const finished = new Promise<void>((resolve, reject) => {
    archive.on("finish", resolve);
    archive.on("error", reject);
  });
  archive.end(Buffer.from(bytes));
  await finished;
  if (state.failure !== null) throw state.failure;
}

/** Every file below `dir`, as relative POSIX paths. */
function files(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(join(dir, path)).isDirectory()) found.push(...files(dir, path));
    else found.push(path);
  }
  return found;
}

export interface JudgeRunOptions {
  requestId: string;
  release: Release;
  store: PrivateStore;
  /** --deadline-at: the create time plus the timeout minus 120 s, from the route. */
  deadlineAtMs: number;
  /** An empty or new local directory. */
  work: string;
  probesDir?: string;
  alternativeDir?: string;
}

export interface JudgeRunOutcome {
  state: ReplayOutcome;
  known_condition: boolean;
  summary: ControllerSummary;
  jobDir: string;
  /** Whether the controller's operation was ended and settled; false leaves it for the operator. */
  closed: boolean;
}

/** Runs one judge replay end to end. `deps.sandbox` is the copies' SDK and stops the controller's own sandbox. */
export async function runJudgeReplay(options: JudgeRunOptions, deps: ControllerDeps): Promise<JudgeRunOutcome> {
  const { store, release } = options;
  const startedMs = deps.clock.now();
  const ids = judgeIds(options.requestId);
  const keys = judgeKeys(ids.root);
  const judge = judgeRelease(release);
  const envelope = controllerEnvelope(deps.rates);
  if (!envelope.ok) throw new Error(`the controller envelope was refused (${envelope.code})`);
  const operation = judgeOperation(options.requestId, judge, envelope);

  const stored = await store.get(keys.progress, PROGRESS_LIMIT_BYTES);
  const progress: ReplayProgress = { ...(stored === null ? newProgress(ids.root, startedMs, options.deadlineAtMs) : parseProgress(stored)), state: "running" };
  const putProgress = () => store.put(keys.progress, progressBytes(progress), JSON_TYPE);
  const putRoot = (status: RootRun["status"], outcome: RootRun["outcome"]) => store.put(keys.rootRun, encodeCanonical(replayRootRun(judge, options.requestId, status, outcome)), JSON_TYPE);
  await putRoot("running", null);
  await putProgress();

  const runIds: RunIds = {
    run_tag: runTag(ids.root),
    project_id: release.project_id,
    batch_id: ids.batch,
    root_execution_id: ids.root,
    executions: { "kit-check": ids.execution, observe: ids.execution, admission: ids.execution, "alternative-fix": ids.execution, "candidate-text": ids.execution },
    release_id: release.release_id,
  };
  const jobFiles = join(options.work, "judge-job");
  const inputs: JobInputs = {
    kind: "judge_verify",
    work: join(options.work, "run"),
    name: JUDGE_JOB_NAME,
    image: "",
    manifest: join(jobFiles, "projection-manifest.json"),
    terms: join(jobFiles, "strict-terms.txt"),
    policy: join(jobFiles, "audit-policy.json"),
    kitStage: join(options.work, "kit-stage-unused"),
    originalSuite: join(jobFiles, "original-suite.json"),
    ...(options.probesDir === undefined ? {} : { probesDir: options.probesDir }),
    ...(options.alternativeDir === undefined ? {} : { alternativeDir: options.alternativeDir }),
    backend: "sandbox",
    sandboxImage: release.images.kit_image,
    trials: null,
    ledger: JUDGE,
  };
  const jobDir = join(inputs.work, "jobs", JUDGE_JOB_NAME);

  let state: ReplayOutcome;
  let known = false;
  let summary: ControllerSummary;
  let root: { status: RootRun["status"]; outcome: RootRun["outcome"] };
  const fetched = await fetchJudgeJob(store, release, jobFiles);
  if (!fetched.ok) {
    summary = refusedSummary(inputs, deps, runIds, startedMs, "judge_job_mismatch", fetched.detail);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, "summary.json"), encodeCanonical(summary));
    deps.log(`judge judge_job_mismatch ${fetched.detail}`);
    state = "incomplete";
    root = { status: "terminal", outcome: "failed" };
  } else {
    const job = overlayJudgeJob({ request: readFileSync(join(jobFiles, "request.json")), expected: readFileSync(join(jobFiles, "expected-trials.json")) }, { request_id: options.requestId, deadline_at: utcSeconds(options.deadlineAtMs) });
    const sourceDir = join(options.work, "source");
    await extractSource(readFileSync(join(jobFiles, "source.tar")), sourceDir);
    const outcome = await runJob(
      {
        ...inputs,
        image: job.request.image_digest,
        prebuilt: { ids: runIds, deadlineMs: options.deadlineAtMs, fingerprint: { index_sha256: fetched.indexSha256, request_id: options.requestId }, job, sourceDir, controllerReservedMicrousd: envelope.reserved_microusd },
      },
      {
        ...deps,
        progress: async (trialId, event) => {
          progress.copies = progress.copies.map((copy) =>
            copy.trial_id !== trialId ? copy : { ...copy, status: event, started_at: event === "running" ? utcSeconds(deps.clock.now()) : copy.started_at },
          );
          try {
            await putProgress();
          } catch (error) {
            if (!(error instanceof StoreError)) throw error;
            deps.log(`judge progress not written (${error.code})`);
          }
        },
      },
    );
    summary = outcome.summary;
    if (outcome.status === "complete") {
      const evidence = JSON.parse(readFileSync(join(jobDir, "evidence.json"), "utf8")) as Evidence;
      const verdict = replayVerdict(evidence, judge, startedMs, parseSuiteManifest(readFileSync(join(jobFiles, "original-suite.json"))));
      state = verdict.state;
      known = verdict.known_condition;
      root = { status: "terminal", outcome: "completed" };
    } else if (outcome.status === "needs_reconciliation") {
      state = "needs_reconciliation";
      root = { status: "needs_reconciliation", outcome: null };
    } else {
      state = "incomplete";
      root = { status: "terminal", outcome: "incomplete" };
    }
  }

  progress.state = state;
  progress.known_condition = known;
  progress.ended_at = utcSeconds(deps.clock.now());
  let written = false;
  try {
    for (const name of RUN_FILES) {
      const path = join(jobDir, name);
      if (!existsSync(path)) continue;
      const relative = statSync(path).isDirectory() ? files(path).map((file) => `${name}/${file}`) : [name];
      for (const file of relative) await store.put(`${keys.run}jobs/${JUDGE_JOB_NAME}/${file}`, readFileSync(join(jobDir, file)), file.endsWith(".json") ? JSON_TYPE : "application/octet-stream");
    }
    await putProgress();
    await putRoot(root.status, root.outcome);
    written = true;
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    deps.log(`judge the final files were not written (${error.code}); the operation stays open for the operator`);
  }
  const closed = written && (await closeOperation(deps, operation, envelope, ids.root));
  await stopOwnSandbox(deps, ids.root);
  deps.log(`judge ${state}${known ? " known_condition" : ""}`);
  return { state, known_condition: known, summary, jobDir, closed };
}

/** running → terminal, the settlement in full, then the slot release. Returns false when the ledger refused a step before the settlement. */
async function closeOperation(deps: ControllerDeps, operation: JudgeOperation, envelope: CopyEnvelope, root: string): Promise<boolean> {
  try {
    const terminal = await deps.spend.transition({ operation_id: operation.operation_id, from_state: "running", to_state: "terminal", actor_role: ACTOR, terminal_status: "completed" });
    if (!terminal.ok) {
      deps.log(`judge the controller's operation was not ended (${terminal.code})`);
      return false;
    }
    const settled = await deps.spend.settle(controllerSettlement(envelope, operation.operation_id));
    if (!settled.ok) {
      deps.log(`judge the controller's operation was not settled (${settled.code})`);
      return false;
    }
    const released = await deps.spend.releaseSlot({ slot_key: JUDGE.slot_key, root_execution_id: root, actor_role: ACTOR, evidence: null, reason: null });
    if (!released.ok) deps.log(`judge the slot was not released (${released.code})`);
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    deps.log(`judge a ledger call failed (${error.name}); the operation stays open for the operator`);
    return false;
  }
}

/** Stops the controller's own sandbox. The stop cannot be confirmed from inside it. */
async function stopOwnSandbox(deps: ControllerDeps, root: string): Promise<void> {
  if (deps.sandbox === undefined) return;
  try {
    const own = await deps.sandbox.get(controllerSandboxName(root));
    await own?.stop();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    deps.log(`judge the stop of its own sandbox failed (${error.name}); the provider timeout ends it`);
  }
}
