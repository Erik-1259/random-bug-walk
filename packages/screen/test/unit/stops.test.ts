// The run's stop paths and its refusals before a database connect: a spend refusal, a prompt over the
// input bound, a ledger refusal after launch, an unexpected error, and the checks on DATABASE_URL,
// --out and the connect itself.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { Spend } from "@rbw/spend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "../../src/commands.ts";
import { ScreenRecordSchema } from "../../src/record.ts";
import type { StaticProbe } from "../../src/record.ts";
import { LOCATED_AND_FIXED, MISS, scriptedFetch } from "../fixtures/scripted.ts";
import { commandOptions, ENV, freshSpend, noNetwork, openDb, POOL, RATES, SLOT, spySpend, syntheticTree, tempDir } from "../support.ts";
import type { Tree } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

function args(tree: Tree, out: string, attempts: number, pool = POOL): string[] {
  return [
    "run",
    "--input",
    tree.input,
    "--tree",
    tree.tree,
    "--clean",
    tree.clean,
    "--rate-sheet",
    RATES,
    "--attempts",
    String(attempts),
    "--budget-microusd",
    "1000000",
    "--out",
    out,
    "--slot-key",
    SLOT,
    "--pool",
    pool,
  ];
}

function probeOf(out: string): { verdict: string; probe: StaticProbe } {
  const record = ScreenRecordSchema.parse(JSON.parse(readFileSync(join(out, "screen.json"), "utf8")));
  if (typeof record.optional_static_probe === "string") {
    throw new Error("the record has no probe");
  }
  return { verdict: record.verdict, probe: record.optional_static_probe };
}

async function slotHolder(spend: Spend): Promise<string | null> {
  const slot = await spend.slotStatus({ slot_key: SLOT });
  if (!slot.ok) {
    throw new Error("no slot status");
  }
  return slot.holder;
}

describe("stop paths after the slot is held", () => {
  it("stops on a spend refusal, exits 1, writes the record and releases the slot", async () => {
    const base = await freshSpend(db);
    const created = await base.createPool({ pool_key: "synthetic-tiny", cap_microusd: 1_000, allocations: [], actor_role: "owner", reason: "synthetic pool below one reservation" });
    expect(created.ok).toBe(true);
    const spy = spySpend(base);
    const fake = scriptedFetch([MISS, MISS]);
    const out = join(tempDir(), "out");
    const output: string[] = [];
    const code = await runCommand(commandOptions(args(syntheticTree(), out, 2, "synthetic-tiny"), spy.spend, fake.fetch, output));
    expect(code).toBe(1);
    expect(fake.bodies).toHaveLength(0);
    const { verdict, probe } = probeOf(out);
    expect(verdict).toBe("inconclusive");
    expect(probe.stopped).toMatchObject({ reason: "refused", attempt: 1, detail: "insufficient_funds" });
    expect(probe.attempts_run).toBe(0);
    expect(output.join("")).toContain("screen: refused: insufficient_funds at attempt 1");
    expect(await slotHolder(base)).toBeNull();
  });

  it("stops before reserving when the prompt is over the input bound, with its own reason", async () => {
    const spend = await freshSpend(db);
    const spy = spySpend(spend);
    const tree = syntheticTree();
    // About 300,000 bytes of synthetic source in a shown file: over the 65,536-token counted bound.
    appendFileSync(join(tree.tree, "src", "format.ts"), `// ${"x".repeat(100)}\n`.repeat(3_000));
    const out = join(tempDir(), "out");
    const output: string[] = [];
    const code = await runCommand(commandOptions(args(tree, out, 2), spy.spend, noNetwork, output));
    expect(code).toBe(1);
    expect(spy.reserves).toHaveLength(0);
    const { verdict, probe } = probeOf(out);
    expect(verdict).toBe("inconclusive");
    expect(probe.stopped).toMatchObject({ reason: "prompt_too_large", attempt: 1, detail: "prompt_too_large" });
    expect(await slotHolder(spend)).toBeNull();
  });

  it("stops when the ledger refuses a write after launch", async () => {
    const spend = await freshSpend(db);
    const refusing: Spend = { ...spend, settle: () => Promise.resolve({ ok: false, code: "invalid_request", detail: "synthetic settle refusal" }) };
    const fake = scriptedFetch([MISS, MISS]);
    const out = join(tempDir(), "out");
    const output: string[] = [];
    const code = await runCommand(commandOptions(args(syntheticTree(), out, 2), refusing, fake.fetch, output));
    expect(code).toBe(1);
    expect(fake.bodies).toHaveLength(1);
    const { probe } = probeOf(out);
    expect(probe.stopped).toMatchObject({ reason: "ledger_refusal", attempt: 1, detail: "invalid_request" });
    expect(probe.cost.unsettled_operation_ids).toHaveLength(1);
    expect(output.join("")).toContain("the ledger refused a write after launch (invalid_request)");
  });

  it("stops inconclusive when the reported prompt tokens exceed the counted bound, and does not count its hit", async () => {
    const spend = await freshSpend(db);
    const fake = scriptedFetch([LOCATED_AND_FIXED, LOCATED_AND_FIXED], { prompt_tokens: 10_000_000, completion_tokens: 80 });
    const out = join(tempDir(), "out");
    const output: string[] = [];
    const code = await runCommand(commandOptions([...args(syntheticTree(), out, 2), "--fail-at-hits", "1"], spend, fake.fetch, output));
    expect(code).toBe(1);
    expect(fake.bodies).toHaveLength(1);
    const { verdict, probe } = probeOf(out);
    expect(verdict).toBe("inconclusive");
    expect(probe.stopped).toMatchObject({ reason: "bound_exceeded", attempt: 1, detail: "prompt_tokens_over_bound" });
    expect(probe.attempts).toHaveLength(1);
    expect(probe.attempts[0]).toMatchObject({ prompt_within_bound: false, outcome: "no_answer", miss_kind: null, hit_range: null });
    expect(probe.hits).toBe(0);
    expect(probe.answered).toBe(0);
    const record = ScreenRecordSchema.parse(JSON.parse(readFileSync(join(out, "screen.json"), "utf8")));
    expect(record.static_tells).toEqual([]);
    expect(probe.cost.unsettled_operation_ids).toEqual([]);
    expect(output.join("")).toContain("screen: bound exceeded: reported prompt tokens 10000000 exceed the counted bound");
    expect(await slotHolder(spend)).toBeNull();
  });

  it("lists a reserved operation whose launch was refused as unsettled", async () => {
    const spend = await freshSpend(db);
    const refusing: Spend = { ...spend, transition: () => Promise.resolve({ ok: false, code: "pool_halted", detail: "synthetic halt" }) };
    const fake = scriptedFetch([MISS, MISS]);
    const out = join(tempDir(), "out");
    const output: string[] = [];
    const code = await runCommand(commandOptions(args(syntheticTree(), out, 2), refusing, fake.fetch, output));
    expect(code).toBe(1);
    expect(fake.bodies).toHaveLength(0);
    const { probe } = probeOf(out);
    expect(probe.stopped).toMatchObject({ reason: "refused", attempt: 1, detail: "pool_halted" });
    expect(probe.stopped?.operation_id).toMatch(/.+/);
    expect(probe.cost.unsettled_operation_ids).toEqual([probe.stopped?.operation_id]);
  });

  it("writes an error record and tries the release when the spend throws", async () => {
    const spend = await freshSpend(db);
    let releases = 0;
    const throwing: Spend = {
      ...spend,
      settle: () => Promise.reject(Object.assign(new Error("synthetic settle failure"), { code: "ECONNRESET" })),
      releaseSlot: (request) => {
        releases += 1;
        return spend.releaseSlot(request);
      },
    };
    const fake = scriptedFetch([MISS, MISS]);
    const out = join(tempDir(), "out");
    const output: string[] = [];
    const code = await runCommand(commandOptions(args(syntheticTree(), out, 2), throwing, fake.fetch, output));
    expect(code).toBe(1);
    const { verdict, probe } = probeOf(out);
    expect(verdict).toBe("inconclusive");
    expect(probe.stopped).toMatchObject({ reason: "error", attempt: 1, detail: "Error" });
    expect(probe.stopped?.operation_id).toMatch(/.+/);
    expect(probe.attempts).toHaveLength(0);
    expect(probe.cost.unsettled_operation_ids).toEqual([probe.stopped?.operation_id]);
    expect(releases).toBe(1);
    const text = output.join("");
    expect(text).toContain("screen: stopped on an unexpected error (Error, code ECONNRESET)");
    expect(text).toContain("may be unresolved");
    expect(text).not.toContain("synthetic settle failure");
  });
});

