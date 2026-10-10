// The jobs of the first local sequence, built only with @rbw/schema's builders: the request, its
// expected trials, and every identity in them. Trial IDs, code states and round counts come from
// TRIAL_PROFILES; expected outcome vectors from the fixture's outcome_vectors, checked against
// the probes' recorded vectors; patch hashes from the derived code states.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { ImportRefusal, importRecordSet } from "@rbw/admission";
import { assertRecord, buildExpectedTrials, buildJobRequest, canonicalDigest, mutationId, sha256Hex, taskRevision } from "@rbw/schema";
import type { CodeState, ExpectedCheck, ExpectedTrials, JobKind, JobRequest, TaskRevisionIdentity } from "@rbw/schema";
import type { ProbeSet } from "@rbw/shapes";
import { UMAMI_COMMIT } from "@rbw/umami-driver";
import type { Fixture } from "@rbw/umami-fixture";
import type { CodeStates, StateFile, StateKey } from "./code-states.ts";

export type JobLabel = "kit-check" | "observe" | "admission" | "alternative-fix";

export const JOB_LABELS: readonly JobLabel[] = ["kit-check", "observe", "admission", "alternative-fix"];

/**
 * The alternative fix is development evidence outside the admission job's 13 copies. It runs as
 * the fixed-01 trial of its own judge_verify job, the one profile with a single fixed copy that
 * runs the added checks once and the original suite once; that job's other trials never run.
 */
export const JOB_KINDS: Readonly<Record<JobLabel, JobKind>> = {
  "kit-check": "kit_check",
  observe: "observe",
  admission: "admission",
  "alternative-fix": "judge_verify",
};

/** Where the kit check's imported evidence sits under the run directory; its record set is `records/` beside it. */
export const BASELINE_KEY = "jobs/kit-check/evidence.json";

/** Development placeholders: no controller issues projects or policies to this runner yet. */
export const PLACEHOLDER_PROJECT_ID = "00000000-0000-4000-8000-000000000001";
export const PLACEHOLDER_POLICY_SHA256 = "0".repeat(64);
export const POLICY_ID = "local-development";
/** The schema's smallest reservation; a local Docker run spends nothing (the proof-job script does the same). */
export const PLACEHOLDER_RESERVATION_MICROUSD = 1;

export class JobRefusal extends Error {
  override name = "JobRefusal";
}

export interface RunIds {
  /** Eight hex digits that name this run's containers. */
  run_tag: string;
  project_id: string;
  batch_id: string;
  root_execution_id: string;
  executions: Readonly<Record<JobLabel | "candidate-text", string>>;
  release_id: string;
}

export function runTag(rootExecutionId: string): string {
  return sha256Hex(Buffer.from(rootExecutionId)).slice(0, 8);
}

export function newRunIds(uuid: () => string): RunIds {
  const root = uuid();
  return {
    run_tag: runTag(root),
    project_id: PLACEHOLDER_PROJECT_ID,
    batch_id: uuid(),
    root_execution_id: root,
    executions: { "kit-check": uuid(), observe: uuid(), admission: uuid(), "alternative-fix": uuid(), "candidate-text": uuid() },
    release_id: uuid(),
  };
}

export interface JobContext {
  ids: RunIds;
  imageDigest: string;
  /** SHA-256 of the image manifest the kit writes at build time. */
  kitSha256: string;
  fixtureSha256: string;
  addedSuiteSha256: string;
  originalSuite: { sha256: string; testIds: readonly string[] };
  states: CodeStates;
  vectors: Readonly<Record<CodeState, readonly ExpectedCheck[]>>;
  /** SHA-256 of the copy profile (resources, network, limits), as the runtime profile and the environment. */
  profileSha256: string;
  deadlineAt: string;
  /** The project policy the jobs run under. Absent: the development placeholders. */
  projectPolicy?: { sha256: string; policy_id: string };
  /** The code state judge_verify's fixed trial grades. Absent: the alternative fix. */
  judgeFixed?: "fixed" | "alternative_fix";
  /** The frozen issue. Present: the candidate's revision is complete. Absent: provisional, with no issue. */
  issue?: { sha256: string; style: string };
}

export interface BuiltJob {
  label: JobLabel;
  kind: JobKind;
  request: JobRequest;
  requestBytes: Uint8Array;
  requestSha256: string;
  expected: ExpectedTrials;
  expectedBytes: Uint8Array;
  expectedSha256: string;
}

function state(states: CodeStates, key: StateKey): StateFile {
  const found = states.get(key);
  if (found === undefined) throw new JobRefusal(`the ${key} code state was not derived`);
  return found;
}

