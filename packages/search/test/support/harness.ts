import { PGlite } from "@electric-sql/pglite";
import { createSpend, migrate } from "@rbw/spend";
import type { Spend } from "@rbw/spend";
import { createTavilyClient, createSearcher, parseRateSheet } from "../../src/index.ts";
import type { RecordStore, SearchSettings, Searcher } from "../../src/index.ts";
import { startReplayServer } from "./replay-server.ts";
import type { Fault, LoggedRequest, ReplayServer } from "./replay-server.ts";
import {
  CONTEXT,
  EXCLUDED_IDENTIFIERS,
  POOL,
  RATE_ENTRIES,
  ROOT,
  SETTINGS,
  SLOT,
  SYNTHETIC_KEY,
  loadRecordings,
} from "./fixtures.ts";

let schemaCounter = 0;
const sharedDb = PGlite.create();

export interface World {
  db: PGlite;
  schema: string;
  /** The spend API with every call logged into `log`. */
  spend: Spend;
  rawSpend: Spend;
  server: ReplayServer;
  searcher: Searcher;
  /** Ordered log of spend calls and server requests. */
  log: string[];
  close(): Promise<void>;
}

export interface WorldOptions {
  recordings: string[];
  cap?: number;
  fault?: (request: LoggedRequest) => Fault | undefined;
  settings?: SearchSettings;
  excludedIdentifiers?: string[];
  store?: RecordStore;
  holdSlot?: boolean;
  apiKey?: string;
}

export async function makeWorld(options: WorldOptions): Promise<World> {
  const db = await sharedDb;
  schemaCounter += 1;
  const schema = `synthetic_search_${String(schemaCounter)}`;
  await db.exec(`CREATE SCHEMA ${schema}`);
  await migrate(db, { schema });
  const rawSpend = createSpend({ client: db, schema });
  const pool = await rawSpend.createPool({
    pool_key: POOL,
    cap_microusd: options.cap ?? 1_000_000,
    allocations: [],
    actor_role: "owner",
    reason: "synthetic test pool",
  });
  if (!pool.ok) {
    throw new Error(`pool setup refused: ${pool.code}`);
  }
  await rawSpend.createSlotKey({ slot_key: SLOT, actor_role: "owner", reason: "synthetic test slot" });
  if (options.holdSlot !== false) {
    await rawSpend.acquireSlot({ slot_key: SLOT, root_execution_id: ROOT, actor_role: "workflow" });
  }

  const log: string[] = [];
  const spend: Spend = {
    ...rawSpend,
    slotStatus: (r) => {
      log.push("slotStatus");
      return rawSpend.slotStatus(r);
    },
    reserve: (r) => {
      log.push("reserve");
      return rawSpend.reserve(r);
    },
    transition: (r) => {
      log.push(`transition:${r.to_state}`);
      return rawSpend.transition(r);
    },
    settle: (r) => {
      log.push("settle");
      return rawSpend.settle(r);
    },
  };
  const server = await startReplayServer({
    recordings: loadRecordings(options.recordings),
    onRequest: (request) => log.push(`request:${request.endpoint}`),
    ...(options.fault === undefined ? {} : { fault: options.fault }),
  });
  const client = createTavilyClient({ apiKey: options.apiKey ?? SYNTHETIC_KEY, apiBaseURL: server.baseURL });
  const searcher = createSearcher({
    client,
    spend,
    context: CONTEXT,
    rates: parseRateSheet(JSON.stringify(RATE_ENTRIES)),
    poolKey: POOL,
    slotKey: SLOT,
    settings: options.settings ?? SETTINGS,
    excludedIdentifiers: options.excludedIdentifiers ?? EXCLUDED_IDENTIFIERS,
    ...(options.store === undefined ? {} : { store: options.store }),
  });
  return {
    db,
    schema,
    spend,
    rawSpend,
    server,
    searcher,
    log,
    close: async () => {
      await server.close();
      await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    },
  };
}
