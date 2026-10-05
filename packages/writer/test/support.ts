import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createSpend, migrate } from "@rbw/spend";
import type { Spend } from "@rbw/spend";
import type { FetchFunction } from "../src/http.ts";
import { createReplayFetch, loadRecordings } from "../src/recording.ts";
import type { Recording } from "../src/recording.ts";
import { createWriter, createWriterProvider } from "../src/writer.ts";
import type { Writer } from "../src/writer.ts";
import { CONTEXT, RATE_ENTRIES } from "./fixtures/cases.ts";

export const POOL = "synthetic-pool";
export const SLOT = "synthetic-slot";
export const RECORDINGS_DIR = fileURLToPath(new URL("./fixtures/recordings/", import.meta.url));

export function rateSheetBytes(entries: unknown = RATE_ENTRIES): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(entries, null, 2)}\n`);
}

export async function openDb(dataDir?: string): Promise<PGlite> {
  return dataDir === undefined ? PGlite.create() : PGlite.create(dataDir);
}

let schemaCounter = 0;

/** Applies the spend migrations into a new schema and creates the synthetic pool and slot key. */
export async function freshSpend(db: PGlite, cap = 1_000_000, schema?: string): Promise<{ spend: Spend; schema: string }> {
  schemaCounter += 1;
  const name = schema ?? `synthetic_writer_${String(process.pid)}_${String(schemaCounter)}`;
  await db.exec(`CREATE SCHEMA ${name}`);
  await migrate(db, { schema: name });
  const spend = createSpend({ client: db, schema: name });
  const pool = await spend.createPool({
    pool_key: POOL,
    cap_microusd: cap,
    allocations: [],
    actor_role: "owner",
    reason: "synthetic test pool",
  });
  const slot = await spend.createSlotKey({ slot_key: SLOT, actor_role: "owner", reason: "synthetic test slot" });
  if (!pool.ok || !slot.ok) {
    throw new Error("could not create the synthetic pool or slot key");
  }
  return { spend, schema: name };
}

export async function acquire(spend: Spend): Promise<void> {
  const hold = await spend.acquireSlot({
    slot_key: SLOT,
    root_execution_id: CONTEXT.root_execution_id,
    actor_role: "workflow",
  });
  if (!hold.ok) {
    throw new Error(`could not acquire the synthetic slot: ${hold.code}`);
  }
}

/** Records the order of spend writes and HTTP requests in one shared list. */
export function spySpend(spend: Spend, events: string[]): Spend {
  return {
    ...spend,
    reserve: (request) => {
      events.push("reserve");
      return spend.reserve(request);
    },
    transition: (request) => {
      events.push(`transition:${request.to_state}`);
      return spend.transition(request);
    },
    settle: (settlement) => {
      events.push("settle");
      return spend.settle(settlement);
    },
  };
}

export interface FetchSpy {
  fetch: FetchFunction;
  calls: { url: string; body: string; headers: Record<string, string> }[];
}

export function spyFetch(inner: FetchFunction, events: string[]): FetchSpy {
  const calls: FetchSpy["calls"] = [];
  const fetch: FetchFunction = async (input, init) => {
    events.push("fetch");
    const url = input instanceof Request ? input.url : String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return inner(input, init);
  };
  return { fetch, calls };
}

let cachedRecordings: Recording[] | undefined;

export async function committedRecordings(): Promise<Recording[]> {
  cachedRecordings ??= await loadRecordings(RECORDINGS_DIR);
  return cachedRecordings;
}

export interface Rig {
  schema: string;
  spend: Spend;
  rawSpend: Spend;
  events: string[];
  fetchSpy: FetchSpy;
  writer: Writer;
}

export interface RigOptions {
  cap?: number;
  rateSheet?: Uint8Array;
  fetch?: FetchFunction;
  extraRecordings?: Recording[];
  acquireSlot?: boolean;
  apiKey?: string;
  /** Reuse a ledger instead of creating a fresh schema. */
  existing?: { spend: Spend; schema: string };
}

/** A writer over a fresh spend schema, the committed recordings, and spies on both. */
export async function rig(db: PGlite, options: RigOptions = {}): Promise<Rig> {
  const { spend: rawSpend, schema } = options.existing ?? (await freshSpend(db, options.cap));
  if (options.acquireSlot ?? true) {
    await acquire(rawSpend);
  }
  const events: string[] = [];
  const replay = createReplayFetch([...(await committedRecordings()), ...(options.extraRecordings ?? [])]);
  const fetchSpy = spyFetch(options.fetch ?? replay, events);
  const spend = spySpend(rawSpend, events);
  const writer = createWriter({
    spend,
    provider: createWriterProvider({
      fetch: fetchSpy.fetch,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    }),
    context: CONTEXT,
    poolKey: POOL,
    allocationKey: null,
    slotKey: SLOT,
    rateSheet: options.rateSheet ?? rateSheetBytes(),
  });
  return { schema, spend, rawSpend, events, fetchSpy, writer };
}

/** Number of operations in the ledger, read through the operations table of the schema. */
export async function operationCount(db: PGlite, schema: string): Promise<number> {
  const rows = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${schema}.operations`);
  return rows.rows[0]?.n ?? -1;
}
