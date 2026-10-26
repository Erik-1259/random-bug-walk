// Live mode's dependencies from the configuration, built once per server process and configuration:
// every route bundle of one process shares them through globalThis, so the process holds one database
// pool and one worker Sandbox SDK (the local backend's SDK keeps its sandboxes in memory, and the
// status route must see the ones the start route created). The database opens on first use and a
// failed open is retried by the next call; the session and the example never open it. The prepared
// packages index is read once, when the server is built. The rate sheet is the one the build froze
// (next.config.ts), since a bundled module cannot resolve the envelope package's file.
import { WORKER_IMAGE_VARIABLE, createWorkerSandboxSdk, openFactoryDatabase, parseRateSheet } from "@rbw/controller/factory-web";
import type { FactoryDatabase } from "@rbw/controller/factory-web";
import type { HostAdapter } from "@rbw/factory-contract";
import type { FactoryConfig } from "../../config.ts";
import type { FactoryServer } from "../ports.ts";
import type { PreparedPackages } from "./packages.ts";
import { createLiveServer } from "./server.ts";
import { hostRegistry, localBackend, packageTools } from "./tools.ts";
import type { LiveDeps, Rates } from "./server.ts";

/** A worker image reference pinned by digest, as the launch requires. */
const PINNED = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

type Log = (line: string) => void;

/**
 * The worker launch for the configured backend, or null while its configuration is incomplete: the
 * sandbox backend needs the three Sandbox credentials and a worker image pinned by digest, the local
 * backend a prepared packages directory; both need DATABASE_URL, which the worker receives.
 */
export async function launchFor(config: FactoryConfig, log: Log): Promise<LiveDeps["launch"]> {
  const { databaseUrl } = config;
  if (databaseUrl === null) return null;
  switch (config.workerBackend) {
    case "sandbox": {
      const { sandbox, workerImage } = config;
      if (sandbox === null || workerImage === null || !PINNED.test(workerImage)) return null;
      const env = { DATABASE_URL: databaseUrl, VERCEL_TOKEN: sandbox.token, VERCEL_TEAM_ID: sandbox.teamId, VERCEL_PROJECT_ID: sandbox.projectId, [WORKER_IMAGE_VARIABLE]: workerImage };
      return { sandbox: createWorkerSandboxSdk(sandbox), config: { image: workerImage, env } };
    }
    case "local": {
      if (config.packagesDir === null) return null;
      // Loaded only on the local backend: it runs the worker command as a child of this process.
      const local = await localBackend();
      const env: Record<string, string> = { [local.PACKAGES_DIR_VARIABLE]: config.packagesDir };
      for (const name of ["PATH", "HOME"]) {
        const found = process.env[name];
        if (found !== undefined) env[name] = found;
      }
      return { sandbox: local.localWorkerSandbox({ repoRoot: config.repoRoot, env, log }), config: { image: local.LOCAL_WORKER_IMAGE, env: { DATABASE_URL: databaseUrl } } };
    }
    case null:
      return null;
  }
}

/** The prepared packages, or null (logged) when no directory is configured or its index cannot be read. */
async function preparedPackages(dir: string | null, log: Log): Promise<PreparedPackages | null> {
  if (dir === null) return null;
  try {
    return { dir, index: await (await packageTools()).readPreparedIndex(dir) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    log(`factory: the prepared packages index could not be read (${error.name}); no entry is offered`);
    return null;
  }
}

/**
 * The host registry's adapters, or none (logged) when the registry cannot be loaded: a deployment
 * whose files do not hold it then still serves the session and the example, and offers no host.
 */
async function registeredAdapters(log: Log): Promise<readonly HostAdapter[]> {
  try {
    return (await hostRegistry()).list().map((registration) => registration.adapter);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    log(`factory: the host registry could not be loaded (${error.name}); no host is offered`);
    return [];
  }
}

/** The rate sheet the build froze into RBW_FACTORY_RATE_SHEET. */
function frozenRates(): Rates {
  const text = process.env.RBW_FACTORY_RATE_SHEET;
  if (text === undefined || text === "") throw new Error("the build holds no factory rate sheet");
  return parseRateSheet(text);
}

/** Opens the database on first use; a failed open is forgotten, so the next call tries again. */
function lazyDatabase(databaseUrl: string, log: Log): () => Promise<FactoryDatabase> {
  let opening: Promise<FactoryDatabase> | null = null;
  return () => {
    opening ??= openFactoryDatabase({ databaseUrl, now: () => new Date(), log }).catch((error: unknown) => {
      opening = null;
      throw error;
    });
    return opening;
  };
}

async function build(config: FactoryConfig, log: Log): Promise<FactoryServer> {
  return createLiveServer({
    passcode: config.passcode,
    database: config.databaseUrl === null ? null : lazyDatabase(config.databaseUrl, log),
    launch: await launchFor(config, log),
    adapters: await registeredAdapters(log),
    prepared: await preparedPackages(config.packagesDir, log),
    rates: frozenRates(),
    now: () => new Date(),
    log,
  });
}

const shared = globalThis as { __rbwFactoryLive?: Map<string, Promise<FactoryServer>> };

/** The live server for this configuration, built once per process; a build that failed is built again next time. */
export function liveServerFor(config: FactoryConfig, log: Log): Promise<FactoryServer> {
  const servers = (shared.__rbwFactoryLive ??= new Map<string, Promise<FactoryServer>>());
  const key = JSON.stringify(config);
  let server = servers.get(key);
  if (server === undefined) {
    server = build(config, log);
    servers.set(key, server);
    void server.catch(() => servers.delete(key));
  }
  return server;
}
