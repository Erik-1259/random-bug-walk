// The synthetic host for the wiring's tests: the package tooling's synthetic adapter, its one entry
// exported under the factory's identity functions (CASE_IDENTITY) into a prepared directory, a
// request accepted on the real factory records with an interpretation the factory core computed over
// it, and a copy runner that runs each copy's command as a local Node process instead of a
// container. Nothing here is real host, harness or Sandbox evidence: it proves the wiring between
// the factory core, the harness and the ledger on the synthetic host only.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { exportCase, resultsSha256, writePrepared } from "@rbw/case-package";
import type { PreparedEntry } from "@rbw/case-package";
import { syntheticAdapter } from "@rbw/case-package/synthetic";
import { CASE_IDENTITY } from "@rbw/case-validate/factory-prepare";
import { createHostRegistry } from "@rbw/case-validate/registry";
import type { HostRegistry } from "@rbw/case-validate/registry";
import { loadRateSheet } from "@rbw/envelope";
import type { Rates } from "@rbw/envelope";
import { HOST_PRESENTATION, budgetKey, criteriaCatalogV1, interpret } from "@rbw/factory";
import type { CollectedCopy, CopyPlan, CopyRoots, CopyRunner, HostAdapter } from "@rbw/factory-contract";
import { canonicalDigest, sha256Hex } from "@rbw/schema";
import { migrate } from "@rbw/spend";
import { FACTORY_IDENTITY, ROUTE_ACTOR } from "../../src/factory-ledger.ts";
import type { FactoryRequestRecord } from "../../src/factory-ports.ts";
import { FACTORY_PROFILE, factoryProfileInput } from "../../src/factory-profile.ts";
import { factoryDatabaseOver } from "../../src/factory-spend.ts";
import type { FactoryDatabase } from "../../src/factory-spend.ts";
import { createFactoryWiring } from "../../src/factory-wiring.ts";
import type { FactoryWiring } from "../../src/factory-wiring.ts";
import { RATE_SHEET_PATH } from "../../src/rate-sheet.ts";
import { Clock } from "./factory-fakes.ts";

export interface SyntheticHost {
  adapter: HostAdapter;
  registry: HostRegistry;
  /** The prepared directory: the entry's bug case and validator core and index.json. */
  packagesDir: string;
  prepared: PreparedEntry;
  /** The bug case and validator core bytes as exported. */
  bug_case: Uint8Array;
  core: Uint8Array;
}

/** A fresh directory for one test. */
export function scratch(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `rbw-wiring-${name}-`));
}

/** The synthetic task-report host with its one entry exported, as `case-package prepare` exports a real host. */
export async function syntheticHost(): Promise<SyntheticHost> {
  const work = await scratch("host");
  const adapter = syntheticAdapter({ workdir: join(work, "adapter") });
  const registry = createHostRegistry([{ host_id: "task-report", label: HOST_PRESENTATION["task-report"].label, description: HOST_PRESENTATION["task-report"].description, license: "MIT", adapter }]);
  const [entry] = adapter.catalog();
  if (entry === undefined) throw new Error("synthetic: the synthetic catalog is empty");
  const exported = await exportCase({ adapter, entry, identity: CASE_IDENTITY, license: "MIT", scan: null });
  const packagesDir = join(work, "packages");
  const index = await writePrepared(packagesDir, [exported]);
  const [prepared] = index.entries;
  if (prepared === undefined) throw new Error("synthetic: nothing was prepared");
  return { adapter, registry, packagesDir, prepared, bug_case: exported.bug_case.bytes, core: exported.validator_core.bytes };
}

const ARCHITECTURE: CollectedCopy["architecture"] = process.arch === "arm64" ? "arm64" : "amd64";

/** Places a plan's files from the roots under a copy directory, checking each hash; false on any mismatch. */
async function place(plan: CopyPlan, roots: CopyRoots, dir: string): Promise<boolean> {
  const sets = [[roots.app_root, plan.files, join(dir, "app")], [roots.evaluator_root, plan.evaluator_files, join(dir, "evaluator")]] as const;
  for (const [root, files, target] of sets) {
    for (const file of files) {
      const bytes = new Uint8Array(await readFile(join(root, file.path)));
      if (sha256Hex(bytes) !== file.sha256) return false;
      await mkdir(dirname(join(target, file.path)), { recursive: true });
      await writeFile(join(target, file.path), bytes);
    }
  }
  return true;
}

export type LocalProcessRunner = CopyRunner & { plans: CopyPlan[] };

/**
 * A copy runner that runs the plan's command as a local Node process instead of a container: the
 * plan's destinations are mapped to directories of a fresh copy directory under `parent`.
 */
