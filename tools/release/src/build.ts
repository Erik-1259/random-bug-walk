// build: the checks, then the frozen judge job in the private store, then the release directory
// (design note sections 4 and 5). It runs on the conductor's host, where Docker exports the image.
// Any failing check stores and writes nothing and names every failing code.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Rates } from "@rbw/envelope";
import { judgeReservation } from "@rbw/controller";
import { CodeStateRefusal, ExportError, InputsError, PlanError, inspectRepoDigests, utcSeconds } from "@rbw/local-runner";
import type { Clock, Docker } from "@rbw/local-runner";
import { CanonicalError, RecordError, RegistryRefusal, assertRecord, checkPublicDemoInput, encodeCanonical, parseRecord, sha256Hex, validateRecord } from "@rbw/schema";
import type { DefName, DefTypes, Family, JsonValue, ProjectPolicy, Release, ReleaseApproval, ReleaseFile } from "@rbw/schema";
import { RELEASE_FILE, admissionExecution, checkRelease } from "./check.ts";
import type { PublishedRun } from "./check.ts";
import { ReleaseInputError } from "./errors.ts";
import { buildJudgeJob, storeJudgeJob } from "./judge-job.ts";
import type { BuildSources, JudgeJob } from "./judge-job.ts";
import { LocalPrivateStore } from "@rbw/publisher/private-store";
import type { PrivateStore } from "@rbw/publisher/private-store";

/** The variables the real private store reads (W2-6-pre); removed from the environment once the store has its copy. */
export const PRIVATE_STORE_VARIABLES: readonly string[] = ["VERCEL_OIDC_TOKEN", "BLOB_PRIVATE_STORE_ID", "BLOB_PUBLIC_STORE_ID"];

export interface BuildOptions {
  /** The UUID the conductor assigned before anything was built; reused on any rerun. */
  releaseId: string;
  /** The published run directory, as a fresh clone of the results repository holds runs/<root>/. */
  run: string;
  /** The run's PublicationRecord. */
  publication: string;
  /** The frozen public_demo ProjectPolicy file. */
  policy: string;
  rootRun: string;
  issue: string;
  issueCheck: string;
  /** The writer's card and issue recordings, one file each. */
  recordings: string;
  /** The owner's approval: { decision: "approved", issue_sha256, reviewed_at }. */
  approval: string;
  registry: string;
  /** The private HeldOutIdentityList. */
  heldOut: string;
  sources: BuildSources;
  /** <repository>@sha256:<digest> of the pushed controller image. */
  controllerImage: string;
  /** Local mode: the private store is this directory. Null: the real store from the environment. */
  localStore: string | null;
  /** A new release directory. */
  out: string;
}

export interface BuildDeps {
  docker: Docker;
  clock: Clock;
  rates: Rates;
  /** The environment; in real mode the store's variables are removed from it before Docker runs. */
  env: Record<string, string | undefined>;
  privateStoreFromEnv: (env: Readonly<Record<string, string | undefined>>) => PrivateStore;
  log: (line: string) => void;
}

export type BuildCode = string;

export type BuildOutcome = { ok: true; release: Release; releaseSha256: string; issueSha256: string } | { ok: false; codes: BuildCode[]; issueSha256: string | null };

function read(path: string, code: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new ReleaseInputError(code);
  }
}

/** A JSON file as canonical bytes: the release publishes canonical bytes. */
function canonicalJson(path: string, code: string): Uint8Array {
  try {
    return encodeCanonical(JSON.parse(read(path, code).toString("utf8")) as JsonValue);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof CanonicalError) throw new ReleaseInputError(code);
    throw error;
  }
}

function record<K extends DefName>(type: K, path: string, code: string): DefTypes[K] {
  try {
    return parseRecord(type, read(path, code));
  } catch (error) {
    if (error instanceof RecordError || error instanceof CanonicalError) throw new ReleaseInputError(code);
    throw error;
  }
}

function approvalOf(path: string): ReleaseApproval {
  let value: unknown;
  try {
    value = JSON.parse(read(path, "approval_unreadable").toString("utf8"));
    return assertRecord("ReleaseApproval", value);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RecordError) throw new ReleaseInputError("approval_invalid");
    throw error;
  }
}

