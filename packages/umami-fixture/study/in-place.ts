import pg from "pg";

// Reset-study candidate (a): an in-place reset of the application tables. A snapshot of every
// table, taken right after migration, is kept in a separate schema; the reset truncates the
// tables and copies the snapshot back.

const SNAPSHOT_SCHEMA = "rbw_fixture_snapshot";
const SKIPPED_TABLES = new Set(["_prisma_migrations"]);

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function withClient<T>(connectionString: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function appTables(client: pg.Client): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  return result.rows.map((row) => row.table_name).filter((name) => !SKIPPED_TABLES.has(name));
}

export async function snapshotTables(connectionString: string): Promise<number> {
  return withClient(connectionString, async (client) => {
    const tables = await appTables(client);
    await client.query("BEGIN");
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(SNAPSHOT_SCHEMA)} CASCADE`);
    await client.query(`CREATE SCHEMA ${quoteIdent(SNAPSHOT_SCHEMA)}`);
    for (const table of tables) {
      await client.query(`CREATE TABLE ${quoteIdent(SNAPSHOT_SCHEMA)}.${quoteIdent(table)} AS TABLE public.${quoteIdent(table)}`);
    }
    await client.query("COMMIT");
    return tables.length;
  });
}

export async function resetInPlace(connectionString: string): Promise<void> {
  await withClient(connectionString, async (client) => {
    const tables = await appTables(client);
    await client.query("BEGIN");
    await client.query(`TRUNCATE ${tables.map((table) => `public.${quoteIdent(table)}`).join(", ")} RESTART IDENTITY CASCADE`);
    for (const table of tables) {
      await client.query(`INSERT INTO public.${quoteIdent(table)} SELECT * FROM ${quoteIdent(SNAPSHOT_SCHEMA)}.${quoteIdent(table)}`);
    }
    await client.query("COMMIT");
  });
}
