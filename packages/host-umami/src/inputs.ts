// What the package lane's exporter takes for one catalog entry: the bug case's buggy source and
// incident, and the validator's checks, expected matrix, clean reconstruction, reference repair
// and protocol. Everything comes from the prepared store (pinned, by content hash) and the pins;
// each tree is written into a new directory from `newDir`, never into the store.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalDigest, encodeCanonical, sha256Hex } from "@rbw/schema";
import type { BugCaseInputs, CatalogEntry, ExpectedMatrix, ValidatorInputs } from "@rbw/factory-contract";
import type { ExpectedCheck } from "@rbw/schema";
import { baselineIdentity, expectedVectorsSha256 } from "./catalog.ts";
import { UmamiRefusal } from "./errors.ts";
import { buildFrozenJob } from "./job.ts";
import type { ExpectedVectors, UmamiPins } from "./pins.ts";
import { UMAMI_PROTOCOL } from "./protocol.ts";
import { materialize, openStore } from "./store.ts";
import type { PreparedStore } from "./store.ts";
import { filesOf, treeSha256 } from "./tree.ts";

export interface InputOptions {
  /** The prepared store's directory; bugCaseInputs and validatorInputs refuse with store_missing without one. */
  store: string | null;
  /** Makes a new, empty directory for each tree the adapter hands out. */
  newDir: () => Promise<string>;
}

/** Where the validator's checks put each part. */
export const CHECKS_LAYOUT = {
  /** The fixture package the kit image runs, file for file. */
  fixture: "fixture/",
  /** The canonical clean, buggy and fixed vectors; its SHA-256 is the entry's expected_vectors_sha256. */
  vectors: "expected-vectors.json",
  /** The independent correct repair, extra evaluator evidence. */
  alternativeRepair: "evidence/alternative-repair.patch",
  alternativeRecord: "evidence/alternative-repair.json",
} as const;

/** How a debugging agent runs the source: the kit image and its own commands. */
export const RUNTIME_SETUP: readonly string[] = [
  "Run in a linux/amd64 container of the kit image (kit_image at kit_image_digest). It holds Umami's locked dependencies, Node and PostgreSQL 15 with a migrated database.",
  "Copy the source tree over /workspace/app in that container.",
  "As root, build with /opt/rbw/bin/rbw-build-app, then start PostgreSQL and Umami on 127.0.0.1:3000 with /opt/rbw/bin/rbw-start. /opt/rbw/bin/rbw-stop stops both.",
  "The original API test suite is tests/api with playwright.api.config.ts, unchanged.",
];

/** The qualification table of contract section 1. */
export const EXPECTED_MATRIX: ExpectedMatrix = {
  original_suite: { clean: "pass", buggy: "pass", fixed: "pass" },
  verification: { clean: "pass", buggy: "fail", fixed: "pass" },
};

async function store(options: InputOptions, pins: UmamiPins): Promise<PreparedStore> {
  if (options.store === null) throw new UmamiRefusal("store_missing", "the adapter was built without a prepared store");
  return openStore(options.store, pins);
}

async function writeNew(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: "wx", mode: 0o644 });
}

/** The buggy tree: the image's source with each planted target's resulting hash. */
export function buggyTree(sourceFiles: Readonly<Record<string, string>>, entry: CatalogEntry): Record<string, string> {
  const tree = { ...sourceFiles };
  for (const target of entry.plant.targets) {
    if (tree[target.path] !== target.before_sha256) throw new UmamiRefusal("store_tree_mismatch", `the store's ${target.path} is not the planted change's base`);
    tree[target.path] = target.after_sha256;
  }
  return tree;
}

export async function bugCaseInputs(pins: UmamiPins, entry: CatalogEntry, options: InputOptions): Promise<BugCaseInputs> {
  const prepared = await store(options, pins);
  const buggy = buggyTree(prepared.index.source.files, entry);
  const sourceRoot = await options.newDir();
  await materialize(prepared, buggy, sourceRoot);
  const incidentRoot = await options.newDir();
  await writeNew(incidentRoot, entry.incident.path, await prepared.read(entry.incident.sha256));
  return {
    host_id: "umami",
    entry_id: entry.entry_id,
    baseline: baselineIdentity(pins),
    source: { root: sourceRoot, files: filesOf(buggy) },
    incident: { root: incidentRoot, files: [{ path: entry.incident.path, sha256: entry.incident.sha256 }] },
    runtime: { kit_image: entry.environment.kit_image, kit_image_digest: entry.environment.kit_image_digest, setup: [...RUNTIME_SETUP] },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The test IDs of the frozen suite manifest that `freeze` writes ({ tests: [{ id }] }). */
export function suiteTestIds(bytes: Uint8Array): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UmamiRefusal("suite_mismatch", "the frozen suite manifest is not JSON");
    throw error;
  }
  const tests = isRecord(parsed) ? parsed.tests : undefined;
  if (!Array.isArray(tests)) throw new UmamiRefusal("suite_mismatch", "the frozen suite manifest lists no tests");
  return tests.map((test) => {
    if (!isRecord(test) || typeof test.id !== "string") throw new UmamiRefusal("suite_mismatch", "the frozen suite manifest has a test without an ID");
    return test.id;
  });
}

