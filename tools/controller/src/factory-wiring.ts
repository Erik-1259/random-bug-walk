// What the factory-worker command runs with: the factory core's identity module and request loop,
// the spend ledger's request budgets and factory records, and the harness with its host registry
// and the copy runner of the backend, over the prepared packages.
//
// Request mode (orchestrate): the core's runRequest over the request's frozen interpretation, the
// registry's adapters in host order, criteria catalog v1 and the profile as the core reads it. Its
// events go through the worker's fenced appender (a conflicting or refused append rejects, which the
// loop treats as a failure); its ledger status is the request budget, the factory pool and the
// ledger's halt; its candidate reservations and settlements are the copy meter's (one operation per
// copy of the candidate's protocol); its stop check is the worker's checkpoint. Export verification
// runs the harness (validatePair) on the entry's bug case and validator core, read from the
// prepared directory by host, entry and catalog version; the stored validator is the core with the
// qualification record as its evidence member, read back with inspectValidator.
//
// Validation mode (validate): the case's delivered validator is rebuilt from the core and the
// request's recorded evidence and checked against the hash the run was started with; then the
// harness runs on the two parts with the run's copies under its own operation.
//
// The copy runner is the sandbox runner (one Vercel sandbox per copy) on the sandbox backend, and
// the harness's docker runner with the meter's glue (factory-docker-runner.ts) on the docker one.
import { assembleFinalValidator, inspectValidator, packageFilename, pairSha256, readPreparedIndex, readPreparedObject, resultsSha256 } from "@rbw/case-package";
import type { PreparedEntry, PreparedIndex } from "@rbw/case-package";
import { HARNESS_IDENTITY, dockerRunner, validatePair } from "@rbw/case-validate";
import type { ValidatePairResult } from "@rbw/case-validate";
import { HOST_REGISTRY } from "@rbw/case-validate/registry";
import type { HostRegistry } from "@rbw/case-validate/registry";
import { EXPECTED, candidateId, caseId, criteriaCatalogV1, defectId, runRequest } from "@rbw/factory";
import type { CasePackages, CellMatrix, HarnessResult, LedgerStatus, NewEvent, RunRequestDeps } from "@rbw/factory";
import type { CatalogEntry, CellSet, CheckSet, CopyRunner, CopyState, HostAdapter, ValidationMatrix } from "@rbw/factory-contract";
import type { SandboxSdk } from "@rbw/local-runner";
import { parseCanonical, sha256Hex } from "@rbw/schema";
import { createDockerCopyRunner } from "./factory-docker-runner.ts";
import { FACTORY_IDENTITY } from "./factory-ledger.ts";
import type { CopyMeter } from "./factory-meter.ts";
import type { FactoryEventInput, FactoryIdentity, FactoryLog } from "./factory-ports.ts";
import { factoryProfileInput } from "./factory-profile.ts";
import { createSandboxCopyRunner } from "./factory-sandbox-runner.ts";
import { openFactoryDatabase } from "./factory-spend.ts";
import type { FactoryDatabase } from "./factory-spend.ts";
import type { Orchestrate, RequestHooks, Validate, ValidationHooks, ValidationRunResult } from "./factory-worker.ts";

/** Where the worker image holds the prepared packages (kit/factory-worker/Dockerfile). */
export const FACTORY_PACKAGES_DIR = "/opt/rbw/factory-packages";
/** Names another prepared directory, for local mode (--backend docker) only. */
export const PACKAGES_DIR_VARIABLE = "RBW_FACTORY_PACKAGES_DIR";

export type WorkerBackend = "sandbox" | "docker";

/** What the worker needs of the factory database: its ledger and factory records ports. */
export type WorkerDatabase = Pick<FactoryDatabase, "ledger" | "factoryRecords" | "close">;

/** What orchestrate and validate run with, from the worker command. */
export interface WiringContext {
  db: Pick<FactoryDatabase, "ledger" | "factoryRecords">;
  /** The copies' Sandbox SDK with the credentials bound; null on the docker backend. */
  copySandbox: SandboxSdk | null;
  /** The prepared directory: index.json and the archives it names, each named by its sha256. */
  packagesDir: string;
  /** A local directory for the harness's workspaces and the copies' results. */
  workDir: string;
  log: FactoryLog;
}

export interface FactoryWiring {
  identity: FactoryIdentity;
  /** The factory database named by DATABASE_URL (its migrations applied). */
  openDatabase(databaseUrl: string, now: () => Date, log: FactoryLog): Promise<WorkerDatabase>;
  /** The factory core's request loop over the harness, the host registry and the copy runner of the backend. */
  orchestrate(backend: WorkerBackend, ctx: WiringContext): Orchestrate;
  /** The harness on a case's two parts, with the copy runner of the backend. */
  validate(backend: WorkerBackend, ctx: WiringContext): Validate;
}

