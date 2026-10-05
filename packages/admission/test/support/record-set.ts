import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildExpectedTrials,
  buildJobRequest,
  canonicalDigest,
  parseRecord,
  sha256Hex,
  type ArtifactEntry,
  type ArtifactManifest,
  type CheckObservation,
  type CodeState,
  type ExpectedCheck,
  type ExpectedTrial,
  type ExpectedTrials,
  type JobKind,
  type JobRequest,
  type JobRequestFields,
  type ObservedOutcome,
  type TrialObservations,
  type TrialResult,
} from "@rbw/schema";

export const UTC = "tzarg.utc-day-counts";
export const LA = "tzarg.la-day-counts";
export const AKL = "tzarg.auckland-day-counts";
export const KOL = "tzarg.kolkata-day-counts";
export const TEST_IDS = ["synthetic-spec-0001", "synthetic-spec-0002", "synthetic-spec-0003"];

const pass = (checkId: string): ExpectedCheck => ({ check_id: checkId, expected: "pass", failure_code: null });
const fail = (checkId: string, code: ExpectedCheck["failure_code"]): ExpectedCheck => ({ check_id: checkId, expected: "assertion_fail", failure_code: code });

/** The check vectors of the synthetic record sets, in the order UTC, Los Angeles, Auckland, Kolkata. */
export const VECTORS: Record<CodeState, ExpectedCheck[]> = {
  clean: [UTC, LA, AKL, KOL].map(pass),
  fixed: [UTC, LA, AKL, KOL].map(pass),
  planted: [pass(UTC), fail(LA, "local_day_counts_mismatch"), fail(AKL, "local_day_counts_mismatch"), fail(KOL, "local_day_counts_mismatch")],
  partial: [pass(UTC), fail(LA, "local_day_counts_mismatch"), pass(AKL), fail(KOL, "local_day_counts_mismatch")],
  stub: [pass(UTC), fail(LA, "bucket_labels_mismatch"), fail(AKL, "bucket_labels_mismatch"), fail(KOL, "bucket_labels_mismatch")],
};

const EXECUTION_ID = "00000000-0000-4000-8000-000000000203";
const ROOT_ID = "00000000-0000-4000-8000-000000000101";
export const TASK_REVISION = "4".repeat(64);
export const OTHER_TASK_REVISION = "8".repeat(64);
export const ORIGINAL_SUITE = "1".repeat(64);
export const ADDED_SUITE = "2".repeat(64);

export interface OutcomeLine {
  test_id: string;
  outcome: string;
}

export interface TrialDraft {
  expected: ExpectedTrial;
  /** false: no trial-result.json is written. */
  write: boolean;
  status: TrialResult["status"];
  invalidReason: TrialResult["invalid_reason"];
  observations: CheckObservation[];
  responses: Map<string, string>;
  /** null: no original-suite outcomes entry. */
  tests: OutcomeLine[] | null;
  /** Merged into the outcomes file content before it is hashed. */
  outcomesPatch: Record<string, unknown>;
  /** Merged into the artifact manifest before it is hashed. */
  manifestPatch: Record<string, unknown>;
  /** Merged into the observations record before it is hashed. */
  observationsPatch: Record<string, unknown>;
  /** Merged into the result after its hashes are set. */
  resultPatch: Record<string, unknown>;
  /** Merged into the artifact entry of a key. */
  entryPatch: Map<string, Partial<ArtifactEntry>>;
  /** Response keys whose files are written but not listed in the artifact manifest. */
  unlisted: Set<string>;
}

export interface RecordSetDraft {
  kind: JobKind;
  requestFields: JobRequestFields;
  request: JobRequest;
  manifest: ExpectedTrials;
  trials: Map<string, TrialDraft>;
  /** Extra directories under results/, each with this trial-result.json content. */
  extraResults: Map<string, Uint8Array>;
}

export const trialKey = (trialId: string, name: string): string => `trials/${trialId}/${name}`;
export const responseKey = (trialId: string, checkId: string, repeat: number): string => trialKey(trialId, `responses/${checkId}/${String(repeat)}.json`);
export const resultPath = (trialId: string): string => `results/${trialId}/trial-result.json`;

function requestFields(kind: JobKind, manifestSha: string): JobRequestFields {
  return {
    schema_version: 1,
    project_id: "00000000-0000-4000-8000-000000000001",
    project_policy_sha256: "5".repeat(64),
    batch_id: "00000000-0000-4000-8000-000000000301",
    execution_id: EXECUTION_ID,
    root_execution_id: ROOT_ID,
    parent_execution_id: ROOT_ID,
    attempt_ordinal: 1,
    kind,
    task_revision: TASK_REVISION,
    policy_id: "synthetic-policy-1",
    runtime_profile_sha256: "6".repeat(64),
    image_digest: `sha256:${"7".repeat(64)}`,
    expected_trials_key: `jobs/${EXECUTION_ID}/expected-trials.json`,
    expected_trials_sha256: manifestSha,
    baseline_evidence_key: null,
    baseline_evidence_sha256: null,
    deadline_at: "2026-10-05T18:00:00Z",
    reservation_microusd: 2500000,
    release_id: kind === "judge_verify" ? "00000000-0000-4000-8000-000000000401" : null,
  };
}