/** The writer's recordings, each as canonical bytes under recordings/. Only `*.recording.json` files are taken, so the `*.summary.json` files `record --out` writes beside them never reach the release. */
function recordingsOf(dir: string): { path: string; bytes: Uint8Array }[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".recording.json")).sort();
  } catch {
    throw new ReleaseInputError("recordings_unreadable");
  }
  const files = names.map((name) => {
    if (!lstatSync(join(dir, name)).isFile() || validateRecord("RelativePath", name).length > 0 || name.includes("/")) throw new ReleaseInputError("recording_invalid", name);
    return { path: `recordings/${name}`, bytes: canonicalJson(join(dir, name), "recording_invalid") };
  });
  if (files.length === 0) throw new ReleaseInputError("recordings_missing");
  return files;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The family that links the mutation, and the public-demo check against the registry and the held-out list. */
function familyOf(registryPath: string, heldOutPath: string, mutationId: string, codes: Set<string>): { family: Family | null } {
  const registry = record("FamilyRegistry", registryPath, "registry_invalid");
  const heldOut = record("HeldOutIdentityList", heldOutPath, "held_out_invalid");
  try {
    checkPublicDemoInput(registry, { kind: "mutation", mutation_id: mutationId }, heldOut);
  } catch (error) {
    if (!(error instanceof RegistryRefusal)) throw error;
    codes.add(error.code);
    return { family: null };
  }
  const family = registry.families.find((item) => item.mutation_ids.includes(mutationId)) ?? null;
  if (family?.source_fixes.length !== 1) codes.add("source_fix_ambiguous");
  return { family };
}