/** The clean, planted and fixed outcome vectors of the fixture's data file, as ExpectedCheck lists. */
export function fixtureVectors(bytes: Uint8Array): ExpectedVectors {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UmamiRefusal("vectors_mismatch", "the fixture data file is not JSON");
    throw error;
  }
  const vectors = isRecord(parsed) ? parsed.outcome_vectors : undefined;
  const rows = (state: string): ExpectedCheck[] => {
    const list = isRecord(vectors) ? vectors[state] : undefined;
    if (!Array.isArray(list)) throw new UmamiRefusal("vectors_mismatch", `the fixture declares no ${state} vector`);
    return list.map((row): ExpectedCheck => {
      if (!isRecord(row) || typeof row.check_id !== "string") throw new UmamiRefusal("vectors_mismatch", `the fixture's ${state} vector has a malformed row`);
      const { check_id: checkId, observed, failure_code: code } = row;
      if (observed === "pass" && code === null) return { check_id: checkId, expected: "pass", failure_code: null };
      if (observed === "assertion_fail" && (code === "local_day_counts_mismatch" || code === "bucket_labels_mismatch")) return { check_id: checkId, expected: "assertion_fail", failure_code: code };
      throw new UmamiRefusal("vectors_mismatch", `the fixture's ${state} vector has an outcome the time-zone checks do not report`);
    });
  };
  return { clean: rows("clean"), buggy: rows("planted"), fixed: rows("fixed") };
}

export async function validatorInputs(pins: UmamiPins, entry: CatalogEntry, options: InputOptions): Promise<ValidatorInputs> {
  const prepared = await store(options, pins);
  const fixture = prepared.index.fixture.files;
  if (treeSha256(fixture) !== entry.verification.check_set_sha256) throw new UmamiRefusal("checks_not_kit", "the store's fixture is not the entry's check set");
  // The vectors come from the fixture the image runs, and must be the pinned ones.
  const dataFiles = Object.entries(fixture).filter(([path, sha256]) => path.startsWith("data/") && sha256 === pins.kit.fixture_sha256);
  const [dataFile] = dataFiles;
  if (dataFile === undefined || dataFiles.length !== 1) throw new UmamiRefusal("vectors_mismatch", "the store's fixture holds no single pinned data file");
  const vectors = fixtureVectors(await prepared.read(dataFile[1]));
  if (expectedVectorsSha256(vectors) !== entry.verification.expected_vectors_sha256) throw new UmamiRefusal("vectors_mismatch", "the fixture's vectors differ from the entry's");
  const job = buildFrozenJob(pins, suiteTestIds(await prepared.read(prepared.index.original_suite.sha256)));
  if (job.requestSha256 !== pins.job.request_sha256 || job.expectedSha256 !== pins.job.expected_trials_sha256) {
    throw new UmamiRefusal("evaluator_mismatch", "the frozen job differs from the pinned one");
  }

  const root = await options.newDir();
  const prefixed: Record<string, string> = {};
  for (const [path, sha256] of Object.entries(fixture)) prefixed[`${CHECKS_LAYOUT.fixture}${path}`] = sha256;
  await materialize(prepared, prefixed, root);
  const written: Record<string, string> = { ...prefixed };
  const generated: { path: string; bytes: Uint8Array }[] = [
    ...job.files,
    { path: CHECKS_LAYOUT.vectors, bytes: encodeCanonical(vectors) },
    { path: CHECKS_LAYOUT.alternativeRepair, bytes: Buffer.from(pins.alternative_repair.patch, "utf8") },
    {
      path: CHECKS_LAYOUT.alternativeRecord,
      bytes: canonicalDigest({
        schema_version: 1,
        kind: "alternative_repair",
        note: "An independent correct repair of the planted file, kept as extra evaluator evidence. It is not the reference repair.",
        path: pins.target.path,
        base_sha256: pins.target.after_sha256,
        result_sha256: pins.alternative_repair.result_sha256,
        patch_sha256: pins.alternative_repair.patch_sha256,
      }).bytes,
    },
  ];
  for (const file of generated) {
    await writeNew(root, file.path, file.bytes);
    written[file.path] = sha256Hex(file.bytes);
  }
  return {
    host_id: "umami",
    entry_id: entry.entry_id,
    checks: { root, files: filesOf(written) },
    expected: { original_suite: { ...EXPECTED_MATRIX.original_suite }, verification: { ...EXPECTED_MATRIX.verification } },
    clean_reconstruction: { patch: pins.repair.patch, patch_sha256: pins.repair.patch_sha256 },
    reference_repair: { ...entry.reference_repair, result_sha256: entry.reference_repair.result_sha256.map((file) => ({ ...file })) },
    protocol: structuredClone(UMAMI_PROTOCOL),
  };
}
