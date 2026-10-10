// checkRelease: what makes a release valid (design note section 4), checked against the published
// run and the release directory before anything is written or stored. Each failing check is named
// by a code; build adds the registry, held-out and image checks.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decisionErrors, evidenceErrors } from "@rbw/admission";
import type { Decision } from "@rbw/admission";
import { CanonicalError, RecordError, encodeCanonical, parseCanonical, parseRecord, sha256Hex, taskRevision } from "@rbw/schema";
import type { ExpectedTrials, JobRequest, PublicationRecord, Release, RootRun, RunManifest, TaskRevisionIdentity } from "@rbw/schema";
import { NOVELTY_PATH } from "./stage.ts";

/** The admission policy a release is graded under. */
export const RELEASE_POLICY_ID = "umami-uc3-v1";
export const RELEASE_FILE = "release.json";

export type CheckCode =
  | "run_manifest_mismatch"
  | "run_file_mismatch"
  | "publication_mismatch"
  | "policy_mismatch"
  | "policy_not_public_demo"
  | "root_mismatch"
  | "root_not_factory"
  | "root_not_completed"
  | "admission_missing"
  | "admission_evidence_mismatch"
  | "outcome_verdict_not_pass"
  | "classification_not_blind_spot"
  | "audit_not_pass"
  | "policy_id_not_uc3"
  | "revision_mismatch"
  | "release_file_mismatch"
  | "issue_mismatch"
  | "issue_not_ready"
  | "novelty_blocked"
  | "novelty_incomplete"
  | "approval_issue_mismatch";

/** The published run a release names: its directory as a fresh clone holds runs/<root>/, and its records. */
export interface PublishedRun {
  dir: string;
  policyBytes: Uint8Array;
  publication: PublicationRecord;
  rootRun: RootRun;
}

interface SummaryCopy {
  trial_id?: unknown;
  code_state?: unknown;
  copy?: { audit?: { verdict?: unknown } } | null;
}

function readOptional(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null;
}

function json(bytes: Buffer | null): unknown {
  if (bytes === null) return null;
  try {
    return parseCanonical(bytes);
  } catch (error) {
    if (error instanceof CanonicalError) return null;
    throw error;
  }
}

function parsed<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof RecordError || error instanceof CanonicalError) return null;
    throw error;
  }
}

/** The manifest, when it is the one the release names; otherwise null and a code. */
function manifestOf(release: Release, run: PublishedRun, codes: Set<CheckCode>): RunManifest | null {
  const bytes = readOptional(join(run.dir, "manifest.json"));
  const manifest = bytes === null ? null : parsed(() => parseRecord("RunManifest", bytes));
  if (bytes === null || manifest === null || sha256Hex(bytes) !== release.run.manifest_sha256 || manifest.root_execution_id !== release.run.root_execution_id) {
    codes.add("run_manifest_mismatch");
    return null;
  }
  for (const entry of manifest.entries) {
    if ((entry.outcome !== "published" && entry.outcome !== "truncated") || entry.sha256 === null) continue;
    const file = readOptional(join(run.dir, ...entry.path.split("/")));
    // A large file lives in the public store; a fresh clone holds only the repository files.
    if (file === null ? entry.public_uri === null : sha256Hex(file) !== entry.sha256) codes.add("run_file_mismatch");
  }
  return manifest;
}

/** A published file the manifest names, or null when the run did not publish it here. */
function runFile(run: PublishedRun, manifest: RunManifest, path: string): Buffer | null {
  const entry = manifest.entries.find((item) => item.path === path && item.outcome === "published");
  if (entry === undefined) return null;
  const bytes = readOptional(join(run.dir, ...path.split("/")));
  return bytes !== null && sha256Hex(bytes) === entry.sha256 ? bytes : null;
}