export type WiringResult = { ok: true; wiring: FactoryWiring } | { ok: false; missing: string[] };

/** Nothing is missing from this build. */
export const MISSING_MODULES: readonly string[] = [];

/** No interface is held between the parts. */
export const HELD_INTERFACES: readonly string[] = [];

export interface WiringOptions {
  /** The host registry; the harness's (HOST_REGISTRY) unless replaced, as a synthetic proof does. */
  registry?: HostRegistry;
  /** The bare copy runner the docker backend meters; the harness's docker runner unless replaced (tests). */
  localRunner?: (workDir: string) => CopyRunner;
}

/** Stands for a package hash in a harness result for parts that could not be read (only a rejection follows). */
const NO_PACKAGE = "0".repeat(64);

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "non-error";
}

/** A core event as the worker appends it: the store assigns the time. */
function eventInput(event: NewEvent): FactoryEventInput {
  return { event_key: event.event_key, type: event.type, host_id: event.host_id, candidate_id: event.candidate_id, item_key: event.item_key, case_id: event.case_id, message: event.message, data: { ...event.data } };
}

function preparedFor(index: PreparedIndex, entry: Pick<CatalogEntry, "host_id" | "entry_id" | "catalog_version">): PreparedEntry | null {
  return index.entries.find((item) => item.host_id === entry.host_id && item.entry_id === entry.entry_id && item.catalog_version === entry.catalog_version) ?? null;
}

/** The core's harness result for a validatePair result: the harness identity, and integrity failed exactly for export_mismatch. */
function harnessResult(result: ValidatePairResult): HarnessResult {
  return {
    result: result.result,
    stopped: result.stopped,
    package_sha256: result.package_sha256,
    harness: HARNESS_IDENTITY,
    matrix: result.matrix,
    records: result.records,
    integrity: result.error_code === "export_mismatch" ? "failed" : "verified",
    message: result.message,
  };
}

/** The six cells as a validation run reports them: observed against the qualification table's expectation. */
function validationMatrix(matrix: CellMatrix): ValidationMatrix {
  const set = (name: CheckSet): CellSet => {
    const cell = (state: CopyState) => {
      const observed = matrix[name][state];
      const expected = EXPECTED[name][state];
      return { expected, observed: observed.observed, runs_valid: observed.runs_valid, runs_total: observed.runs_total, matches_expectation: observed.observed === expected };
    };
    return { clean: cell("clean"), buggy: cell("buggy"), fixed: cell("fixed") };
  };
  return { original_suite: set("original_suite"), verification: set("verification") };
}

/** The copy runner of the backend for one subject (a candidate, or a validation run's case). */
function copyRunner(options: WiringOptions, backend: WorkerBackend, ctx: WiringContext, run: { meter: CopyMeter; subject: string; root: string; now: () => Date }): CopyRunner {
  const now = (): number => run.now().getTime();
  if (backend === "sandbox") {
    if (ctx.copySandbox === null) throw new Error("the sandbox backend runs copies with a Sandbox SDK, and none was given");
    return createSandboxCopyRunner({
      sdk: ctx.copySandbox,
      meter: run.meter,
      subject: run.subject,
      workDir: ctx.workDir,
      resultsSha256,
      now,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      attempt: run.root,
      log: ctx.log,
    });
  }
  const runner = options.localRunner?.(ctx.workDir) ?? dockerRunner({ resultsDir: ctx.workDir, now: run.now });
  return createDockerCopyRunner({ runner, meter: run.meter, subject: run.subject, now, log: ctx.log });
}

type EntryParts = { prepared: PreparedEntry; bug_case: Uint8Array; core: Uint8Array } | { problem: string; prepared: PreparedEntry | null };

