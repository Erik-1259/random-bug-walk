import {
  RecordError,
  canonicalDigest,
  parseRecord,
  sha256Hex,
  type ArtifactEntry,
  type ArtifactManifest,
  type DefTypes,
  type ExpectedTrial,
  type ExpectedTrials,
  type JobRequest,
  type TrialObservations,
  type TrialReason,
  type TrialResult,
  type TrialStatus,
} from "@rbw/schema";
import { classifyObservation, combineObservations } from "./classify.ts";
import { ORIGINAL_SUITE_OUTCOMES_KIND, ORIGINAL_SUITE_OUTCOMES_MEDIA_TYPE, readOriginalSuiteOutcomes, type OriginalSuiteOutcomes } from "./original-suite.ts";
import type { Cell, CellState, Evidence, Finding, ImportCode, ObservationEvidence, Stage, TrialEvidence } from "./output.ts";
import { RecordSetDir } from "./paths.ts";

/** A request-level refusal: the whole import stops, with no evidence and no verdict. */
export class ImportRefusal extends Error {
  readonly code: ImportCode;

  constructor(code: ImportCode) {
    super(`import refused: ${code}`);
    this.name = "ImportRefusal";
    this.code = code;
  }
}

type RecordType = "JobRequest" | "ExpectedTrials" | "TrialResult" | "TrialObservations" | "ArtifactManifest";

type RecordRead<T> =
  | { state: "ok"; bytes: Buffer; value: T }
  | { state: "identity"; bytes: Buffer; value: T; errors: readonly string[] }
  | { state: "shape"; errors: readonly string[] }
  | { state: "missing" }
  | { state: "unsafe" };

const sameBytes = (value: unknown, bytes: Buffer): boolean => Buffer.from(canonicalDigest(value).bytes).equals(bytes);

/**
 * Reads one record with parseRecord: canonical bytes, then the schema, then the code rules. Errors
 * that come only from the request context (request:<field>) are identity errors, not shape errors.
 */
function readRecord<K extends RecordType>(dir: RecordSetDir, type: K, key: string, request?: JobRequest): RecordRead<DefTypes[K]> {
  const read = dir.read(key);
  if (read.kind !== "ok") return { state: read.kind };
  const { bytes } = read;
  try {
    const value = parseRecord(type, bytes, request === undefined ? {} : { request });
    return sameBytes(value, bytes) ? { state: "ok", bytes, value } : { state: "shape", errors: ["canonical_bytes"] };
  } catch (error) {
    if (!(error instanceof RecordError)) throw error;
    if (!error.errors.every((code) => code.startsWith("request:"))) return { state: "shape", errors: error.errors };
    const value = parseRecord(type, bytes);
    return sameBytes(value, bytes) ? { state: "identity", bytes, value, errors: error.errors } : { state: "shape", errors: ["canonical_bytes"] };
  }
}

const parsedValue = <T>(read: RecordRead<T>): T | null => (read.state === "ok" || read.state === "identity" ? read.value : null);

function readRequest(dir: RecordSetDir): { request: JobRequest; manifest: ExpectedTrials } {
  const requestRead = readRecord(dir, "JobRequest", "request.json");
  if (requestRead.state === "missing") throw new ImportRefusal("import:request_missing");
  if (requestRead.state === "unsafe") throw new ImportRefusal("import:key_unsafe");
  if (requestRead.state !== "ok") throw new ImportRefusal("import:request_invalid");
  const request = requestRead.value;
  const manifestRead = readRecord(dir, "ExpectedTrials", request.expected_trials_key, request);
  if (manifestRead.state === "missing") throw new ImportRefusal("import:expected_trials_missing");
  if (manifestRead.state === "unsafe") throw new ImportRefusal("import:key_unsafe");
  if (manifestRead.state !== "ok") {
    throw new ImportRefusal(manifestRead.errors.includes("request:expected_trials_sha256") ? "import:expected_trials_hash" : "import:expected_trials_invalid");
  }
  return { request, manifest: manifestRead.value };
}

