import type { Server } from 'node:http';
import { loadServiceConfig } from './config.ts';
import { verifyMigrations } from './db/migrate.ts';
import { createPool } from './db/pool.ts';
import { log } from './log.ts';
import { createAppServer } from './server.ts';

function fatal(err: unknown): never {
  const error = err instanceof Error ? err : new Error(String(err));
  log('error', 'fatal', { error_name: error.name, sqlstate: (err as { code?: string }).code ?? null, stack: error.stack });
  process.exit(1);
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const config = loadServiceConfig();
const pool = createPool(config.databaseUrl, config.poolMax);

let server: Server | undefined;
let stopping = false;
let inFlight = 0;
let drained: (() => void) | undefined;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', 'shutdown', { signal });
  if (server !== undefined) {
    server.close();
    const idle = new Promise<void>((resolve) => {
      drained = resolve;
      if (inFlight === 0) resolve();
    });
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 4000).unref());
    await Promise.race([idle, timer]);
    server.closeAllConnections();
  }
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', (signal) => void shutdown(signal));
process.on('SIGINT', (signal) => void shutdown(signal));

async function start(): Promise<void> {
  const migrations = await verifyMigrations(pool).catch((err: unknown) => (stopping ? null : fatal(err)));
  if (stopping || migrations === null) return;
  if (!migrations.current) {
    log('error', 'migrations_not_current', { version: migrations.version });
    await pool.end().catch(() => {});
    process.exit(1);
  }

  const app = createAppServer(pool);
  server = app;
  app.on('error', fatal);
  app.on('request', (_req, res) => {
    inFlight += 1;
    res.on('close', () => {
      inFlight -= 1;
      if (inFlight === 0) drained?.();
    });
  });
  app.listen(config.port, config.host, () => {
    log('info', 'listening', { host: config.host, port: config.port });
  });
}

await start();
