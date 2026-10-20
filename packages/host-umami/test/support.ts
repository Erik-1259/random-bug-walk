// Synthetic pins over a synthetic prepared store, synthetic unpacked pairs and synthetic copy
// record sets. The image's source tree, the frozen suite and the released incident are not in the
// repository, so the tests build the adapter from these; the fixture package is the repository's
// own (packages/umami-fixture), which is the fixture the pinned image runs.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalDigest, sha256Hex } from "@rbw/schema";
import type { ArtifactEntry, CheckObservation, ExpectedTrial, TrialResult } from "@rbw/schema";
import type { CopyState, UnpackedPair } from "@rbw/factory-contract";
import { buildFrozenJob } from "../src/job.ts";
import type { FrozenJob } from "../src/job.ts";
import { UMAMI_PINS } from "../src/pins.ts";
import type { UmamiPins } from "../src/pins.ts";
import { UMAMI_PROTOCOL, TRIAL_OF_STATE } from "../src/protocol.ts";
import { STORE_FORMAT, writeStore } from "../src/store.ts";
import type { StoreIndex } from "../src/store.ts";
import { filesOf, treeSha256 } from "../src/tree.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const repoPath = (...parts: string[]): string => join(REPO_ROOT, ...parts);

/** The fixture parts stage-kit.ts stages into the kit's umami-fixture slot. */
const FIXTURE_PARTS = ["package.json", "playwright.config.ts", "src", "checks", "data"];

const created: string[] = [];

export function tempDir(prefix = "rbw-host-umami-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTemp(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Every regular file under a directory, by relative path, with its SHA-256. */
export function hashTree(root: string, skip: (path: string) => boolean = () => false): Record<string, string> {
  const tree: Record<string, string> = {};
  const visit = (prefix: string): void => {
    for (const name of readdirSync(join(root, prefix))) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (skip(path)) continue;
      const full = join(root, path);
      if (statSync(full).isDirectory()) visit(path);
      else tree[path] = sha256Hex(readFileSync(full));
    }
  };
  visit("");
  return tree;
}

/** The repository's fixture package, as the kit stages it: its tree and every file's bytes. */
export function repoFixture(): { tree: Record<string, string>; bytes: Map<string, Buffer> } {
  const root = repoPath("packages", "umami-fixture");
  const tree: Record<string, string> = {};
  const bytes = new Map<string, Buffer>();
  for (const part of FIXTURE_PARTS) {
    const full = join(root, part);
    const files = statSync(full).isDirectory() ? Object.keys(hashTree(full)).map((path) => `${part}/${path}`) : [part];
    for (const path of files) {
      const content = readFileSync(join(root, path));
      tree[path] = sha256Hex(content);
      bytes.set(sha256Hex(content), content);
    }
  }
  return { tree, bytes };
}

export const SYNTHETIC_TEST_IDS = ["synthetic-test-0001", "synthetic-test-0002", "synthetic-test-0003"];
export const SYNTHETIC_CLEAN_TARGET = "export function synthetic() {\n  return 'clean';\n}\n";
export const SYNTHETIC_PLANTED_TARGET = "export function synthetic() {\n  return 'planted';\n}\n";

/** A small synthetic app tree: the target, an ordinary file and the suite's closure files. */
export function syntheticSource(): Record<string, string> {
  return {
    "package.json": '{"name":"synthetic-app"}\n',
    "README.md": "Synthetic app for host-umami tests.\n",
    [UMAMI_PINS.target.path]: SYNTHETIC_CLEAN_TARGET,
    "src/lib/analytics-query.ts": "export const synthetic = 1;\n",
    "playwright.api.config.ts": "export default {};\n",
    "tests/api/synthetic.spec.ts": "// synthetic spec\n",
  };
}

export interface SyntheticWorld {
  pins: UmamiPins;
  source: Record<string, string>;
  objects: Map<string, Uint8Array>;
  index: StoreIndex;
  fixtureTree: Record<string, string>;
  suiteBytes: Buffer;
  incidentBytes: Buffer;
  job: FrozenJob;
}

