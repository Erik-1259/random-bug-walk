// The frozen judge job (design note section 5): everything Docker produces, made once at release
// time from the local runner's own functions, so a judge replay runs from these bytes without
// Docker. The files go to the private store under judge-jobs/<release_id>/, with the canonical
// index judge-job.json, which lists the release ID and each file with its SHA-256 and nothing else.
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { pack } from "tar-stream";
import {
  buildJob,
  candidateIdentity,
  containerName,
  deriveCodeStates,
  expectedVectors,
  exportImage,
  inspectImage,
  loadCopyInputs,
  profileSha256,
  runTag,
} from "@rbw/local-runner";
import type { BuiltJob, Docker, JobContext, RunIds } from "@rbw/local-runner";
import { buildJobRequest, canonicalDigest, sha256Hex } from "@rbw/schema";
import type { TaskRevisionIdentity } from "@rbw/schema";
import { addedSuiteSha256, parseSuiteManifest } from "@rbw/umami-driver";
import { FIXTURE_FILE, loadFixture } from "@rbw/umami-fixture";
import { ReleaseInputError } from "./errors.ts";
import type { PrivateStore } from "@rbw/publisher/private-store";

/** The host inputs a job is built from: the local kit image and the files the copies and their audit read. */
export interface BuildSources {
  /** The local kit image, a tag or a digest. */
  image: string;
  /** The projection manifest. */
  manifest: string;
  /** The strict term list. */
  terms: string;
  /** The audit policy file. */
  auditPolicy: string;
  kitStage: string;
  /** The admission's frozen original-suite manifest. */
  originalSuite: string;
  /** The shapes package's probes unless a test gives others. */
  probesDir?: string;
  /** The local runner's alternative fix unless a test gives another. */
  alternativeDir?: string;
}

/**
 * The fields W2-8's per-replay overlay replaces, frozen as fixed placeholders. operation_id and
 * payload_hash are derived from them by buildJobRequest, and expected_trials_key from the
 * execution ID.
 */
export const JUDGE_PLACEHOLDERS = {
  root_execution_id: "00000000-0000-4000-8000-00000000a001",
  batch_id: "00000000-0000-4000-8000-00000000a002",
  execution_id: "00000000-0000-4000-8000-00000000a003",
  deadline_at: "2000-01-01T00:00:00Z",
} as const;

/** The issue style a release records (spec §2.2 step 9's user report); nothing upstream sets one yet. */
export const ISSUE_STYLE = "user-report";

export const INDEX_FILE = "judge-job.json";

export function judgeJobPrefix(releaseId: string): string {
  return `judge-jobs/${releaseId}/`;
}

export interface ContextOptions {
  ids: RunIds;
  deadlineAt: string;
  projectPolicy?: { sha256: string; policy_id: string };
  judgeFixed?: "fixed" | "alternative_fix";
  issue?: { sha256: string; style: string };
  /** Where the image's source is exported; it must not exist yet. */
  exportDir: string;
}

function readInput(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new ReleaseInputError("input_unreadable", what);
  }
}

/**
 * A job context from the image and the host inputs, exactly as the controller's build makes one:
 * the image digest, the exported source and its kit manifest, the derived code states, the
 * fixture, both suites, the vectors and the copy profile.
 */
export async function jobContext(docker: Docker, sources: BuildSources, options: ContextOptions): Promise<{ ctx: JobContext; sourceDir: string }> {
  const copyInputs = loadCopyInputs({
    manifest: sources.manifest,
    terms: sources.terms,
    policy: sources.auditPolicy,
    ...(sources.probesDir === undefined ? {} : { probesDir: sources.probesDir }),
    ...(sources.alternativeDir === undefined ? {} : { alternativeDir: sources.alternativeDir }),
  });
  const digest = await inspectImage(docker, sources.image);
  const exported = await exportImage(docker, { image: digest, container: containerName(runTag(options.ids.root_execution_id), "release", "export"), dest: options.exportDir });
  const states = deriveCodeStates(readFileSync(join(exported.source_dir, copyInputs.probes.data.target_path)), copyInputs.probes, copyInputs.alternative);
  const suiteBytes = readInput(sources.originalSuite, "the original suite");
  let testIds: string[];
  try {
    testIds = parseSuiteManifest(suiteBytes).tests.map((test) => test.id);
  } catch (error) {
    if (error instanceof Error && error.name === "ManifestError") throw new ReleaseInputError("original_suite_invalid", error.message);
    throw error;
  }
  const ctx: JobContext = {
    ids: options.ids,
    imageDigest: digest,
    kitSha256: sha256Hex(exported.image_manifest),
    fixtureSha256: sha256Hex(readFileSync(FIXTURE_FILE)),
    addedSuiteSha256: await addedSuiteSha256(join(sources.kitStage, "umami-fixture")),
    originalSuite: { sha256: sha256Hex(suiteBytes), testIds },
    states,
    vectors: expectedVectors(loadFixture(), copyInputs.probes),
    profileSha256: profileSha256(),
    deadlineAt: options.deadlineAt,
    ...(options.projectPolicy === undefined ? {} : { projectPolicy: options.projectPolicy }),
    ...(options.judgeFixed === undefined ? {} : { judgeFixed: options.judgeFixed }),
    ...(options.issue === undefined ? {} : { issue: options.issue }),
  };
  return { ctx, sourceDir: exported.source_dir };
}

