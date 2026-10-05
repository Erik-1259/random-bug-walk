import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createTestClient, guarded, sanitized } from "./support.ts";
import { createSpend, fromPg, migrate } from "@rbw/spend";
import { afterAll, beforeAll, expect, test } from "vitest";
import { admissionEnvelope, observeEnvelope, parseRateSheet, toReserveRequest } from "../../src/index.ts";
import { identity } from "../identity.ts";
const schema = `synthetic_envelope_${randomBytes(8).toString("hex")}`;
const client = createTestClient(process.env.DATABASE_URL);
const rates = parseRateSheet(await readFile(new URL("../../rate-sheets/v1.json", import.meta.url), "utf8"));
const spend = createSpend({ client: fromPg(client), schema });
client.on("error", error => { throw sanitized(error); });
let connected = false;
beforeAll(async () => {
  await guarded(() => client.connect()); connected = true;
  await guarded(async () => {
    await client.query(`CREATE SCHEMA ${schema}`);
    await migrate(fromPg(client), { schema });
    expect((await spend.createPool({ pool_key: "synthetic-pool", cap_microusd: 2000000, allocations: [], actor_role: "owner", reason: "synthetic integration" })).ok).toBe(true);
  });
});
afterAll(async () => {
  try { if (connected) await guarded(() => client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)); }
  finally { await guarded(() => client.end()); }
});
test("I1 observe reserves", async () => {
  const result = await guarded(() => spend.reserve(toReserveRequest(observeEnvelope(rates), identity(1))));
  expect(result).toMatchObject({ ok: true, reserved_microusd: 215843n });
  expect(await guarded(() => spend.poolStatus({ pool_key: "synthetic-pool" }))).toMatchObject({ ok: true, committed_microusd: 215843n });
});
test("I2 over-pool refused", async () => {
  const before = await guarded(() => spend.poolStatus({ pool_key: "synthetic-pool" }));
  expect(await guarded(() => spend.reserve(toReserveRequest(admissionEnvelope(rates, { includeGeneration: false }), identity(2))))).toMatchObject({ ok: false, code: "insufficient_funds" });
  expect(await guarded(() => spend.poolStatus({ pool_key: "synthetic-pool" }))).toEqual(before);
});