function patchHash(states: CodeStates, key: StateKey): string {
  const hash = state(states, key).patch_sha256;
  if (hash === null) throw new JobRefusal(`the ${key} code state has no patch`);
  return hash;
}

/** The expected-check vectors from the fixture, refused when a probe's recorded vector disagrees. */
export function expectedVectors(fixture: Fixture, probes: ProbeSet): Record<CodeState, ExpectedCheck[]> {
  const vector = (codeState: CodeState): ExpectedCheck[] =>
    fixture.outcome_vectors[codeState].map((row) => assertRecord("ExpectedCheck", { check_id: row.check_id, expected: row.observed, failure_code: row.failure_code }));
  const vectors = { clean: vector("clean"), fixed: vector("fixed"), planted: vector("planted"), partial: vector("partial"), stub: vector("stub") };
  for (const [probeId, codeState] of [
    ["mutation", "planted"],
    ["partial", "partial"],
    ["stub", "stub"],
  ] as const) {
    const recorded = probes.data.probes.find((probe) => probe.id === probeId)?.expected;
    const fixtureVector = vectors[codeState];
    const agrees =
      recorded !== undefined &&
      Object.keys(recorded).length === fixtureVector.length &&
      fixtureVector.every((check) => {
        const probe = recorded[check.check_id];
        if (probe === undefined) return false;
        return probe.outcome === "pass" ? check.expected === "pass" && check.failure_code === null : check.expected === "assertion_fail" && check.failure_code === probe.reason;
      });
    if (!agrees) throw new JobRefusal(`probe ${probeId} records a vector that differs from the fixture's ${codeState} vector`);
  }
  return vectors;
}

function policyId(ctx: JobContext): string {
  return ctx.projectPolicy?.policy_id ?? POLICY_ID;
}

function kitRevision(ctx: JobContext): string {
  return taskRevision({
    schema_version: 1,
    revision_kind: "kit",
    host_commit: UMAMI_COMMIT,
    image_digest: ctx.imageDigest,
    kit_sha256: ctx.kitSha256,
    fixture_sha256: ctx.fixtureSha256,
    original_suite_sha256: ctx.originalSuite.sha256,
    added_suite_sha256: ctx.addedSuiteSha256,
    grading_policy_id: policyId(ctx),
    environment_sha256: ctx.profileSha256,
    mutation_id: null,
    issue_sha256: null,
    issue_style: null,
  }).sha256;
}

/**
 * The identity the candidate's task revision hashes: the kit's inputs plus the mutation, and
 * provisional with no issue until the context names the frozen issue, which makes it complete.
 */
export function candidateIdentity(ctx: JobContext): TaskRevisionIdentity {
  const clean = state(ctx.states, "clean");
  const planted = state(ctx.states, "planted");
  const mutation = mutationId(
    { host_commit: UMAMI_COMMIT, changes: [{ path: planted.path, original_sha256: clean.sha256, resulting_sha256: planted.sha256, original_mode: "100644", resulting_mode: "100644" }] },
    { allowedPaths: [planted.path] },
  ).sha256;
  return {
    schema_version: 1,
    revision_kind: ctx.issue === undefined ? "provisional" : "complete",
    host_commit: UMAMI_COMMIT,
    image_digest: ctx.imageDigest,
    kit_sha256: ctx.kitSha256,
    fixture_sha256: ctx.fixtureSha256,
    original_suite_sha256: ctx.originalSuite.sha256,
    added_suite_sha256: ctx.addedSuiteSha256,
    grading_policy_id: policyId(ctx),
    environment_sha256: ctx.profileSha256,
    mutation_id: mutation,
    issue_sha256: ctx.issue?.sha256 ?? null,
    issue_style: ctx.issue?.style ?? null,
  };
}

function candidateRevision(ctx: JobContext): string {
  return taskRevision(candidateIdentity(ctx)).sha256;
}

