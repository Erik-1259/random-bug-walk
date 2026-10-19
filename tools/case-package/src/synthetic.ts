// A synthetic host for tests and test modes: a tiny application with one planted defect, its original
// tests, a verification check, a copy driver, a host adapter and a deterministic pair builder. Everything
// here is synthetic and labeled so; it proves the package tooling, not any real host. The pair builder is
// pure and in memory; only the adapter's input methods (which write into the directory they are given)
// and its collect (which reads a copy's results) touch the file system.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  BaselineIdentity,
  BugCaseInputs,
  BugTypeId,
  CatalogEntry,
  CellObservation,
  CollectedCopy,
  CopyPlan,
  CopyRecord,
  CopyState,
  FileSet,
  HostAdapter,
  HostId,
  InterpretedCells,
  PackageFormat,
  PackageKind,
  Protocol,
  ValidatorInputs,
} from "@rbw/factory-contract";
import { canonicalDigest, sha256Hex } from "@rbw/schema";
import { compareUtf8, type ArchiveMember } from "./archive.ts";
import { assembleFinalValidator } from "./assembly.ts";
import { formatOf, packageFilename, pairSha256, QUALIFICATION_EXPECTED, type CaseIdentity } from "./format.ts";
import { packPair, type PairInput } from "./pack.ts";

export const SYNTHETIC_LICENSE = "MIT";
export const SYNTHETIC_TARGET = "src/counter.js";
export const SYNTHETIC_COPY_LIMITS = { timeout_s: 120, vcpus: 1, memory_mb: 512, network: "none" } as const;
/** Where the synthetic copy command expects the app, the evaluator files and its results inside a copy. */
export const SYNTHETIC_COPY_LOCATIONS = { app: "/rbw/app", evaluator: "/rbw/evaluator", results: "/rbw/results" } as const;

/** Criteria and failure codes per host, as the criteria catalog version 1 publishes them; a test can choose another code. */
const HOST_DEFAULTS: Record<HostId, { bug_type_id: BugTypeId; criterion_id: string; failure_code: string }> = {
  "task-report": { bug_type_id: "concurrency", criterion_id: "concurrency.lost-acknowledged-change", failure_code: "acknowledged_completion_not_counted" },
  umami: { bug_type_id: "date_time", criterion_id: "date_time.time-zone-grouping", failure_code: "local_day_counts_mismatch" },
};

export interface SyntheticOptions {
  host_id?: HostId;
  /** Names the catalog entry: synthetic-<host>-<seed>. */
  seed?: string;
  /** Names the planted change; entries with the same defect seed share one defect. Defaults to the seed. */
  defect_seed?: string;
  /** The failure code the synthetic check reports on the buggy copy. Defaults to the host's criterion code. */
  failure_code?: string;
  package_version?: number;
  /** The factory's identity functions; defaults to syntheticIdentity, which is not the factory's formula. */
  identity?: CaseIdentity;
}

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const sha = (text: string): string => sha256Hex(bytes(text));

const CLEAN_COUNTER = [
  "// Synthetic application for package tooling tests.",
  "export function countAcknowledged(changes) {",
  "  let count = 0;",
  "  for (const change of changes) {",
  "    if (change.acknowledged) count += 1;",
  "  }",
  "  return count;",
  "}",
  "",
].join("\n");
const CLEAN_RETURN = "  return count;";

function buggyReturn(defectSeed: string): string {
  return `  return count > 1 ? count - 1 : count; // synthetic-defect-${defectSeed}`;
}

function counterPatch(from: string, to: string): string {
  return [
    `diff --git a/${SYNTHETIC_TARGET} b/${SYNTHETIC_TARGET}`,
    `--- a/${SYNTHETIC_TARGET}`,
    `+++ b/${SYNTHETIC_TARGET}`,
    "@@ -6,3 +6,3 @@",
    "   }",
    `-${from}`,
    `+${to}`,
    " }",
    "",
  ].join("\n");
}

const ORIGINAL_SUITE = [
  "// Synthetic original suite: node test/counter.test.js prints one JSON line per test.",
  'import { countAcknowledged } from "../src/counter.js";',
  "",
  "const tests = [",
  '  ["synthetic-empty", () => countAcknowledged([]) === 0],',
  '  ["synthetic-unacknowledged", () => countAcknowledged([{ acknowledged: false }]) === 0],',
  '  ["synthetic-one", () => countAcknowledged([{ acknowledged: true }]) === 1],',
  "];",
  "let failed = 0;",
  "for (const [id, test] of tests) {",
  "  const ok = test();",
  "  if (!ok) failed += 1;",
  "  console.log(JSON.stringify({ id, ok }));",
  "}",
  "process.exitCode = failed === 0 ? 0 : 1;",
  "",
].join("\n");
const ORIGINAL_TEST_IDS = ["synthetic-empty", "synthetic-one", "synthetic-unacknowledged"];

