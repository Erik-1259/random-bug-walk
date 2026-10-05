import { PGlite } from "@electric-sql/pglite";
import { createSpend, migrate } from "@rbw/spend";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { admissionEnvelope, judgeEnvelope, observeEnvelope, parseRateSheet, toReserveRequest } from "../../src/index.ts";
import { identity } from "../identity.ts";
const rates = parseRateSheet(await readFile(new URL("../../rate-sheets/v1.json", import.meta.url), "utf8"));
test("PGlite reserves the per-line total and refuses null prices without an operation", async () => {
  const db = await PGlite.create();
  try {
    await db.exec("CREATE SCHEMA synthetic_envelope");
    await migrate(db, { schema: "synthetic_envelope" });
    const spend = createSpend({ client: db, schema: "synthetic_envelope" });
    expect((await spend.createPool({ pool_key: "synthetic-pool", cap_microusd: 10000000, allocations: [], actor_role: "owner", reason: "synthetic test" })).ok).toBe(true);
    const envelopes = [observeEnvelope(rates), judgeEnvelope(rates), admissionEnvelope(rates, { includeGeneration: false })];
    for (const [i, envelope] of envelopes.entries()) {
      if (!envelope.ok) throw new Error("expected envelope");
      const result = await spend.reserve(toReserveRequest(envelope, identity(i + 1)));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected reservation");
      expect(result.reserved_microusd).toBe(envelope.reserved_microusd);
    }
    const request = toReserveRequest(observeEnvelope(rates), identity(4));
    request.envelope = request.envelope.map(l => ({ ...l, price: null }));
    expect(await spend.reserve(request)).toMatchObject({ ok: false, code: "unknown_price" });
    expect((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM synthetic_envelope.operations")).rows[0]?.n).toBe("3");
    expect(await spend.operationStatus({ operation_id: request.operation_id })).toMatchObject({ ok: false, code: "unknown_operation" });
  } finally { await db.close(); }
});
