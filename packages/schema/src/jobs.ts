import { canonicalDigest, type CanonicalDigest } from "./canonical.ts";
import { TRIAL_PROFILES, jobOperationIdentity, jobPayloadDigest } from "./derive.ts";
import {
  FILE_MODE_VALUES,
  JOB_KIND_VALUES,
  type CodeState,
  type ExpectedCheck,
  type ExpectedTrial,
  type ExpectedTrials,
  type JobKind,
  type JobRequest,
  type MutationChange,
  type MutationIdentity,
  type OperationIdentity,
  type TaskRevisionIdentity,
} from "./generated.ts";
import { RecordError, assertRecord, validateRecord } from "./validate.ts";

export { TRIAL_PROFILES, jobOperationIdentity } from "./derive.ts";
export type { ProfileTrial, TrialProfile } from "./derive.ts";

/** Every JobRequest field except the two the builder computes. */
export type JobRequestFields = Omit<JobRequest, "operation_id" | "payload_hash">;

export interface BuiltJobRequest {
  request: JobRequest;
  bytes: Uint8Array;
  sha256: string;
}

export interface ExpectedTrialsInput {
  kind: JobKind;
  executionId: string;
  taskRevision: string;
  /** A patch hash for each non-clean code state the kind uses; others are ignored. */
  patchSha256: Partial<Record<Exclude<CodeState, "clean">, string>>;
  /** Ignored for observe, whose trials run no original suite. */
  originalSuiteSha256: string | null;
  originalTestIds: readonly string[];
  addedSuiteSha256: string;
  /** An expected-check vector for each code state the kind uses; others are ignored. */
  checks: Partial<Record<CodeState, readonly ExpectedCheck[]>>;
}

export interface BuiltExpectedTrials {
  manifest: ExpectedTrials;
  bytes: Uint8Array;
  sha256: string;
}

export interface MutationInput {
  host_commit: string;
  changes: readonly MutationChange[];
}

const PLACEHOLDER_SHA256 = "0".repeat(64);

/** operation_id: the SHA-256 of the identity record's canonical bytes. Throws RecordError when invalid. */
export function operationId(identity: OperationIdentity): CanonicalDigest {
  return canonicalDigest(assertRecord("OperationIdentity", identity));
}

/** payload_hash of a job request: the request without its payload_hash key, operation_id included. */
export function jobPayloadHash(fields: Omit<JobRequest, "payload_hash"> | JobRequest): CanonicalDigest {
  return jobPayloadDigest(fields);
}

/** Computes operation_id and payload_hash, validates the request, and returns it with its canonical bytes and SHA-256. */
export function buildJobRequest(fields: JobRequestFields): BuiltJobRequest {
  // Check the shape first, with placeholder IDs, so a missing or malformed field is refused with
  // its schema error before anything is hashed; only the two ID rules may fail at this point.
  const shape = validateRecord("JobRequest", { ...fields, operation_id: PLACEHOLDER_SHA256, payload_hash: PLACEHOLDER_SHA256 });
  const shapeErrors = shape.filter((error) => error !== "job:operation_id" && error !== "job:payload_hash");
  if (shapeErrors.length > 0) throw new RecordError("JobRequest", shapeErrors);
  const withOperation = { ...fields, operation_id: canonicalDigest(jobOperationIdentity(fields)).sha256 };
  const candidate = { ...withOperation, payload_hash: jobPayloadDigest(withOperation).sha256 };
  const request = assertRecord("JobRequest", candidate);
  const { bytes, sha256 } = canonicalDigest(request);
  return { request, bytes, sha256 };
}

/**
 * Builds the expected-trial manifest of a job kind from the kind's trial profile and the given
 * hashes and check vectors. Throws RecordError with a build: code for a kind that is not a job
 * kind, a missing patch hash or check vector, or a missing original suite outside observe.
 */
export function buildExpectedTrials(input: ExpectedTrialsInput): BuiltExpectedTrials {
  if (!(JOB_KIND_VALUES as readonly string[]).includes(input.kind)) throw new RecordError("ExpectedTrials", ["build:kind"]);
  const profile = TRIAL_PROFILES[input.kind];
  if (profile.originalSuite && input.originalSuiteSha256 === null) throw new RecordError("ExpectedTrials", ["build:original_suite_missing"]);
  const trials = profile.trials.map((trial): ExpectedTrial => {
    const patch = trial.code_state === "clean" ? null : input.patchSha256[trial.code_state];
    if (patch === undefined) throw new RecordError("ExpectedTrials", ["build:patch_missing"]);
    const checks = input.checks[trial.code_state];
    if (checks === undefined) throw new RecordError("ExpectedTrials", ["build:checks_missing"]);
    return {
      trial_id: trial.trial_id,
      code_state: trial.code_state,
      patch_sha256: patch,
      original_suite_sha256: profile.originalSuite ? input.originalSuiteSha256 : null,
      original_test_ids: profile.originalSuite ? [...input.originalTestIds] : [],
      added_suite_sha256: input.addedSuiteSha256,
      added_repeat_count: trial.added_repeat_count,
      expected_checks: checks.map((check) => ({ ...check })),
    };
  });
  const candidate = { schema_version: 1, execution_id: input.executionId, task_revision: input.taskRevision, trials };
  const manifest = assertRecord("ExpectedTrials", candidate);
  const { bytes, sha256 } = canonicalDigest(manifest);
  return { manifest, bytes, sha256 };
}

function changeRefusal(change: MutationChange, allowed: ReadonlySet<string>): string | null {
  for (const mode of [change.original_mode, change.resulting_mode]) {
    if (mode !== null && !(FILE_MODE_VALUES as readonly string[]).includes(mode)) return "mutation:mode";
  }
  if (change.path.startsWith("/")) return "mutation:absolute_path";
  if (change.path.split("/").some((segment) => segment === ".." || segment === ".")) return "mutation:traversal";
  if (!allowed.has(change.path)) return "mutation:outside_allowed";
  return null;
}

/**
 * mutation_id: sorts the changes by path and hashes the identity record. A mode outside FileMode
 * (such as a symlink), an absolute path, a . or .. segment, or a path outside allowedPaths is
 * refused before anything is hashed. Throws RecordError.
 */
export function mutationId(input: MutationInput, options: { allowedPaths: Iterable<string> }): CanonicalDigest {
  const allowed = new Set(options.allowedPaths);
  for (const change of input.changes) {
    const code = changeRefusal(change, allowed);
    if (code !== null) throw new RecordError("MutationIdentity", [code]);
  }
  const changes = [...input.changes].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const identity: MutationIdentity = { schema_version: 1, host_commit: input.host_commit, changes };
  return canonicalDigest(assertRecord("MutationIdentity", identity));
}

/** task_revision: the SHA-256 of the identity record's canonical bytes. Throws RecordError when invalid. */
export function taskRevision(identity: TaskRevisionIdentity): CanonicalDigest {
  return canonicalDigest(assertRecord("TaskRevisionIdentity", identity));
}
