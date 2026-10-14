// The frozen judge job (design note section 5): everything Docker produces, made once at release
// time from the local runner's own functions, so a judge replay runs from these bytes without
// Docker. The files go to the private store under judge-jobs/<release_id>/, with the canonical
// index judge-job.json, which lists the release ID and each file with its SHA-256 and nothing else.
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pack } from "tar-stream";
import {
  ALTERNATIVE_FIX_DIR,
  DEFAULT_FAMILY,
  FAMILIES,
  FamilyError,
  adm06For,
  buildJob,
  candidateIdentity,
  checkFamilyImage,
  containerName,
  deriveCodeStates,
  expectedVectors,
  exportImage,
  inspectImage,
  loadCopyInputs,
  profileSha256,
  runTag,
} from "@rbw/local-runner";
import type { BuiltJob, Docker, FamilyFixture, FamilyId, JobContext, RunIds } from "@rbw/local-runner";
import { buildJobRequest, canonicalDigest, sha256Hex } from "@rbw/schema";
import type { TaskRevisionIdentity } from "@rbw/schema";
import { PROBE_DIR } from "@rbw/shapes";
import { addedSuiteSha256, parseSuiteManifest } from "@rbw/umami-driver";
import { CODE_STATES, FIXTURE_FILE, loadFixture } from "@rbw/umami-fixture";
import type { Fixture } from "@rbw/umami-fixture";
import { ReleaseInputError } from "./errors.ts";
import type { PrivateStore } from "@rbw/publisher/private-store";

/**
 * The bug family a judge job is built for: its fixture package (the data file whose SHA-256 the job
 * records, and the parsed fixture whose outcome vectors the job expects), its probe directory and
 * its alternative fix. A release of one family must never take another family's fixture or probes.
 * A judge replay reads the family back from the frozen job (the fixture vectors and the profile
 * hash) and uses that family's own probes and fix, so a family is either a known one (`id`, from
 * the admitted run's records) or, through familyFrom, one whose probes and fix are the time-zone
 * family's.
 */
export interface JudgeJobFamily<F extends FamilyFixture = Fixture> {
  /** The local runner's family this is; absent for the time-zone family and for families given by flags. */
  id?: FamilyId;
  /** The fixture package's data file, hashed as fixture_sha256. */
  fixtureFile: string | URL;
  /** The fixture package's parsed data file. */
  loadFixture: () => F;
  /** The family's probe directory: probes.json and its patches. */
  probesDir: string;
  /** The family's alternative fix directory, or null for a family with none (its judge job grades the reference fix). */
  alternativeDir: string | null;
}

/** The released time-zone family: @rbw/umami-fixture, the shapes package's probes and the local runner's alternative fix. */
export const TIME_ZONE_FAMILY: Readonly<JudgeJobFamily & { alternativeDir: string }> = Object.freeze({ fixtureFile: FIXTURE_FILE, loadFixture, probesDir: PROBE_DIR, alternativeDir: ALTERNATIVE_FIX_DIR });

/** A known family's judge job inputs, as the local runner's family names them; the time-zone family is TIME_ZONE_FAMILY itself. */
export function judgeJobFamily(id: FamilyId): Readonly<JudgeJobFamily<FamilyFixture>> {
  if (id === DEFAULT_FAMILY) return TIME_ZONE_FAMILY;
  const family = FAMILIES[id];
  return Object.freeze({ id, fixtureFile: family.fixtureFile, loadFixture: family.loadFixture, probesDir: family.probesDir, alternativeDir: family.alternativeDir });
}

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
  /** The family the job is built for; the time-zone family when absent. */
  family?: Readonly<JudgeJobFamily<FamilyFixture>>;
  /** A race family's database latency in ms, which every replay copy sets and the profile hash holds; required for the race family (race_latency_missing). */
  raceLatencyMs?: number | null;
}

/**
 * The fields the controller's per-replay overlay (`overlayJudgeJob`) replaces, frozen as fixed
 * placeholders. operation_id and payload_hash are derived from them by buildJobRequest, and
 * expected_trials_key from the execution ID.
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

function readInput(path: string | URL, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new ReleaseInputError("input_unreadable", what);
  }
}

/**
 * The family's data file must be the one staged into the kit: stage-kit.ts copies the chosen
 * fixture package's data/ to <kitStage>/umami-fixture/data/, so a file of the same name and bytes
 * must be there, or the job would pair one family's fixture hash and vectors with another family's
 * kit and added suite. A stage with no data/ at all is not one stage-kit.ts writes (the tests'
 * synthetic stage), so there is nothing to compare.
 */
