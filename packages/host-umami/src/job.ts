// The frozen judge_verify job the validator carries: the request and its expected trials, built
// only with @rbw/schema's builders. Every copy runs one of its three trials with the kit's copy
// script, so the in-copy driver checks the frozen suite hash and test IDs and the fixture's
// added-suite hash against this job before it runs anything. Its identities are factory
// placeholders; the content identities (suite, added suite, image, profile, patches, vectors) are
// the pinned ones.
import { buildExpectedTrials, buildJobRequest, canonicalDigest, mutationId, taskRevision } from "@rbw/schema";
import type { ExpectedTrials, JobRequest, TaskRevisionIdentity } from "@rbw/schema";
import type { PlantTarget } from "@rbw/factory-contract";
import { UmamiRefusal } from "./errors.ts";
import type { UmamiPins } from "./pins.ts";
import { byCodePoint } from "./tree.ts";

/** Placeholder identities: the factory runs the job under no project, batch, execution or release of its own. */
export const FROZEN_JOB_IDS = {
  project_id: "00000000-0000-4000-8000-00000000c001",
  batch_id: "00000000-0000-4000-8000-00000000c002",
  root_execution_id: "00000000-0000-4000-8000-00000000c003",
  execution_id: "00000000-0000-4000-8000-00000000c004",
  release_id: "00000000-0000-4000-8000-00000000c005",
  project_policy_sha256: "0".repeat(64),
  policy_id: "factory-validation",
  deadline_at: "2000-01-01T00:00:00Z",
  reservation_microusd: 1,
} as const;

/** The issue style the release recorded for the incident. */
export const ISSUE_STYLE = "user-report";

/** The job's directory inside the validator's checks, which a copy receives at /var/lib/rbw/job. */
export const JOB_DIR = "job";
export const REQUEST_FILE = `${JOB_DIR}/request.json`;
export const EXPECTED_TRIALS_FILE = `${JOB_DIR}/jobs/${FROZEN_JOB_IDS.execution_id}/expected-trials.json`;

export interface FrozenJob {
  request: JobRequest;
  requestBytes: Uint8Array;
  requestSha256: string;
  expected: ExpectedTrials;
  expectedBytes: Uint8Array;
  expectedSha256: string;
  /** The two files, at their paths in the validator's checks. */
  files: { path: string; bytes: Uint8Array }[];
}

/** mutation_id (@rbw/schema) of planted target changes: the release's identity of the same defect. */
export function mutationIdOf(appCommit: string, targets: readonly PlantTarget[]): string {
  const changes = targets.map((target) => ({
    path: target.path,
    original_sha256: target.before_sha256,
    resulting_sha256: target.after_sha256,
    original_mode: "100644" as const,
    resulting_mode: "100644" as const,
  }));
  return mutationId({ host_commit: appCommit, changes }, { allowedPaths: targets.map((target) => target.path) }).sha256;
}

/** The task identity of the frozen job: the released case's content identity under the factory's policy ID. */
export function frozenTaskIdentity(pins: UmamiPins): TaskRevisionIdentity {
  return {
    schema_version: 1,
    revision_kind: "complete",
    host_commit: pins.app_commit,
    image_digest: pins.kit.digest,
    kit_sha256: pins.kit.kit_sha256,
    fixture_sha256: pins.kit.fixture_sha256,
    original_suite_sha256: pins.original_suite.sha256,
    added_suite_sha256: pins.kit.added_suite_sha256,
    grading_policy_id: FROZEN_JOB_IDS.policy_id,
    environment_sha256: pins.kit.profile_sha256,
    mutation_id: mutationIdOf(pins.app_commit, [pins.target]),
    issue_sha256: pins.incident.sha256,
    issue_style: ISSUE_STYLE,
  };
}

/** Refuses a test ID list that is not the pinned suite's: its count and the hash of the sorted IDs. */
export function checkTestIds(pins: UmamiPins, testIds: readonly string[]): string[] {
  const sorted = [...testIds].sort(byCodePoint);
  if (new Set(sorted).size !== sorted.length) throw new UmamiRefusal("suite_mismatch", "the frozen suite repeats a test ID");
  if (sorted.length !== pins.original_suite.test_count) {
    throw new UmamiRefusal("suite_mismatch", `the frozen suite has ${String(sorted.length)} tests, not ${String(pins.original_suite.test_count)}`);
  }
  if (canonicalDigest(sorted).sha256 !== pins.original_suite.test_ids_sha256) throw new UmamiRefusal("suite_mismatch", "the frozen suite's test IDs differ from the pinned ones");
  return sorted;
}

export function buildFrozenJob(pins: UmamiPins, testIds: readonly string[]): FrozenJob {
  const sorted = checkTestIds(pins, testIds);
  const revision = taskRevision(frozenTaskIdentity(pins)).sha256;
  const ids = FROZEN_JOB_IDS;
  const expected = buildExpectedTrials({
    kind: "judge_verify",
    executionId: ids.execution_id,
    taskRevision: revision,
    patchSha256: { planted: pins.plant.patch_sha256, fixed: pins.repair.patch_sha256 },
    originalSuiteSha256: pins.original_suite.sha256,
    originalTestIds: sorted,
    addedSuiteSha256: pins.kit.added_suite_sha256,
    checks: { clean: [...pins.vectors.clean], planted: [...pins.vectors.buggy], fixed: [...pins.vectors.fixed] },
  });
  const built = buildJobRequest({
    schema_version: 1,
    project_id: ids.project_id,
    project_policy_sha256: ids.project_policy_sha256,
    batch_id: ids.batch_id,
    execution_id: ids.execution_id,
    root_execution_id: ids.root_execution_id,
    parent_execution_id: ids.root_execution_id,
    attempt_ordinal: 1,
    kind: "judge_verify",
    task_revision: revision,
    policy_id: ids.policy_id,
    runtime_profile_sha256: pins.kit.profile_sha256,
    image_digest: pins.kit.digest,
    expected_trials_key: `jobs/${ids.execution_id}/expected-trials.json`,
    expected_trials_sha256: expected.sha256,
    baseline_evidence_key: null,
    baseline_evidence_sha256: null,
    deadline_at: ids.deadline_at,
    reservation_microusd: ids.reservation_microusd,
    release_id: ids.release_id,
  });
  return {
    request: built.request,
    requestBytes: built.bytes,
    requestSha256: built.sha256,
    expected: expected.manifest,
    expectedBytes: expected.bytes,
    expectedSha256: expected.sha256,
    files: [
      { path: REQUEST_FILE, bytes: built.bytes },
      { path: EXPECTED_TRIALS_FILE, bytes: expected.bytes },
    ],
  };
}
