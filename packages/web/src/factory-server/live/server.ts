// Live mode's ports over the real modules: the factory core's capabilities, interpreter, identity and
// status projection; the spend ledger's start lock, factory slot, pool, halt, request budgets and
// factory records; the worker's request and validation launches and its lost-worker finish; and the
// prepared packages directory. Everything comes in through LiveDeps, so tests run it on PGlite with
// a fake Sandbox SDK. The service counts as configured only with a database and a complete launch
// configuration; otherwise capabilities show not_configured and every port that needs either throws
// FactoryNotConfigured, which the handlers answer `unavailable` before anything is recorded.
import {
  FACTORY_EVENTS,
  FACTORY_IDENTITY,
  FACTORY_PROFILE,
  ROUTE_ACTOR,
  busyReason,
  factoryProfileInput,
  finalizeLostWorker,
  profileForService,
  startFactoryWorker,
} from "@rbw/controller/factory-web";
import type { FactoryDatabase, FactoryLaunchDeps, WorkerLaunchConfig, WorkerSandboxSdk, parseRateSheet } from "@rbw/controller/factory-web";
import { budgetKey, candidateIndex, criteriaCatalogV1, serviceFunctions } from "@rbw/factory";
import type { HostAdapter } from "@rbw/factory-contract";
import type { CreateRecordLaunchResult, FactoryServer, FactoryServerPorts } from "../ports.ts";
import { preparedOnly } from "./hosts.ts";
import { readPackage } from "./packages.ts";
import type { PreparedPackages } from "./packages.ts";
import { noteUnresponsive, readStatus, recordStop } from "./status.ts";
import { getValidation, startValidation } from "./validation.ts";

export type Rates = ReturnType<typeof parseRateSheet>;

export class FactoryNotConfigured extends Error {
  override name = "FactoryNotConfigured";
}

export interface LiveDeps {
  passcode: string | null;
  /** Opens the factory database, or returns the one already open; null without DATABASE_URL. */
  database: (() => Promise<FactoryDatabase>) | null;
  /** The worker launch for the configured backend; null while its configuration is incomplete. */
  launch: { sandbox: WorkerSandboxSdk; config: WorkerLaunchConfig } | null;
  /** The host registry's adapters. */
  adapters: readonly HostAdapter[];
  /** The prepared packages; null when no directory is configured or its index cannot be read. */
  prepared: PreparedPackages | null;
  rates: Rates;
  now: () => Date;
  log: (line: string) => void;
}

const { pool_key: POOL, slot_key: SLOT } = FACTORY_PROFILE;
export const ACCEPTED_MESSAGE = "Request accepted.";