const APP_FILES: Record<string, string> = {
  "README.md": "# Synthetic application\n\nUsed by the package tooling tests. Run the original tests with `node test/counter.test.js`.\n",
  "package.json": '{ "name": "synthetic-app", "private": true, "type": "module" }\n',
  "test/counter.test.js": ORIGINAL_SUITE,
};

const INCIDENT = "# Synthetic incident\n\nThe synthetic application sometimes reports fewer acknowledged changes than it received.\n";

function verifyScript(failureCode: string): string {
  return [
    "// Synthetic verification check: node verify.js <app directory> prints one JSON line.",
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    "",
    "const app = process.argv[2];",
    'const vectors = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));',
    'const { countAcknowledged } = await import(pathToFileURL(join(app, "src/counter.js")).href);',
    "const failed = vectors.cases.filter((item) => countAcknowledged(item.changes) !== item.expected);",
    `console.log(JSON.stringify({ ok: failed.length === 0, failure_code: failed.length === 0 ? null : ${JSON.stringify(failureCode)} }));`,
    "",
  ].join("\n");
}

const EXPECTED_VECTORS = '{ "cases": [{ "changes": [{ "acknowledged": true }, { "acknowledged": true }], "expected": 2 }] }\n';

const COPY_DRIVER = [
  "// Synthetic copy driver: node run-copy.js <app directory> <results directory> <rounds>.",
  "// Runs the original tests and the verification check once per round and writes copy.json.",
  'import { execFileSync } from "node:child_process";',
  'import { createHash } from "node:crypto";',
  'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "",
  "const [app, results, roundsText] = process.argv.slice(2);",
  'const verify = fileURLToPath(new URL("./verify.js", import.meta.url));',
  "const run = (args) => {",
  "  try {",
  '    return execFileSync(process.execPath, args, { cwd: app, encoding: "utf8" });',
  "  } catch (error) {",
  '    return String(error.stdout ?? "");',
  "  }",
  "};",
  "const rounds = [];",
  "for (let round = 0; round < Number(roundsText); round += 1) {",
  '  const tests = run(["test/counter.test.js"]).split("\\n").filter(Boolean).map((line) => JSON.parse(line));',
  "  const check = JSON.parse(run([verify, app]).trim());",
  "  rounds.push({ original_suite: { executed: tests.length, failing_test_ids: tests.filter((test) => !test.ok).map((test) => test.id) }, verification: check });",
  "}",
  'const suite = createHash("sha256").update(readFileSync(join(app, "test/counter.test.js"))).digest("hex");',
  "mkdirSync(results, { recursive: true });",
  'writeFileSync(join(results, "copy.json"), JSON.stringify({ format: "synthetic-copy/1", suite_sha256: suite, rounds }) + "\\n");',
  "",
].join("\n");

interface Material {
  entry: CatalogEntry;
  source: ArchiveMember[];
  incident: ArchiveMember[];
  checks: ArchiveMember[];
  cleanReconstruction: string;
}

function members(files: Record<string, string>): ArchiveMember[] {
  return Object.entries(files)
    .map(([path, text]) => ({ path, bytes: bytes(text) }))
    .sort((a, b) => compareUtf8(a.path, b.path));
}

export function syntheticBaseline(hostId: HostId): BaselineIdentity {
  return {
    host_id: hostId,
    baseline_id: `synthetic-${hostId}@5e5e5e5`,
    app_commit: "5e".repeat(20),
    original_suite: {
      suite_id: "synthetic-original-suite",
      sha256: sha(ORIGINAL_SUITE),
      test_count: ORIGINAL_TEST_IDS.length,
      test_ids_sha256: canonicalDigest(ORIGINAL_TEST_IDS).sha256,
    },
  };
}

export function syntheticKit(hostId: HostId): { kit_image: string; kit_image_digest: string } {
  return { kit_image: `registry.invalid/synthetic/${hostId}-kit:1`, kit_image_digest: `sha256:${sha(`synthetic-kit-${hostId}`)}` };
}