/** Builds a release. Inputs that cannot be read throw ReleaseInputError before anything is built. */
export async function buildRelease(options: BuildOptions, deps: BuildDeps): Promise<BuildOutcome> {
  if (!UUID.test(options.releaseId)) throw new ReleaseInputError("invalid_release_id");
  if (validateRecord("ImageReference", options.controllerImage).length > 0) throw new ReleaseInputError("invalid_controller_image");
  if (existsSync(options.out)) throw new ReleaseInputError("out_exists");
  const policyBytes = read(options.policy, "policy_unreadable");
  let policy: ProjectPolicy;
  try {
    policy = parseRecord("ProjectPolicy", policyBytes);
  } catch (error) {
    if (error instanceof RecordError || error instanceof CanonicalError) throw new ReleaseInputError("policy_invalid");
    throw error;
  }
  const publication = record("PublicationRecord", options.publication, "publication_invalid");
  const rootRun = record("RootRun", options.rootRun, "root_run_invalid");
  const approval = approvalOf(options.approval);
  const issue = canonicalJson(options.issue, "issue_invalid");
  const issueSha256 = sha256Hex(issue);
  const issueCheck = canonicalJson(options.issueCheck, "issue_check_invalid");
  const recordings = recordingsOf(options.recordings);
  deps.log(`build release=${options.releaseId} issue_sha256=${issueSha256}`);

  // Real mode: the store takes its own copy of the environment, then its variables leave the
  // environment, so no child process (Docker, git) inherits them.
  let store: PrivateStore | null = null;
  if (options.localStore === null) {
    store = deps.privateStoreFromEnv({ ...deps.env });
    for (const name of PRIVATE_STORE_VARIABLES) Reflect.deleteProperty(deps.env, name);
  }

  const admission = admissionExecution(options.run);
  if (admission === null) return { ok: false, codes: ["admission_missing"], issueSha256 };
  const reservation = judgeReservation(deps.rates);
  if (!reservation.ok) throw new ReleaseInputError("reservation_unpriced", reservation.code);

  const work = mkdtempSync(join(tmpdir(), "rbw-release-build-"));
  const cleanup = [work];
  try {
    const codes = new Set<string>();
    let job: JudgeJob;
    let repoDigests: string[];
    try {
      job = await buildJudgeJob(deps.docker, options.sources, {
        releaseId: options.releaseId,
        projectId: policy.project_id,
        policy: { sha256: sha256Hex(policyBytes), policy_id: admission.request.policy_id },
        issueSha256,
        reservationMicrousd: Number(reservation.reserved_microusd),
        exportDir: join(work, "source"),
      });
      repoDigests = await inspectRepoDigests(deps.docker, options.sources.image);
    } catch (error) {
      if (error instanceof PlanError || error instanceof ExportError || error instanceof CodeStateRefusal || error instanceof InputsError) {
        deps.log(`build judge_job_unbuildable ${error.name}`);
        return { ok: false, codes: ["judge_job_unbuildable"], issueSha256 };
      }
      throw error;
    }
    const kitImage = repoDigests.filter((item) => validateRecord("ImageReference", item).length === 0).sort()[0];
    if (kitImage === undefined) codes.add("kit_image_missing");
    const mutationId = job.identity.mutation_id ?? "";
    const { family } = familyOf(options.registry, options.heldOut, mutationId, codes);

    // The release directory, assembled beside --out and renamed to it only after the judge job is stored.
    mkdirSync(dirname(resolve(options.out)), { recursive: true });
    const releaseDir = mkdtempSync(join(dirname(resolve(options.out)), ".rbw-release-"));
    cleanup.push(releaseDir);
    const contents = [
      { path: "issue-check.json", bytes: issueCheck },
      { path: "issue.json", bytes: issue },
      ...recordings,
    ].sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const file of contents) {
      mkdirSync(dirname(join(releaseDir, file.path)), { recursive: true });
      writeFileSync(join(releaseDir, file.path), file.bytes);
    }
    const files: ReleaseFile[] = contents.map((file) => ({ path: file.path, sha256: sha256Hex(file.bytes) }));
    const release: Release = {
      schema_version: 1,
      release_id: options.releaseId,
      project_id: policy.project_id,
      project_policy_sha256: sha256Hex(policyBytes),
      policy_id: admission.request.policy_id,
      created_at: utcSeconds(deps.clock.now()),
      calibration: "not_requested",
      revisions: [{ sha256: job.built.request.task_revision, identity: job.identity }],
      images: { kit_image: kitImage ?? "", controller_image: options.controllerImage },
      family: {
        family_id: family?.family_id ?? "",
        source_fix: family?.source_fixes[0] ?? { upstream: "", commit: "" },
        mutation_id: mutationId,
        split: "public_demo",
      },
      run: { root_execution_id: rootRun.root_execution_id, publication_id: publication.publication_id, manifest_sha256: publication.manifest_sha256, repository_commit: publication.repository_commit ?? "" },
      admission: { execution_id: admission.executionId, outcome_verdict: "pass", classification: "blind_spot_demonstrated" },
      files,
      approval,
      judge_job: { index_key: job.indexKey, index_sha256: job.indexSha256 },
    };
    const run: PublishedRun = { dir: options.run, policyBytes, publication, rootRun };
    for (const code of checkRelease(release, run, releaseDir)) codes.add(code);
    if (codes.size > 0) {
      const sorted = [...codes].sort();
      deps.log(`build refused codes=${sorted.join(",")}`);
      return { ok: false, codes: sorted, issueSha256 };
    }

    const valid = assertRecord("Release", release);
    try {
      await storeJudgeJob(store ?? new LocalPrivateStore(options.localStore ?? ""), job);
    } catch (error) {
      const code = error instanceof Error && "code" in error && (error.code === "store_mismatch" || error.code === "store_unavailable") ? error.code : null;
      if (code === null) throw error;
      deps.log(`build refused codes=${code}`);
      return { ok: false, codes: [code], issueSha256 };
    }
    deps.log(`build stored key=${job.indexKey} sha256=${job.indexSha256}`);
    const releaseBytes = encodeCanonical(valid);
    writeFileSync(join(releaseDir, RELEASE_FILE), releaseBytes);
    renameSync(releaseDir, options.out);
    const releaseSha256 = sha256Hex(releaseBytes);
    deps.log(`build wrote release=${options.releaseId} release_sha256=${releaseSha256}`);
    return { ok: true, release: valid, releaseSha256, issueSha256 };
  } finally {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  }
}
