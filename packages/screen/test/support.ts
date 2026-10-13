import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createSpend, migrate } from "@rbw/spend";
import type { ReserveRequest, Spend } from "@rbw/spend";
import type { FetchFunction } from "@rbw/writer";
import type { ScreenOptions } from "../src/screen.ts";
import { CLEAN_REPORT, FORMAT, PLANTED_REPORT } from "./fixtures/synthetic-source.ts";

export const SYNTHETIC_INPUT = fileURLToPath(new URL("./fixtures/synthetic-input.json", import.meta.url));
export const RATES = fileURLToPath(new URL("../rates.json", import.meta.url));
export const README = fileURLToPath(new URL("../README.md", import.meta.url));

export const SLOT = "development";
export const POOL = "development";
export const ENV = { DATABASE_URL: "postgres://synthetic.example.invalid/synthetic", TOKEN_FACTORY_SCREEN_KEY: "synthetic-screen-key" };

/** The planted line of the synthetic report. */
export const PLANTED_LINE = 12;

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "synthetic-screen-"));
}

export interface Tree {
  root: string;
  tree: string;
  clean: string;
  input: string;
}

/** A fresh planted tree, the clean copy of the planted file beside it, and the input file. */
export function syntheticTree(inputOverrides: Record<string, unknown> = {}): Tree {
  const root = tempDir();
  const tree = join(root, "tree");
  mkdirSync(join(tree, "src"), { recursive: true });
  writeFileSync(join(tree, "src", "report.ts"), PLANTED_REPORT);
  writeFileSync(join(tree, "src", "format.ts"), FORMAT);
  const clean = join(root, "clean-report.ts");
  writeFileSync(clean, CLEAN_REPORT);
  const input = join(root, "screen-input.json");
  const base = JSON.parse(readFileSync(SYNTHETIC_INPUT, "utf8")) as Record<string, unknown>;
  writeFileSync(input, `${JSON.stringify({ ...base, ...inputOverrides }, null, 2)}\n`);
  return { root, tree, clean, input };
}

let schemaCounter = 0;

/** A fresh spend schema with the migrations' pools and the development slot key. */
export async function freshSpend(db: PGlite): Promise<Spend> {
  schemaCounter += 1;
  const schema = `synthetic_screen_${String(process.pid)}_${String(schemaCounter)}`;
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

/** Command options over the given ledger and fetch, collecting stdout. */
export function commandOptions(argv: string[], spend: Spend, fetch: FetchFunction, output: string[], env: Record<string, string | undefined> = ENV): ScreenOptions {
  return {
    argv,
    env,
    fetch,
    provenance: "synthetic",
    connect: () => Promise.resolve({ spend, close: () => Promise.resolve() }),
    write: (text) => output.push(text),
    now: () => new Date("2026-10-13T12:00:00Z"),
  };
}

export const noNetwork: FetchFunction = () => Promise.reject(new Error("no network in this test"));
