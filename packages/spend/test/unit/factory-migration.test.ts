import { copyFile, cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, MigrationError } from "../../src/migrate.ts";
import { acceptRequest, event, factorySetup, populateFactoryTables, records } from "../factory-helpers.ts";
import { expectOk, harness, openDb } from "../helpers.ts";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");
const FACTORY_MIGRATION = "0006_factory.sql";
const DETAILS_MIGRATION = "0007_factory_validation_details.sql";
const SCHEMA = "synthetic_factory_migration";

let db: PGlite;
const scratches: string[] = [];

/** A new directory holding a copy of every migration that sorts before `file`. */
async function migrationsBefore(file: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spend-factory-migration-"));
  scratches.push(dir);
  await cp(MIGRATIONS_DIR, dir, { recursive: true });
  for (const name of await readdir(dir)) {
    if (name >= file) {
      await rm(join(dir, name));
    }
  }
  return dir;
}

beforeAll(async () => {
  db = await openDb();
  await db.exec(`CREATE SCHEMA ${SCHEMA}`);
});

afterAll(async () => {
  for (const dir of scratches) {
    await rm(dir, { recursive: true, force: true });
  }
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
    const scratch = await migrationsBefore(FACTORY_MIGRATION);
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

describe("migration 0007_factory_validation_details.sql", () => {
  type State = Record<"rows" | "functions" | "triggers" | "columns" | "constraints" | "domains", Map<string, string>>;

  /** Every row of every table and every definition in `schema`, by name. */
  async function state(schema: string): Promise<State> {
    const named = async (sql: string): Promise<Map<string, string>> => {
      const result = await db.query<{ k: string; v: string }>(sql, [schema]);
      return new Map(result.rows.map((r) => [r.k, r.v]));
    };
    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1",
      [schema],
    );
    const tableRows = new Map<string, string>();
    for (const { table_name } of tables.rows) {
      const found = await db.query<{ v: string }>(
        `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]')::text AS v FROM ${schema}.${table_name} t`,
      );
      tableRows.set(table_name, found.rows[0]?.v ?? "");
    }
    return {
      rows: tableRows,
      functions: await named(
        `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k, pg_get_functiondef(p.oid) AS v
         FROM pg_proc p WHERE p.pronamespace = $1::regnamespace`,
      ),
      triggers: await named(
        `SELECT c.relname || '.' || t.tgname AS k, pg_get_triggerdef(t.oid) AS v FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relnamespace = $1::regnamespace AND NOT t.tgisinternal`,
      ),
      columns: await named(
        `SELECT table_name || '.' || column_name AS k,
                coalesce(domain_name, data_type) || ' ' || is_nullable || ' ' || coalesce(column_default, '') AS v
         FROM information_schema.columns WHERE table_schema = $1`,
      ),
      // Table constraints; NOT NULL is read from the columns above (Postgres 18 also lists it here,
      // Postgres 17 does not).
      constraints: await named(
        `SELECT t.relname || ' ' || c.conname AS k, pg_get_constraintdef(c.oid) AS v
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
         WHERE c.connamespace = $1::regnamespace AND c.contype <> 'n'`,
      ),
      domains: await named(
        `SELECT t.typname || ' ' || c.conname AS k, pg_get_constraintdef(c.oid) AS v
         FROM pg_type t JOIN pg_constraint c ON c.contypid = t.oid WHERE t.typnamespace = $1::regnamespace`,
      ),
    };
  }

  /** The names `after` adds to `before`, the names it removes, and the names whose definition changed. */
  function diff(before: Map<string, string>, after: Map<string, string>) {
    return {
      added: [...after.keys()].filter((k) => !before.has(k)).sort(),
      removed: [...before.keys()].filter((k) => !after.has(k)).sort(),
      changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)).sort(),
    };
  }

  const UNCHANGED = { added: [], removed: [], changed: [] };

  async function applied(schema: string): Promise<string[]> {
    return rows(`SELECT file_name AS v FROM ${schema}.applied_migrations ORDER BY file_name`);
  }

  it("replaces three functions and adds one, the run details' seven columns and three checks; every row stays", async () => {
    const scratch = await migrationsBefore(DETAILS_MIGRATION);
    const h = await harness(db, { migrationsDir: scratch });
    // A request with events but no validation run: 0007 applies over it.
    await factorySetup(h);
    const requestId = await acceptRequest(h, 1);
    expectOk(await records(h).appendEvent(event(requestId, "worker_started")));
    const before = await state(h.schema);
    const appliedBefore = await applied(h.schema);

    await copyFile(join(MIGRATIONS_DIR, DETAILS_MIGRATION), join(scratch, DETAILS_MIGRATION));
    expect(await migrate(db, { schema: h.schema, migrationsDir: scratch })).toEqual({ applied: [DETAILS_MIGRATION] });
    const after = await state(h.schema);

    // Only the record of applied migrations gains a row.
    expect(diff(before.rows, after.rows)).toEqual({ added: [], removed: [], changed: ["applied_migrations"] });
    expect(await applied(h.schema)).toEqual([...appliedBefore, DETAILS_MIGRATION]);
    expect(diff(before.functions, after.functions)).toEqual({
      added: ["factory_request_events_read(p_request jsonb)"],
      removed: [],
      changed: [
        "factory_record_validation_body(p_request jsonb, p_now text)",
        `factory_validation_json(v ${h.schema}.factory_validations)`,
        "factory_validation_read(p_request jsonb)",
      ],
    });
    expect(diff(before.triggers, after.triggers)).toEqual(UNCHANGED);
    expect(diff(before.domains, after.domains)).toEqual(UNCHANGED);
    expect(Object.fromEntries([...after.columns].filter(([k]) => !before.columns.has(k)))).toEqual({
      "factory_validations.accepted_at": "timestamp with time zone NO ",
      "factory_validations.bug_case_sha256": "spend_hex64 NO ",
      "factory_validations.copies": "integer NO ",
      "factory_validations.harness_name": "text NO ",
      "factory_validations.harness_version": "text NO ",
      "factory_validations.host_id": "spend_key NO ",
      "factory_validations.validator_sha256": "spend_hex64 NO ",
    });
    expect(diff(before.columns, after.columns)).toMatchObject({ removed: [], changed: [] });
    expect(diff(before.constraints, after.constraints)).toEqual({
      added: [
        "factory_validations factory_validations_copies",
        "factory_validations factory_validations_harness_name",
        "factory_validations factory_validations_harness_version",
      ],
      removed: [],
      changed: [],
    });

    // The request recorded before 0007 reads as before, and its events now with their keys.
    const f = records(h);
    expect(expectOk(await f.readRequest({ request_id: requestId, after: 0, limit: 10 })).last_seq).toBe(2);
    const keyed = expectOk(await f.readRequestEvents({ request_id: requestId, after: 0, limit: 10 }));
    expect(keyed.events.map((e) => e.event_key)).toEqual(["request_accepted", "worker_started"]);
  });

  it("refuses a schema whose factory_validations holds a run, and applies nothing", async () => {
    const scratch = await migrationsBefore(DETAILS_MIGRATION);
    const h = await harness(db, { migrationsDir: scratch });
    await populateFactoryTables(h, { before0007: true });
    const before = await state(h.schema);
    const appliedBefore = await applied(h.schema);
    expect(appliedBefore).toContain(FACTORY_MIGRATION);

    await copyFile(join(MIGRATIONS_DIR, DETAILS_MIGRATION), join(scratch, DETAILS_MIGRATION));
    const refused: unknown = await migrate(db, { schema: h.schema, migrationsDir: scratch }).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(refused instanceof MigrationError)) {
      throw new Error("expected a MigrationError");
    }
    expect(refused.file).toBe(DETAILS_MIGRATION);
    expect(refused.reason).toMatch(/factory_validations already holds validation runs/);

    expect(await applied(h.schema)).toEqual(appliedBefore);
    const after = await state(h.schema);
    for (const key of Object.keys(before) as (keyof State)[]) {
      expect({ key, diff: diff(before[key], after[key]) }).toEqual({ key, diff: UNCHANGED });
    }
  });
});