const bytesOf = (text: string): Buffer => Buffer.from(text, "utf8");

/**
 * Synthetic pins whose source, suite, incident and kit identity are synthetic; patches, vectors
 * and fixture are real. `kitSha256` sets the image manifest's hash (the prepare tests serve one).
 */
export function syntheticWorld(options: { kitSha256?: string } = {}): SyntheticWorld {
  const source = syntheticSource();
  const objects = new Map<string, Uint8Array>();
  const sourceTree: Record<string, string> = {};
  for (const [path, text] of Object.entries(source)) {
    sourceTree[path] = sha256Hex(bytesOf(text));
    objects.set(sha256Hex(bytesOf(text)), bytesOf(text));
  }
  const planted = bytesOf(SYNTHETIC_PLANTED_TARGET);
  objects.set(sha256Hex(planted), planted);
  const fixture = repoFixture();
  for (const [sha, content] of fixture.bytes) objects.set(sha, content);
  const suiteBytes = bytesOf(`${JSON.stringify({ synthetic: true, tests: SYNTHETIC_TEST_IDS.map((id) => ({ id, file: "tests/api/synthetic.spec.ts" })) })}\n`);
  const incidentBytes = bytesOf('{"title":"Synthetic incident for host-umami tests"}\n');
  objects.set(sha256Hex(suiteBytes), suiteBytes);
  objects.set(sha256Hex(incidentBytes), incidentBytes);
  const base: UmamiPins = {
    ...UMAMI_PINS,
    original_suite: {
      suite_id: "synthetic-suite",
      sha256: sha256Hex(suiteBytes),
      test_count: SYNTHETIC_TEST_IDS.length,
      test_ids_sha256: canonicalDigest([...SYNTHETIC_TEST_IDS].sort()).sha256,
    },
    kit: {
      ...UMAMI_PINS.kit,
      image: "synthetic/umami-kit",
      digest: `sha256:${"a".repeat(64)}`,
      kit_sha256: options.kitSha256 ?? "b".repeat(64),
      source_tree_sha256: treeSha256(sourceTree),
      source_file_count: Object.keys(sourceTree).length,
    },
    incident: { path: "issue.json", sha256: sha256Hex(incidentBytes) },
    target: { path: UMAMI_PINS.target.path, before_sha256: sha256Hex(bytesOf(SYNTHETIC_CLEAN_TARGET)), after_sha256: sha256Hex(planted) },
    job: { request_sha256: "", expected_trials_sha256: "" },
  };
  const job = buildFrozenJob(base, SYNTHETIC_TEST_IDS);
  const pins: UmamiPins = { ...base, job: { request_sha256: job.requestSha256, expected_trials_sha256: job.expectedSha256 } };
  const index: StoreIndex = {
    format: STORE_FORMAT,
    host_id: "umami",
    kit_image_digest: pins.kit.digest,
    kit_sha256: pins.kit.kit_sha256,
    source: { tree_sha256: treeSha256(sourceTree), files: sourceTree },
    fixture: { tree_sha256: treeSha256(fixture.tree), files: fixture.tree },
    original_suite: { sha256: pins.original_suite.sha256 },
    incident: { sha256: pins.incident.sha256 },
    extra_objects: [sha256Hex(planted)],
  };
  return { pins, source: sourceTree, objects, index, fixtureTree: fixture.tree, suiteBytes, incidentBytes, job };
}

export async function writeSyntheticStore(world: SyntheticWorld, index: StoreIndex = world.index): Promise<string> {
  const dir = tempDir("rbw-host-umami-store-");
  await writeStore(dir, index, world.objects);
  return dir;
}

/** A newDir for the adapter that records every directory it hands out. */
export function recordingNewDir(): { newDir: () => Promise<string>; dirs: string[] } {
  const dirs: string[] = [];
  return {
    dirs,
    newDir: () => {
      const dir = tempDir("rbw-host-umami-out-");
      dirs.push(dir);
      return Promise.resolve(dir);
    },
  };
}

