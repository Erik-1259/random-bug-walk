// Checks against the real inputs, which are not in the repository. Each block is skipped unless its
// variable names a directory:
//   RBW_UMAMI_RELEASE_DIR  releases/319f3100-9ecf-441d-b7af-a643af9ae4e5/ of the results repository
//   RBW_UMAMI_STORE        a store that src/prepare-cli.ts prepared from the pinned kit image
//   RBW_UMAMI_RECORDS_DIR  a published judge replay job directory (runs/<root>/results/<execution>/)
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256Hex } from "@rbw/schema";
import type { CopyState } from "@rbw/factory-contract";
import { afterEach, describe, expect, it } from "vitest";
import { createUmamiAdapter } from "../src/adapter.ts";
import { RELEASED_CASE } from "../src/mapping.ts";
import { UMAMI_PINS } from "../src/pins.ts";
import { TRIAL_OF_STATE, UMAMI_PROTOCOL } from "../src/protocol.ts";
import { COPY_LIMITS, UMAMI_COPY_DESTINATIONS } from "../src/copy-plans.ts";
import { collectCopy, readCopyResults } from "../src/records.ts";
import { openStore } from "../src/store.ts";
import { filesOf } from "../src/tree.ts";
import type { UnpackedPair } from "@rbw/factory-contract";
import { cleanupTemp, hashTree, recordingNewDir, tempDir } from "./support.ts";

afterEach(cleanupTemp);

const RELEASE = process.env.RBW_UMAMI_RELEASE_DIR;
const STORE = process.env.RBW_UMAMI_STORE;
const RECORDS = process.env.RBW_UMAMI_RECORDS_DIR;
const STATES: CopyState[] = ["clean", "buggy", "fixed"];

describe.skipIf(RELEASE === undefined)("the release record", () => {
  const dir = RELEASE ?? "";

  it("has the pinned SHA-256, ID and files, and its revision names the pinned identities", () => {
    const bytes = readFileSync(join(dir, "release.json"));
    expect(sha256Hex(bytes)).toBe(RELEASED_CASE.release_sha256);
    const release = JSON.parse(bytes.toString("utf8")) as {
      release_id: string;
      files: { path: string; sha256: string }[];
      family: { family_id: string; mutation_id: string };
      revisions: { sha256: string; identity: Record<string, string> }[];
      images: Record<string, string>;
    };
    expect(release.release_id).toBe(RELEASED_CASE.release_id);
    expect(release.files).toEqual(RELEASED_CASE.files);
    for (const file of release.files) expect(sha256Hex(readFileSync(join(dir, ...file.path.split("/"))))).toBe(file.sha256);
    expect(release.family).toMatchObject({ family_id: RELEASED_CASE.family_id, mutation_id: RELEASED_CASE.mutation_id });
    const [revision] = release.revisions;
    expect(revision?.sha256).toBe(RELEASED_CASE.task_revision);
    expect(revision?.identity).toMatchObject({
      host_commit: UMAMI_PINS.app_commit,
      image_digest: UMAMI_PINS.kit.digest,
      kit_sha256: UMAMI_PINS.kit.kit_sha256,
      fixture_sha256: UMAMI_PINS.kit.fixture_sha256,
      original_suite_sha256: UMAMI_PINS.original_suite.sha256,
      added_suite_sha256: UMAMI_PINS.kit.added_suite_sha256,
      environment_sha256: UMAMI_PINS.kit.profile_sha256,
      mutation_id: RELEASED_CASE.mutation_id,
      issue_sha256: UMAMI_PINS.incident.sha256,
      grading_policy_id: RELEASED_CASE.grading_policy_id,
    });
    // The pinned digest is the image ID the release recorded, and on Docker's containerd image store
    // that ID is the image's manifest digest, the one its registry reference carries. A hosted copy
    // runs the registry repository by the pinned digest, so the two must agree.
    expect(release.images.kit_image?.endsWith(`@${UMAMI_PINS.kit.digest}`)).toBe(true);
  });
});

