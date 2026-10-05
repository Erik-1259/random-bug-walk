// Development: writes a synthetic kit_check job for the kit-image proof run, as a directory laid
// out as a record set (request.json and the expected trials at the request's key). The trials
// carry the frozen original suite, the staged fixture's hash and the fixture's clean outcome
// vector. Every identity comes from @rbw/schema's builders. The project, policy and profile
// fields are synthetic placeholders: the controller that issues real requests is not built yet.
//
//   node packages/umami-driver/scripts/proof-job.ts --suite <original-suite.json> \
//     --added-suite-sha256 <sha256> --image-digest sha256:<hex> --out <dir>
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { assertRecord, buildExpectedTrials, buildJobRequest, sha256Hex, taskRevision } from "@rbw/schema";
import type { ExpectedCheck, JobRequest } from "@rbw/schema";
import { FIXTURE_FILE, loadFixture } from "@rbw/umami-fixture";
import { parseSuiteManifest } from "../src/manifest.ts";
import { UMAMI_COMMIT } from "../src/pinned.ts";

const SYNTHETIC_SHA256 = "0".repeat(64);
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const ROOT_EXECUTION_ID = "00000000-0000-4000-8000-000000000101";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000201";
const BATCH_ID = "00000000-0000-4000-8000-000000000301";

export interface ProofJob {
  request: JobRequest;
  requestBytes: Uint8Array;
  expectedTrialsBytes: Uint8Array;
}

export function buildProofJob(input: { suiteManifest: Uint8Array; addedSuiteSha256: string; imageDigest: string; fixtureSha256?: string }): ProofJob {
  const manifest = parseSuiteManifest(input.suiteManifest);
  const originalSuiteSha256 = sha256Hex(input.suiteManifest);
  const clean: ExpectedCheck[] = loadFixture().outcome_vectors.clean.map((check) =>
    assertRecord("ExpectedCheck", { check_id: check.check_id, expected: check.observed, failure_code: check.failure_code }),
  );
  const revision = taskRevision({
    schema_version: 1,
    revision_kind: "kit",
    host_commit: UMAMI_COMMIT,
    image_digest: input.imageDigest,
    kit_sha256: SYNTHETIC_SHA256,
    fixture_sha256: input.fixtureSha256 ?? SYNTHETIC_SHA256,
    original_suite_sha256: originalSuiteSha256,
    added_suite_sha256: input.addedSuiteSha256,
    grading_policy_id: "synthetic-proof",
    environment_sha256: SYNTHETIC_SHA256,
    mutation_id: null,
    issue_sha256: null,
    issue_style: null,
  }).sha256;
  const expected = buildExpectedTrials({
    kind: "kit_check",
    executionId: EXECUTION_ID,
    taskRevision: revision,
    patchSha256: {},
    originalSuiteSha256,
    originalTestIds: manifest.tests.map((test) => test.id),
    addedSuiteSha256: input.addedSuiteSha256,
    checks: { clean },
  });
  const built = buildJobRequest({
    schema_version: 1,
    project_id: PROJECT_ID,
    project_policy_sha256: SYNTHETIC_SHA256,
    batch_id: BATCH_ID,
    execution_id: EXECUTION_ID,
    root_execution_id: ROOT_EXECUTION_ID,
    parent_execution_id: ROOT_EXECUTION_ID,
    attempt_ordinal: 1,
    kind: "kit_check",
    task_revision: revision,
    policy_id: "synthetic-proof",
    runtime_profile_sha256: SYNTHETIC_SHA256,
    image_digest: input.imageDigest,
    expected_trials_key: `jobs/${EXECUTION_ID}/expected-trials.json`,
    expected_trials_sha256: expected.sha256,
    baseline_evidence_key: null,
    baseline_evidence_sha256: null,
    deadline_at: "2026-12-31T00:00:00Z",
    reservation_microusd: 1,
    release_id: null,
  });
  return { request: built.request, requestBytes: built.bytes, expectedTrialsBytes: expected.bytes };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { suite: { type: "string" }, "added-suite-sha256": { type: "string" }, "image-digest": { type: "string" }, out: { type: "string" } },
  });
  const { suite, out } = values;
  const added = values["added-suite-sha256"];
  const image = values["image-digest"];
  if (suite === undefined || out === undefined || added === undefined || image === undefined) {
    process.stderr.write("usage: proof-job.ts --suite <original-suite.json> --added-suite-sha256 <sha256> --image-digest sha256:<hex> --out <dir>\n");
    process.exitCode = 2;
  } else {
    const job = buildProofJob({
      suiteManifest: await readFile(resolve(suite)),
      addedSuiteSha256: added,
      imageDigest: image,
      fixtureSha256: sha256Hex(await readFile(FIXTURE_FILE)),
    });
    const expectedPath = join(resolve(out), ...job.request.expected_trials_key.split("/"));
    await mkdir(dirname(expectedPath), { recursive: true });
    await writeFile(join(resolve(out), "request.json"), job.requestBytes);
    await writeFile(expectedPath, job.expectedTrialsBytes);
    process.stdout.write(`request=${join(resolve(out), "request.json")} expected_trials_key=${job.request.expected_trials_key}\n`);
  }
}