describe("refusals before the database connect", () => {
  it("refuses without DATABASE_URL and never connects", async () => {
    const spy = spySpend(await freshSpend(db));
    let connects = 0;
    const output: string[] = [];
    const options = commandOptions(args(syntheticTree(), join(tempDir(), "out"), 1), spy.spend, noNetwork, output, { TOKEN_FACTORY_SCREEN_KEY: ENV.TOKEN_FACTORY_SCREEN_KEY });
    const code = await runCommand({ ...options, connect: (url) => ((connects += 1), options.connect(url)) });
    expect(code).toBe(1);
    expect(connects).toBe(0);
    expect(spy.reserves).toHaveLength(0);
    expect(output.join("")).toContain("screen: DATABASE_URL is not set");
  });

  it("refuses an --out that already holds a file and leaves the file untouched", async () => {
    const spy = spySpend(await freshSpend(db));
    const out = join(tempDir(), "out");
    mkdirSync(out);
    writeFileSync(join(out, "screen.json"), "earlier record\n");
    let connects = 0;
    const output: string[] = [];
    const options = commandOptions(args(syntheticTree(), out, 1), spy.spend, noNetwork, output);
    const code = await runCommand({ ...options, connect: (url) => ((connects += 1), options.connect(url)) });
    expect(code).toBe(1);
    expect(connects).toBe(0);
    expect(spy.reserves).toHaveLength(0);
    expect(readFileSync(join(out, "screen.json"), "utf8")).toBe("earlier record\n");
    expect(existsSync(join(out, "answers.json"))).toBe(false);
    expect(output.join("")).toContain("screen: --out must be a new or empty directory");
  });

  it("prints only the error code when the connect fails, never its message", async () => {
    const spy = spySpend(await freshSpend(db));
    const out = join(tempDir(), "out");
    const output: string[] = [];
    const options = commandOptions(args(syntheticTree(), out, 1), spy.spend, noNetwork, output);
    const secretUrl = "postgres://synthetic-user:synthetic-password@db.example.invalid/synthetic";
    const code = await runCommand({
      ...options,
      connect: () => Promise.reject(Object.assign(new Error(`could not reach ${secretUrl}`), { code: "ECONNREFUSED" })),
    });
    expect(code).toBe(1);
    expect(spy.reserves).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
    const text = output.join("");
    expect(text).toContain("screen: could not connect to the database named by DATABASE_URL (error code ECONNREFUSED)");
    expect(text).not.toContain("synthetic-password");
    expect(text).not.toContain("db.example.invalid");
  });
});
