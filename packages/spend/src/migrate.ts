import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlClient } from "./client.ts";
import { assertSchemaName } from "./spend.ts";

export interface MigrateOptions {
  /** Schema to migrate. It must exist. Default `public`. */
  schema?: string;
  /** Directory of `.sql` files. Default: this package's `migrations/`. */
  migrationsDir?: string;
}

export interface MigrateResult {
  /** Files applied by this run, in order. Empty when nothing was pending. */
  applied: string[];
}

/** A migration could not be applied or verified. Names the file and the reason. */
export class MigrationError extends Error {
  readonly file: string;
  readonly reason: string;

  constructor(file: string, reason: string) {
    super(`${file}: ${reason}`);
    this.name = "MigrationError";
    this.file = file;
    this.reason = reason;
  }
}

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

// The record of applied migrations is insert-only, like every other table in the schema, and
// takes rows only through applied_migrations_record, which turns on rbw.spend_api for its call.
// Each part is created when missing, so a database bootstrapped by an earlier runner gains it.
const BOOTSTRAP = `
DO $bootstrap$
BEGIN
  IF to_regclass('applied_migrations') IS NULL THEN
    CREATE TABLE applied_migrations (
      file_name text PRIMARY KEY,
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE FUNCTION applied_migrations_reject_change() RETURNS trigger
    LANGUAGE plpgsql SET search_path FROM CURRENT AS $fn$
    BEGIN
      RAISE EXCEPTION 'table applied_migrations is insert-only: % is not allowed', TG_OP
        USING ERRCODE = 'restrict_violation';
    END
    $fn$;
    CREATE TRIGGER applied_migrations_insert_only BEFORE UPDATE OR DELETE ON applied_migrations
      FOR EACH ROW EXECUTE FUNCTION applied_migrations_reject_change();
    CREATE TRIGGER applied_migrations_no_truncate BEFORE TRUNCATE ON applied_migrations
      FOR EACH STATEMENT EXECUTE FUNCTION applied_migrations_reject_change();
  END IF;
  IF to_regprocedure('applied_migrations_record(text, text)') IS NULL THEN
    CREATE FUNCTION applied_migrations_require_function() RETURNS trigger
    LANGUAGE plpgsql SET search_path FROM CURRENT AS $fn$
    BEGIN
      IF current_setting('rbw.spend_api', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'table applied_migrations accepts rows only through the spend database functions'
          USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN NEW;
    END
    $fn$;
    CREATE TRIGGER applied_migrations_api_only BEFORE INSERT ON applied_migrations
      FOR EACH ROW EXECUTE FUNCTION applied_migrations_require_function();
    CREATE FUNCTION applied_migrations_record(p_file text, p_checksum text) RETURNS void
    LANGUAGE sql SET search_path FROM CURRENT SET rbw.spend_api = 'on'
    BEGIN ATOMIC
      INSERT INTO applied_migrations (file_name, checksum) VALUES (p_file, p_checksum);
    END;
  END IF;
END
$bootstrap$;
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Applies pending migration files in lexical order, each exactly once, in one transaction.
 * Every applied file is recorded with its SHA-256; if an applied file has changed or is
 * missing, or a pending file sorts before an applied one, nothing is applied and a
 * MigrationError names it.
 */
export async function migrate(client: SqlClient, options: MigrateOptions = {}): Promise<MigrateResult> {
  const schema = options.schema ?? "public";
  assertSchemaName(schema);
  const dir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const sources = await Promise.all(
    files.map(async (file) => {
      const sql = await readFile(join(dir, file), "utf8");
      return { file, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );

  await client.query("BEGIN");
  try {
    // Concurrent runners on one schema wait here, also before its first run, then see what the
    // first one applied.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('spend_migrate'), hashtext($1))", [schema]);
    // pg_temp last: a session's temp tables never shadow the schema's tables, here or inside the
    // functions, which capture this path.
    await client.query("SELECT set_config('search_path', $1, true)", [`${schema}, pg_temp`]);
    await client.exec(BOOTSTRAP);
    const { rows } = await client.query("SELECT file_name, checksum FROM applied_migrations ORDER BY file_name");
    const applied = new Map(rows.map((row) => [String(row.file_name), String(row.checksum)]));
    for (const [file, checksum] of applied) {
      const source = sources.find((s) => s.file === file);
      if (!source) {
        throw new MigrationError(file, "applied migration file is missing");
      }
      if (source.checksum !== checksum) {
        throw new MigrationError(file, "checksum differs from the applied version; migrations are forward-only");
      }
    }
    const pending = sources.filter((s) => !applied.has(s.file));
    const latest = [...applied.keys()].sort().at(-1);
    const early = latest === undefined ? undefined : pending.find((s) => s.file < latest);
    if (early) {
      throw new MigrationError(early.file, "sorts before an applied migration; migrations are forward-only");
    }
    for (const source of pending) {
      try {
        await client.exec(source.sql);
        // Fire this file's deferred constraint triggers now, so a failure names the file, then
        // defer again for the next file. Every deferrable constraint here is initially deferred.
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("SET CONSTRAINTS ALL DEFERRED");
      } catch (error) {
        throw new MigrationError(source.file, errorMessage(error));
      }
      await client.query("SELECT applied_migrations_record($1, $2)", [source.file, source.checksum]);
    }
    await client.query("COMMIT");
    return { applied: pending.map((s) => s.file) };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "migration failed and could not be rolled back", {
        cause: rollbackError,
      });
    }
    throw error;
  }
}

export interface RunMigrateOptions extends MigrateOptions {
  /** Receives each output line; failures are marked `error`. */
  write: (line: string, kind: "info" | "error") => void;
  /** Removes connection details from error text before it is written. */
  redact?: (text: string) => string;
}

/**
 * What the `migrate` CLI runs: applies pending migrations, writes one line per applied file
 * and a final count, and returns the process exit code (0 on success, 1 on failure).
 */
export async function runMigrate(client: SqlClient, options: RunMigrateOptions): Promise<number> {
  const redact = options.redact ?? ((text: string) => text);
  try {
    const { applied } = await migrate(client, options);
    for (const file of applied) {
      options.write(`applied ${file}`, "info");
    }
    options.write(`applied ${String(applied.length)} migrations`, "info");
    return 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      options.write(`migrate failed in ${error.file}: ${redact(error.reason)}`, "error");
    } else {
      options.write(`migrate failed: ${redact(errorMessage(error))}`, "error");
    }
    return 1;
  }
}