/** The trial evidence built so far; a stage that fails finishes it with its status and reason. */
class TrialRecorder {
  readonly evidence: TrialEvidence;

  constructor(expected: ExpectedTrial) {
    this.evidence = {
      trial_id: expected.trial_id,
      code_state: expected.code_state,
      status: "complete",
      stage: "outcomes",
      reason: null,
      code: null,
      findings: [],
      driver_status: null,
      driver_reason: null,
      observations_key: null,
      artifacts_key: null,
      original_suite_key: null,
      artifact_keys: [],
      added: null,
      original: null,
      diagnostics: null,
    };
  }

  stop(stage: Stage, status: TrialStatus, findings: readonly Finding[], reason: TrialReason | null): TrialEvidence {
    Object.assign(this.evidence, { stage, status, reason, code: findings[0]?.code ?? null, findings: [...findings] });
    return this.evidence;
  }
}

const finding = (code: ImportCode, detail: string): Finding => ({ code, detail });

interface TrialRecords {
  result: TrialResult;
  resultRead: RecordRead<TrialResult>;
  observations: RecordRead<TrialObservations>;
  artifacts: RecordRead<ArtifactManifest>;
  outcomesEntries: ArtifactEntry[];
  outcomes: OriginalSuiteOutcomes | null;
}

/** Stage 1: every record of the trial parses as its type. Missing files are left to later stages. */
function shapeStage(dir: RecordSetDir, request: JobRequest, result: TrialResult, findings: Finding[]): Omit<TrialRecords, "result" | "resultRead"> {
  const observations: RecordRead<TrialObservations> = result.observations_key === null ? { state: "missing" } : readRecord(dir, "TrialObservations", result.observations_key, request);
  const artifacts: RecordRead<ArtifactManifest> = result.artifacts_key === null ? { state: "missing" } : readRecord(dir, "ArtifactManifest", result.artifacts_key, request);
  for (const [read, code, key] of [
    [observations, "import:shape_observations", result.observations_key],
    [artifacts, "import:shape_artifacts", result.artifacts_key],
  ] as const) {
    if (read.state === "unsafe") findings.push(finding("import:key_unsafe", key ?? ""));
    if (read.state === "shape") findings.push(finding(code, `${key ?? ""}: ${read.errors.join(" ")}`));
  }
  const outcomesEntries = parsedValue(artifacts)?.entries.filter((entry) => entry.kind === ORIGINAL_SUITE_OUTCOMES_KIND) ?? [];
  let outcomes: OriginalSuiteOutcomes | null = null;
  const [entry] = outcomesEntries;
  if (outcomesEntries.length === 1 && entry !== undefined) {
    const read = dir.read(entry.key);
    if (read.kind === "unsafe") findings.push(finding("import:key_unsafe", entry.key));
    if (read.kind === "ok") {
      const parsed = readOriginalSuiteOutcomes(read.bytes);
      if (!parsed.ok) findings.push(finding("import:shape_original_suite", `${entry.key}: ${parsed.error}`));
      else if (entry.media_type !== ORIGINAL_SUITE_OUTCOMES_MEDIA_TYPE) findings.push(finding("import:shape_original_suite", `${entry.key}: media_type`));
      else outcomes = parsed.value;
    }
  }
  return { observations, artifacts, outcomesEntries, outcomes };
}