describe.skipIf(STORE === undefined)("the real prepared store", () => {
  const store = STORE ?? "";

  it("serves the pinned buggy source, incident and validator, and the copy plans accept the trees", async () => {
    const before = hashTree(store);
    const opened = await openStore(store, UMAMI_PINS);
    expect(Object.keys(opened.index.source.files)).toHaveLength(2026);
    const out = recordingNewDir();
    const adapter = createUmamiAdapter({ store, newDir: out.newDir });
    const [entry] = adapter.catalog();
    if (entry === undefined) throw new Error("the catalog is empty");
    const bugCase = await adapter.bugCaseInputs(entry);
    const buggy = Object.fromEntries(bugCase.source.files.map((file) => [file.path, file.sha256]));
    expect(buggy[UMAMI_PINS.target.path]).toBe(UMAMI_PINS.target.after_sha256);
    expect(hashTree(bugCase.source.root)).toEqual(buggy);
    expect(sha256Hex(readFileSync(join(bugCase.incident.root, "issue.json")))).toBe(RELEASED_CASE.issue_sha256);
    const validator = await adapter.validatorInputs(entry);
    expect(hashTree(validator.checks.root)).toEqual(Object.fromEntries(validator.checks.files.map((file) => [file.path, file.sha256])));
    const pair: UnpackedPair = {
      bug_case_sha256: "0".repeat(64),
      validator_sha256: "0".repeat(64),
      pair_sha256: "0".repeat(64),
      states: {
        clean: { root: "clean", files: Object.entries(opened.index.source.files).map(([path, sha256]) => ({ path, sha256 })) },
        buggy: bugCase.source,
        fixed: { root: "fixed", files: Object.entries(opened.index.source.files).map(([path, sha256]) => ({ path, sha256 })) },
      },
      evaluator: validator.checks,
      protocol: validator.protocol,
    };
    for (const state of STATES) {
      const [plan] = adapter.copyPlans(state, pair, UMAMI_PROTOCOL);
      // The whole state tree, because the runtime image holds no app source.
      expect(plan?.files).toEqual(filesOf(state === "buggy" ? buggy : opened.index.source.files));
      expect(plan?.evaluator_files.every((file) => file.path.startsWith("fixture/") || file.path.startsWith("job/"))).toBe(true);
    }
    expect(hashTree(store)).toEqual(before);
  });
});

describe.skipIf(RECORDS === undefined)("published judge replay record sets", () => {
  const job = RECORDS ?? "";

  /** One copy's results directory as the copy script leaves it, made from the published job's trial. */
  function copyResults(trialId: string): string {
    const results = tempDir("rbw-host-umami-real-");
    writeFileSync(join(results, "freeze.exit"), "0\n");
    writeFileSync(join(results, "run.exit"), "0\n");
    const out = join(results, "out");
    const request = JSON.parse(readFileSync(join(job, "request.json"), "utf8")) as { expected_trials_key: string };
    mkdirSync(join(out, dirname(request.expected_trials_key)), { recursive: true });
    cpSync(join(job, "request.json"), join(out, "request.json"));
    cpSync(join(job, "expected-trials.json"), join(out, request.expected_trials_key));
    cpSync(join(job, trialId), join(out, "results", trialId), { recursive: true });
    return results;
  }

  it("reads each real copy's own trial: the original suite passes 271 of 271, and only buggy reports the criterion's code", () => {
    const pins = { ...UMAMI_PINS, job: { ...UMAMI_PINS.job, request_sha256: sha256Hex(readFileSync(join(job, "request.json"))) } };
    const read = STATES.map((state) => readCopyResults(pins, { state, outcome: "ran", resultsDir: copyResults(TRIAL_OF_STATE[state]) }));
    expect(read.map((item) => [item.status, item.original_suite.observed, item.original_suite.executed, item.verification.observed, item.verification.failure_codes])).toEqual([
      ["complete", "pass", 271, "pass", []],
      ["complete", "pass", 271, "fail", ["local_day_counts_mismatch"]],
      ["complete", "pass", 271, "pass", []],
    ]);
    const record = collectCopy(
      pins,
      { copy_id: "buggy-01", host_id: "umami", state: "buggy", image: { reference: UMAMI_PINS.kit.image, digest: UMAMI_PINS.kit.digest }, files: [], evaluator_files: [], destinations: { ...UMAMI_COPY_DESTINATIONS }, command: [], limits: { ...COPY_LIMITS } },
      {
        copy_id: "buggy-01",
        outcome: "ran",
        exit_code: 0,
        results_dir: copyResults("planted-01"),
        image_digest: UMAMI_PINS.kit.digest,
        architecture: "amd64",
        started_at: "2026-10-12T18:00:00.000Z",
        finished_at: "2026-10-12T18:03:00.000Z",
        results_sha256: "0".repeat(64),
      },
    );
    expect(record.status).toBe("complete");
    const cells = createUmamiAdapter().interpret([record], UMAMI_PROTOCOL);
    expect(cells.verification.failure_codes).toEqual(["local_day_counts_mismatch"]);
  });
});
