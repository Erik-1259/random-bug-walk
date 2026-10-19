// The factory host adapter of the task-report host (host ID task-report, baseline
// task-report@ca4a71f), on evaluator v2. It reads the vendored baseline, catalog version 2, the
// version 2 protocol, the F3 data file and the kit image pin, and gives the factory what each step
// needs: the debugging agent's inputs (the buggy tree, the incident and neutral provenance, never a
// check or a repair), the evaluator's inputs (the check package, the expected cells, the clean
// reconstruction and the reference repair), copy plans that place the harness-built trees, the
// evaluation of each copy's record set, and the combination of a state's copies.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalDigest } from "@rbw/schema";
import { loadBaseline } from "../src/baseline.ts";
import type { Baseline } from "../src/baseline.ts";
import { applyChecked, readBaselineTree } from "../src/catalog.ts";
import { loadData } from "../src/f3/data.ts";
import type { F3Data } from "../src/f3/data.ts";
import { sha256Hex, treeSha256 } from "../src/hash.ts";
import { UsageError, parseCopyArgsV2 } from "../v2/args.ts";
import type { CopyArgsV2 } from "../v2/args.ts";
import { parseCatalogPins } from "../v2/entry.ts";
import type { CatalogPins } from "../v2/entry.ts";
import { EXPECTED_CELLS, aggregateState, evaluateCopyV2, perStateV2 } from "../v2/evaluate.ts";
import { stateExpectation } from "../v2/expected.ts";
import type { StateExpectation } from "../v2/expected.ts";
import { PROTOCOL_V2_ID, loadProtocolV2 } from "../v2/protocol.ts";
import type { ProtocolV2 } from "../v2/protocol.ts";
import { COPY_V2_FILE, RecordError, parseCopySummaryV2 } from "../v2/record.ts";
import type { CopySummaryV2 } from "../v2/record.ts";
import { loadCatalogV2 } from "./catalog.ts";
import type { CatalogV2, CatalogV2Entry } from "./catalog.ts";
import { checkPackageListing, checkSetSha256 } from "./check-package.ts";
import type {
  BaselineIdentity,
  BugCaseInputs,
  CatalogEntry,
  CellObservation,
  CollectedCopy,
  CopyPlan,
  CopyRecord,
  CopyState,
  FileDigest,
  HostAdapter,
  InterpretedCells,
  Protocol,
  SuiteObservation,
  UnpackedPair,
  ValidatorInputs,
} from "./contract.ts";
import { COPY_COMMAND, COPY_DESTINATIONS, COPY_LIMITS, loadKitImage } from "./kit.ts";
import type { KitImagePin } from "./kit.ts";

const HOST_ID = "task-report";
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(PACKAGE_DIR, "../..");
const SUITE_ID_PREFIX = "task-report-original-suite";

export interface TaskReportAdapterOptions {
  /** The repository root that holds hosts/task-report/app; defaults to this repository. */
  repoRoot?: string;
  /** The package directory to read the catalog, data, protocol, baseline and check files from; defaults to this package. */
  packageDir?: string;
  /** Where bugCaseInputs writes each bug case's files, in a new subdirectory per call; defaults to a new directory under the system's temporary directory. */
  workDir?: string;
  /** The kit image the copies run; defaults to catalog/kit-image.v2.json. */
  kitImage?: KitImagePin;
}

export class AdapterError extends Error {
  override name = "AdapterError";
}

export interface TaskReportAdapter extends HostAdapter {
  availability(): { available: boolean; reason: string | null };
}

interface Loaded {
  baseline: Baseline;
  data: F3Data;
  protocol: ProtocolV2;
  catalog: CatalogV2;
  pins: CatalogPins;
  kit: KitImagePin;
  listing: FileDigest[];
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalDigest(a).sha256 === canonicalDigest(b).sha256;
}

