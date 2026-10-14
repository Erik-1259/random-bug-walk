import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fromPg, type SqlClient } from "../../src/client.ts";
import { runOperator } from "../../src/operator.ts";
import { expectOk, reserveRequest, ROOT, OTHER_ROOT } from "../helpers.ts";
import { openTestDatabase, type TestDatabase } from "./support.ts";

let database: TestDatabase;
let directory: string | undefined;
let dropDatabase: (() => Promise<void>) | undefined;
beforeAll(async () => {
  database = await openTestDatabase();
  dropDatabase = () => database.drop();
  directory = await mkdtemp(join(tmpdir(), "synthetic-operator-integration-"));
});
afterAll(async () => {
  try { await dropDatabase?.(); }
  finally { if (directory !== undefined) await rm(directory, { recursive: true }); }
});

it("operator snapshot is read-only, reconciliation defaults to dry run, and release applies in its own schema", async () => {
  const { client, spend } = await database.connect();
  const sql = fromPg(client);
  const statements: string[] = [];
  let readOnly: unknown;
  const recording: SqlClient = {
    exec: s => sql.exec(s),
    query: async (s, p) => {
      statements.push(s);
      const result = await sql.query(s, p);
      if (s.startsWith("BEGIN")) readOnly = (await client.query<{ transaction_read_only: string }>("SHOW transaction_read_only")).rows[0]?.transaction_read_only;
      return result;
    },
  };
  const options = { schema: database.schema, write: () => undefined };
  expect(await runOperator(recording, ["status", "--json"], options)).toBe(0);
  expect(statements[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  expect(statements.at(-1)).toBe("ROLLBACK");
  expect(readOnly).toBe("on");
  if (directory === undefined) throw new Error("synthetic evidence directory was not created");
  const evidence = join(directory, "synthetic-evidence.txt");
  await writeFile(evidence, "synthetic integration evidence");
  const op = expectOk(await spend.reserve(reserveRequest(1, { pool_key: "development", root_execution_id: OTHER_ROOT, execution_id: OTHER_ROOT }))).operation_id;
  const before = expectOk(await spend.operationStatus({ operation_id: op }));
  const count = async () => {
    const tables = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name", [database.schema]);
    const counts: Record<string, string> = {};
    for (const { table_name } of tables.rows) {
      const result = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${database.schema}.${table_name}`);
      counts[table_name] = result.rows[0]?.n ?? "missing";
    }
    return counts;
  };
  const beforeCount = await count();
  expect(await runOperator(sql, ["reconcile", "--operation", op, "--from", "prepared", "--decision", "confirm_no_launch", "--retained", "0", "--released", "1000", "--evidence", evidence, "--reason", "synthetic reason"], options)).toBe(0);
  expect(await spend.operationStatus({ operation_id: op })).toEqual(before);
  expect(await count()).toEqual(beforeCount);
  const slot = "synthetic-operator-slot";
  expectOk(await spend.createSlotKey({ slot_key: slot, actor_role: "owner", reason: "synthetic reason" }));
  expectOk(await spend.acquireSlot({ slot_key: slot, root_execution_id: ROOT, actor_role: "workflow" }));
  expect(await runOperator(sql, ["release-slot", "--slot", slot, "--root", ROOT, "--evidence", evidence, "--reason", "synthetic reason", "--apply"], options)).toBe(0);
  expect(expectOk(await spend.slotStatus({ slot_key: slot })).holder).toBeNull();
});
