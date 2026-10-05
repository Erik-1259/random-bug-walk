import { randomBytes } from "node:crypto";
import { createSpend, fromPg, migrate } from "@rbw/spend";
import type { Spend } from "@rbw/spend";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSearcher, createTavilyClient, parseRateSheet } from "../../src/index.ts";
import type { Searcher } from "../../src/index.ts";
import { CONTEXT, RATE_ENTRIES, ROOT, SEARCH_INPUT, SETTINGS, SYNTHETIC_KEY, loadRecordings } from "../support/fixtures.ts";
import { startReplayServer } from "../support/replay-server.ts";
import type { ReplayServer } from "../support/replay-server.ts";
import { recorded } from "../support/assert.ts";

// Needs a real Postgres. `run.ts` skips the suite when DATABASE_URL is unset.
const SCHEMA = `synthetic_search_it_${randomBytes(6).toString("hex")}`;
const POOL = `synthetic-pool-${randomBytes(4).toString("hex")}`;
const SLOT = `synthetic-slot-${randomBytes(4).toString("hex")}`;

let client: pg.Client;
let spend: Spend;
let server: ReplayServer;

function searcherFor(base: string, pool: string): Searcher {
  return createSearcher({
    client: createTavilyClient({ apiKey: SYNTHETIC_KEY, apiBaseURL: base }),
    spend,
    context: CONTEXT,
    rates: parseRateSheet(JSON.stringify(RATE_ENTRIES)),
    poolKey: pool,
    slotKey: SLOT,
    settings: SETTINGS,
    excludedIdentifiers: [],
  });
}

async function createPool(key: string, cap: number): Promise<void> {
  const result = await spend.createPool({ pool_key: key, cap_microusd: cap, allocations: [], actor_role: "owner", reason: "synthetic integration pool" });
  if (!result.ok) {
    throw new Error(`pool refused: ${result.code}`);
  }
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (url === undefined) {
    throw new Error("DATABASE_URL is not set");
  }
  client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await migrate(fromPg(client), { schema: SCHEMA });
  spend = createSpend({ client: fromPg(client), schema: SCHEMA });
  await createPool(POOL, 1_000_000);
  await spend.createSlotKey({ slot_key: SLOT, actor_role: "owner", reason: "synthetic integration slot" });
  await spend.acquireSlot({ slot_key: SLOT, root_execution_id: ROOT, actor_role: "workflow" });
  server = await startReplayServer({
    recordings: loadRecordings(["source-1.ok", "phrase-1.500", "phrase-2.zero-results"]),
  });
});

afterAll(async () => {
  try {
    await server.close();
  } finally {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await client.end();
    }
  }
});

describe("search against a real Postgres", () => {
  it("reserves and settles one replayed source search", async () => {
    const result = recorded(await searcherFor(server.baseURL, POOL).searchSource("source-1", SEARCH_INPUT));
    expect(result.record.outcome).toBe("complete");
    const status = await spend.operationStatus({ operation_id: result.record.operation_id });
    expect(status).toMatchObject({ ok: true, state: "reconciled", reserved_microusd: 16_000n, settled_microusd: 8_000n });
  });

  it("gives incomplete, not no_public_match, for a forced 500 on a phrase check, with the operation terminal and its usage unknown", async () => {
    const result = recorded(await searcherFor(server.baseURL, POOL).checkPhrase("phrase-1", SEARCH_INPUT));
    expect(result.record).toMatchObject({ outcome: "incomplete", reason: "provider_error" });
    const status = await spend.operationStatus({ operation_id: result.record.operation_id });
    expect(status).toMatchObject({ ok: true, state: "terminal", settled_microusd: 0n, open_microusd: 16_000n });
    const row = await client.query(
      `SELECT terminal_status FROM ${SCHEMA}.operation_events WHERE operation_id = $1 AND cause = 'transition' AND to_state = 'terminal'`,
      [result.record.operation_id],
    );
    expect(row.rows[0]).toEqual({ terminal_status: "failed" });
  });

  it("refuses an insufficient pool with no request", async () => {
    const small = `synthetic-small-${randomBytes(4).toString("hex")}`;
    await createPool(small, 1);
    const before = server.requests.length;
    const result = recorded(await searcherFor(server.baseURL, small).checkPhrase("phrase-2", SEARCH_INPUT));
    expect(result.record).toMatchObject({ outcome: "incomplete", reason: "spend_refused:insufficient_funds" });
    expect(server.requests.length).toBe(before);
  });
});
