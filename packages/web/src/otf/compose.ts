// The OTF server composition: one place that gives every OTF route its runtime dependencies.
// Every route under app/api/factory/otf imports this module for its side effect, so each route
// bundle installs, once per function instance:
// - the Postgres pool opener for store.ts (node-postgres, one pool per DATABASE_URL per process,
//   shared across route bundles through globalThis);
// - the customer routes' dependency loader: the store (otfStoreFor), the Nebius power port
//   (nebiusPowerFrom; null when any RBW_NEBIUS_* variable is unset), the lifecycle (requestStart,
//   runWatchdog, builderState), the clock and the customer config from loadOtfConfig, with the
//   deterministic scope check (cardInScope) only;
// - in the factory's test mode (RBW_FACTORY_TEST_MODE=1 on a local server), the test world's
//   store, power port, clock and host profiles instead, and its scenario reset.
//
// Fail closed: when DATABASE_URL, RBW_OTF_BUILDER_SECRET, RBW_JUDGE_PASSCODE, every host's lanes or
// any RBW_NEBIUS_* variable is unset, the loader throws and every customer route (availability
// included) answers unavailable; the builder routes answer unavailable on their own check.
import { criteriaCatalogV1, criterionOf } from "@rbw/factory";
import pg from "pg";
import { loadFactoryConfig, loadOtfConfig, otfConfigured, type OtfConfig } from "../config.ts";
import { microusd } from "./builder-handlers.ts";
import {
  CRITERION_HOST,
  LANE_IDS,
  OTF_CRITERION_IDS,
  OTF_HOST_IDS,
  type OtfBehaviorOption,
  type OtfHostId,
  type OtfHostProfile,
  type OtfStore,
  type OtfTypical,
  type VmPower,
} from "./contract.ts";
import {
  setOtfCustomerDependencies,
  setOtfTestReset,
  type OtfCustomerConfig,
  type OtfCustomerDependencies,
  type OtfCustomerHostConfig,
  type OtfCustomerLifecycle,
} from "./handlers.ts";
import { builderState, requestStart, runWatchdog } from "./power/lifecycle.ts";
import { nebiusPowerFrom } from "./power/nebius.ts";
import { otfStoreFor, setOtfPoolOpener, type PgPoolLike } from "./store.ts";
import { otfTestMode, otfTestWorld } from "./test-mode/fake-builder.ts";
import { isOtfTestScenario } from "./test-mode/timeline.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** Connections per function instance: a held claim, a power-lock transaction and a few reads at once. */
export const OTF_POOL_MAX = 6;
/** A connect that has not finished by then fails the request (answered unavailable), not the function. */
export const OTF_CONNECT_TIMEOUT_MS = 10_000;

/** W5's lifecycle as the customer routes take it. */
export const OTF_LIFECYCLE: OtfCustomerLifecycle = { requestStart, runWatchdog, builderState };

function log(line: string): void {
  console.log(line);
}

const pools = ((globalThis as { __rbwOtfPgPools?: Map<string, PgPoolLike> }).__rbwOtfPgPools ??= new Map<string, PgPoolLike>());

/** One node-postgres pool per database URL per process, whichever route bundle asks first. */
export function openOtfPool(databaseUrl: string): PgPoolLike {
  let pool = pools.get(databaseUrl);
  if (pool === undefined) {
    const opened = new pg.Pool({ connectionString: databaseUrl, max: OTF_POOL_MAX, connectionTimeoutMillis: OTF_CONNECT_TIMEOUT_MS, idleTimeoutMillis: 30_000 });
    // An idle connection the server drops must not end the function; the next query reconnects.
    opened.on("error", (error) => {
      log(`otf: an idle database connection failed (${error.name})`);
    });
    pool = opened;
    pools.set(databaseUrl, pool);
  }
  return pool;
}

let behaviorsCache: OtfBehaviorOption[] | null = null;

/** Every OTF criterion with its label and example phrases from the factory's criteria catalog. */
export function otfBehaviors(): OtfBehaviorOption[] {
  behaviorsCache ??= OTF_CRITERION_IDS.flatMap((criterion_id) => {
    const found = criterionOf(criteriaCatalogV1(), criterion_id);
    return found === null ? [] : [{ criterion_id, host_id: CRITERION_HOST[criterion_id], label: found.criterion.label, example_phrases: [...found.criterion.example_phrases] }];
  });
  return structuredClone(behaviorsCache);
}

function hostConfig(enabled: boolean, lanes: readonly { model: string; model_label: string }[], profile: Readonly<OtfHostProfile>, typical: OtfTypical | null): OtfCustomerHostConfig {
  return {
    enabled,
    lanes: lanes.flatMap(({ model, model_label }, index) => {
      const lane_id = LANE_IDS[index];
      return lane_id === undefined ? [] : [{ lane_id, model, model_label }];
    }),
    maxActive: profile.max_active,
    jobSpendCapMicrousd: microusd(profile.max_usd_job),
    deadlineMs: profile.deadline_ms,
    typical,
  };
}

