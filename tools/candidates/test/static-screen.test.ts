// End to end over @rbw/screen with fakes for the model and the ledger: a scripted fetch answers
// the model calls, and an in-memory PGlite holds the spend. No network, no real database, no money.
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { executeScreen } from "@rbw/screen";
import { createSpend, migrate } from "@rbw/spend";
import type { Spend } from "@rbw/spend";
import type { FetchFunction } from "@rbw/writer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScreenStopError } from "../src/pipeline.ts";
import { makeStaticScreen, type StaticScreenDeps } from "../src/static-screen.ts";
import type { Screen, ScreenJob } from "../src/types.ts";

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
/** A reply whose content is not an answer at all: the call settles, but it counts as no answer. */
const GARBAGE = "not an answer";
/** A located answer whose reply reports prompt tokens far above the counted bound. */
const LOCATED_OVER_BOUND = { overBound: LOCATED } as const;

type Scripted = Answer | typeof GARBAGE | typeof LOCATED_OVER_BOUND;

/**
 * A fetch that answers each model call from a script in call order, in Token Factory's shape. A call
 * past the end of the script rejects, which the writer treats as a lost response (an uncertain call).
 */
function scriptedFetch(script: readonly Scripted[]): FetchFunction {
  const queue = [...script];
  return () => {
    const entry = queue.shift();
    if (entry === undefined) {
      return Promise.reject(new Error("the script has no answer for this call"));
    }
    const overBound = typeof entry === "object" && "overBound" in entry;
    const next = overBound ? entry.overBound : entry;
    const promptTokens = overBound ? 10_000_000 : 800;
    const body = JSON.stringify({
      id: "synthetic",
      object: "chat.completion",
      created: 1_767_225_600,
      model: "nvidia/nemotron-3-super-120b-a12b",
      choices: [{ index: 0, message: { role: "assistant", content: next === GARBAGE ? next : JSON.stringify(next) }, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 40, total_tokens: promptTokens + 40 },
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

/**
 * The real screen, failing only at two hits, so a located answer can be followed by a call that ends
 * the run without a verdict.
 */
const failAtTwoHits: typeof executeScreen = (options, run) => executeScreen(options, { ...run, failAtHits: 2 });

/** Runs a screen and returns its result or the error it threw. */
async function settle(screen: Screen, screenJob: ScreenJob): Promise<unknown> {
  try {
    return await screen(screenJob);
  } catch (error) {
    return error;
  }
}

const ENV = { DATABASE_URL: "postgres://synthetic.invalid/x", TOKEN_FACTORY_SCREEN_KEY: "synthetic-key" };

/** A screen over a fresh ledger whose working files go to a fresh directory the test can inspect. */
async function screenWith(script: readonly Scripted[], overrides: Partial<StaticScreenDeps> = {}) {
  const spend = await freshSpend();
  const outBase = mkdtempSync(join(tmpdir(), "rbw-candidates-screen-out-"));
  const screen = makeStaticScreen({
    fetch: scriptedFetch(script),
    connect: () => Promise.resolve({ spend, close: () => Promise.resolve() }),
    env: ENV,
    rateSheet: readFileSync(RATES),
    slotKey: "development",
    pool: "development",
    provenance: "synthetic",
    now: () => new Date("2026-10-13T12:00:00.000Z"),
    outBase,
    ...overrides,
  });
  return { screen, outBase, spend };
}

describe("the real screen over @rbw/screen with a fake model and ledger", () => {
  it("returns not_located when no attempt finds the planted change, and removes its working files", async () => {
    const { screen, outBase } = await screenWith([MISS, MISS]);
    const result = await screen(job());
    expect(result).toMatchObject({ verdict: "not_located", hits: 0, attempts: 2 });
    expect(result.costMicrousd).toBeGreaterThan(0);
    // The model's answers and the call recordings can echo host source; none is left behind.
    expect(readdirSync(outBase)).toEqual([]);
  });

  it("returns located when an attempt finds and fixes the planted change", async () => {
    const { screen } = await screenWith([MISS, LOCATED]);
    const result = await screen(job());
    expect(result.verdict).toBe("located");
    expect(result.hits).toBeGreaterThanOrEqual(1);
    expect(result.costMicrousd).toBeGreaterThan(0);
  });

  it("returns inconclusive, not a survivor, when an attempt gave no answer", async () => {
    const { screen } = await screenWith([MISS, GARBAGE]);
    const result = await screen(job());
    expect(result).toMatchObject({ verdict: "inconclusive", hits: 0, attempts: 2 });
  });

  it("keeps its working files when asked", async () => {
    const { screen, outBase } = await screenWith([MISS, MISS], { keepOutput: true });
    await screen(job());
    expect(readdirSync(outBase)).toHaveLength(1);
  });

  it("stops the run when the run does not fit the budget, charges nothing and removes its working files", async () => {
    const { screen, outBase } = await screenWith([MISS]);
    // One micro-USD cannot fit even one worst-case Super call.
    const error: unknown = await settle(screen, { ...job(), budget: { maxAttempts: 1, maxCostMicrousd: 1 } });
    expect(error).toBeInstanceOf(ScreenStopError);
    expect((error as ScreenStopError).message).toMatch(/did not start: screen: over budget/);
    expect((error as ScreenStopError).chargedMicrousd).toBe(0);
    expect(readdirSync(outBase)).toEqual([]);
  });

  it("stops the run on an uncertain call, charges the whole budget and keeps what is needed to reconcile it", async () => {
    // The second call has no scripted answer, so its response is lost: it may have been billed.
    const { screen, outBase } = await screenWith([MISS]);
    const error: unknown = await settle(screen, job());
    expect(error).toBeInstanceOf(ScreenStopError);
    const stop = error as ScreenStopError;
    expect(stop.chargedMicrousd).toBe(1_000_000);
    expect(stop.message).toMatch(/uncertain/);
    expect(stop.message).toMatch(/root execution [0-9a-f-]{36}/);
    expect(stop.message).toMatch(/operations [0-9a-f-]{36}/);
    const kept = readdirSync(outBase);
    expect(kept).toHaveLength(1);
    expect(stop.message).toContain(join(outBase, kept[0] ?? ""));
  });

  it("stops the run when the slot is still held by an earlier run, with the screen's own reason", async () => {
    const { screen, spend } = await screenWith([MISS]);
    await settle(screen, job());
    // Same ledger, slot still held by the uncertain run above.
    const { screen: second } = await screenWith([MISS, MISS], {
      connect: () => Promise.resolve({ spend, close: () => Promise.resolve() }),
    });
    const error: unknown = await settle(second, job());
    expect(error).toBeInstanceOf(ScreenStopError);
    expect((error as ScreenStopError).message).toMatch(/could not acquire the slot/);
    expect((error as ScreenStopError).chargedMicrousd).toBe(0);
  });

  it("stops the run, charging the whole budget and keeping its files, when the screen itself throws", async () => {
    // A dropped database connection surfaces as an error from close(); the spend state is unknown.
    const spend = await freshSpend();
    const { screen, outBase } = await screenWith([MISS, MISS], {
      connect: () => Promise.resolve({ spend, close: () => Promise.reject(new Error("1 connection error(s)")) }),
    });
    const error: unknown = await settle(screen, job());
    expect(error).toBeInstanceOf(ScreenStopError);
    expect((error as ScreenStopError).message).toMatch(/connection error/);
    expect((error as ScreenStopError).chargedMicrousd).toBe(1_000_000);
    expect(readdirSync(outBase)).toHaveLength(1);
  });

  it("asks the screen to fail at the first hit, so its verdict matches any located answer", async () => {
    const seen: number[] = [];
    const fake: typeof executeScreen = (_options, run) => {
      seen.push(run.failAtHits);
      return Promise.resolve({ code: 1, record: null });
    };
    const { screen } = await screenWith([], { execute: fake });
    await settle(screen, job());
    expect(seen).toEqual([1]);
  });

  it("does not count a located answer from a call whose reported prompt exceeded the counted bound", async () => {
    const { screen } = await screenWith([LOCATED_OVER_BOUND, LOCATED]);
    const result = await screen(job());
    expect(result).toMatchObject({ verdict: "inconclusive", hits: 0, attempts: 1 });
  });

  it("keeps the screen's inconclusive verdict when a call exceeds the counted bound after a located answer", async () => {
    // The screen counts the first answer as a hit, then stops without a verdict on the second call.
    const { screen } = await screenWith([LOCATED, LOCATED_OVER_BOUND], { execute: failAtTwoHits });
    const result = await screen(job());
    expect(result).toMatchObject({ verdict: "inconclusive", hits: 0, attempts: 2 });
  });

  it("keeps the screen's inconclusive verdict when the ledger refuses a later call after a located answer", async () => {
    const spend = await freshSpend();
    let reservations = 0;
    const refusing: Spend = {
      ...spend,
      reserve: (request) => {
        reservations += 1;
        return reservations === 1 ? spend.reserve(request) : Promise.resolve({ ok: false, code: "insufficient_funds", detail: "synthetic refusal" });
      },
    };
    const { screen } = await screenWith([LOCATED, LOCATED], {
      execute: failAtTwoHits,
      connect: () => Promise.resolve({ spend: refusing, close: () => Promise.resolve() }),
    });
    const result = await screen(job());
    expect(result).toMatchObject({ verdict: "inconclusive", hits: 0, attempts: 1 });
  });
});