/** The request loop's ports over the worker's hooks, the database and the prepared packages. */
function requestDeps(options: WiringOptions, registry: HostRegistry, backend: WorkerBackend, ctx: WiringContext, hooks: RequestHooks): RunRequestDeps {
  const adapters: HostAdapter[] = registry.list().map((registration) => registration.adapter);
  const catalog = criteriaCatalogV1();
  const { request, meter } = hooks;
  let index: Promise<PreparedIndex> | null = null;
  const preparedIndex = (): Promise<PreparedIndex> => {
    index ??= readPreparedIndex(ctx.packagesDir);
    return index;
  };

  /**
   * The entry's bug case and validator core from the prepared directory, or why they cannot be
   * used: no index entry for the host, entry and catalog version, a case ID that is not the one the
   * core computes for the entry (a stale package), or an archive that is missing or whose bytes
   * differ from its name.
   */
  const parts = async (entry: CatalogEntry, adapter: HostAdapter): Promise<EntryParts> => {
    let prepared: PreparedEntry | null = null;
    try {
      prepared = preparedFor(await preparedIndex(), entry);
      if (prepared === null) return { problem: "the prepared directory has no package for the entry", prepared };
      const expected = caseId({ defect_id: defectId(adapter.baseline(), entry), entry, criteria_catalog_version: catalog.criteria_catalog_version });
      if (prepared.case_id !== expected) return { problem: "the prepared package's case ID is not the entry's", prepared };
      return { prepared, bug_case: await readPreparedObject(ctx.packagesDir, prepared.bug_case_sha256), core: await readPreparedObject(ctx.packagesDir, prepared.validator_core_sha256) };
    } catch (error) {
      return { problem: `the prepared packages could not be read (${errorText(error)})`, prepared };
    }
  };

  return {
    request: { request_id: request.request_id, created_at: request.created_at, interpretation: request.interpretation },
    registry: adapters,
    catalog,
    profile: factoryProfileInput({ rates: hooks.rates, registry: adapters, profile: hooks.profile }),
    now: hooks.now,
    events: {
      async append(event) {
        const appended = await hooks.append(eventInput(event));
        if (appended.kind === "conflict") throw new Error(`the event ${event.event_key} differs from the one recorded under its key`);
        if (appended.kind === "refused") throw new Error(`the event ${event.event_key} was refused (${appended.reason})`);
      },
    },
    ledger: {
      async status(): Promise<LedgerStatus> {
        const budget = await ctx.db.ledger.budgets.status(request.budget_key);
        if (!budget.ok) throw new Error(`the request budget's status was refused (${budget.code})`);
        const pool = await ctx.db.ledger.spend.poolStatus({ pool_key: hooks.profile.pool_key });
        if (!pool.ok) throw new Error(`the factory pool's status was refused (${pool.code})`);
        const halt = await ctx.db.ledger.spend.haltStatus();
        if (!halt.ok) throw new Error(`the ledger's halt status was refused (${halt.code})`);
        return {
          budget_microusd: Number(budget.budget_microusd),
          reserved_microusd: Number(budget.open_microusd),
          spent_microusd: Number(budget.settled_microusd),
          halted: halt.halted,
          pool_available_microusd: Number(pool.available_microusd),
          pool_halted: halt.halted,
        };
      },
      async reserveCandidate(input) {
        const reserved = await meter.reserveCandidate({ candidate_id: input.candidate_id, host_id: input.host_id, protocol: input.protocol, worst_case_microusd: input.worst_case_microusd });
        return reserved.kind === "reserved" ? { kind: "reserved" } : { kind: "refused", reason: reserved.reason };
      },
      async settleCandidate(input) {
        await meter.settleCandidate(input);
      },
      settleWorker: (input) => hooks.settleWorker(input.stop_code),
    },
    stopRequested: async () => (await hooks.checkpoint()) !== "continue",

    async qualify(input) {
      const { entry, adapter } = input;
      const read = await parts(entry, adapter);
      if ("problem" in read) {
        // Parts that are missing or not the entry's fail the integrity check of the exported parts.
        ctx.log(`factory ${request.request_id} export verification of ${entry.entry_id} did not run: ${read.problem}`);
        return {
          result: "error",
          stopped: false,
          package_sha256: { bug_case: read.prepared?.bug_case_sha256 ?? NO_PACKAGE, validator: read.prepared?.validator_core_sha256 ?? NO_PACKAGE },
          harness: HARNESS_IDENTITY,
          matrix: null,
          records: [],
          integrity: "failed",
          message: "The case's exported parts could not be read from the worker's packages.",
        };
      }
      const runner = copyRunner(options, backend, ctx, { meter, subject: candidateId(entry), root: request.root, now: hooks.now });
      // A runner rejection (an uncertain copy) passes through: the loop treats it as uncertain.
      const result = await validatePair({
        bug_case: read.bug_case,
        validator: read.core,
        adapters: { [adapter.host_id]: adapter },
        runner,
        now: hooks.now,
        workdir: ctx.workDir,
        beforeCopy: (plan) => input.beforeCopy(plan),
        onCopy: (record) => input.onCopy(record),
        onCells: (state, cells) => input.onCells(state, cells),
      });
      if (result.error_code !== null) ctx.log(`factory ${request.request_id} export verification of ${entry.entry_id} answered ${result.result} (${result.error_code})`);
      return harnessResult(result);
    },

    async packageCase({ case_id, entry, record_json }): Promise<CasePackages> {
      const prepared = preparedFor(await preparedIndex(), entry);
      if (prepared === null) throw new Error("the prepared directory has no package for the entry");
      const bugCase = await readPreparedObject(ctx.packagesDir, prepared.bug_case_sha256);
      const core = await readPreparedObject(ctx.packagesDir, prepared.validator_core_sha256);
      const validator = assembleFinalValidator(core, parseCanonical(record_json));
      const contents = inspectValidator(validator);
      const bugCaseSha256 = sha256Hex(bugCase);
      const validatorSha256 = sha256Hex(validator);
      return {
        package_version: prepared.package_version,
        pair_sha256: pairSha256({ bug_case_sha256: bugCaseSha256, validator_sha256: validatorSha256, case_id }),
        bug_case: { sha256: bugCaseSha256, size_bytes: bugCase.length, filename: packageFilename("bug_case", case_id, prepared.package_version) },
        validator: {
          sha256: validatorSha256,
          size_bytes: validator.length,
          filename: packageFilename("validator", case_id, prepared.package_version),
          core_sha256: contents.core_sha256,
          evidence_sha256: contents.evidence_sha256,
        },
      };
    },

    async writeEvidence(input) {
      await ctx.db.factoryRecords.recordEvidence(input);
    },
  };
}

