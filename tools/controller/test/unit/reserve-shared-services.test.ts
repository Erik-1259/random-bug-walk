import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRecord } from "@rbw/schema";
import { SHARED_SERVICE_LINES, reserveSharedServices, sharedServicesRequest } from "../../scripts/reserve-shared-services.ts";
import { FakeClock } from "../../../local-runner/test/support/fakes.ts";
import { pgliteLedger } from "../support/harness.ts";

const RELEASE = parseRecord("Release", readFileSync(fileURLToPath(new URL("../../../release/fixtures/release/repository/releases/00000000-0000-4000-8000-000000000601/release.json", import.meta.url))));

describe("the shared-service reservation", () => {
  it("reserves every priced line once on judge-demo/judge, and a second run returns the same reservation", async () => {
    const ledger = await pgliteLedger(new FakeClock());
    try {
      const first = await reserveSharedServices(ledger.spend, RELEASE);
      const request = sharedServicesRequest(RELEASE);
      expect(first).toMatch(new RegExp(`^shared_services operation=${request.operation_id} reserved=\\d+ replay=false`));
      const second = await reserveSharedServices(ledger.spend, RELEASE);
      expect(second).toContain("replay=true");
      const status = await ledger.spend.operationStatus({ operation_id: request.operation_id });
      if (!status.ok) throw new Error("synthetic: no operation");
      const expected = SHARED_SERVICE_LINES.reduce((sum, line) => sum + (BigInt(line.limit) * BigInt(line.price?.microusd ?? 0) + BigInt(line.price?.per_units ?? 1) - 1n) / BigInt(line.price?.per_units ?? 1), 0n);
      expect(status.reserved_microusd).toBe(expected);
      expect(status.allocation_key).toBe("judge");
      const pool = await ledger.spend.poolStatus({ pool_key: "judge-demo" });
      if (!pool.ok) throw new Error("synthetic: no pool");
      expect(pool.allocations.find((item) => item.allocation_key === "public")?.committed_microusd).toBe(0n);
    } finally {
      await ledger.close();
    }
  });

  it("names each line's price source", () => {
    for (const line of SHARED_SERVICE_LINES) expect(line.source_url).toMatch(/^https:\/\/vercel\.com\/docs\//);
  });
});