/** Rebuilds the draft's request with changed fields; operation_id and payload_hash stay consistent. */
export function rebuildRequest(draft: RecordSetDraft, fields: Partial<JobRequestFields>): void {
  draft.requestFields = { ...draft.requestFields, ...fields };
  draft.request = buildJobRequest(draft.requestFields).request;
}

function baselineObservations(trial: ExpectedTrial): { observations: CheckObservation[]; responses: Map<string, string> } {
  const observations: CheckObservation[] = [];
  const responses = new Map<string, string>();
  for (let repeat = 1; repeat <= trial.added_repeat_count; repeat += 1) {
    trial.expected_checks.forEach((check, index) => {
      const key = responseKey(trial.trial_id, check.check_id, repeat);
      responses.set(key, `{"check_id":"${check.check_id}","repeat_index":${String(repeat)},"synthetic":true,"trial_id":"${trial.trial_id}"}`);
      observations.push({
        check_id: check.check_id,
        repeat_index: repeat,
        observed: check.expected,
        failure_code: check.failure_code,
        duration_ms: 40 + index,
        response_artifact_key: key,
        response_artifact_sha256: null,
      });
    });
  }
  return { observations, responses };
}

/** A complete, consistent record set of the given kind, before it is written. */
export function baselineDraft(kind: JobKind = "admission"): RecordSetDraft {
  const built = buildExpectedTrials({
    kind,
    executionId: EXECUTION_ID,
    taskRevision: TASK_REVISION,
    patchSha256: { fixed: "c".repeat(64), planted: "d".repeat(64), partial: "e".repeat(64), stub: "3".repeat(64) },
    originalSuiteSha256: ORIGINAL_SUITE,
    originalTestIds: TEST_IDS,
    addedSuiteSha256: ADDED_SUITE,
    checks: VECTORS,
  });
  const fields = requestFields(kind, built.sha256);
  const request = buildJobRequest(fields).request;
  const trials = new Map<string, TrialDraft>();
  for (const expected of built.manifest.trials) {
    trials.set(expected.trial_id, {
      expected,
      write: true,
      status: "complete",
      invalidReason: null,
      ...baselineObservations(expected),
      tests: expected.original_test_ids.length === 0 ? null : expected.original_test_ids.map((id) => ({ test_id: id, outcome: "passed" })),
      outcomesPatch: {},
      manifestPatch: {},
      observationsPatch: {},
      resultPatch: {},
      entryPatch: new Map(),
      unlisted: new Set(),
    });
  }
  return { kind, requestFields: fields, request, manifest: built.manifest, trials, extraResults: new Map() };
}

export function trial(draft: RecordSetDraft, trialId: string): TrialDraft {
  const found = draft.trials.get(trialId);
  if (found === undefined) throw new Error(`no trial ${trialId} in the draft`);
  return found;
}

/** Sets the observed outcome of one observation of a trial. */
export function observe(draft: RecordSetDraft, trialId: string, checkId: string, repeat: number, observed: ObservedOutcome, failureCode: CheckObservation["failure_code"]): void {
  const found = trial(draft, trialId).observations.find((item) => item.check_id === checkId && item.repeat_index === repeat);
  if (found === undefined) throw new Error(`no observation ${checkId} ${String(repeat)} in ${trialId}`);
  found.observed = observed;
  found.failure_code = failureCode;
}

/** Removes one observation of a trial (a missing repetition). */
export function dropObservation(draft: RecordSetDraft, trialId: string, checkId: string, repeat: number): void {
  const target = trial(draft, trialId);
  target.observations = target.observations.filter((item) => !(item.check_id === checkId && item.repeat_index === repeat));
}

/** Sets the outcome of one original test of a trial. */
export function testOutcome(draft: RecordSetDraft, trialId: string, testId: string, outcome: string): void {
  const line = trial(draft, trialId).tests?.find((item) => item.test_id === testId);
  if (line === undefined) throw new Error(`no test ${testId} in ${trialId}`);
  line.outcome = outcome;
}