/** Stage 2: every record carries the request's identity, this trial's ID and its code state. */
function identityStage(expected: ExpectedTrial, records: TrialRecords, findings: Finding[]): void {
  const { result, resultRead } = records;
  if (resultRead.state === "identity") findings.push(finding("import:identity_request", `trial-result: ${resultRead.errors.join(" ")}`));
  if (result.trial_id !== expected.trial_id) findings.push(finding("import:identity_trial_id", `trial-result: ${result.trial_id}`));
  if (result.code_state !== expected.code_state) findings.push(finding("import:identity_code_state", `trial-result: ${result.code_state}`));
  if (result.status !== "complete") return;
  const observations = parsedValue(records.observations);
  if (records.observations.state === "identity" || (observations !== null && observations.trial_id !== result.trial_id)) {
    findings.push(finding("import:identity_observations", result.observations_key ?? ""));
  }
  const artifacts = parsedValue(records.artifacts);
  if (records.artifacts.state === "identity" || (artifacts !== null && artifacts.trial_id !== result.trial_id)) {
    findings.push(finding("import:identity_artifacts", result.artifacts_key ?? ""));
  }
  if (records.outcomesEntries.length > 1) findings.push(finding("import:identity_original_suite", "more than one original-suite outcomes entry"));
  if (records.outcomesEntries.length > 0 && expected.original_test_ids.length === 0) findings.push(finding("import:identity_original_suite", "outcomes for a trial without an original suite"));
  const { outcomes } = records;
  if (outcomes !== null && (outcomes.trial_id !== result.trial_id || outcomes.original_suite_sha256 !== expected.original_suite_sha256)) {
    findings.push(finding("import:identity_original_suite", records.outcomesEntries[0]?.key ?? ""));
  }
}

/** Stage 3: every expected test and every expected check repetition is present exactly once. */
function completenessStage(expected: ExpectedTrial, records: TrialRecords): { invalid: Finding[]; missing: Finding[]; skipped: Finding[] } {
  const invalid: Finding[] = [];
  const missing: Finding[] = [];
  const skipped: Finding[] = [];
  if (expected.original_test_ids.length > 0 && parsedValue(records.artifacts) !== null) {
    if (records.outcomesEntries.length === 0) missing.push(finding("import:test_missing", "no original-suite outcomes entry"));
    const { outcomes } = records;
    if (outcomes !== null) {
      const byId = new Map(outcomes.tests.map((test) => [test.test_id, test.outcome]));
      for (const test of outcomes.tests) if (!expected.original_test_ids.includes(test.test_id)) invalid.push(finding("import:test_unexpected", test.test_id));
      for (const id of expected.original_test_ids) {
        const outcome = byId.get(id);
        if (outcome === undefined) missing.push(finding("import:test_missing", id));
        else if (outcome === "skipped") skipped.push(finding("import:test_skipped", id));
      }
    }
  }
  const observations = parsedValue(records.observations);
  if (observations !== null) {
    const checkIds = new Set(expected.expected_checks.map((check) => check.check_id));
    const seen = new Set<string>();
    for (const observation of observations.observations) {
      const where = `${observation.check_id} repeat ${String(observation.repeat_index)}`;
      if (!checkIds.has(observation.check_id)) invalid.push(finding("import:check_unexpected", where));
      else if (observation.repeat_index > expected.added_repeat_count) invalid.push(finding("import:repeat_unexpected", where));
      seen.add(`${observation.check_id}#${String(observation.repeat_index)}`);
    }
    for (let repeat = 1; repeat <= expected.added_repeat_count; repeat += 1) {
      for (const check of expected.expected_checks) {
        if (!seen.has(`${check.check_id}#${String(repeat)}`)) missing.push(finding("import:check_missing", `${check.check_id} repeat ${String(repeat)}`));
      }
    }
  }
  return { invalid, missing, skipped };
}

