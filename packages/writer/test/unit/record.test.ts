import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createSpend } from "@rbw/spend";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_KEY_VARIABLE } from "../../src/config.ts";
import { runRecord } from "../../src/record.ts";
import { createReplayFetch } from "../../src/recording.ts";
import {
  CALL_WORST_CASE_MICROUSD,
  CONTEXT,
  EXCLUDED_IDENTIFIERS,
  CANDIDATE,
  cardSource,
  symptom,
} from "../fixtures/cases.ts";
import { POOL, SLOT, committedRecordings, freshSpend, openDb, rateSheetBytes, spyFetch } from "../support.ts";

const SYNTHETIC_KEY = "synthetic-writer-key-value";
const SYNTHETIC_URL = "postgres://synthetic-user:synthetic-secret@db.example.invalid:5432/synthetic";

let dir: string;
let db: PGlite;
let schema: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "synthetic-record-"));
  db = await openDb();
  schema = (await freshSpend(db, 1_000_000, "public_record")).schema;
  await writeFile(join(dir, "context.json"), JSON.stringify(CONTEXT));
  await writeFile(join(dir, "rates.json"), rateSheetBytes());
  await writeFile(
    join(dir, "inputs.json"),
    JSON.stringify({
      candidate: CANDIDATE,
      card: cardSource("valid"),
      issue: { symptom: symptom("valid"), excluded_identifiers: EXCLUDED_IDENTIFIERS },
    }),
  );
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  fetchCalls: number;
  events: string[];
  connected: boolean;
}

async function run(args: string[], env: Record<string, string | undefined>): Promise<Run> {
  const events: string[] = [];
  const fetchSpy = spyFetch(createReplayFetch(await committedRecordings()), events);
  let out = "";
  let connected = false;
  const code = await runRecord({
    argv: args,
    env,
    fetch: fetchSpy.fetch,
    provenance: "synthetic",
    connect: () => {
      connected = true;
      return Promise.resolve({ spend: createSpend({ client: db, schema }), close: () => Promise.resolve() });
    },
    write: (text) => {
      out += text;
    },
    now: () => new Date("2026-10-05T00:00:00Z"),
  });
  return { code, out, fetchCalls: fetchSpy.calls.length, events, connected };
}

const ENV = { DATABASE_URL: SYNTHETIC_URL, [API_KEY_VARIABLE]: SYNTHETIC_KEY };

function argv(maxCalls: string, pool = POOL): string[] {
  return [
    "--context", join(dir, "context.json"),
    "--rate-sheet", join(dir, "rates.json"),
    "--input", join(dir, "inputs.json"),
    "--out", join(dir, "out"),
    "--slot-key", SLOT,
    "--pool", pool,
    "--max-calls", maxCalls,
  ];
}