function writeAt(root: string, key: string, bytes: Uint8Array | string): void {
  const path = join(root, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

const byObservationOrder = (left: CheckObservation, right: CheckObservation): number =>
  left.repeat_index !== right.repeat_index ? left.repeat_index - right.repeat_index : left.check_id < right.check_id ? -1 : left.check_id > right.check_id ? 1 : 0;

function writeTrial(root: string, draft: RecordSetDraft, trialDraft: TrialDraft): void {
  const { expected } = trialDraft;
  const id = expected.trial_id;
  const entries: ArtifactEntry[] = [];
  const responseSha = new Map<string, string>();
  for (const [key, text] of trialDraft.responses) {
    writeAt(root, key, text);
    const bytes = Buffer.from(text);
    responseSha.set(key, sha256Hex(bytes));
    if (!trialDraft.unlisted.has(key)) entries.push({ kind: "check_response", key, sha256: sha256Hex(bytes), size_bytes: bytes.length, media_type: "application/json" });
  }
  if (trialDraft.tests !== null) {
    const tests = [...trialDraft.tests].sort((left, right) => (left.test_id < right.test_id ? -1 : left.test_id > right.test_id ? 1 : 0));
    const content = { schema_version: 1, trial_id: id, original_suite_sha256: expected.original_suite_sha256 ?? ORIGINAL_SUITE, tests, ...trialDraft.outcomesPatch };
    const { bytes, sha256 } = canonicalDigest(content);
    const key = trialKey(id, "original-suite-outcomes.json");
    writeAt(root, key, bytes);
    entries.push({ kind: "original_suite_outcomes", key, sha256, size_bytes: bytes.length, media_type: "application/json" });
  }
  const patchedEntries = entries.map((entry) => ({ ...entry, ...trialDraft.entryPatch.get(entry.key) }));
  for (const entry of patchedEntries) if (responseSha.has(entry.key)) responseSha.set(entry.key, entry.sha256);
  const manifest = {
    schema_version: 1,
    project_policy_sha256: draft.request.project_policy_sha256,
    root_execution_id: draft.request.root_execution_id,
    execution_id: draft.request.execution_id,
    task_revision: draft.request.task_revision,
    trial_id: id,
    entries: patchedEntries,
    ...trialDraft.manifestPatch,
  };
  const artifacts = canonicalDigest(manifest);
  writeAt(root, trialKey(id, "artifacts.json"), artifacts.bytes);
  const observations = trialDraft.observations
    .map((item) => ({ ...item, response_artifact_sha256: item.response_artifact_key === null ? null : (responseSha.get(item.response_artifact_key) ?? "f".repeat(64)) }))
    .sort(byObservationOrder);
  const observationsRecord = { schema_version: 1, execution_id: draft.request.execution_id, trial_id: id, observations, ...trialDraft.observationsPatch };
  const observationsDigest = canonicalDigest(observationsRecord);
  writeAt(root, trialKey(id, "observations.json"), observationsDigest.bytes);
  if (!trialDraft.write) return;
  const result = {
    schema_version: 1,
    project_policy_sha256: draft.request.project_policy_sha256,
    root_execution_id: draft.request.root_execution_id,
    execution_id: draft.request.execution_id,
    task_revision: draft.request.task_revision,
    trial_id: id,
    code_state: expected.code_state,
    status: trialDraft.status,
    expected_trials_sha256: draft.request.expected_trials_sha256,
    observations_key: trialKey(id, "observations.json"),
    observations_sha256: observationsDigest.sha256,
    artifacts_key: trialKey(id, "artifacts.json"),
    artifacts_sha256: artifacts.sha256,
    invalid_reason: trialDraft.invalidReason,
    started_at: "2026-10-05T12:00:00Z",
    ended_at: "2026-10-05T12:05:00Z",
    ...trialDraft.resultPatch,
  };
  writeAt(root, resultPath(id), canonicalDigest(result).bytes);
}

const created: string[] = [];

/** A new temporary directory, removed by cleanupRecordSets. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rbw-admission-"));
  created.push(dir);
  return dir;
}

export function cleanupRecordSets(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Writes the draft into a new temporary directory and returns its path. */
export function writeRecordSet(draft: RecordSetDraft, dir = tempDir()): string {
  writeAt(dir, "request.json", canonicalDigest(draft.request).bytes);
  writeAt(dir, draft.request.expected_trials_key, canonicalDigest(draft.manifest).bytes);
  for (const trialDraft of draft.trials.values()) writeTrial(dir, draft, trialDraft);
  for (const [name, bytes] of draft.extraResults) writeAt(dir, `results/${name}/trial-result.json`, bytes);
  return dir;
}

/** A written record set: the baseline of a kind, changed by a mutator, then by a hook on the written files. */
export function recordSet(mutate: (draft: RecordSetDraft) => void = () => undefined, after: (dir: string) => void = () => undefined, kind: JobKind = "admission"): string {
  const draft = baselineDraft(kind);
  mutate(draft);
  const dir = writeRecordSet(draft);
  after(dir);
  return dir;
}

/** Parses every record the baseline writes, so a builder fault fails before any importer test runs. */
export function parseWrittenRecords(draft: RecordSetDraft, read: (key: string) => Uint8Array): void {
  const request = parseRecord("JobRequest", read("request.json"));
  parseRecord("ExpectedTrials", read(request.expected_trials_key), { request });
  for (const trialDraft of draft.trials.values()) {
    const id = trialDraft.expected.trial_id;
    const result: TrialResult = parseRecord("TrialResult", read(resultPath(id)), { request });
    const observations: TrialObservations = parseRecord("TrialObservations", read(result.observations_key ?? ""), { request });
    const manifest: ArtifactManifest = parseRecord("ArtifactManifest", read(result.artifacts_key ?? ""), { request });
    if (observations.trial_id !== id || manifest.trial_id !== id) throw new Error(`trial ${id} records disagree`);
  }
}