/** The customer routes' config from W1's OTF config and the factory session passcode. */
export function otfCustomerConfig(otf: OtfConfig, passcode: string | null): OtfCustomerConfig {
  const hosts = Object.fromEntries(
    OTF_HOST_IDS.map((host) => {
      const found = otf.hosts[host];
      return [host, hostConfig(found.enabled, found.lanes ?? [], found.profile, found.typical)];
    }),
  ) as Record<OtfHostId, OtfCustomerHostConfig>;
  return {
    enabled: otfConfigured(otf),
    builderSecretConfigured: otf.builderSecret !== null,
    passcode,
    maxQueued: otf.maxQueued,
    maxPerDay: otf.maxPerDay,
    totalSpendCapMicrousd: otf.spendCapMicrousd,
    vmHoursPerDay: otf.vmHoursPerDay,
    behaviors: otfBehaviors(),
    hosts,
    coldStartMin: otf.coldStartMin,
  };
}

/** The customer dependencies over a given store, power port and clock. */
export function otfCustomerDependencies(input: { otf: OtfConfig; passcode: string | null; store: OtfStore; power: VmPower | null; now: () => Date }): OtfCustomerDependencies {
  return { store: input.store, power: input.power, now: input.now, lifecycle: OTF_LIFECYCLE, config: otfCustomerConfig(input.otf, input.passcode) };
}

export class OtfNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`custom builds are not configured (${missing})`);
    this.name = "OtfNotConfiguredError";
  }
}

/** The variable names a live OTF needs and does not have; never their values. */
export function otfMissing(otf: OtfConfig, passcode: string | null): string[] {
  return [
    otf.databaseUrl === null ? "DATABASE_URL" : null,
    otf.builderSecret === null ? "RBW_OTF_BUILDER_SECRET" : null,
    passcode === null ? "RBW_JUDGE_PASSCODE" : null,
    OTF_HOST_IDS.some((host) => otf.hosts[host].enabled) ? null : "RBW_OTF_LANES or RBW_OTF_UMAMI_LANES",
    otf.nebius === null ? "RBW_NEBIUS_SA_ID, RBW_NEBIUS_SA_KEY_ID, RBW_NEBIUS_SA_PRIVATE_KEY, RBW_NEBIUS_VM_ID" : null,
  ].filter((item) => item !== null);
}

let notConfiguredLogged = false;

/** The live dependencies: Postgres, Nebius and the wall clock. Throws OtfNotConfiguredError when anything is missing. */
export async function liveOtfCustomerDependencies(env: Env = process.env): Promise<OtfCustomerDependencies> {
  const otf = loadOtfConfig(env);
  const passcode = loadFactoryConfig(env).passcode;
  const missing = otfMissing(otf, passcode);
  const store = missing.length === 0 ? await otfStoreFor(otf) : null;
  const power = missing.length === 0 ? nebiusPowerFrom(otf.nebius) : null;
  if (store === null || power === null) {
    const named = missing.length === 0 ? "the Postgres driver or the power port" : missing.join(", ");
    if (!notConfiguredLogged) log(`otf: custom builds are not configured (${named}); every customer route answers unavailable`);
    notConfiguredLogged = true;
    throw new OtfNotConfiguredError(named);
  }
  return otfCustomerDependencies({ otf, passcode, store, power, now: () => new Date() });
}

/** The test-mode dependencies: the world's store, power port, clock and host profiles. Throws outside test mode. */
export function testOtfCustomerDependencies(env: Env = process.env): OtfCustomerDependencies {
  const world = otfTestWorld(env);
  const otf = loadOtfConfig(env);
  const config = otfCustomerConfig(otf, loadFactoryConfig(env).passcode);
  const hosts = Object.fromEntries(
    OTF_HOST_IDS.map((host) => {
      const found = world.hosts[host];
      return [host, hostConfig(found.enabled, found.lanes, found.profile, found.typical)];
    }),
  ) as Record<OtfHostId, OtfCustomerHostConfig>;
  return {
    store: world.store,
    power: world.power,
    now: () => world.now(),
    lifecycle: OTF_LIFECYCLE,
    config: { ...config, enabled: true, hosts },
  };
}

/** The loader the customer routes call per request: test mode's world, or the live dependencies. */
export function otfCustomerLoader(env: Env = process.env): () => Promise<OtfCustomerDependencies> {
  return () => (otfTestMode(env) === "off" ? liveOtfCustomerDependencies(env) : Promise.resolve().then(() => testOtfCustomerDependencies(env)));
}

/** Resets the test world to a scenario; false for an unknown one. Bound only for handleOtfTestReset, which checks the mode first. */
function resetTestWorld(scenario: string): boolean {
  if (!isOtfTestScenario(scenario)) return false;
  otfTestWorld().reset(scenario);
  return true;
}

/** Installs the composition in this route bundle. Idempotent. */
export function composeOtf(): void {
  setOtfPoolOpener(openOtfPool);
  setOtfCustomerDependencies(otfCustomerLoader());
  setOtfTestReset(resetTestWorld);
}

composeOtf();
