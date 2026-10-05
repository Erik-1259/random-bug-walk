import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromPg } from "../../src/client.ts";
import { migrate } from "../../src/migrate.ts";
import { openTestDatabase, withConnection } from "./support.ts";

async function schemaCount(prefix: string): Promise<number> {
  return withConnection(async (client) => {
    const rows = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE $1",
      [`${prefix}%`],
    );
    return rows.rows[0]?.n ?? -1;
  });
}

describe("integration setup and the migration runner against a real Postgres", () => {
  it("drops its schema when the migrations fail during setup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spend-broken-"));
    try {
      await writeFile(join(dir, "0001_synthetic_broken.sql"), "CREATE TABLE synthetic_broken (;\n");
      const before = await schemaCount("synthetic_it_");
      await expect(openTestDatabase({ migrationsDir: dir })).rejects.toThrow(/DATABASE_URL/);
      expect(await schemaCount("synthetic_it_")).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes two first runs against the same empty schema", async () => {
    const schema = `synthetic_it_migrate_${String(process.pid)}_${String(Date.now())}`;
    await withConnection((client) => client.query(`CREATE SCHEMA ${schema}`));
    try {
      const results = await Promise.all([
        withConnection((client) => migrate(fromPg(client), { schema })),
        withConnection((client) => migrate(fromPg(client), { schema })),
      ]);
      const counts = results.map((r) => r.applied.length).sort((x, y) => x - y);
      expect(counts[0]).toBe(0);
      expect(counts[1]).toBeGreaterThan(0);
    } finally {
      await withConnection((client) => client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    }
  });
});