function sortedListing(files: Iterable<[string, Uint8Array]>): FileDigest[] {
  return [...files].map(([path, bytes]) => ({ path, sha256: sha256Hex(bytes) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function writeSet(root: string, files: Iterable<[string, Uint8Array]>): FileDigest[] {
  const entries = [...files];
  for (const [path, bytes] of entries) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  return sortedListing(entries);
}

function treeOfListing(files: readonly FileDigest[]): string {
  return treeSha256(Object.fromEntries(files.map((file) => [file.path, file.sha256])));
}

/** Runs a synchronous step as a promise, so a refusal is a rejection, never a throw at the call. */
function promised<T>(step: () => T): Promise<T> {
  return new Promise((resolvePromise) => {
    resolvePromise(step());
  });
}

function cell(observed: CellObservation["observed"], detail: string): CellObservation {
  return { observed, runs_valid: 0, runs_total: 0, failure_codes: [], detail };
}

export function createTaskReportAdapter(options: TaskReportAdapterOptions = {}): TaskReportAdapter {
  const packageDir = options.packageDir ?? PACKAGE_DIR;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  let loaded: Loaded | null = null;
  let workRoot: string | null = null;

  const load = (): Loaded => {
    if (loaded !== null) return loaded;
    const baseline = loadBaseline(join(packageDir, "baseline/task-report-ca4a71f.json"));
    const data = loadData(join(packageDir, "data/f3.v1.json"));
    const protocol = loadProtocolV2(join(packageDir, "v2/protocol/f3-repeatability.v2.json"));
    const catalogPath = join(packageDir, "catalog/v2.json");
    const catalog = loadCatalogV2(catalogPath);
    const pins = parseCatalogPins(readFileSync(catalogPath));
    if (catalog.baseline_id !== baseline.baseline_id || protocol.baseline_id !== baseline.baseline_id) throw new AdapterError("the catalog or protocol names another baseline");
    if (protocol.data_sha256 !== data.sha256) throw new AdapterError("the protocol pins another data file");
    for (const entry of catalog.entries) {
      if (entry.check_set.data_sha256 !== data.sha256 || entry.check_set.protocol_sha256 !== protocol.sha256) throw new AdapterError(`${entry.entry_id}: the check set pins another data file or protocol`);
      if (entry.check_set.data_file !== "data/f3.v1.json" || entry.check_set.protocol_file !== "v2/protocol/f3-repeatability.v2.json") throw new AdapterError(`${entry.entry_id}: the check set names other files`);
    }
    loaded = { baseline, data, protocol, catalog, pins, kit: options.kitImage ?? loadKitImage(join(packageDir, "catalog/kit-image.v2.json")), listing: checkPackageListing(packageDir) };
    return loaded;
  };

  const own = (entry: Pick<CatalogEntry, "entry_id">): CatalogV2Entry => {
    const found = load().catalog.entries.find((item) => item.entry_id === entry.entry_id);
    if (found === undefined) throw new AdapterError(`the task-report catalog has no entry ${entry.entry_id}`);
    return found;
  };

  const baselineIdentity = (): BaselineIdentity => {
    const { baseline } = load();
    return {
      host_id: HOST_ID,
      baseline_id: baseline.baseline_id,
      app_commit: baseline.source.commit,
      original_suite: {
        suite_id: `${SUITE_ID_PREFIX}-${baseline.suite.revision}`,
        sha256: baseline.suite.tree_sha256,
        test_count: baseline.suite.tests.length,
        test_ids_sha256: canonicalDigest(baseline.suite.tests.map((test) => test.id).sort()).sha256,
      },
    };
  };

  const contractProtocol = (): Protocol => {
    const { protocol } = load();
    return {
      protocol_id: protocol.protocol_id,
      version: String(protocol.version),
      sha256: protocol.sha256,
      per_state: { clean: perStateV2(protocol, "clean"), buggy: perStateV2(protocol, "buggy"), fixed: perStateV2(protocol, "fixed") },
      valid_trial_rules: [...protocol.valid_trial_rules],
    };
  };

  const toContract = (entry: CatalogV2Entry): CatalogEntry => {
    const { data, protocol, catalog, kit, listing } = load();
    return {
      entry_id: entry.entry_id,
      source_id: entry.source_id,
      catalog_version: String(catalog.version),
      host_id: HOST_ID,
      bug_type_id: entry.bug_type_id,
      criteria: entry.criteria.map((criterion) => ({ ...criterion })),
      plant: { patch: entry.planted.text, patch_sha256: entry.planted.sha256, targets: [{ path: entry.target_path, before_sha256: entry.baseline_sha256, after_sha256: entry.buggy_sha256 }] },
      reference_repair: { patch: entry.repair.text, patch_sha256: entry.repair.sha256, result_sha256: [{ path: entry.target_path, sha256: entry.repair.result_sha256 }], kind: entry.repair.kind },
      incident: { path: "incident.md", sha256: entry.incident.sha256 },
      presentation: { ...entry.presentation },
      verification: {
        check_set_id: entry.check_set.check_set_id,
        version: entry.check_set.version,
        check_set_sha256: checkSetSha256(listing),
        expected_vectors_sha256: canonicalDigest({ cells: EXPECTED_CELLS, trials: data.expected }).sha256,
        protocol_id: protocol.protocol_id,
        protocol_sha256: protocol.sha256,
      },
      environment: { kit_image: kit.reference, kit_image_digest: kit.digest, environment_sha256: canonicalDigest({ host_id: HOST_ID, kit_image_digest: kit.digest }).sha256 },
      difficulty: { status: "not_assessed" },
    };
  };

  /** The adapter's own entry for a catalog entry it is handed, refused when any field differs. */
  const checked = (entry: CatalogEntry): CatalogV2Entry => {
    const found = own(entry);
    if (!sameJson(toContract(found), entry)) throw new AdapterError(`${entry.entry_id} differs from the task-report catalog's entry`);
    return found;
  };

  const expectationFor = (entryId: string): StateExpectation => {
    const { baseline, pins } = load();
    return stateExpectation(baseline, pins, entryId);
  };

  const newWorkDir = (prefix: string): string => {
    if (workRoot === null) {
      workRoot = options.workDir ?? mkdtempSync(join(tmpdir(), "rbw-task-report-"));
      mkdirSync(workRoot, { recursive: true });
    }
    return mkdtempSync(join(workRoot, prefix));
  };

  const sameProtocol = (protocol: Protocol): boolean => sameJson(protocol, contractProtocol());

  const failedRecord = (plan: CopyPlan, collected: CollectedCopy, status: "invalid" | "incomplete", detail: string): CopyRecord => {
    const observed = status === "invalid" ? "error" : "incomplete";
    const suite: SuiteObservation = { ...cell(observed, detail), executed: 0, expected: 0, failing_test_ids: [], suite_sha256: load().baseline.suite.tree_sha256 };
    return {
      copy_id: plan.copy_id,
      state: plan.state,
      status,
      original_suite: suite,
      verification: cell(observed, detail),
      image_digest: collected.image_digest,
      architecture: collected.architecture,
      started_at: collected.started_at,
      finished_at: collected.finished_at,
      evidence_sha256: collected.results_sha256,
    };
  };

  const bugCaseInputs = (entry: CatalogEntry): BugCaseInputs => {
    const found = checked(entry);
    const { baseline, kit } = load();
    const files = readBaselineTree(join(repoRoot, baseline.source.path), baseline);
    const base = files.get(found.target_path);
    if (base === undefined) throw new AdapterError(`the baseline has no ${found.target_path}`);
    files.set(found.target_path, applyChecked(base, found.planted.text, found.target_path, found.baseline_sha256, found.buggy_sha256));
    const dir = newWorkDir("bug-case-");
    const source = writeSet(join(dir, "source"), files);
    if (treeOfListing(source) !== expectationFor(found.entry_id).trees.buggy) throw new AdapterError("the buggy tree differs from the catalog's");
    const provenance = {
      format: "rbw.task-report.provenance.v1",
      host_id: HOST_ID,
      baseline_id: baseline.baseline_id,
      app_commit: baseline.source.commit,
      license: "MIT",
      license_note: "The service and its original suite are covered by the MIT license of the repository they are published in.",
      tools: { node: String(baseline.runtime.node), postgres: String(baseline.runtime.postgres), pg: String(baseline.runtime.pg), playwright: baseline.suite.playwright_version },
    };
    const incident = writeSet(join(dir, "incident"), [
      ["incident.md", Buffer.from(found.incident.text, "utf8")],
      ["provenance.json", Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, "utf8")],
    ]);
    return {
      host_id: HOST_ID,
      entry_id: found.entry_id,
      baseline: baselineIdentity(),
      source: { root: join(dir, "source"), files: source },
      incident: { root: join(dir, "incident"), files: incident },
      runtime: {
        kit_image: kit.reference,
        kit_image_digest: kit.digest,
        setup: [
          `Node.js ${String(baseline.runtime.node)} (type stripping) and PostgreSQL ${String(baseline.runtime.postgres)}; the app's README describes the service and how to run it.`,
          "npm ci --ignore-scripts, then npm run typecheck.",
          "With the taskapp database and the taskapp_owner and taskapp_app roles: MIGRATION_DATABASE_URL=<owner URL> npm run migrate -- apply, then DATABASE_URL=<app URL> npm start (http://127.0.0.1:3000).",
          `BASE_URL=http://127.0.0.1:3000 npm test runs the original suite (Playwright ${baseline.suite.playwright_version}, ${String(baseline.suite.tests.length)} tests).`,
          `The kit image runs the app with TZ=${String(baseline.runtime.app_tz)} and PostgreSQL timezone ${String(baseline.runtime.postgres_timezone)}.`,
        ],
      },
    };
  };

  const validatorInputs = (entry: CatalogEntry): ValidatorInputs => {
    const found = checked(entry);
    const { listing } = load();
    const contract = toContract(found);
    return {
      host_id: HOST_ID,
      entry_id: found.entry_id,
      checks: { root: packageDir, files: listing.map((file) => ({ ...file })) },
      expected: { original_suite: { ...EXPECTED_CELLS.original_suite }, verification: { ...EXPECTED_CELLS.verification } },
      clean_reconstruction: { patch: found.clean_reconstruction.text, patch_sha256: found.clean_reconstruction.sha256 },
      reference_repair: contract.reference_repair,
      protocol: contractProtocol(),
    };
  };

  const collect = (plan: CopyPlan, collected: CollectedCopy): CopyRecord => {
    const { protocol, data, kit, listing } = load();
    const invalid = (detail: string): CopyRecord => failedRecord(plan, collected, "invalid", detail);
    if (plan.command[0] !== COPY_COMMAND) return invalid("the plan is not a task-report version 2 copy");
    let args: CopyArgsV2;
    try {
      args = parseCopyArgsV2(plan.command.slice(1));
    } catch (error) {
      if (error instanceof UsageError) return invalid(`the plan's command is malformed: ${error.message}`);
      throw error;
    }
    if (args.state !== plan.state || args.copyId !== plan.copy_id) return invalid("the plan's command names another copy");
    if (collected.copy_id !== plan.copy_id) return invalid("the runner returned another copy");
    if (plan.host_id !== HOST_ID || plan.image.reference !== kit.reference || plan.image.digest !== kit.digest) return invalid("the plan names another kit image than the adapter's");
    if (collected.image_digest !== kit.digest) return invalid("the copy ran another image");
    if (!sameJson(plan.evaluator_files, listing)) return invalid("the plan's evaluator files are not this adapter's check package");
    if (!load().catalog.entries.some((item) => item.entry_id === args.entryId)) return invalid("the plan's command names an entry the catalog does not have");
    if (collected.outcome === "setup_failed") return invalid("the copy could not be prepared");
    if (collected.outcome === "timed_out") return failedRecord(plan, collected, "incomplete", "the copy ran past its time limit");
    if (collected.exit_code !== 0) return invalid(`the copy driver exited ${String(collected.exit_code)}`);
    if (collected.results_dir === null || collected.results_sha256 === null) return invalid("the copy's results were not collected");
    const file = join(collected.results_dir, COPY_V2_FILE);
    if (!existsSync(file)) return invalid("the copy wrote no record set");
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return invalid("the copy's record set is not JSON");
    }
    let summary: CopySummaryV2;
    try {
      summary = parseCopySummaryV2(value);
    } catch (error) {
      if (error instanceof RecordError) return invalid(`the copy's record set is malformed: ${error.message}`);
      throw error;
    }
    const evaluation = evaluateCopyV2(protocol, data, expectationFor(args.entryId), summary, { copy_id: plan.copy_id, state: plan.state });
    return {
      copy_id: plan.copy_id,
      state: plan.state,
      status: evaluation.status,
      original_suite: evaluation.original_suite,
      verification: evaluation.verification,
      image_digest: collected.image_digest,
      architecture: collected.architecture,
      started_at: collected.started_at,
      finished_at: collected.finished_at,
      evidence_sha256: collected.results_sha256,
    };
  };

  return {
    host_id: HOST_ID,

    baseline: baselineIdentity,

    catalog: () => load().catalog.entries.map(toContract),

    protocol: (entry: CatalogEntry): Protocol => {
      const found = own(entry);
      if (entry.verification.protocol_id !== PROTOCOL_V2_ID || entry.verification.protocol_sha256 !== load().protocol.sha256 || found.check_set.protocol_sha256 !== entry.verification.protocol_sha256) {
        throw new AdapterError(`${entry.entry_id} names another protocol`);
      }
      return contractProtocol();
    },

    availability: () => ({ available: true, reason: null }),

    bugCaseInputs: (entry: CatalogEntry): Promise<BugCaseInputs> => promised(() => bugCaseInputs(entry)),

    validatorInputs: (entry: CatalogEntry): Promise<ValidatorInputs> => promised(() => validatorInputs(entry)),

    copyPlans: (state: CopyState, unpacked: UnpackedPair, protocol: Protocol): CopyPlan[] => {
      const { catalog, kit, listing } = load();
      if (!sameProtocol(protocol) || !sameProtocol(unpacked.protocol)) throw new AdapterError("the copies' protocol is not task-report's version 2 protocol");
      if (!sameJson(unpacked.evaluator.files, listing)) throw new AdapterError("the validator's evaluator files are not this adapter's check package");
      const buggyTree = treeOfListing(unpacked.states.buggy.files);
      const entry = catalog.entries.find((item) => expectationFor(item.entry_id).trees.buggy === buggyTree);
      if (entry === undefined) throw new AdapterError("the exported buggy tree is no catalog entry's");
      const files = unpacked.states[state].files.map((file) => ({ ...file }));
      return Array.from({ length: protocol.per_state[state].copies }, (_, index): CopyPlan => {
        const copyId = `f3q2-${unpacked.pair_sha256.slice(0, 16)}-${state}-${String(index + 1)}`;
        return {
          copy_id: copyId,
          host_id: HOST_ID,
          state,
          image: { reference: kit.reference, digest: kit.digest },
          files,
          evaluator_files: listing.map((file) => ({ ...file })),
          destinations: { ...COPY_DESTINATIONS },
          command: [COPY_COMMAND, "--state", state, "--copy-id", copyId, "--entry", entry.entry_id],
          limits: { ...COPY_LIMITS },
        };
      });
    },

    collect: (plan: CopyPlan, collected: CollectedCopy): Promise<CopyRecord> => promised(() => collect(plan, collected)),

    interpret: (records: CopyRecord[], protocol: Protocol): InterpretedCells => {
      if (!sameProtocol(protocol)) {
        const detail = "the records were evaluated under another protocol";
        return { original_suite: cell("incomplete", detail), verification: cell("incomplete", detail) };
      }
      const first = records[0];
      if (first === undefined) return aggregateState(protocol.per_state.clean, "clean", []);
      return aggregateState(protocol.per_state[first.state], first.state, records);
    },
  };
}

/** The adapter over this repository's files. */
export const taskReportAdapter: TaskReportAdapter = createTaskReportAdapter();