export function syntheticProtocol(): Protocol {
  const body = {
    protocol_id: "synthetic-repetition",
    version: "1",
    per_state: {
      clean: { copies: 1, rounds_per_copy: 2, min_valid_runs: 2 },
      buggy: { copies: 1, rounds_per_copy: 2, min_valid_runs: 2 },
      fixed: { copies: 1, rounds_per_copy: 2, min_valid_runs: 2 },
    },
    valid_trial_rules: ["synthetic-exit-code", "synthetic-record-present"],
  };
  return { ...body, sha256: canonicalDigest(body).sha256 };
}

function material(options: SyntheticOptions = {}): Material {
  const hostId = options.host_id ?? "task-report";
  const seed = options.seed ?? "01";
  const defectSeed = options.defect_seed ?? seed;
  const defaults = HOST_DEFAULTS[hostId];
  const failureCode = options.failure_code ?? defaults.failure_code;
  const buggyCounter = CLEAN_COUNTER.replace(CLEAN_RETURN, buggyReturn(defectSeed));
  const plant = counterPatch(CLEAN_RETURN, buggyReturn(defectSeed));
  const revert = counterPatch(buggyReturn(defectSeed), CLEAN_RETURN);
  const source = members({ ...APP_FILES, [SYNTHETIC_TARGET]: buggyCounter });
  const incident = members({ "incident.md": INCIDENT });
  const checks = members({ "expected.json": EXPECTED_VECTORS, "run-copy.js": COPY_DRIVER, "verify.js": verifyScript(failureCode) });
  const protocol = syntheticProtocol();
  const kit = syntheticKit(hostId);
  const entry: CatalogEntry = {
    entry_id: `synthetic-${hostId}-${seed}`,
    source_id: `synthetic-${hostId}-${defaults.bug_type_id}`,
    catalog_version: "1",
    host_id: hostId,
    bug_type_id: defaults.bug_type_id,
    criteria: [{ criterion_id: defaults.criterion_id, version: "1" }],
    plant: { patch: plant, patch_sha256: sha(plant), targets: [{ path: SYNTHETIC_TARGET, before_sha256: sha(CLEAN_COUNTER), after_sha256: sha(buggyCounter) }] },
    reference_repair: { patch: revert, patch_sha256: sha(revert), result_sha256: [{ path: SYNTHETIC_TARGET, sha256: sha(CLEAN_COUNTER) }], kind: "revert" },
    incident: { path: "incident.md", sha256: sha(INCIDENT) },
    presentation: {
      title: "Synthetic: a count comes out lower than expected",
      observed_failure: "The synthetic application reports fewer acknowledged changes than it received.",
      how_checked: "A synthetic check compares the reported count with the number of acknowledged changes.",
      repetition_summary: "Two synthetic runs per copy state.",
    },
    verification: {
      check_set_id: "synthetic-check-set",
      version: "1",
      check_set_sha256: canonicalDigest(checks.map((member) => ({ path: member.path, sha256: sha256Hex(member.bytes) }))).sha256,
      expected_vectors_sha256: sha(EXPECTED_VECTORS),
      protocol_id: protocol.protocol_id,
      protocol_sha256: protocol.sha256,
    },
    environment: { ...kit, environment_sha256: canonicalDigest({ host_id: hostId, kit_image_digest: kit.kit_image_digest }).sha256 },
    difficulty: { status: "not_assessed" },
  };
  return { entry, source, incident, checks, cleanReconstruction: revert };
}

export function syntheticEntry(options: SyntheticOptions = {}): CatalogEntry {
  return material(options).entry;
}

/**
 * Stand-in identity for synthetic packages. It is NOT the factory's identity formula (contract section 10.4);
 * callers that need the factory's IDs pass the factory's functions as `identity`.
 */
export const syntheticIdentity: CaseIdentity = {
  defectId: (baseline, entry) =>
    canonicalDigest({ synthetic: "defect", host_id: entry.host_id, baseline_id: baseline.baseline_id, targets: entry.plant.targets }).sha256,
  caseId: (defectId, entry) =>
    canonicalDigest({
      synthetic: "case",
      defect_id: defectId,
      bug_type_id: entry.bug_type_id,
      check_set_sha256: entry.verification.check_set_sha256,
      reference_repair_sha256: entry.reference_repair.patch_sha256,
      environment_sha256: entry.environment.environment_sha256,
    }).sha256,
};