/** The admission job's execution: the one job of kind admission with a published decision. */
export function admissionExecution(runDir: string): { executionId: string; request: JobRequest } | null {
  const manifest = parsed(() => parseRecord("RunManifest", readFileSync(join(runDir, "manifest.json"))));
  if (manifest === null) return null;
  const found: { executionId: string; request: JobRequest }[] = [];
  for (const entry of manifest.entries) {
    const match = /^results\/([0-9a-f-]{36})\/decision\.json$/.exec(entry.path);
    if (match === null || entry.outcome !== "published") continue;
    const executionId = match[1] ?? "";
    const decision = json(readOptional(join(runDir, entry.path))) as { kind?: unknown } | null;
    const requestBytes = readOptional(join(runDir, "results", executionId, "request.json"));
    const request = requestBytes === null ? null : parsed(() => parseRecord("JobRequest", requestBytes));
    if (decision?.kind === "admission" && request?.kind === "admission") found.push({ executionId, request });
  }
  return found.length === 1 ? (found[0] ?? null) : null;
}

/** The complete identity with its issue removed: the provisional revision the admission was graded under. */
export function provisionalOf(identity: TaskRevisionIdentity): TaskRevisionIdentity {
  return { ...identity, revision_kind: "provisional", issue_sha256: null, issue_style: null };
}

function checkAdmission(release: Release, run: PublishedRun, manifest: RunManifest, codes: Set<CheckCode>): void {
  const base = `results/${release.admission.execution_id}`;
  const evidenceBytes = runFile(run, manifest, `${base}/evidence.json`);
  const decision = json(runFile(run, manifest, `${base}/decision.json`)) as Decision | null;
  const requestBytes = runFile(run, manifest, `${base}/request.json`);
  const request = requestBytes === null ? null : parsed(() => parseRecord("JobRequest", requestBytes));
  const expected = json(runFile(run, manifest, `${base}/expected-trials.json`)) as ExpectedTrials | null;
  const summary = json(runFile(run, manifest, `${base}/summary.json`)) as { copies?: SummaryCopy[] } | null;
  const evidence = json(evidenceBytes);
  if (evidenceBytes === null || evidence === null || evidenceErrors(evidence).length > 0 || decision === null || decisionErrors(decision).length > 0 || decision.kind !== "admission" || request?.kind !== "admission") {
    codes.add("admission_missing");
    return;
  }
  if (decision.evidence_sha256 !== sha256Hex(evidenceBytes) || decision.execution_id !== request.execution_id) codes.add("admission_evidence_mismatch");
  if (decision.outcome_verdict !== "pass") codes.add("outcome_verdict_not_pass");
  if (decision.comparison?.classification !== "blind_spot_demonstrated") codes.add("classification_not_blind_spot");
  if (request.policy_id !== RELEASE_POLICY_ID) codes.add("policy_id_not_uc3");

  // Every copy with a declared change passed its audit; clean and fixed copies have none, so theirs does not apply.
  const copies = summary?.copies ?? [];
  const audited = (expected?.trials ?? []).every((trial) => {
    const verdict = copies.find((copy) => copy.trial_id === trial.trial_id)?.copy?.audit?.verdict;
    return verdict === "pass" || (verdict === "not_applicable" && (trial.code_state === "clean" || trial.code_state === "fixed"));
  });
  if (expected === null || !audited) codes.add("audit_not_pass");

  // One hash covers the image, kit, fixture, both suites, profile, mutation and grading policy.
  const [revision] = release.revisions;
  if (revision === undefined) {
    codes.add("revision_mismatch");
    return;
  }
  if (taskRevision(revision.identity).sha256 !== revision.sha256 || taskRevision(provisionalOf(revision.identity)).sha256 !== request.task_revision) codes.add("revision_mismatch");
}