/** Stage 4: the records and every listed artifact hash to what the result and manifest declare. */
function provenanceStage(dir: RecordSetDir, records: TrialRecords): { invalid: Finding[]; incomplete: Finding[] } {
  const invalid: Finding[] = [];
  const incomplete: Finding[] = [];
  const { result } = records;
  for (const [read, key, declared, missingCode, mismatchCode] of [
    [records.observations, result.observations_key, result.observations_sha256, "import:observations_missing", "import:observations_hash_mismatch"],
    [records.artifacts, result.artifacts_key, result.artifacts_sha256, "import:artifacts_missing", "import:artifacts_hash_mismatch"],
  ] as const) {
    if (read.state === "missing") incomplete.push(finding(missingCode, key ?? ""));
    else if ((read.state === "ok" || read.state === "identity") && sha256Hex(read.bytes) !== declared) incomplete.push(finding(mismatchCode, key ?? ""));
  }
  const entries = parsedValue(records.artifacts)?.entries ?? [];
  for (const entry of entries) {
    const read = dir.read(entry.key);
    if (read.kind === "unsafe") invalid.push(finding("import:key_unsafe", entry.key));
    else if (read.kind === "missing") incomplete.push(finding("import:artifact_missing", entry.key));
    else if (sha256Hex(read.bytes) !== entry.sha256 || read.bytes.length !== entry.size_bytes) incomplete.push(finding("import:artifact_hash_mismatch", entry.key));
  }
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  for (const observation of parsedValue(records.observations)?.observations ?? []) {
    if (observation.response_artifact_key === null) continue;
    const entry = byKey.get(observation.response_artifact_key);
    if (entry === undefined) incomplete.push(finding("import:response_unlisted", observation.response_artifact_key));
    else if (entry.sha256 !== observation.response_artifact_sha256) incomplete.push(finding("import:response_hash_mismatch", observation.response_artifact_key));
  }
  return { invalid, incomplete };
}

const PROVENANCE_REASON: Partial<Record<ImportCode, TrialReason>> = {
  "import:observations_missing": "artifact_missing",
  "import:artifacts_missing": "artifact_missing",
  "import:artifact_missing": "artifact_missing",
  "import:response_unlisted": "artifact_missing",
  "import:observations_hash_mismatch": "artifact_hash_mismatch",
  "import:artifacts_hash_mismatch": "artifact_hash_mismatch",
  "import:artifact_hash_mismatch": "artifact_hash_mismatch",
  "import:response_hash_mismatch": "artifact_hash_mismatch",
};

function diagnostics(dir: RecordSetDir, request: JobRequest, result: TrialResult): TrialEvidence["diagnostics"] {
  if (result.observations_key === null) return null;
  const read = readRecord(dir, "TrialObservations", result.observations_key, request);
  if (read.state !== "ok" || read.value.trial_id !== result.trial_id) return null;
  return read.value.observations.map(({ check_id, repeat_index, observed, failure_code }) => ({ check_id, repeat_index, observed, failure_code }));
}

/** Runs the five stages for one expected trial; the first stage that fails ends the trial there. */
function importTrial(dir: RecordSetDir, request: JobRequest, expected: ExpectedTrial): TrialEvidence {
  const recorder = new TrialRecorder(expected);
  const resultKey = `results/${expected.trial_id}/trial-result.json`;
  const resultRead = readRecord(dir, "TrialResult", resultKey, request);
  if (resultRead.state === "missing") return recorder.stop("completeness", "incomplete", [finding("import:result_missing", resultKey)], "artifact_missing");
  if (resultRead.state === "unsafe") return recorder.stop("shape", "invalid", [finding("import:key_unsafe", resultKey)], null);
  if (resultRead.state === "shape") return recorder.stop("shape", "invalid", [finding("import:shape_result", `${resultKey}: ${resultRead.errors.join(" ")}`)], null);
  const result = resultRead.value;
  Object.assign(recorder.evidence, {
    driver_status: result.status,
    driver_reason: result.invalid_reason,
    observations_key: result.observations_key,
    artifacts_key: result.artifacts_key,
  });

  const shapeFindings: Finding[] = [];
  const records: TrialRecords =
    result.status === "complete"
      ? { result, resultRead, ...shapeStage(dir, request, result, shapeFindings) }
      : { result, resultRead, observations: { state: "missing" }, artifacts: { state: "missing" }, outcomesEntries: [], outcomes: null };
  recorder.evidence.artifact_keys = parsedValue(records.artifacts)?.entries.map((entry) => entry.key) ?? [];
  recorder.evidence.original_suite_key = records.outcomesEntries[0]?.key ?? null;
  if (shapeFindings.length > 0) return recorder.stop("shape", "invalid", shapeFindings, null);

  const identityFindings: Finding[] = [];
  identityStage(expected, records, identityFindings);
  if (identityFindings.length > 0) return recorder.stop("identity", "invalid", identityFindings, null);

  // The driver's status is never upgraded: a trial it marked invalid or incomplete keeps that
  // status and reason, and its observations are kept only as diagnostics.
  if (result.status !== "complete") {
    recorder.evidence.diagnostics = diagnostics(dir, request, result);
    return recorder.stop("driver", result.status, [finding("import:driver_status", result.invalid_reason ?? "")], result.invalid_reason);
  }

  const completeness = completenessStage(expected, records);
  if (completeness.invalid.length > 0) return recorder.stop("completeness", "invalid", [...completeness.invalid, ...completeness.missing, ...completeness.skipped], null);
  if (completeness.missing.length > 0) return recorder.stop("completeness", "incomplete", [...completeness.missing, ...completeness.skipped], "test_missing");
  if (completeness.skipped.length > 0) return recorder.stop("completeness", "incomplete", completeness.skipped, "test_skipped");

  const provenance = provenanceStage(dir, records);
  if (provenance.invalid.length > 0) return recorder.stop("provenance", "invalid", [...provenance.invalid, ...provenance.incomplete], null);
  const [firstProvenance] = provenance.incomplete;
  if (firstProvenance !== undefined) return recorder.stop("provenance", "incomplete", provenance.incomplete, PROVENANCE_REASON[firstProvenance.code] ?? "artifact_missing");

  return outcomesStage(recorder, expected, records);
}

