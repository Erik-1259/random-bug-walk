import pg from "pg";

/** The database that holds a copy of the freshly migrated fixture database. */
export const TEMPLATE_DATABASE = "rbw_fixture_template";

const OBJECT_IN_USE = "55006";
const COPY_ATTEMPTS = 3;

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The app database's name, and a connection string for the server's maintenance database. */
function target(connectionString: string): { database: string; maintenance: string } {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (database === "" || database === "postgres") {
    throw new Error("resetFixture: the connection string must name the application database");
  }
  url.pathname = "/postgres";
  return { database, maintenance: url.toString() };
}

async function withMaintenance<T>(connectionString: string, run: (client: pg.Client, database: string) => Promise<T>): Promise<T> {
  const { database, maintenance } = target(connectionString);
  const client = new pg.Client({ connectionString: maintenance });
  await client.connect();
  try {
    return await run(client, database);
  } finally {
    await client.end();
  }
}

function isObjectInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === OBJECT_IN_USE;
}

/**
 * Copies the freshly migrated application database to the template database. Run once, right
 * after Umami has migrated and before anything else writes to it. Copying needs the source to
 * have no other sessions, so the app's pooled connections are closed first; the pool reconnects
 * on its next query. Needs a role that may create databases.
 */
export async function createFixtureTemplate(connectionString: string, template: string = TEMPLATE_DATABASE): Promise<void> {
  await withMaintenance(connectionString, async (client, database) => {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(template)}`);
    for (let attempt = 1; ; attempt += 1) {
      await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [database]);
      try {
        await client.query(`CREATE DATABASE ${quoteIdent(template)} TEMPLATE ${quoteIdent(database)}`);
        return;
      } catch (error) {
        if (!isObjectInUse(error) || attempt >= COPY_ATTEMPTS) {
          throw error;
        }
      }
    }
  });
}

/**
 * Resets the application database to the template copy: drops it, closing every session, and
 * recreates it from the template. Takes the application database's connection string as a
 * parameter and reads no environment variable. Needs the database owner's privileges.
 */
export async function resetFixture(connectionString: string, template: string = TEMPLATE_DATABASE): Promise<void> {
  await withMaintenance(connectionString, async (client, database) => {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quoteIdent(database)} TEMPLATE ${quoteIdent(template)}`);
  });
}
