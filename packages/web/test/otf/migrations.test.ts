// The OTF migrations on PGlite: 0002_otf_open.sql adds the nullable rule column after 0001_otf.sql,
// leaves existing rows untouched, and applies twice without error. Every value is synthetic.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migration = (name: string): string => readFileSync(new URL(`../../otf-migrations/${name}`, import.meta.url), "utf8");

describe("otf migrations", () => {
  it("adds a nullable rule jsonb column to otf.jobs, idempotently and without touching existing rows", async () => {
    const db = await PGlite.create();
    try {
      await db.exec(migration("0001_otf.sql"));
      await db.query(
        `INSERT INTO otf.jobs (job_id, client_key, create_sha256, created_at, host_id, criterion_id, sentence, spec, spec_sha256, state)
         VALUES ($1, $2, $3, now(), 'task-report', 'concurrency.lost-acknowledged-change', 'A synthetic sentence.', '{}'::jsonb, $3, 'queued')`,
        ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "a".repeat(64)],
      );
      await db.exec(migration("0002_otf_open.sql"));
      await db.exec(migration("0002_otf_open.sql"));
      const columns = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'otf' AND table_name = 'jobs' AND column_name = 'rule'",
      );
      expect(columns.rows).toEqual([{ data_type: "jsonb", is_nullable: "YES", column_default: null }]);
      const rows = await db.query<{ rule: unknown }>("SELECT rule FROM otf.jobs");
      expect(rows.rows).toEqual([{ rule: null }]);
    } finally {
      await db.close();
    }
  });
});