describe("the record command", () => {
  it("reads the key from TOKEN_FACTORY_WRITER_KEY", () => {
    expect(API_KEY_VARIABLE).toBe("TOKEN_FACTORY_WRITER_KEY");
  });

  it.each(["3", "0", "1.5", "two"])("refuses --max-calls %s before anything else", async (value) => {
    const result = await run(argv(value), {});
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/--max-calls/);
    expect(result.out).not.toMatch(/TOKEN_FACTORY_WRITER_KEY|DATABASE_URL/);
    expect(result.connected).toBe(false);
  });

  it("refuses a missing --max-calls", async () => {
    const result = await run(argv("2").slice(0, -2), ENV);
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/--max-calls/);
  });

  it("refuses an unset key variable before connecting or reserving", async () => {
    const result = await run(argv("2"), { DATABASE_URL: SYNTHETIC_URL });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("TOKEN_FACTORY_WRITER_KEY is not set");
    expect(result.connected).toBe(false);
    expect(result.fetchCalls).toBe(0);
  });

  it("refuses an unset DATABASE_URL", async () => {
    const result = await run(argv("2"), { [API_KEY_VARIABLE]: SYNTHETIC_KEY });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("DATABASE_URL is not set");
    expect(result.connected).toBe(false);
  });

  it("refuses a missing rate file with unknown_price before any reservation", async () => {
    const result = await run(
      argv("2").map((a) => (a === join(dir, "rates.json") ? join(dir, "missing.json") : a)),
      ENV,
    );
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("unknown_price");
    expect(result.fetchCalls).toBe(0);
  });

  it("runs two calls, each reserved before and settled after, writes recordings and summaries, and frees the slot", async () => {
    const result = await run(argv("2"), ENV);
    expect(result.code, result.out).toBe(0);
    expect(result.fetchCalls).toBe(2);

    const files = (await readdir(join(dir, "out"))).sort();
    expect(files).toEqual([
      "card-1.recording.json",
      "card-1.summary.json",
      "issue-2.recording.json",
      "issue-2.summary.json",
    ]);
    const spend = createSpend({ client: db, schema });
    for (const name of ["card-1", "issue-2"]) {
      const summary = JSON.parse(await readFile(join(dir, "out", `${name}.summary.json`), "utf8")) as Record<
        string,
        unknown
      >;
      expect(summary).toMatchObject({
        status: "completed",
        reserved_microusd: String(CALL_WORST_CASE_MICROUSD),
        prompt_tokens: 1200,
        completion_tokens: 300,
        prompt_within_bound: true,
      });
      expect(Number(summary.input_token_bound)).toBeGreaterThan(1200);
      const status = await spend.operationStatus({ operation_id: String(summary.operation_id) });
      expect(status).toMatchObject({ ok: true, state: "reconciled" });
      const recording = JSON.parse(await readFile(join(dir, "out", `${name}.recording.json`), "utf8")) as {
        request: { body: { chat_template_kwargs: unknown } };
      };
      expect(recording.request.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    }
    const issueSummary = await readFile(join(dir, "out", "issue-2.summary.json"), "utf8");
    expect(JSON.parse(issueSummary)).toMatchObject({ check_report: { status: "ready_for_review" } });

    const slot = await spend.slotStatus({ slot_key: SLOT });
    expect(slot).toMatchObject({ ok: true, holder: null });

    const everything = [result.out, ...(await Promise.all(files.map((f) => readFile(join(dir, "out", f), "utf8"))))].join("\n");
    for (const secret of [SYNTHETIC_KEY, "synthetic-secret", "db.example.invalid", "synthetic-user"]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toMatch(/authorization|bearer/i);
  });

  it("stops after one call with --max-calls 1", async () => {
    const result = await run(argv("1"), ENV);
    expect(result.code, result.out).toBe(0);
    expect(result.fetchCalls).toBe(1);
  });

  it("refuses before any call when the pool is insufficient, and leaves nothing to reconcile", async () => {
    const small = await createSpend({ client: db, schema }).createPool({
      pool_key: "synthetic-small",
      cap_microusd: CALL_WORST_CASE_MICROUSD - 1,
      allocations: [],
      actor_role: "owner",
      reason: "synthetic small pool",
    });
    expect(small.ok).toBe(true);
    const result = await run(argv("2", "synthetic-small"), ENV);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("insufficient_funds");
    expect(result.fetchCalls).toBe(0);
    const slot = await createSpend({ client: db, schema }).slotStatus({ slot_key: SLOT });
    expect(slot).toMatchObject({ ok: true, holder: null });
  });

  it("releases the slot after an unexpected error when nothing blocks it", async () => {
    const blocked = argv("2").map((a) => (a === join(dir, "out") ? join(dir, "context.json", "out") : a));
    const result = await run(blocked, ENV);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/unexpected error/);
    expect(result.fetchCalls).toBe(0);
    const slot = await createSpend({ client: db, schema }).slotStatus({ slot_key: SLOT });
    expect(slot).toMatchObject({ ok: true, holder: null });
  });

  it("names the operation when the ledger fails after a reservation", async () => {
    let out = "";
    const spend = createSpend({ client: db, schema });
    const code = await runRecord({
      argv: argv("2"),
      env: ENV,
      fetch: createReplayFetch(await committedRecordings()),
      provenance: "synthetic",
      connect: () =>
        Promise.resolve({
          spend: { ...spend, settle: () => Promise.reject(new Error("synthetic connection lost")) },
          close: () => Promise.resolve(),
        }),
      write: (text) => {
        out += text;
      },
      now: () => new Date("2026-10-05T00:00:00Z"),
    });
    expect(code).toBe(1);
    expect(out).toMatch(/operation [0-9a-f]{64} may be unresolved/);
    expect(out).not.toContain("synthetic connection lost");
  });

  it("leaves the slot held and names the operation when a response is lost", async () => {
    let out = "";
    const code = await runRecord({
      argv: argv("2"),
      env: ENV,
      fetch: () => Promise.reject(new TypeError("synthetic connection reset")),
      provenance: "synthetic",
      connect: () => Promise.resolve({ spend: createSpend({ client: db, schema }), close: () => Promise.resolve() }),
      write: (text) => {
        out += text;
      },
      now: () => new Date("2026-10-05T00:00:00Z"),
    });
    expect(code).not.toBe(0);
    expect(out).toMatch(/uncertain/);
    expect(out).toMatch(/[0-9a-f]{64}/);
    const slot = await createSpend({ client: db, schema }).slotStatus({ slot_key: SLOT });
    expect(slot).toMatchObject({ ok: true, holder: CONTEXT.root_execution_id });
  });
});
