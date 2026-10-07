// Spec §6.1's serial-run checks against the Postgres in DATABASE_URL: each check gets its own
// randomly named schema with every spend migration, dropped afterwards. Errors name only the
// variable and a driver error code.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, describe, it } from "vitest";
import { createSpend, fromPg, migrate } from "@rbw/spend";
import type { Clock } from "@rbw/local-runner";
import { createSlotKeys, world } from "../support/harness.ts";
import type { TestLedger, WorldOptions } from "../support/harness.ts";
import { SERIAL_CHECKS } from "../support/serial-checks.ts";

function sanitized(error: unknown): Error {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "UNKNOWN";
  return new Error(`DATABASE_URL failed (driver error code ${code})`);
}

async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw sanitized(error);
  }
}

const opened: { client: pg.Client; schema: string }[] = [];

async function postgresLedger(clock: Clock): Promise<TestLedger> {
  const schema = `synthetic_controller_${randomBytes(8).toString("hex")}`;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  client.on("error", (error) => {
    throw sanitized(error);
  });
  await guarded(() => client.connect());
  opened.push({ client, schema });
  await guarded(async () => {
    await client.query(`CREATE SCHEMA ${schema}`);
    await migrate(fromPg(client), { schema });
  });
  const spend = createSpend({ client: fromPg(client), schema, clock: () => new Date(clock.now()) });
  await guarded(() => createSlotKeys(spend));
  return { spend, close: () => Promise.resolve() };
}

afterAll(async () => {
  for (const { client, schema } of opened) {
    try {
      await guarded(() => client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    } finally {
      await guarded(() => client.end());
    }
  }
});

describe("serial-run checks (spec §6.1) on Postgres", () => {
  for (const [name, check] of Object.entries(SERIAL_CHECKS)) {
    it(name, () => check((options: WorldOptions = {}) => world({ ...options, ledger: postgresLedger })));
  }
});
