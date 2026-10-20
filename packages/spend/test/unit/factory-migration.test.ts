import { copyFile, cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/migrate.ts";
import { openDb } from "../helpers.ts";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");
const FACTORY_MIGRATION = "0006_factory.sql";
const SCHEMA = "synthetic_factory_migration";

let db: PGlite;
let scratch: string;

beforeAll(async () => {
  db = await openDb();
  scratch = await mkdtemp(join(tmpdir(), "spend-factory-migration-"));
  await cp(MIGRATIONS_DIR, scratch, { recursive: true });
  await rm(join(scratch, FACTORY_MIGRATION));
  await db.exec(`CREATE SCHEMA ${SCHEMA}`);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  await db.close();
});

async function rows(sql: string, params: unknown[] = []): Promise<string[]> {
  const result = await db.query<{ v: string }>(sql, params);
  return result.rows.map((r) => r.v);
}

/** Everything that existed before the factory migration and must not change: rows, functions, triggers, columns, constraints. */
async function snapshot(): Promise<Record<string, string[]>> {
  const table = (name: string, where = "true") =>
    rows(`SELECT to_jsonb(t)::text AS v FROM ${SCHEMA}.${name} t WHERE ${where} ORDER BY t.seq`);
  return {
    pools: await table("pools"),
    pool_allocations: await table("pool_allocations"),
    pool_cap_changes: await table("pool_cap_changes"),
    allocation_transfers: await table("allocation_transfers"),
    execution_slot: await table("execution_slot"),
    judge_demo_status: await rows(`SELECT ${SCHEMA}.spend_pool_status('{"pool_key": "judge-demo"}')::text AS v`),
    development_status: await rows(`SELECT ${SCHEMA}.spend_pool_status('{"pool_key": "development"}')::text AS v`),
    functions: await rows(
      `SELECT p.oid::regprocedure::text || E'\\n' || pg_get_functiondef(p.oid) AS v
       FROM pg_proc p WHERE p.pronamespace = $1::regnamespace ORDER BY 1`,
      [SCHEMA],
    ),
    triggers: await rows(
      `SELECT pg_get_triggerdef(t.oid) AS v FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relnamespace = $1::regnamespace AND NOT t.tgisinternal ORDER BY 1`,
      [SCHEMA],
    ),
    columns: await rows(
      `SELECT table_name || '.' || column_name || ' ' || coalesce(domain_name, data_type) || ' ' || is_nullable
              || ' ' || coalesce(column_default, '') AS v
       FROM information_schema.columns WHERE table_schema = $1 ORDER BY 1`,
      [SCHEMA],
    ),
    constraints: await rows(
      `SELECT c.conrelid::regclass::text || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid) AS v
       FROM pg_constraint c WHERE c.connamespace = $1::regnamespace ORDER BY 1`,
      [SCHEMA],
    ),
    domains: await rows(
      `SELECT t.typname || ' ' || pg_get_constraintdef(c.oid) AS v FROM pg_type t JOIN pg_constraint c ON c.contypid = t.oid
       WHERE t.typnamespace = $1::regnamespace ORDER BY 1`,
      [SCHEMA],
    ),
  };
}

describe("migration 0006_factory.sql", () => {
  it("only adds: judge-demo, its allocations and every earlier function, trigger, column and constraint stay byte-for-byte the same", async () => {
    expect(await migrate(db, { schema: SCHEMA, migrationsDir: scratch })).toEqual({
      applied: (await readdir(scratch)).filter((f) => f.endsWith(".sql")).sort(),
    });
    const before = await snapshot();
    expect((before.functions ?? []).some((f) => f.startsWith("synthetic_factory_migration.spend_reserve_body("))).toBe(true);
    expect(before.judge_demo_status).toHaveLength(1);

    await copyFile(join(MIGRATIONS_DIR, FACTORY_MIGRATION), join(scratch, FACTORY_MIGRATION));
    expect(await migrate(db, { schema: SCHEMA, migrationsDir: scratch })).toEqual({ applied: [FACTORY_MIGRATION] });
    const after = await snapshot();

    // Rows: nothing seeded, nothing changed. The factory pool and slot key are owner actions.
    for (const key of ["pools", "pool_allocations", "pool_cap_changes", "allocation_transfers", "execution_slot", "judge_demo_status", "development_status"]) {
      expect({ key, rows: after[key] }).toEqual({ key, rows: before[key] });
    }
    // Definitions: every earlier one is still present and identical; the migration only adds.
    for (const key of ["functions", "triggers", "columns", "constraints", "domains"]) {
      const kept = new Set(after[key]);
      expect({ key, missing: (before[key] ?? []).filter((v) => !kept.has(v)) }).toEqual({ key, missing: [] });
    }
    for (const key of ["functions", "triggers", "columns", "constraints"]) {
      expect((after[key] ?? []).length).toBeGreaterThan((before[key] ?? []).length);
    }
  });
});