export function localProcessRunner(parent: string): LocalProcessRunner {
  const runner: LocalProcessRunner = {
    plans: [],
    async run(plan, roots) {
      runner.plans.push(plan);
      const startedAt = new Date().toISOString();
      const base = { copy_id: plan.copy_id, image_digest: plan.image.digest ?? `sha256:${"0".repeat(64)}`, architecture: ARCHITECTURE, started_at: startedAt };
      const dir = await mkdtemp(join(parent, "copy-"));
      if (!(await place(plan, roots, dir))) return { ...base, outcome: "setup_failed", exit_code: null, results_dir: null, finished_at: new Date().toISOString(), results_sha256: null };
      const mapped = plan.command.map((arg) =>
        arg.replace(plan.destinations.app, join(dir, "app")).replace(plan.destinations.evaluator, join(dir, "evaluator")).replace(plan.destinations.results, join(dir, "results")),
      );
      const [command = "", ...args] = mapped;
      const exit = await new Promise<number | null>((resolve) => {
        execFile(command === "node" ? process.execPath : command, args, { cwd: dir, timeout: plan.limits.timeout_s * 1000 }, (error) => {
          resolve(error === null ? 0 : typeof error.code === "number" ? error.code : null);
        });
      });
      const results = join(dir, "results");
      const present = await access(results).then(
        () => true,
        () => false,
      );
      return { ...base, outcome: "ran", exit_code: exit, results_dir: present ? results : null, finished_at: new Date().toISOString(), results_sha256: present ? await resultsSha256(results) : null };
    },
  };
  return runner;
}

/** The ledger as the bootstrap leaves it (PGlite, every migration, the factory pool and slot key) and the ports over it. */
export interface WiringWorld {
  pglite: PGlite;
  db: FactoryDatabase;
  clock: Clock;
  rates: Rates;
  logs: string[];
}

export async function wiringWorld(): Promise<WiringWorld> {
  const clock = new Clock();
  const pglite = await PGlite.create();
  await migrate(pglite, { schema: "public" });
  const db = factoryDatabaseOver({ client: pglite, now: clock.now });
  const pool = await db.spend.createPool({ pool_key: "factory", cap_microusd: 40_000_000, allocations: [], actor_role: "owner", reason: "synthetic factory pool" });
  if (!pool.ok) throw new Error(`synthetic: the factory pool was refused (${pool.code})`);
  const slot = await db.spend.createSlotKey({ slot_key: "factory", actor_role: "owner", reason: "synthetic factory slot" });
  if (!slot.ok) throw new Error(`synthetic: the factory slot key was refused (${slot.code})`);
  return { pglite, db, clock, rates: await loadRateSheet(RATE_SHEET_PATH), logs: [] };
}

/**
 * What the web service does before it starts a worker: the slot under the request root, then the
 * request accepted (budget, record, request_accepted) with the interpretation the factory core
 * computes for one concurrency case on the registry's hosts.
 */
export async function acceptSyntheticRequest(w: WiringWorld, registry: HostRegistry, budget = 1_500_000): Promise<FactoryRequestRecord> {
  const requestId = randomUUID();
  const root = FACTORY_IDENTITY.requestRoot(requestId);
  const slot = await w.db.spend.acquireSlot({ slot_key: "factory", root_execution_id: root, actor_role: ROUTE_ACTOR });
  if (!slot.ok) throw new Error(`synthetic: the slot was refused (${slot.code})`);
  const adapters = registry.list().map((registration) => registration.adapter);
  const interpretation = interpret({
    input: { hosts: ["task-report"], items: [{ item_key: "concurrency-1", bug_type_id: "concurrency", quantity: 1, description: null, difficulty: "source_inferable_allowed" }], budget_microusd: budget },
    registry: adapters,
    catalog: criteriaCatalogV1(),
    profile: factoryProfileInput({ rates: w.rates, registry: adapters }),
    now: w.clock.now(),
  });
  if (!interpretation.startable) throw new Error("synthetic: the interpretation is not startable");
  const accepted = await w.db.records.acceptRequest({
    budget: { budget_key: budgetKey(requestId), root_execution_id: root, pool_key: "factory", cap_microusd: budget, pool_required_microusd: FACTORY_PROFILE.prices.worker_worst_case_microusd, actor_role: ROUTE_ACTOR },
    request: {
      request_id: requestId,
      request_sha256: canonicalDigest({ synthetic_start: requestId }).sha256,
      interpretation,
      interpretation_sha256: interpretation.interpretation_sha256,
      budget_key: budgetKey(requestId),
      root_execution_id: root,
      factory_profile_sha256: FACTORY_PROFILE.profile_sha256,
    },
    accepted_message: "Request accepted.",
  });
  if (!accepted.ok) throw new Error(`synthetic: the request was refused (${accepted.code})`);
  const record = await w.db.factoryRecords.request(requestId);
  if (record === null) throw new Error("synthetic: the accepted request is not recorded");
  return record;
}

/** The real wiring over the synthetic registry, its docker backend's copies run by `runner`, on the world's database. */
export function syntheticWiring(w: WiringWorld, host: SyntheticHost, runner: CopyRunner): FactoryWiring {
  return { ...createFactoryWiring({ registry: host.registry, localRunner: () => runner }), openDatabase: () => Promise.resolve(w.db) };
}