/** The harness on a case's two parts for a validation run: the bug case and the delivered validator, rebuilt. */
async function validationRun(options: WiringOptions, registry: HostRegistry, backend: WorkerBackend, ctx: WiringContext, hooks: ValidationHooks): Promise<ValidationRunResult> {
  const { validation, request } = hooks;
  const refused = (problem: string, message: string): ValidationRunResult => {
    ctx.log(`factory validation ${validation.validation_id} did not run: ${problem}`);
    return { result: "error", matrix: null, message };
  };
  const evidence = await ctx.db.factoryRecords.readEvidence(request.request_id, validation.case_id);
  if (evidence === null) return refused("the request has no evidence for the case", "The case's delivered validator could not be rebuilt.");
  let bugCase: Uint8Array;
  let validator: Uint8Array;
  try {
    const prepared = (await readPreparedIndex(ctx.packagesDir)).entries.find((item) => item.case_id === validation.case_id && item.host_id === validation.host_id) ?? null;
    if (prepared === null) return refused("the prepared directory has no package for the case", "The case's packages are not in the worker's packages.");
    bugCase = await readPreparedObject(ctx.packagesDir, validation.package_sha256.bug_case);
    validator = assembleFinalValidator(await readPreparedObject(ctx.packagesDir, prepared.validator_core_sha256), evidence.record);
  } catch (error) {
    return refused(`the case's parts could not be read or rebuilt (${errorText(error)})`, "The case's delivered validator could not be rebuilt.");
  }
  if (sha256Hex(validator) !== validation.package_sha256.validator) return refused("the rebuilt validator's hash is not the run's", "The rebuilt validator is not the case's delivered validator.");
  const runner = copyRunner(options, backend, ctx, { meter: hooks.meter, subject: validation.case_id, root: validation.root, now: hooks.now });
  const result = await validatePair({
    bug_case: bugCase,
    validator,
    adapters: registry.adapters(),
    runner,
    now: hooks.now,
    workdir: ctx.workDir,
    beforeCopy: async () => ((await hooks.checkpoint()) === "continue" ? "continue" : "stop"),
  });
  if (result.error_code !== null) ctx.log(`factory validation ${validation.validation_id} answered ${result.result} (${result.error_code})`);
  return { result: result.result, matrix: result.matrix === null ? null : validationMatrix(result.matrix), message: result.message };
}

/** The real wiring: the factory core, the spend ledger, the harness and its registry. */
export function createFactoryWiring(options: WiringOptions = {}): FactoryWiring {
  const registry = options.registry ?? HOST_REGISTRY;
  return {
    identity: FACTORY_IDENTITY,
    openDatabase: (databaseUrl, now, log) => openFactoryDatabase({ databaseUrl, now, log }),
    orchestrate: (backend, ctx) => async (hooks) => {
      const result = await runRequest(requestDeps(options, registry, backend, ctx, hooks));
      for (const note of result.notes) ctx.log(`factory ${hooks.request.request_id} ${note}`);
    },
    validate: (backend, ctx) => (hooks) => validationRun(options, registry, backend, ctx, hooks),
  };
}

export function loadFactoryWiring(): Promise<WiringResult> {
  return Promise.resolve({ ok: true, wiring: createFactoryWiring() });
}
