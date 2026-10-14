import pg from "pg";
import { loadFixture, type Fixture } from "./fixture.ts";

/** The database that holds a copy of the migrated application database with the two-factor state baked in. */
export const TEMPLATE_DATABASE = "rbw_fixture_template";

const OBJECT_IN_USE = "55006";
const COPY_ATTEMPTS = 3;

export interface Statement {
  text: string;
  values: string[];
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * The statements that bake the fixture's two-factor state into a freshly migrated database, run
 * in one transaction: two-factor sign-in enabled for the pinned migration's admin user, with the
 * fixture's ten unused backup codes in data-file order, and no rate-limit or used-code rows. The
 * TOTP secret column holds a synthetic placeholder, because no check uses a TOTP code.
 */
export function twoFactorSeedStatements(fixture: Fixture): Statement[] {
  const { user_id: userId, row_id: rowId, secret_column: secretColumn, backup_codes: codes } = fixture.two_factor;
  return [
    { text: "DELETE FROM two_factor_backup_code WHERE user_id = $1", values: [userId] },
    { text: "DELETE FROM two_factor_rate_limit WHERE user_id = $1", values: [userId] },
    { text: "DELETE FROM two_factor_otp_used WHERE user_id = $1", values: [userId] },
    { text: "DELETE FROM two_factor_auth WHERE user_id = $1", values: [userId] },
    {
      text: "INSERT INTO two_factor_auth (id, user_id, secret, is_enabled, updated_at) VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP)",
      values: [rowId, userId, secretColumn],
    },
    ...codes.map((code) => ({
      text: "INSERT INTO two_factor_backup_code (id, user_id, code_hash, used) VALUES ($1, $2, $3, false)",
      values: [code.id, userId, code.code_hash],
    })),
  ];
}

/** Runs the seed statements on the given (template) database in one transaction, after checking the admin user exists. */
async function bakeTwoFactorState(connectionString: string, fixture: Fixture): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const user = await client.query('SELECT 1 FROM "user" WHERE user_id = $1 AND deleted_at IS NULL', [fixture.two_factor.user_id]);
    if (user.rowCount !== 1) {
      throw new Error("createFixtureTemplate: the migrated database has no admin user to enable two-factor sign-in for");
    }
    await client.query("BEGIN");
    try {
      for (const statement of twoFactorSeedStatements(fixture)) {
        await client.query(statement.text, statement.values);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
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

/** The same connection string with its database replaced by the given one. */
function onDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/**
 * Copies the freshly migrated application database to the template database, then bakes the
 * two-factor state into the template copy only. Run once, right after Umami has migrated. The
 * application database itself stays stock Umami, so the upstream suite that runs before the
 * first reset signs in as admin without a two-factor challenge; `resetFixture` then gives every
 * round the baked state. Copying needs the source to have no other sessions, so the app's pooled
 * connections are closed first; the pool reconnects on its next query. Needs the owner role,
 * which may create databases and owns the copy it creates.
 */
export async function createFixtureTemplate(connectionString: string, template: string = TEMPLATE_DATABASE): Promise<void> {
  target(connectionString);
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
  await bakeTwoFactorState(onDatabase(connectionString, template), loadFixture());
}

/**
 * Resets the application database to the template copy: drops it, closing every session, and
 * recreates it from the template. Every round so starts with all ten backup codes unused and no
 * failed-attempt count. Reads no environment variable. Needs the database owner's privileges.
 */
export async function resetFixture(connectionString: string, template: string = TEMPLATE_DATABASE): Promise<void> {
  await withMaintenance(connectionString, async (client, database) => {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quoteIdent(database)} TEMPLATE ${quoteIdent(template)}`);
  });
}
