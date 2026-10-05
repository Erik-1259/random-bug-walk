// The fixture's database steps in the kit: the template copy after start, the reset before every
// round, and the checks around them. The fixture package does the copy and the reset as the
// owner role. CREATE DATABASE does not copy database-level grants, so after each one the driver
// restores the kit's grants (etc/bootstrap.sql): PUBLIC has no access, and the application role
// may only connect to the application database, never to the template.
import pg from "pg";

/** The fixture package's exports the driver uses (see its README, "Reset between rounds"). */
export interface FixtureModule {
  TEMPLATE_DATABASE: string;
  createFixtureTemplate(connectionString: string): Promise<void>;
  resetFixture(connectionString: string): Promise<void>;
}

export interface SqlClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export type Connect = (connectionString: string) => SqlClient;

export type ConnectCheck = { ok: true } | { ok: false; code: string };

export interface FixtureDatabase {
  /** Copies the freshly migrated application database to the fixture's template. */
  createTemplate(): Promise<void>;
  /** Recreates the application database from the template. */
  reset(): Promise<void>;
  /** Whether the application role can connect to the application database and run a query. */
  appCanConnect(): Promise<ConnectCheck>;
}

const realConnect: Connect = (connectionString) => new pg.Client({ connectionString });

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The application role's connection string, from the kit's app environment file (`DATABASE_URL=...`). */
export function appDatabaseUrl(environmentFile: string): string {
  const line = environmentFile.split("\n").find((item) => item.startsWith("DATABASE_URL="));
  if (line === undefined) throw new Error("the app environment file has no DATABASE_URL line");
  return line.slice("DATABASE_URL=".length);
}

/** An error's code, never its message, which may carry connection details. */
function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "unknown";
}

export function kitDatabase(options: { fixture: FixtureModule; ownerUrl: string; appUrl: string; connect?: Connect }): FixtureDatabase {
  const connect = options.connect ?? realConnect;
  const database = decodeURIComponent(new URL(options.ownerUrl).pathname.slice(1));
  const appRole = decodeURIComponent(new URL(options.appUrl).username);
  const asOwner = async (statements: readonly string[]): Promise<void> => {
    const client = connect(options.ownerUrl);
    await client.connect();
    try {
      for (const statement of statements) await client.query(statement);
    } finally {
      await client.end();
    }
  };
  return {
    async createTemplate() {
      await options.fixture.createFixtureTemplate(options.ownerUrl);
      await asOwner([`REVOKE ALL ON DATABASE ${quoteIdent(options.fixture.TEMPLATE_DATABASE)} FROM PUBLIC`]);
    },
    async reset() {
      await options.fixture.resetFixture(options.ownerUrl);
      await asOwner([
        `REVOKE ALL ON DATABASE ${quoteIdent(database)} FROM PUBLIC`,
        `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${quoteIdent(appRole)}`,
      ]);
    },
    async appCanConnect() {
      const client = connect(options.appUrl);
      try {
        await client.connect();
      } catch (error) {
        return { ok: false, code: errorCode(error) };
      }
      try {
        await client.query("SELECT 1");
        return { ok: true };
      } catch (error) {
        return { ok: false, code: errorCode(error) };
      } finally {
        await client.end();
      }
    },
  };
}