/** The packer input for one synthetic entry, which tests can change before calling packPair. */
export function syntheticPairInput(options: SyntheticOptions = {}): PairInput {
  const { entry, source, incident, checks, cleanReconstruction } = material(options);
  const baseline = syntheticBaseline(entry.host_id);
  const identity = options.identity ?? syntheticIdentity;
  const defectId = identity.defectId(baseline, entry);
  return {
    case_id: identity.caseId(defectId, entry),
    defect_id: defectId,
    package_version: options.package_version ?? 1,
    license: SYNTHETIC_LICENSE,
    entry,
    baseline,
    bug_case: { source, incident, runtime: { kit_image: entry.environment.kit_image, kit_image_digest: entry.environment.kit_image_digest, setup: [] } },
    validator: {
      checks,
      expected: QUALIFICATION_EXPECTED,
      protocol: syntheticProtocol(),
      clean_reconstruction: { patch: cleanReconstruction, patch_sha256: sha(cleanReconstruction) },
      reference_repair: entry.reference_repair,
    },
  };
}

export interface SyntheticPart {
  kind: PackageKind;
  format: PackageFormat;
  filename: string;
  bytes: Uint8Array;
  sha256: string;
  size_bytes: number;
}

export interface SyntheticPair {
  host_id: HostId;
  entry_id: string;
  case_id: string;
  defect_id: string;
  package_version: number;
  entry: CatalogEntry;
  /** pair_sha256 of the bug case and the final validator. */
  pair_sha256: string;
  bug_case: SyntheticPart;
  /** The downloadable validator: the core plus the evidence member, or the core alone when evidence is null. */
  validator: SyntheticPart;
  validator_core: SyntheticPart;
}

function syntheticPart(kind: PackageKind, caseId: string, data: Uint8Array): SyntheticPart {
  return { kind, format: formatOf(kind), filename: packageFilename(kind, caseId), bytes: data, sha256: sha256Hex(data), size_bytes: data.length };
}

/**
 * Builds one matching synthetic pair, deterministically from its options. `evidence` (any canonical JSON
 * value) becomes the final validator's evidence member; null delivers the core alone; the default is a
 * small synthetic evidence object.
 */
export function buildSyntheticPair(options: SyntheticOptions & { evidence?: unknown } = {}): SyntheticPair {
  const input = syntheticPairInput(options);
  const packed = packPair(input);
  const evidence = options.evidence === undefined ? { synthetic: true, case_id: input.case_id, entry_id: input.entry.entry_id } : options.evidence;
  const finalValidator = evidence === null ? packed.validator_core.bytes : assembleFinalValidator(packed.validator_core.bytes, evidence);
  const bugCase = syntheticPart("bug_case", input.case_id, packed.bug_case.bytes);
  const validator = syntheticPart("validator", input.case_id, finalValidator);
  return {
    host_id: input.entry.host_id,
    entry_id: input.entry.entry_id,
    case_id: input.case_id,
    defect_id: input.defect_id,
    package_version: input.package_version,
    entry: input.entry,
    pair_sha256: pairSha256({ bug_case_sha256: bugCase.sha256, validator_sha256: validator.sha256, case_id: input.case_id }),
    bug_case: bugCase,
    validator,
    validator_core: syntheticPart("validator", input.case_id, packed.validator_core.bytes),
  };
}

export interface SyntheticMismatchedPair {
  host_id: HostId;
  bug_case: SyntheticPart;
  /** A validator built for another synthetic bug case of the same host. */
  validator: SyntheticPart;
}

/** A bug case with a validator that belongs to another bug case, which the harness must refuse. */
export function buildMismatchedSyntheticPair(options: SyntheticOptions = {}): SyntheticMismatchedPair {
  const own = buildSyntheticPair(options);
  const other = buildSyntheticPair({ ...options, seed: `${options.seed ?? "01"}-other`, defect_seed: `${options.defect_seed ?? options.seed ?? "01"}-other` });
  return { host_id: own.host_id, bug_case: own.bug_case, validator: other.validator };
}

async function writeSet(root: string, files: readonly ArchiveMember[]): Promise<FileSet> {
  for (const file of files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
  }
  return { root, files: files.map((file) => ({ path: file.path, sha256: sha256Hex(file.bytes) })) };
}

function cell(observed: CellObservation["observed"], valid: number, total: number, codes: string[], detail: string): CellObservation {
  return { observed, runs_valid: valid, runs_total: total, failure_codes: codes, detail };
}