/** Stage 5: classifies every observation against its expected check and records every original test. */
function outcomesStage(recorder: TrialRecorder, expected: ExpectedTrial, records: TrialRecords): TrialEvidence {
  const checks = new Map(expected.expected_checks.map((check) => [check.check_id, check]));
  const observations: ObservationEvidence[] = [];
  const classified = [];
  const findings: Finding[] = [];
  for (const observation of parsedValue(records.observations)?.observations ?? []) {
    const check = checks.get(observation.check_id);
    if (check === undefined) throw new Error("completeness admitted an unexpected check");
    const outcome = classifyObservation(check, observation);
    classified.push(outcome);
    if (outcome.code !== null) findings.push(finding(outcome.code, `${observation.check_id} repeat ${String(observation.repeat_index)}`));
    observations.push({
      check_id: observation.check_id,
      repeat_index: observation.repeat_index,
      expected: check.expected,
      expected_failure_code: check.failure_code,
      observed: observation.observed,
      failure_code: observation.failure_code,
      classification: outcome.classification,
      reason: outcome.reason,
      response_artifact_key: observation.response_artifact_key,
    });
  }
  const { verdict, first } = combineObservations(classified);
  const tests = (records.outcomes?.tests ?? []).flatMap((test) => (test.outcome === "skipped" ? [] : [{ test_id: test.test_id, outcome: test.outcome }]));
  recorder.evidence.added = { verdict, observations };
  recorder.evidence.original = { tests, failed_test_ids: tests.filter((test) => test.outcome === "failed").map((test) => test.test_id) };
  if (verdict === "invalid" || verdict === "incomplete") {
    const leading = findings.filter((item) => item.code === first?.code);
    return recorder.stop("outcomes", verdict, [...leading, ...findings.filter((item) => item.code !== first?.code)], first?.reason ?? null);
  }
  return recorder.evidence;
}

/** The trials whose original suite and added checks form the six cells, in output order. */
const CELL_TRIALS = ["clean-01", "planted-01", "fixed-01"] as const;

/** The six cells before any import: every cell not_run, with the expected IDs and suite hashes. */
export function initialCells(manifest: ExpectedTrials): Cell[] | null {
  const trials = CELL_TRIALS.map((id) => manifest.trials.find((item) => item.trial_id === id));
  if (trials.some((item) => item === undefined)) return null;
  return trials.flatMap((expected): Cell[] => {
    if (expected === undefined) return [];
    const base = { trial_id: expected.trial_id, state: "not_run" as const, matches_expectation: false, executed_ids: [], executed_count: 0, failing: [], artifact_keys: [] };
    const checkIds = expected.expected_checks.map((check) => check.check_id);
    return [
      { ...base, suite: "original", suite_sha256: expected.original_suite_sha256, expected_ids: [...expected.original_test_ids], expected_count: expected.original_test_ids.length },
      { ...base, suite: "added", suite_sha256: expected.added_suite_sha256, expected_ids: checkIds, expected_count: checkIds.length * expected.added_repeat_count },
    ];
  });
}

