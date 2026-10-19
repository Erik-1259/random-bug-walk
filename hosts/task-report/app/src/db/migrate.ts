import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { loadMigrationUrl } from '../config.ts';
import { log } from '../log.ts';

type Migration = { version: string; sha256: string; sql: string };
type Queryable = Pick<pg.ClientBase, 'query'>;
type VerifyResult = { current: true } | { current: false; version: string };

const DIRECTORY = new URL('../../migrations/', import.meta.url);

function readMigrations(): Migration[] {
  return readdirSync(DIRECTORY)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const bytes = readFileSync(new URL(name, DIRECTORY));
      return {
        version: name.slice(0, -'.sql'.length),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sql: bytes.toString('utf8'),
      };
    });
}

async function recorded(db: Queryable): Promise<Map<string, string> | null> {
  try {
    const result = await db.query<{ version: string; sha256: string }>(
      'SELECT version, sha256 FROM schema_migrations',
    );
    return new Map(result.rows.map((row) => [row.version, row.sha256]));
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return null;
    throw err;
  }
}

export async function verifyMigrations(db: Queryable): Promise<VerifyResult> {
  const applied = (await recorded(db)) ?? new Map<string, string>();
  for (const migration of readMigrations()) {
    if (applied.get(migration.version) !== migration.sha256) {
      return { current: false, version: migration.version };
    }
  }
  return { current: true };
}

async function apply(db: pg.Client): Promise<VerifyResult> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, sha256 char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  await db.query('BEGIN');
  try {
    await db.query('LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE');
    const applied = (await recorded(db)) ?? new Map<string, string>();
    for (const migration of readMigrations()) {
      const sha256 = applied.get(migration.version);
      if (sha256 === migration.sha256) continue;
      if (sha256 !== undefined) {
        await db.query('ROLLBACK');
        return { current: false, version: migration.version };
      }
      await db.query(migration.sql);
      await db.query('INSERT INTO schema_migrations (version, sha256) VALUES ($1, $2)', [
        migration.version,
        migration.sha256,
      ]);
    }
    await db.query('COMMIT');
    return { current: true };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function main(): Promise<number> {
  const { command, databaseUrl } = loadMigrationUrl(process.argv[2]);
  const db = new pg.Client({ connectionString: databaseUrl, application_name: 'taskapp' });
  try {
    await db.connect();
    const result = command === 'apply' ? await apply(db) : await verifyMigrations(db);
    if (!result.current) {
      log('error', 'migrations_not_current', { version: result.version });
      return 1;
    }
    return 0;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('error', 'fatal', { error_name: error.name, sqlstate: (err as { code?: string }).code ?? null, stack: error.stack });
    return 1;
  } finally {
    await db.end().catch(() => {});
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