export function createLiveServer(deps: LiveDeps): FactoryServer {
  const catalog = criteriaCatalogV1();
  const service = serviceFunctions({
    registry: preparedOnly(deps.adapters, deps.prepared?.index ?? null, catalog.criteria_catalog_version),
    catalog,
    profile: factoryProfileInput({ rates: deps.rates, registry: deps.adapters }),
  });
  const candidates = candidateIndex(deps.adapters);
  const { now, log } = deps;

  const db = (): Promise<FactoryDatabase> => {
    if (deps.database === null) return Promise.reject(new FactoryNotConfigured("the factory service has no database"));
    return deps.database();
  };
  const launchDeps = async (): Promise<FactoryLaunchDeps> => {
    if (deps.launch === null) throw new FactoryNotConfigured("the factory worker launch is not configured");
    const { ledger, factoryRecords } = await db();
    return { ledger, records: factoryRecords, identity: FACTORY_IDENTITY, sandbox: deps.launch.sandbox, rates: deps.rates, now, launch: deps.launch.config, log };
  };
  const prepared = (): PreparedPackages => {
    if (deps.prepared === null) throw new FactoryNotConfigured("the prepared packages are not readable");
    return deps.prepared;
  };
  const pool = async (spend: FactoryDatabase["spend"]): Promise<bigint | null> => {
    const status = await spend.poolStatus({ pool_key: POOL });
    return status.ok ? status.available_microusd : null;
  };

  const ports: FactoryServerPorts = {
    now,
    passcode: deps.passcode,
    profile: profileForService(),
    capabilities: (at) => service.capabilities(at),
    interpret: (body, at) => service.interpret(body, at),
    canonicalStart: (body) => service.canonicalStart(body),
    withRequestLock: async (id, fn) => (await db()).withStartLock("request", id, fn),

    async findRequest(id) {
      const read = await (await db()).records.readRequest({ request_id: id, after: 0, limit: 1 });
      if (read.ok) return { canonical_sha256: read.request.request_sha256 };
      if (read.code === "unknown_request") return null;
      throw new Error(`the request read was refused (${read.code})`);
    },

    async ledgerState() {
      if (deps.database === null || deps.launch === null) return { configured: false, halted: false };
      const { spend } = await db();
      const slot = await spend.slotStatus({ slot_key: SLOT });
      if ((await pool(spend)) === null || !slot.ok) return { configured: false, halted: false };
      const halt = await spend.haltStatus();
      if (!halt.ok) throw new Error(`the ledger's halt status was refused (${halt.code})`);
      return { configured: true, halted: halt.halted };
    },

    async poolAvailable() {
      const available = await pool((await db()).spend);
      if (available === null) throw new Error("the factory pool's status was refused");
      return Number(available);
    },

    async acquireSlot(root) {
      const { spend, factoryRecords } = await db();
      const slot = await spend.acquireSlot({ slot_key: SLOT, root_execution_id: root, actor_role: ROUTE_ACTOR });
      if (slot.ok) return { kind: slot.replay ? "replay" : "acquired" };
      if (slot.code === "slot_held") return { kind: "held", reason: await busyReason({ spend, records: factoryRecords }, SLOT) };
      throw new Error(`the factory slot was refused (${slot.code})`);
    },

    async slotHolder() {
      const { spend, factoryRecords } = await db();
      const slot = await spend.slotStatus({ slot_key: SLOT });
      if (!slot.ok) throw new Error(`the factory slot's status was refused (${slot.code})`);
      if (slot.holder === null) return null;
      const owner = await factoryRecords.rootOwner(slot.holder);
      if (owner === null) return null;
      return owner.validation_id === null ? { request_id: owner.request_id } : { validation_id: owner.validation_id };
    },

    async releaseSlot(root) {
      const released = await (await db()).spend.releaseSlot({ slot_key: SLOT, root_execution_id: root, actor_role: ROUTE_ACTOR, evidence: null, reason: null });
      // The handlers release on every refusal before the record, also when this root never took the slot.
      if (!released.ok && released.code !== "slot_not_held") throw new Error(`the factory slot's release was refused (${released.code})`);
    },

    async createRecordLaunch({ start, sha256, interpretation, root }): Promise<CreateRecordLaunchResult> {
      const launch = await launchDeps();
      const { records } = await db();
      const requestId = start.request_id;
      const key = budgetKey(requestId);
      const accepted = await records.acceptRequest({
        budget: { budget_key: key, root_execution_id: root, pool_key: POOL, cap_microusd: interpretation.input.budget_microusd, pool_required_microusd: FACTORY_PROFILE.prices.worker_worst_case_microusd, actor_role: ROUTE_ACTOR },
        request: { request_id: requestId, request_sha256: sha256, interpretation, interpretation_sha256: interpretation.interpretation_sha256, budget_key: key, root_execution_id: root, factory_profile_sha256: FACTORY_PROFILE.profile_sha256 },
        accepted_message: ACCEPTED_MESSAGE,
      });
      if (!accepted.ok) {
        if (accepted.code === "insufficient_funds") return { ok: false, code: "budget_unavailable", message: "The factory pool's available amount cannot cover the worker's worst case right now." };
        return { ok: false, code: "unavailable", message: accepted.code === "pool_halted" ? "The spend ledger is halted, so no paid work can start. Try again later." : "The spend ledger did not accept the request." };
      }
      // The request is recorded: every later outcome of the launch is the request's own (its events and finish).
      const started = await startFactoryWorker(launch, requestId);
      log(`factory start ${requestId}: worker launch ${started.kind}`);
      return { ok: true };
    },

    status: async (id, after, at) => readStatus(await db(), candidates, id, after, at),
    noteUnresponsive: async (id, at) => noteUnresponsive(await db(), id, at),
    recordStop: async (id) => recordStop(await db(), id, now()),

    async finalizeLost(target) {
      const launch = await launchDeps();
      await finalizeLostWorker({ ledger: launch.ledger, records: launch.records, identity: FACTORY_IDENTITY, events: FACTORY_EVENTS, sandbox: launch.sandbox, rates: deps.rates, now, log }, target);
    },

    async findValidation(id) {
      const record = await (await db()).factoryRecords.validation(id);
      return record === null ? null : { request_id: record.request_id, case_id: record.case_id };
    },
    startValidation: async (args) => startValidation(await launchDeps(), prepared(), args),
    getValidation: async (requestId, caseId, validationId) => getValidation(await db(), requestId, caseId, validationId),
    readPackage: async (requestId, caseId, part) => readPackage(await db(), prepared(), requestId, caseId, part),
    example: () => Promise.resolve(null),
  };
  return { ports, requestRoot: (id) => FACTORY_IDENTITY.requestRoot(id), test: null, log };
}