/** A cell whose suite was never classified takes the trial's status; only an invalid trial is invalid. */
const unobservedState = (trial: TrialEvidence): CellState => (trial.status === "invalid" ? "invalid" : "incomplete");

function observedCell(cell: Cell, trial: TrialEvidence): Cell {
  if (cell.suite === "original") {
    if (trial.original === null) return { ...cell, state: unobservedState(trial), artifact_keys: trial.original_suite_key === null ? [] : [trial.original_suite_key] };
    const state = trial.original.failed_test_ids.length > 0 ? "fail" : "pass";
    return {
      ...cell,
      state,
      matches_expectation: state === "pass",
      executed_ids: trial.original.tests.map((test) => test.test_id),
      executed_count: trial.original.tests.length,
      failing: trial.original.failed_test_ids.map((id) => ({ id, repeat_index: null, failure_code: null })),
      artifact_keys: trial.original_suite_key === null ? [] : [trial.original_suite_key],
    };
  }
  if (trial.added === null) return { ...cell, state: unobservedState(trial), artifact_keys: trial.observations_key === null ? [] : [trial.observations_key] };
  const { verdict, observations } = trial.added;
  const executed = observations.filter((item) => item.observed === "pass" || item.observed === "assertion_fail");
  const failing = observations.filter((item) => item.observed === "assertion_fail");
  const state: CellState = verdict === "invalid" || verdict === "incomplete" ? verdict : failing.length > 0 ? "fail" : "pass";
  const responses = observations.flatMap((item) => (item.response_artifact_key === null ? [] : [item.response_artifact_key]));
  return {
    ...cell,
    state,
    matches_expectation: verdict === "match",
    executed_ids: cell.expected_ids.filter((id) => executed.some((item) => item.check_id === id)),
    executed_count: executed.length,
    failing: failing.map((item) => ({ id: item.check_id, repeat_index: item.repeat_index, failure_code: item.failure_code })),
    artifact_keys: [...new Set([...(trial.observations_key === null ? [] : [trial.observations_key]), ...responses])],
  };
}

function observedCells(manifest: ExpectedTrials, trials: readonly TrialEvidence[]): Cell[] | null {
  return (
    initialCells(manifest)?.map((cell) => {
      const trial = trials.find((item) => item.trial_id === cell.trial_id);
      return trial === undefined ? cell : observedCell(cell, trial);
    }) ?? null
  );
}

function openDir(path: string): RecordSetDir {
  try {
    return new RecordSetDir(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) throw new ImportRefusal("import:request_missing");
    throw error;
  }
}

/**
 * Imports one job's record set: the request-level checks, then the five stages for every
 * expected trial, then the six cells. Throws ImportRefusal when the request-level checks fail.
 */
export function importRecordSet(path: string): Evidence {
  const dir = openDir(path);
  const { request, manifest } = readRequest(dir);
  const trials = manifest.trials.map((expected) => importTrial(dir, request, expected));
  const expectedIds = new Set(manifest.trials.map((item) => item.trial_id));
  const unexpected = dir
    .list("results")
    .filter((name) => !expectedIds.has(name))
    .map((name) => ({ name, status: "invalid" as const, stage: "identity" as const, code: "import:identity_unexpected_trial" as const }));
  return {
    schema_version: 1,
    request: {
      kind: request.kind,
      execution_id: request.execution_id,
      root_execution_id: request.root_execution_id,
      project_policy_sha256: request.project_policy_sha256,
      task_revision: request.task_revision,
      expected_trials_key: request.expected_trials_key,
      expected_trials_sha256: request.expected_trials_sha256,
    },
    trials,
    unexpected_results: unexpected,
    cells: observedCells(manifest, trials),
  };
}