/** The exported source as a tar archive with fixed metadata: entries sorted by path, mtime 0, owner 0, no names. */
export async function sourceTar(dir: string): Promise<Buffer> {
  const paths: string[] = [];
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(dir, relative)).sort()) {
      const path = relative === "" ? name : `${relative}/${name}`;
      const stats = lstatSync(join(dir, path));
      if (stats.isDirectory()) walk(path);
      else paths.push(path);
    }
  };
  walk("");
  paths.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on("data", (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });
  const fixed = { mtime: new Date(0), uid: 0, gid: 0, uname: "", gname: "" };
  for (const path of paths) {
    const stats = lstatSync(join(dir, path));
    if (stats.isSymbolicLink()) archive.entry({ ...fixed, name: path, type: "symlink", linkname: readlinkSync(join(dir, path)), mode: 0o777 });
    else archive.entry({ ...fixed, name: path, mode: (stats.mode & 0o111) !== 0 ? 0o755 : 0o644 }, readFileSync(join(dir, path)));
  }
  archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

export interface JudgeJob {
  releaseId: string;
  built: BuiltJob;
  /** The identity the request's task revision hashes: the release's complete revision. */
  identity: TaskRevisionIdentity;
  /** Each file by its path below judge-jobs/<release_id>/, in path order. */
  files: { path: string; bytes: Uint8Array; contentType: string }[];
  indexKey: string;
  indexBytes: Uint8Array;
  indexSha256: string;
}

export interface JudgeJobOptions {
  releaseId: string;
  projectId: string;
  policy: { sha256: string; policy_id: string };
  issueSha256: string;
  reservationMicrousd: number;
  /** A new directory for the exported source. */
  exportDir: string;
}

/**
 * Builds the complete judge_verify job: the real project, policy and release ID, fixed-01 grading
 * the source fix's fixed state, the frozen issue making the revision complete, and the judge
 * reservation; only the fields the overlay replaces hold placeholders.
 */
export async function buildJudgeJob(docker: Docker, sources: BuildSources, options: JudgeJobOptions): Promise<JudgeJob> {
  const ids: RunIds = {
    run_tag: runTag(JUDGE_PLACEHOLDERS.root_execution_id),
    project_id: options.projectId,
    batch_id: JUDGE_PLACEHOLDERS.batch_id,
    root_execution_id: JUDGE_PLACEHOLDERS.root_execution_id,
    executions: {
      "kit-check": JUDGE_PLACEHOLDERS.execution_id,
      observe: JUDGE_PLACEHOLDERS.execution_id,
      admission: JUDGE_PLACEHOLDERS.execution_id,
      "alternative-fix": JUDGE_PLACEHOLDERS.execution_id,
      "candidate-text": JUDGE_PLACEHOLDERS.execution_id,
    },
    release_id: options.releaseId,
  };
  const { ctx, sourceDir } = await jobContext(docker, sources, {
    ids,
    deadlineAt: JUDGE_PLACEHOLDERS.deadline_at,
    projectPolicy: options.policy,
    judgeFixed: "fixed",
    issue: { sha256: options.issueSha256, style: ISSUE_STYLE },
    exportDir: options.exportDir,
  });
  const first = buildJob("alternative-fix", ctx);
  // buildJobRequest derives operation_id and payload_hash again, so the builder's values are replaced.
  const rebuilt = buildJobRequest({ ...first.request, reservation_microusd: options.reservationMicrousd });
  const built: BuiltJob = { ...first, request: rebuilt.request, requestBytes: rebuilt.bytes, requestSha256: rebuilt.sha256 };
  const files = [
    { path: "audit-policy.json", bytes: readInput(sources.auditPolicy, "the audit policy"), contentType: "application/json" },
    { path: "expected-trials.json", bytes: built.expectedBytes, contentType: "application/json" },
    { path: "original-suite.json", bytes: readInput(sources.originalSuite, "the original suite"), contentType: "application/json" },
    { path: "projection-manifest.json", bytes: readInput(sources.manifest, "the projection manifest"), contentType: "application/json" },
    { path: "request.json", bytes: built.requestBytes, contentType: "application/json" },
    { path: "source.tar", bytes: await sourceTar(sourceDir), contentType: "application/x-tar" },
    { path: "strict-terms.txt", bytes: readInput(sources.terms, "the strict term list"), contentType: "text/plain" },
  ];
  const index = canonicalDigest({ release_id: options.releaseId, files: files.map((file) => ({ path: file.path, sha256: sha256Hex(file.bytes) })) });
  return {
    releaseId: options.releaseId,
    built,
    identity: candidateIdentity(ctx),
    files,
    indexKey: `${judgeJobPrefix(options.releaseId)}${INDEX_FILE}`,
    indexBytes: index.bytes,
    indexSha256: index.sha256,
  };
}

/** Stores every file with no overwrite, then the index, so a stored index means every file it lists is stored. */
export async function storeJudgeJob(store: PrivateStore, job: JudgeJob): Promise<void> {
  const prefix = judgeJobPrefix(job.releaseId);
  for (const file of job.files) await store.putNew(`${prefix}${file.path}`, file.bytes, file.contentType);
  await store.putNew(job.indexKey, job.indexBytes, "application/json");
}