/** An unpacked pair as the harness would build it: trees as lists, roots that are never read. */
export function unpackedPair(world: SyntheticWorld, evaluator: Record<string, string>, overrides: Partial<Record<CopyState, Record<string, string>>> = {}): UnpackedPair {
  const clean = { ...world.source };
  const buggy = { ...world.source, [world.pins.target.path]: world.pins.target.after_sha256 };
  const fixed = { ...world.source };
  const states = { clean: overrides.clean ?? clean, buggy: overrides.buggy ?? buggy, fixed: overrides.fixed ?? fixed };
  return {
    bug_case_sha256: "1".repeat(64),
    validator_sha256: "2".repeat(64),
    pair_sha256: "3".repeat(64),
    states: {
      clean: { root: "/nonexistent/clean", files: filesOf(states.clean) },
      buggy: { root: "/nonexistent/buggy", files: filesOf(states.buggy) },
      fixed: { root: "/nonexistent/fixed", files: filesOf(states.fixed) },
    },
    evaluator: { root: "/nonexistent/evaluator", files: filesOf(evaluator) },
    protocol: structuredClone(UMAMI_PROTOCOL),
  };
}

/** The validator checks tree that validatorInputs writes for the world, without writing it. */
export function evaluatorTree(world: SyntheticWorld): Record<string, string> {
  const tree: Record<string, string> = {};
  for (const [path, sha] of Object.entries(world.fixtureTree)) tree[`fixture/${path}`] = sha;
  for (const file of world.job.files) tree[file.path] = sha256Hex(file.bytes);
  tree["expected-vectors.json"] = canonicalDigest(world.pins.vectors).sha256;
  return tree;
}

// ---- copy record sets -------------------------------------------------------------------------

export interface CopyDraft {
  trial: ExpectedTrial;
  status: TrialResult["status"];
  invalidReason: TrialResult["invalid_reason"];
  observations: CheckObservation[];
  /** Original tests and their outcomes; null writes no outcomes entry. */
  tests: { test_id: string; outcome: string }[] | null;
  /** Exit statuses the copy script writes; null leaves the file out. */
  freezeExit: number | null;
  runExit: number | null;
  /** Writes no trial-result.json when false. */
  writeResult: boolean;
}

/** The draft of one copy's record set of the frozen job: every check as its expected vector says, every test passing. */
export function copyDraft(job: FrozenJob, state: CopyState): CopyDraft {
  const trial = job.expected.trials.find((item) => item.trial_id === TRIAL_OF_STATE[state]);
  if (trial === undefined) throw new Error(`no trial for ${state}`);
  const observations: CheckObservation[] = [];
  for (let repeat = 1; repeat <= trial.added_repeat_count; repeat += 1) {
    trial.expected_checks.forEach((check, index) => {
      observations.push({
        check_id: check.check_id,
        repeat_index: repeat,
        observed: check.expected,
        failure_code: check.failure_code,
        duration_ms: 50 + index,
        response_artifact_key: `results/${trial.trial_id}/responses/${check.check_id}-${String(repeat)}.json`,
        response_artifact_sha256: null,
      });
    });
  }
  return {
    trial,
    status: "complete",
    invalidReason: null,
    observations,
    tests: trial.original_test_ids.map((test_id) => ({ test_id, outcome: "passed" })),
    freezeExit: 0,
    runExit: 0,
    writeResult: true,
  };
}

/** Sets one check's observed outcome in every repetition. */
export function observe(draft: CopyDraft, checkId: string, observed: CheckObservation["observed"], code: CheckObservation["failure_code"]): void {
  for (const item of draft.observations) {
    if (item.check_id === checkId) {
      item.observed = observed;
      item.failure_code = code;
    }
  }
}