function checkReleaseDir(release: Release, releaseDir: string, codes: Set<CheckCode>): void {
  const listed = new Map(release.files.map((file) => [file.path, file.sha256]));
  const present = readdirSync(releaseDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => [entry.parentPath.slice(releaseDir.length).replace(/^\/+/, ""), entry.name].filter((part) => part !== "").join("/"))
    .filter((path) => path !== RELEASE_FILE);
  const recordingsOnly = [...listed.keys()].every((path) => path === "issue.json" || path === "issue-check.json" || path.startsWith("recordings/"));
  const matches = [...listed].every(([path, sha256]) => {
    const bytes = readOptional(join(releaseDir, ...path.split("/")));
    return bytes !== null && sha256Hex(bytes) === sha256;
  });
  if (!listed.has("issue.json") || !listed.has("issue-check.json") || !recordingsOnly || !matches || present.length !== listed.size || present.some((path) => !listed.has(path))) {
    codes.add("release_file_mismatch");
  }

  const issue = readOptional(join(releaseDir, "issue.json"));
  const issueSha256 = issue === null ? null : sha256Hex(issue);
  if (issueSha256 === null || release.revisions[0]?.identity.issue_sha256 !== issueSha256) codes.add("issue_mismatch");
  // ADM-07: the human alignment check is the recorded approval of exactly this issue.
  if (issueSha256 === null || release.approval.issue_sha256 !== issueSha256) codes.add("approval_issue_mismatch");
  // ADM-07: the writer's code checks (structure, numbers, the identifier scan) passed.
  const report = json(readOptional(join(releaseDir, "issue-check.json"))) as { status?: unknown } | null;
  if (report?.status !== "ready_for_review") codes.add("issue_not_ready");
}

/**
 * ADM-09: a release names a passing admission of a completed factory root under the public_demo
 * policy, its complete revision reduces to that admission's revision, and the release directory
 * holds exactly the files it lists. ADM-07: its issue passed the writer's checks and the exact-
 * phrase searches, and the owner approved this issue's hash. Returns every failing code, sorted.
 */
export function checkRelease(release: Release, run: PublishedRun, releaseDir: string): CheckCode[] {
  const codes = new Set<CheckCode>();
  const manifest = manifestOf(release, run, codes);

  const publication = run.publication;
  if (
    publication.status !== "published" ||
    publication.root_execution_id !== release.run.root_execution_id ||
    publication.publication_id !== release.run.publication_id ||
    publication.manifest_sha256 !== release.run.manifest_sha256 ||
    publication.repository_commit !== release.run.repository_commit
  ) {
    codes.add("publication_mismatch");
  }

  const policyBytes = Buffer.from(run.policyBytes);
  const policy = parsed(() => parseRecord("ProjectPolicy", policyBytes));
  if (policy?.purpose !== "public_demo" || policy.visibility !== "public" || !Buffer.from(encodeCanonical(policy)).equals(policyBytes)) codes.add("policy_not_public_demo");
  const policySha256 = sha256Hex(policyBytes);
  if (
    policySha256 !== release.project_policy_sha256 ||
    policy?.project_id !== release.project_id ||
    publication.project_policy_sha256 !== policySha256 ||
    (manifest !== null && (manifest.project_policy_sha256 !== policySha256 || manifest.project_id !== release.project_id))
  ) {
    codes.add("policy_mismatch");
  }

  const root = run.rootRun;
  if (root.root_execution_id !== release.run.root_execution_id || root.project_policy_sha256 !== policySha256) codes.add("root_mismatch");
  if (root.kind !== "factory" || (manifest !== null && manifest.kind !== "factory")) codes.add("root_not_factory");
  if (root.status !== "terminal" || root.outcome !== "completed" || (manifest !== null && manifest.outcome !== "completed")) codes.add("root_not_completed");

  if (manifest !== null) {
    checkAdmission(release, run, manifest, codes);
    // ADM-07: the three exact-phrase searches found no public match; an incomplete search is never clear.
    const novelty = json(runFile(run, manifest, NOVELTY_PATH)) as { status?: unknown } | null;
    if (novelty?.status === "blocked") codes.add("novelty_blocked");
    else if (novelty?.status !== "clear") codes.add("novelty_incomplete");
  }
  checkReleaseDir(release, releaseDir, codes);
  return [...codes].sort();
}