function checkStagedFixture(kitStage: string, fixtureFile: string | URL, fixtureBytes: Buffer): void {
  const stagedData = join(kitStage, "umami-fixture", "data");
  if (!existsSync(stagedData)) return;
  const name = basename(fixtureFile instanceof URL ? fileURLToPath(fixtureFile) : fixtureFile);
  const staged = join(stagedData, name);
  if (!existsSync(staged) || !readFileSync(staged).equals(fixtureBytes)) {
    throw new ReleaseInputError("fixture_stage_mismatch", `the kit stage's umami-fixture/data/${name} is not the family's fixture data file`);
  }
}

/**
 * A family with a database proxy needs a set latency: the race only shows under a delay, and the
 * plain copy profile hash is the time-zone family's, so a race job without one would not name its
 * family in the profile it is graded under. Checked before anything is exported or written.
 */
export function checkRaceLatency(sources: BuildSources): void {
  const id = sources.family?.id;
  if (id !== undefined && FAMILIES[id].proxy && (sources.raceLatencyMs === undefined || sources.raceLatencyMs === null)) {
    throw new ReleaseInputError("race_latency_missing", `the ${id} family's judge job needs a race latency, and the admitted run set none`);
  }
}

/**
 * A job context from the image and the host inputs, exactly as the controller's build makes one:
 * the image digest, the exported source and its kit manifest, the derived code states, the
 * fixture, both suites, the vectors and the copy profile.
 */
export async function jobContext(docker: Docker, sources: BuildSources, options: ContextOptions): Promise<{ ctx: JobContext; sourceDir: string }> {
  checkRaceLatency(sources);
  const family = sources.family ?? TIME_ZONE_FAMILY;
  // The same family selection and latency check as the controller's run (loadCopyInputs).
  const copyInputs = loadCopyInputs({
    manifest: sources.manifest,
    terms: sources.terms,
    policy: sources.auditPolicy,
    ...(family.id === undefined ? {} : { family: family.id }),
    ...(sources.raceLatencyMs === undefined || sources.raceLatencyMs === null ? {} : { raceLatencyMs: sources.raceLatencyMs }),
    probesDir: family.probesDir,
    ...(family.alternativeDir === null ? {} : { alternativeDir: family.alternativeDir }),
  });
  const adm06 = adm06For(copyInputs.probes);
  const fixture = family.loadFixture();
  // The judge job expects a vector for every code state the probe set uses; a fixture without one cannot build it.
  const vectorsByState = fixture.outcome_vectors as Partial<Record<string, unknown>>;
  const missing = CODE_STATES.filter((state) => (adm06 === "required" || !["partial", "stub"].includes(state)) && !Array.isArray(vectorsByState[state]));
  if (missing.length > 0) throw new ReleaseInputError("fixture_vectors_incomplete", missing.join(","));
  const fixtureBytes = readInput(family.fixtureFile, "the fixture data file");
  checkStagedFixture(sources.kitStage, family.fixtureFile, fixtureBytes);
  const digest = await inspectImage(docker, sources.image);
  const exported = await exportImage(docker, { image: digest, container: containerName(runTag(options.ids.root_execution_id), "release", "export"), dest: options.exportDir });
  // The kit image must be the family's own, as the controller's run checks before any copy.
  try {
    checkFamilyImage(copyInputs.family, exported.image_manifest);
  } catch (error) {
    if (error instanceof FamilyError) throw new ReleaseInputError("kit_image_family_mismatch", error.message);
    throw error;
  }
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
    fixtureSha256: sha256Hex(fixtureBytes),
    addedSuiteSha256: await addedSuiteSha256(join(sources.kitStage, "umami-fixture")),
    originalSuite: { sha256: sha256Hex(suiteBytes), testIds },
    states,
    vectors: expectedVectors(fixture, copyInputs.probes),
    adm06,
    profileSha256: profileSha256(copyInputs.raceLatencyMs),
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
  /** The family the job was built for, which a replay reads back from the frozen job (frozenJobFamily). */
  family: FamilyId;
  /** The race latency the profile hash holds and every replay copy sets; null only for a family without the proxy. */
  raceLatencyMs: number | null;
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
    family: sources.family?.id ?? DEFAULT_FAMILY,
    raceLatencyMs: sources.raceLatencyMs ?? null,
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