function writeAt(root: string, key: string, bytes: Uint8Array | string): void {
  const path = join(root, ...key.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/**
 * Writes the copy's results directory as the copy script leaves it: exit files, and under out/
 * the frozen job's request and expected trials plus this one trial's records. Returns the dir.
 */
export function writeCopyResults(job: FrozenJob, draft: CopyDraft, extraTrials: CopyDraft[] = []): string {
  const results = tempDir("rbw-host-umami-results-");
  if (draft.freezeExit !== null) writeAt(results, "freeze.exit", `${String(draft.freezeExit)}\n`);
  if (draft.runExit !== null) writeAt(results, "run.exit", `${String(draft.runExit)}\n`);
  const out = join(results, "out");
  writeAt(out, "request.json", job.requestBytes);
  writeAt(out, job.request.expected_trials_key, job.expectedBytes);
  for (const item of [draft, ...extraTrials]) writeTrial(out, job, item);
  return results;
}

function writeTrial(root: string, job: FrozenJob, draft: CopyDraft): void {
  const id = draft.trial.trial_id;
  const entries: ArtifactEntry[] = [];
  const responseSha = new Map<string, string>();
  for (const item of draft.observations) {
    if (item.response_artifact_key === null) continue;
    const bytes = Buffer.from(`{"check_id":"${item.check_id}","repeat_index":${String(item.repeat_index)},"synthetic":true}`);
    writeAt(root, item.response_artifact_key, bytes);
    responseSha.set(item.response_artifact_key, sha256Hex(bytes));
    entries.push({ kind: "check_response", key: item.response_artifact_key, sha256: sha256Hex(bytes), size_bytes: bytes.length, media_type: "application/json" });
  }
  if (draft.tests !== null) {
    const tests = [...draft.tests].sort((left, right) => (left.test_id < right.test_id ? -1 : left.test_id > right.test_id ? 1 : 0));
    const outcomes = canonicalDigest({ schema_version: 1, trial_id: id, original_suite_sha256: draft.trial.original_suite_sha256, tests });
    const key = `results/${id}/original-suite-outcomes.json`;
    writeAt(root, key, outcomes.bytes);
    entries.push({ kind: "original_suite_outcomes", key, sha256: outcomes.sha256, size_bytes: outcomes.bytes.length, media_type: "application/json" });
  }
  const identity = {
    project_policy_sha256: job.request.project_policy_sha256,
    root_execution_id: job.request.root_execution_id,
    execution_id: job.request.execution_id,
    task_revision: job.request.task_revision,
  };
  const artifacts = canonicalDigest({ schema_version: 1, ...identity, trial_id: id, entries });
  writeAt(root, `results/${id}/artifacts.json`, artifacts.bytes);
  const observations = draft.observations
    .map((item) => ({ ...item, response_artifact_sha256: item.response_artifact_key === null ? null : (responseSha.get(item.response_artifact_key) ?? null) }))
    .sort((left, right) => left.repeat_index - right.repeat_index || (left.check_id < right.check_id ? -1 : left.check_id > right.check_id ? 1 : 0));
  const observationsRecord = canonicalDigest({ schema_version: 1, execution_id: job.request.execution_id, trial_id: id, observations });
  writeAt(root, `results/${id}/observations.json`, observationsRecord.bytes);
  if (!draft.writeResult) return;
  const result = {
    schema_version: 1,
    ...identity,
    trial_id: id,
    code_state: draft.trial.code_state,
    status: draft.status,
    expected_trials_sha256: job.request.expected_trials_sha256,
    observations_key: `results/${id}/observations.json`,
    observations_sha256: observationsRecord.sha256,
    artifacts_key: `results/${id}/artifacts.json`,
    artifacts_sha256: artifacts.sha256,
    invalid_reason: draft.invalidReason,
    started_at: "2026-10-05T12:00:00Z",
    ended_at: "2026-10-05T12:05:00Z",
  };
  writeAt(root, `results/${id}/trial-result.json`, canonicalDigest(result).bytes);
}