function interpretCell(records: readonly CopyRecord[], pick: (record: CopyRecord) => CellObservation, minValid: number): CellObservation {
  if (records.length === 0) return cell("incomplete", 0, 0, [], "no copy ran");
  const cells = records.map(pick);
  const valid = cells.reduce((sum, item) => sum + item.runs_valid, 0);
  const total = cells.reduce((sum, item) => sum + item.runs_total, 0);
  const codes = [...new Set(cells.flatMap((item) => item.failure_codes))].sort();
  if (records.some((record) => record.status === "invalid")) return cell("error", valid, total, codes, "a copy was invalid");
  if (records.some((record) => record.status === "incomplete") || valid < minValid) return cell("incomplete", valid, total, codes, "too few valid runs");
  const observed = new Set(cells.map((item) => item.observed));
  if (observed.size !== 1) return cell("error", valid, total, codes, "the copies disagree");
  const [only] = [...observed];
  return cell(only ?? "error", valid, total, codes, "");
}

/** What the synthetic copy driver writes to <results>/copy.json: one entry per round. */
interface SyntheticCopyResults {
  suite_sha256: string;
  rounds: { original_suite: { executed: number; failing_test_ids: string[] }; verification: { ok: boolean; failure_code: string | null } }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCopyResults(text: string): SyntheticCopyResults | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.format !== "synthetic-copy/1" || typeof value.suite_sha256 !== "string" || !Array.isArray(value.rounds)) return null;
  const rounds: SyntheticCopyResults["rounds"] = [];
  for (const round of value.rounds as unknown[]) {
    if (!isRecord(round) || !isRecord(round.original_suite) || !isRecord(round.verification)) return null;
    const { executed, failing_test_ids: failing } = round.original_suite;
    const { ok, failure_code: code } = round.verification;
    if (typeof executed !== "number" || !Number.isSafeInteger(executed) || !Array.isArray(failing)) return null;
    const ids = (failing as unknown[]).filter((id): id is string => typeof id === "string");
    if (ids.length !== failing.length || typeof ok !== "boolean" || (code !== null && typeof code !== "string")) return null;
    rounds.push({ original_suite: { executed, failing_test_ids: ids }, verification: { ok, failure_code: code } });
  }
  return { suite_sha256: value.suite_sha256, rounds };
}

function agree(values: readonly boolean[]): "pass" | "fail" | "error" | "incomplete" {
  if (values.length === 0) return "incomplete";
  if (values.every(Boolean)) return "pass";
  return values.some(Boolean) ? "error" : "fail";
}

/**
 * The synthetic host's collect: reads only <results>/copy.json. A copy that did not run, exited non-zero,
 * wrote no readable record or ran another original suite is invalid; a timed-out copy is incomplete.
 */
