import { randomBytes } from "node:crypto";
import pg from "pg";
import { errorCode, fromPg } from "../../src/client.ts";
import { migrate } from "../../src/migrate.ts";
import { createSpend } from "../../src/spend.ts";
import type { Spend } from "../../src/spend.ts";

/** A fresh, randomly named schema with all migrations applied, and connections that use it. */
export interface TestDatabase {
  schema: string;
  connect(): Promise<{ client: pg.Client; spend: Spend }>;
  drop(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** Directory of `.sql` files. Default: this package's `migrations/`. */
  migrationsDir?: string;
}

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return url;
}

// Driver and server messages can name the host, port, user or database, and the test runner
// prints every property of a thrown error. Setup errors therefore carry only a step and a code.
function sanitized(step: string, error: unknown): Error {
  return new Error(`${step} on the database named by DATABASE_URL failed (error code ${errorCode(error)})`);
}

async function guarded<T>(step: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw sanitized(step, error);
  }
}

async function open(onError: (error: Error) => void): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: connectionString() });
  client.on("error", onError);
  await guarded("connecting", () => client.connect());
  return client;
}

/** Runs `fn` on a new connection to DATABASE_URL and closes it afterwards. */
export async function withConnection<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const errors: Error[] = [];
  const client = await open((error) => errors.push(error));
  let result: T;
  try {
    result = await fn(client);
  } finally {
    await guarded("disconnecting", () => client.end());
  }
  if (errors.length > 0) {
    throw new Error(`${String(errors.length)} connection error(s) on the database named by DATABASE_URL`);
  }
  return result;
}

export async function openTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const schema = `synthetic_it_${randomBytes(6).toString("hex")}`;
  const clients: pg.Client[] = [];
  const connectionErrors: Error[] = [];

  const connect = async (): Promise<{ client: pg.Client; spend: Spend }> => {
    const client = await open((error) => connectionErrors.push(error));
    clients.push(client);
    return { client, spend: createSpend({ client: fromPg(client), schema }) };
  };
  const end = async (): Promise<void> => {
    await Promise.allSettled(clients.map((c) => c.end()));
  };

  const admin = await connect();
  try {
    await guarded("creating the test schema", () => admin.client.query(`CREATE SCHEMA ${schema}`));
    await guarded("applying the migrations", () =>
      migrate(fromPg(admin.client), {
        schema,
        ...(options.migrationsDir === undefined ? {} : { migrationsDir: options.migrationsDir }),
      }),
    );
  } catch (error) {
    try {
      await guarded("dropping the test schema", () => admin.client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    } catch (dropError) {
      throw new AggregateError([error, dropError], "test setup failed and its schema could not be dropped", {
        cause: dropError,
      });
    } finally {
      await end();
    }
    throw error;
  }

  const drop = async (): Promise<void> => {
    try {
      await guarded("dropping the test schema", () => admin.client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    } finally {
      await end();
    }
    if (connectionErrors.length > 0) {
      throw new Error(`${String(connectionErrors.length)} connection error(s) during the run`);
    }
  };

  return { schema, connect, drop };
}

/** Polls `check` until it returns true; fails after `timeoutMs`. */
export async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function suffix(): string {
  return randomBytes(4).toString("hex");
}
