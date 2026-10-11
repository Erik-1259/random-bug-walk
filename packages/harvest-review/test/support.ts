import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createSpend, migrate } from "@rbw/spend";
import type { ReserveRequest, Spend } from "@rbw/spend";
import { createReplayFetch, loadRecordings } from "@rbw/writer";
import type { FetchFunction, Recording } from "@rbw/writer";
import { parseReviewInputs } from "../src/inputs.ts";
import type { ReviewInputs } from "../src/inputs.ts";
import type { ReviewOptions } from "../src/review.ts";

export const HARVEST_RUN = fileURLToPath(new URL("../../harvest/test/fixtures/synthetic-run/", import.meta.url));
export const SYNTHETIC_INPUTS = fileURLToPath(new URL("./fixtures/synthetic-inputs.json", import.meta.url));
export const RECORDINGS_DIR = fileURLToPath(new URL("./fixtures/recordings/", import.meta.url));
export const RATES = fileURLToPath(new URL("../rates.json", import.meta.url));

export const SLOT = "development";
export const POOL = "development";
export const ENV = { DATABASE_URL: "postgres://synthetic.example.invalid/synthetic", TOKEN_FACTORY_REVIEW_KEY: "synthetic-review-key" };

export function syntheticInputs(): ReviewInputs {
  return parseReviewInputs(JSON.parse(readFileSync(SYNTHETIC_INPUTS, "utf8")));
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "synthetic-harvest-review-"));
}

let schemaCounter = 0;

/** A fresh spend schema with the migrations' pools and the development slot key. */
export async function freshSpend(db: PGlite): Promise<Spend> {
  schemaCounter += 1;
  const schema = `synthetic_review_${String(process.pid)}_${String(schemaCounter)}`;
  await db.exec(`CREATE SCHEMA ${schema}`);
  await migrate(db, { schema });
  const spend = createSpend({ client: db, schema });
  const slot = await spend.createSlotKey({ slot_key: SLOT, actor_role: "owner", reason: "synthetic test slot" });
  if (!slot.ok) {
    throw new Error("could not create the synthetic slot key");
  }
  return spend;
}

export async function openDb(): Promise<PGlite> {
  return PGlite.create();
}

let cached: Recording[] | undefined;

export async function committedRecordings(): Promise<Recording[]> {
  cached ??= await loadRecordings(RECORDINGS_DIR);
  return cached;
}

export interface Spy {
  spend: Spend;
  reserves: ReserveRequest[];
}

export function spySpend(spend: Spend): Spy {
  const spy: Spy = { spend, reserves: [] };
  spy.spend = {
    ...spend,
    reserve: (request) => {
      spy.reserves.push(request);
      return spend.reserve(request);
    },
  };
  return spy;
}

export interface FetchSpy {
  fetch: FetchFunction;
  bodies: Record<string, unknown>[];
}

export function spyFetch(inner: FetchFunction): FetchSpy {
  const spy: FetchSpy = {
    bodies: [],
    fetch: (input, init) => {
      spy.bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
      return inner(input, init);
    },
  };
  return spy;
}

export async function replayFetch(): Promise<FetchFunction> {
  return createReplayFetch(await committedRecordings());
}

/** Command options over the given ledger and fetch, collecting stdout. */
export function commandOptions(argv: string[], spend: Spend, fetch: FetchFunction, output: string[]): ReviewOptions {
  return {
    argv,
    env: ENV,
    fetch,
    provenance: "synthetic",
    connect: () => Promise.resolve({ spend, close: () => Promise.resolve() }),
    write: (text) => output.push(text),
    now: () => new Date("2026-10-07T00:00:00Z"),
  };
}