export function buildJob(label: JobLabel, ctx: JobContext, baseline: { key: string; sha256: string } | null = null): BuiltJob {
  const kind = JOB_KINDS[label];
  if (kind === "observe" && baseline === null) throw new JobRefusal("an observation needs the kit-check baseline");
  const executionId = ctx.ids.executions[label];
  const revision = label === "kit-check" ? kitRevision(ctx) : candidateRevision(ctx);
  const expected = buildExpectedTrials({
    kind,
    executionId,
    taskRevision: revision,
    patchSha256: {
      planted: patchHash(ctx.states, "planted"),
      fixed: patchHash(ctx.states, label === "alternative-fix" ? (ctx.judgeFixed ?? "alternative_fix") : "fixed"),
      partial: patchHash(ctx.states, "partial"),
      stub: patchHash(ctx.states, "stub"),
    },
    originalSuiteSha256: ctx.originalSuite.sha256,
    originalTestIds: ctx.originalSuite.testIds,
    addedSuiteSha256: ctx.addedSuiteSha256,
    checks: ctx.vectors,
  });
  const built = buildJobRequest({
    schema_version: 1,
    project_id: ctx.ids.project_id,
    project_policy_sha256: ctx.projectPolicy?.sha256 ?? PLACEHOLDER_POLICY_SHA256,
    batch_id: ctx.ids.batch_id,
    execution_id: executionId,
    root_execution_id: ctx.ids.root_execution_id,
    parent_execution_id: ctx.ids.root_execution_id,
    attempt_ordinal: 1,
    kind,
    task_revision: revision,
    policy_id: policyId(ctx),
    runtime_profile_sha256: ctx.profileSha256,
    image_digest: ctx.imageDigest,
    expected_trials_key: `jobs/${executionId}/expected-trials.json`,
    expected_trials_sha256: expected.sha256,
    baseline_evidence_key: kind === "observe" ? (baseline?.key ?? null) : null,
    baseline_evidence_sha256: kind === "observe" ? (baseline?.sha256 ?? null) : null,
    deadline_at: ctx.deadlineAt,
    reservation_microusd: PLACEHOLDER_RESERVATION_MICROUSD,
    release_id: kind === "judge_verify" ? ctx.ids.release_id : null,
  });
  return {
    label,
    kind,
    request: built.request,
    requestBytes: built.bytes,
    requestSha256: built.sha256,
    expected: expected.manifest,
    expectedBytes: expected.bytes,
    expectedSha256: expected.sha256,
  };
}

/** Writes a job directory laid out as the driver reads it: request.json and the expected trials at its key. */
export function writeJobDir(dir: string, job: Pick<BuiltJob, "request" | "requestBytes" | "expectedBytes">): void {
  const expectedPath = join(dir, ...job.request.expected_trials_key.split("/"));
  mkdirSync(dirname(expectedPath), { recursive: true });
  writeFileSync(join(dir, "request.json"), job.requestBytes);
  writeFileSync(expectedPath, job.expectedBytes);
}

/** The SHA-256 of the evidence a record set imports to now, or the importer's refusal code. */
export function evidenceDigest(recordsDir: string): { sha256: string | null; refusal: string | null } {
  try {
    return { sha256: canonicalDigest(importRecordSet(recordsDir)).sha256, refusal: null };
  } catch (error) {
    if (error instanceof ImportRefusal) return { sha256: null, refusal: error.code };
    throw error;
  }
}

export type BaselineCheck = { ok: true; key: string; sha256: string } | { ok: false; reason: "baseline_missing" | "baseline_mismatch"; detail: string };

/**
 * Before an observation starts: the request must name the kit-check baseline, the evidence file
 * at its key (under the run directory `root`) must hash to the named value, and the kit-check
 * record set beside it must still import to that same evidence.
 */
export function checkBaseline(root: string, request: JobRequest): BaselineCheck {
  const key = request.baseline_evidence_key;
  const expected = request.baseline_evidence_sha256;
  if (key === null || expected === null) return { ok: false, reason: "baseline_missing", detail: "the request names no kit-check baseline" };
  const path = join(root, ...key.split("/"));
  if (!existsSync(path)) return { ok: false, reason: "baseline_missing", detail: `no kit-check evidence at ${key}` };
  const bytes = readFileSync(path);
  const actual = sha256Hex(bytes);
  if (actual !== expected) return { ok: false, reason: "baseline_mismatch", detail: `the request names ${expected} but ${key} hashes to ${actual}` };
  const evidence = JSON.parse(bytes.toString("utf8")) as { request?: { kind?: unknown } };
  if (evidence.request?.kind !== "kit_check") return { ok: false, reason: "baseline_mismatch", detail: `${key} is not a kit-check evidence file` };
  const recordsKey = posix.join(posix.dirname(key), "records");
  const recomputed = evidenceDigest(join(root, ...recordsKey.split("/")));
  if (recomputed.sha256 !== expected) {
    const found = recomputed.sha256 ?? `nothing (${recomputed.refusal ?? "refused"})`;
    return { ok: false, reason: "baseline_mismatch", detail: `the kit-check records at ${recordsKey} import to ${found}, not ${expected}` };
  }
  return { ok: true, key, sha256: expected };
}
