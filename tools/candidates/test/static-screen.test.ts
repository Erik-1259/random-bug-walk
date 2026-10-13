// End to end over @rbw/screen with fakes for the model and the ledger: a scripted fetch answers
// the model calls, and an in-memory PGlite holds the spend. No network, no real database, no money.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { createSpend, migrate } from "@rbw/spend";
import type { Spend } from "@rbw/spend";
import type { FetchFunction } from "@rbw/writer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStaticScreen } from "../src/static-screen.ts";
import type { ScreenJob } from "../src/types.ts";

const RATES = fileURLToPath(new URL("../../../packages/screen/rates.json", import.meta.url));

const CLEAN = [
  "export function total(rows: number[]): number {",
  "  const sum = rows.reduce((a, b) => a + b, 0);",
  '  const label = "total";',
  "  const note = label.toUpperCase();",
  "  void note;",
  "  return Math.round(sum);",
  "}",
  "",
].join("\n");

const PLANTED = CLEAN.replace("  return Math.round(sum);", "  return sum;");

interface Answer {
  file: string;
  start_line: number;
  end_line: number;
  fixed_code: string;
  reason: string;
}

const LOCATED: Answer = { file: "src/x.ts", start_line: 6, end_line: 6, fixed_code: "  return Math.round(sum);", reason: "synthetic: the total is not rounded" };
const MISS: Answer = { file: "src/x.ts", start_line: 2, end_line: 2, fixed_code: "  const sum = rows.reduce((a, b) => a + b, 1);", reason: "synthetic: a far miss" };

/** A fetch that answers each model call from a script in call order, in Token Factory's shape. */
function scriptedFetch(script: readonly Answer[]): FetchFunction {
  const queue = [...script];
  return () => {
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error("the script has no answer for this call"));
    }
    const body = JSON.stringify({
      id: "synthetic",
      object: "chat.completion",
      created: 1_767_225_600,
      model: "nvidia/nemotron-3-super-120b-a12b",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(next) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 800, completion_tokens: 40, total_tokens: 840 },
    });
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
  };
}

function plantedTree(): string {
  const root = mkdtempSync(join(tmpdir(), "rbw-candidates-screen-tree-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "x.ts"), PLANTED);
  return root;
}

let db: PGlite;
beforeAll(async () => {
  db = await PGlite.create();
});
afterAll(async () => {
  await db.close();
});

let counter = 0;
async function freshSpend(): Promise<Spend> {
  counter += 1;
  const schema = `candidates_screen_${String(process.pid)}_${String(counter)}`;
  await db.exec(`CREATE SCHEMA ${schema}`);
  await migrate(db, { schema });
  const spend = createSpend({ client: db, schema });
  const slot = await spend.createSlotKey({ slot_key: "development", actor_role: "owner", reason: "synthetic test slot" });
  if (!slot.ok) {
    throw new Error("could not create the synthetic slot");
  }
  return spend;
}

function job(): ScreenJob {
  return {
    plantedTree: plantedTree(),
    targetPath: "src/x.ts",
    cleanText: CLEAN,
    symptom: { text: "Under load, a total shown to the user is sometimes off by a fraction." },
    budget: { maxAttempts: 2, maxCostMicrousd: 1_000_000 },
    model: "super",
  };
}

async function screenWith(script: readonly Answer[]) {
  const spend = await freshSpend();
  return makeStaticScreen({
    fetch: scriptedFetch(script),
    connect: () => Promise.resolve({ spend, close: () => Promise.resolve() }),
    env: { DATABASE_URL: "postgres://synthetic.invalid/x", TOKEN_FACTORY_SCREEN_KEY: "synthetic-key" },
    rateSheet: readFileSync(RATES),
    slotKey: "development",
    pool: "development",
    provenance: "synthetic",
    now: () => new Date("2026-10-13T12:00:00.000Z"),
  });
}

describe("the real screen over @rbw/screen with a fake model and ledger", () => {
  it("returns not_located when no attempt finds the planted change", async () => {
    const screen = await screenWith([MISS, MISS]);
    const result = await screen(job());
    expect(result).toMatchObject({ verdict: "not_located", hits: 0, attempts: 2 });
    expect(result.costMicrousd).toBeGreaterThan(0);
  });

  it("returns located when an attempt finds and fixes the planted change", async () => {
    const screen = await screenWith([MISS, LOCATED]);
    const result = await screen(job());
    expect(result.verdict).toBe("located");
    expect(result.hits).toBeGreaterThanOrEqual(1);
    expect(result.costMicrousd).toBeGreaterThan(0);
  });

  it("throws when the run does not fit the budget, so the pipeline charges the whole budget", async () => {
    const spend = await freshSpend();
    const screen = makeStaticScreen({
      fetch: scriptedFetch([MISS]),
      connect: () => Promise.resolve({ spend, close: () => Promise.resolve() }),
      env: { DATABASE_URL: "postgres://synthetic.invalid/x", TOKEN_FACTORY_SCREEN_KEY: "synthetic-key" },
      rateSheet: readFileSync(RATES),
      slotKey: "development",
      pool: "development",
      provenance: "synthetic",
    });
    // One micro-USD cannot fit even one worst-case Super call.
    await expect(screen({ ...job(), budget: { maxAttempts: 1, maxCostMicrousd: 1 } })).rejects.toThrow();
  });
});
