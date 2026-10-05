import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectNothingWritten, expectOk, expectRefused, harness, openDb, reserveRequest, setup, type Harness } from "../helpers.ts";

const MIGRATION = readFileSync(new URL("../../migrations/0005_call_name.sql", import.meta.url), "utf8");
const RECORDS_SCHEMA = JSON.parse(
  readFileSync(new URL("../../../schema/schema/records.schema.json", import.meta.url), "utf8"),
) as { $defs: { CallName: { pattern: string } } };

/** The one regular-expression literal and the length limit of spend_is_call_name. */
function migrationRule(): { pattern: string; maxLength: number } {
  const match = /FUNCTION spend_is_call_name\(p text\)[^;]*?p ~ '([^']*)' AND length\(p\) <= (\d+)/.exec(MIGRATION);
  if (match === null) {
    throw new Error("spend_is_call_name not found in 0005_call_name.sql");
  }
  return { pattern: match[1] ?? "", maxLength: Number(match[2]) };
}

let db: PGlite;
let h: Harness;

beforeAll(async () => {
  db = await openDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  h = await harness(db);
  await setup(h);
});

describe("the call_name domain", () => {
  it("uses the schema's CallName pattern exactly, with a limit of at least 128 characters", () => {
    const rule = migrationRule();
    expect(rule.pattern).toBe(RECORDS_SCHEMA.$defs.CallName.pattern);
    expect(rule.maxLength).toBeGreaterThanOrEqual(128);
  });

  it("is the type of operations.call_name, and the other label columns keep spend_label", async () => {
    const rows = await h.sql(
      "SELECT table_name, column_name, domain_name FROM information_schema.columns WHERE table_schema = $1 AND domain_name IN ('spend_label', 'spend_call_name') ORDER BY 1, 2",
      [h.schema],
    );
    expect(rows).toEqual([
      { table_name: "halt_observations", column_name: "service", domain_name: "spend_label" },
      { table_name: "operation_lines", column_name: "service", domain_name: "spend_label" },
      { table_name: "operations", column_name: "call_name", domain_name: "spend_call_name" },
      { table_name: "operations", column_name: "kind", domain_name: "spend_label" },
      { table_name: "operations", column_name: "provider", domain_name: "spend_label" },
      { table_name: "slot_children", column_name: "kind", domain_name: "spend_label" },
      { table_name: "slot_children", column_name: "provider", domain_name: "spend_label" },
    ]);
  });

  it.each([
    ["the colon form of a writer call", "writer.issue:cand-17:3"],
    ["the colon form of a search call", "search.phrase:synthetic-candidate-1:phrase-2"],
    ["a single segment", "synthetic.generate"],
    ["128 characters", `writer.issue:${"a".repeat(115)}`],
  ])("accepts %s in a reservation", async (_name, callName) => {
    const result = expectOk(await h.spend.reserve(reserveRequest(1, { call_name: callName })));
    expect(result.replay).toBe(false);
    const rows = await h.sql("SELECT call_name FROM operations WHERE operation_id = $1", [result.operation_id]);
    expect(rows).toEqual([{ call_name: callName }]);
  });

  it.each([
    ["129 characters", `writer.issue:${"a".repeat(116)}`],
    ["an empty segment", "writer.issue::3"],
    ["a trailing colon", "writer.issue:cand-17:"],
    ["a leading colon", ":writer.issue"],
    ["an uppercase letter", "writer.issue:Cand-17:3"],
    ["a space", "writer.issue:cand 17:3"],
    ["a trailing newline", "writer.issue:cand-17:3\n"],
    ["an empty string", ""],
  ])("refuses %s before writing anything", async (_name, callName) => {
    await expectNothingWritten(h, async () => {
      const refused = expectRefused(await h.spend.reserve(reserveRequest(1, { call_name: callName })), "invalid_request");
      expect(refused.detail).toMatch(/^call_name /);
    });
  });

  it.each([
    ["kind", { kind: "writer.issue:x" }],
    ["provider", { provider: "synthetic:provider" }],
  ])("still refuses a colon in %s", async (field, overrides) => {
    const refused = expectRefused(await h.spend.reserve(reserveRequest(1, overrides)), "invalid_request");
    expect(refused.detail).toMatch(new RegExp(`^${field} `));
  });
});