async function collectSynthetic(plan: CopyPlan, collected: CollectedCopy): Promise<CopyRecord> {
  const suite = syntheticBaseline(plan.host_id).original_suite;
  const base = {
    copy_id: plan.copy_id,
    state: plan.state,
    image_digest: collected.image_digest,
    architecture: collected.architecture,
    started_at: collected.started_at,
    finished_at: collected.finished_at,
    evidence_sha256: collected.results_sha256,
  };
  const without = (status: "invalid" | "incomplete", detail: string): CopyRecord => {
    const observed = status === "invalid" ? "error" : "incomplete";
    const empty = cell(observed, 0, 0, [], detail);
    return { ...base, status, original_suite: { ...empty, executed: 0, expected: suite.test_count, failing_test_ids: [], suite_sha256: suite.sha256 }, verification: empty };
  };
  if (collected.outcome === "setup_failed") return without("invalid", "the copy could not be set up");
  if (collected.outcome === "timed_out") return without("incomplete", "the copy passed its time limit");
  if (collected.exit_code !== 0) return without("invalid", "the copy driver failed");
  if (collected.results_dir === null || collected.results_sha256 === null) return without("invalid", "the copy brought back no results");
  let results: SyntheticCopyResults | null;
  try {
    results = parseCopyResults(await readFile(join(collected.results_dir, "copy.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    results = null;
  }
  if (results === null) return without("invalid", "the copy wrote no readable record");
  if (results.suite_sha256 !== suite.sha256) return without("invalid", "the copy ran another original suite");
  const total = results.rounds.length;
  const valid = results.rounds.filter((round) => round.original_suite.executed === suite.test_count);
  const failing = [...new Set(valid.flatMap((round) => round.original_suite.failing_test_ids))].sort();
  const codes = [...new Set(valid.flatMap((round) => (round.verification.failure_code === null ? [] : [round.verification.failure_code])))].sort();
  return {
    ...base,
    status: total > 0 && valid.length === total ? "complete" : "incomplete",
    original_suite: {
      ...cell(agree(valid.map((round) => round.original_suite.failing_test_ids.length === 0)), valid.length, total, [], ""),
      executed: valid.at(-1)?.original_suite.executed ?? 0,
      expected: suite.test_count,
      failing_test_ids: failing,
      suite_sha256: results.suite_sha256,
    },
    verification: cell(agree(valid.map((round) => round.verification.ok)), valid.length, total, codes, ""),
  };
}

export interface SyntheticAdapterOptions {
  host_id?: HostId;
  /** One catalog entry per seed, in order. Defaults to ["01"]. */
  seeds?: string[];
  failure_code?: string;
  /** The directory the input methods write the entries' files into. */
  workdir: string;
  availability?: HostAdapter["availability"];
}

/** A synthetic host adapter over the synthetic catalog; it maps the harness-built trees and applies no patch. */
export function syntheticAdapter(options: SyntheticAdapterOptions): HostAdapter {
  const hostId = options.host_id ?? "task-report";
  const materials = new Map(
    (options.seeds ?? ["01"]).map((seed) => {
      const item = material({ host_id: hostId, seed, ...(options.failure_code === undefined ? {} : { failure_code: options.failure_code }) });
      return [item.entry.entry_id, item] as const;
    }),
  );
  const find = (entry: CatalogEntry): Material => {
    const item = materials.get(entry.entry_id);
    if (item === undefined) throw new Error(`synthetic adapter: unknown entry ${entry.entry_id}`);
    return item;
  };
  const kit = syntheticKit(hostId);
  const adapter: HostAdapter = {
    host_id: hostId,
    baseline: () => syntheticBaseline(hostId),
    catalog: () => [...materials.values()].map((item) => item.entry),
    protocol: () => syntheticProtocol(),
    bugCaseInputs: async (entry): Promise<BugCaseInputs> => {
      const item = find(entry);
      const root = join(options.workdir, item.entry.entry_id, "bug-case");
      return {
        host_id: hostId,
        entry_id: item.entry.entry_id,
        baseline: syntheticBaseline(hostId),
        source: await writeSet(join(root, "source"), item.source),
        incident: await writeSet(join(root, "incident"), item.incident),
        runtime: { ...kit, setup: [] },
      };
    },
    validatorInputs: async (entry): Promise<ValidatorInputs> => {
      const item = find(entry);
      return {
        host_id: hostId,
        entry_id: item.entry.entry_id,
        checks: await writeSet(join(options.workdir, item.entry.entry_id, "validator", "checks"), item.checks),
        expected: QUALIFICATION_EXPECTED,
        clean_reconstruction: { patch: item.cleanReconstruction, patch_sha256: sha(item.cleanReconstruction) },
        reference_repair: item.entry.reference_repair,
        protocol: syntheticProtocol(),
      };
    },
    copyPlans: (state: CopyState, unpacked, protocol): CopyPlan[] =>
      Array.from({ length: protocol.per_state[state].copies }, (_, index) => ({
        copy_id: `synthetic-${state}-${String(index + 1)}`,
        host_id: hostId,
        state,
        image: { reference: kit.kit_image, digest: kit.kit_image_digest },
        files: unpacked.states[state].files,
        evaluator_files: unpacked.evaluator.files,
        destinations: { ...SYNTHETIC_COPY_LOCATIONS },
        command: [
          "node",
          `${SYNTHETIC_COPY_LOCATIONS.evaluator}/run-copy.js`,
          SYNTHETIC_COPY_LOCATIONS.app,
          SYNTHETIC_COPY_LOCATIONS.results,
          String(protocol.per_state[state].rounds_per_copy),
        ],
        limits: { ...SYNTHETIC_COPY_LIMITS },
      })),
    collect: (plan, collected) => collectSynthetic(plan, collected),
    interpret: (records, protocol): InterpretedCells => {
      const state = records[0]?.state ?? "clean";
      const minValid = protocol.per_state[state].min_valid_runs;
      return {
        original_suite: interpretCell(records, (record) => record.original_suite, minValid),
        verification: interpretCell(records, (record) => record.verification, minValid),
      };
    },
  };
  if (options.availability !== undefined) adapter.availability = options.availability;
  return adapter;
}
