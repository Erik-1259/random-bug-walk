import { spawnSync } from "node:child_process";
import { appendFile, cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, runMigrate } from "../../src/migrate.ts";
import { openDb } from "../helpers.ts";

const PACKAGE_DIR = join(import.meta.dirname, "..", "..");
const MIGRATIONS_DIR = join(PACKAGE_DIR, "migrations");

let db: PGlite;
let schema: string;
let counter = 0;
let output: string[];
let scratch: string;

beforeAll(async () => {
  db = await openDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  counter += 1;
  schema = `synthetic_migrate_${String(counter)}`;
  await db.exec(`CREATE SCHEMA ${schema}`);
  output = [];
  scratch = await mkdtemp(join(tmpdir(), "spend-migrations-"));
  await cp(MIGRATIONS_DIR, scratch, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function run(dir = scratch): Promise<number> {
  return runMigrate(db, { schema, migrationsDir: dir, write: (text) => output.push(text) });
}

async function sqlFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
}

describe("migrate", () => {
  it("applies every file in lexical order into an empty schema, then applies nothing", async () => {
    const files = await sqlFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(await run()).toBe(0);
    expect(output).toEqual([...files.map((f) => `applied ${f}`), `applied ${String(files.length)} migrations`]);

    const recorded = await db.query<{ file_name: string; checksum: string }>(
      `SELECT file_name, checksum FROM ${schema}.applied_migrations ORDER BY file_name`,
    );
    expect(recorded.rows.map((r) => r.file_name)).toEqual(files);
    for (const row of recorded.rows) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }

    output = [];
    expect(await run()).toBe(0);
    expect(output).toEqual(["applied 0 migrations"]);
  });

  it("returns the applied file names from the library function", async () => {
    const first = await migrate(db, { schema, migrationsDir: scratch });
    expect(first.applied).toEqual(await sqlFiles());
    const second = await migrate(db, { schema, migrationsDir: scratch });
    expect(second.applied).toEqual([]);
  });

  it("exits non-zero and names the file when an applied migration changed", async () => {
    expect(await run()).toBe(0);
    const [first] = await sqlFiles();
    await appendFile(join(scratch, String(first)), "\n-- synthetic edit\n");
    output = [];
    expect(await run()).toBe(1);
    expect(output.join("\n")).toContain(String(first));
    expect(output.join("\n")).toMatch(/checksum/);
  });

  it("exits non-zero when an applied migration file is missing", async () => {
    expect(await run()).toBe(0);
    const files = await sqlFiles();
    const last = String(files[files.length - 1]);
    await rm(join(scratch, last));
    output = [];
    expect(await run()).toBe(1);
    expect(output.join("\n")).toContain(last);
  });

  it("applies a new file and rolls back the whole run when a file fails", async () => {
    expect(await run()).toBe(0);
    await writeFile(join(scratch, "9998_synthetic_ok.sql"), "CREATE TABLE synthetic_ok (id int);\n");
    await writeFile(join(scratch, "9999_synthetic_broken.sql"), "CREATE TABLE synthetic_broken (;\n");
    output = [];
    expect(await run()).toBe(1);
    expect(output.join("\n")).toContain("9999_synthetic_broken.sql");
    const tables = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'synthetic_%'",
      [schema],
    );
    expect(tables.rows).toEqual([]);

    await rm(join(scratch, "9999_synthetic_broken.sql"));
    output = [];
    expect(await run()).toBe(0);
    expect(output).toEqual(["applied 9998_synthetic_ok.sql", "applied 1 migrations"]);
  });

  it("exits non-zero and applies nothing when a new file sorts before an applied one", async () => {
    expect(await run()).toBe(0);
    const [first] = await sqlFiles();
    const early = `${String(first).replace(/\.sql$/, "")}a_synthetic_late.sql`;
    await writeFile(join(scratch, early), "CREATE TABLE synthetic_late (id int);\n");
    output = [];
    expect(await run()).toBe(1);
    expect(output.join("\n")).toContain(early);
    expect(output.join("\n")).toMatch(/forward-only/);
    const tables = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'synthetic_late'",
      [schema],
    );
    expect(tables.rows).toEqual([]);
  });

  it("names the file whose deferred constraint fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spend-deferred-"));
    try {
      await writeFile(
        join(dir, "0001_synthetic_table.sql"),
        `CREATE TABLE synthetic_deferred (id int);
         CREATE FUNCTION synthetic_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'synthetic deferred refusal'; END $$;
         CREATE CONSTRAINT TRIGGER synthetic_deferred_check AFTER INSERT ON synthetic_deferred
           DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION synthetic_refuse();\n`,
      );
      await writeFile(join(dir, "0002_synthetic_row.sql"), "INSERT INTO synthetic_deferred VALUES (1);\n");
      await writeFile(join(dir, "0003_synthetic_after.sql"), "CREATE TABLE synthetic_after (id int);\n");
      expect(await run(dir)).toBe(1);
      expect(output).toEqual([expect.stringMatching(/^migrate failed in 0002_synthetic_row\.sql: .*synthetic deferred refusal/)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a schema name that is not a plain lowercase identifier", async () => {
    await expect(migrate(db, { schema: "Synthetic; DROP", migrationsDir: scratch })).rejects.toThrow(/schema/);
  });
});

describe("migrate CLI", () => {
  function cli(env: Record<string, string>) {
    const rest = { ...process.env };
    delete rest.DATABASE_URL;
    return spawnSync(process.execPath, [join(PACKAGE_DIR, "src", "cli.ts")], {
      env: { ...rest, ...env },
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  it("exits non-zero with a message naming DATABASE_URL when it is unset", () => {
    const result = cli({});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_URL");
  });

  it("never prints any part of the connection string when it cannot connect", () => {
    const result = cli({ DATABASE_URL: "postgres://synthetic-user:synthetic-secret@127.0.0.1:9/synthetic-db" });
    expect(result.status).not.toBe(0);
    const printed = `${result.stdout}\n${result.stderr}`;
    for (const part of ["synthetic-user", "synthetic-secret", "127.0.0.1", "synthetic-db", ":9"]) {
      expect(printed).not.toContain(part);
    }
    expect(printed).toContain("DATABASE_URL");
  });
});
