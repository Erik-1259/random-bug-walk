import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { profileSha256 } from "@rbw/writer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "../../src/commands.ts";
import { KIMI_SCREEN_PROFILE, SUPER_SCREEN_PROFILE } from "../../src/profiles.ts";
import { ScreenRecordSchema } from "../../src/record.ts";
import type { ScreenRecord, StaticProbe } from "../../src/record.ts";
import { screenKey } from "../../src/screen.ts";
import { sha256Hex } from "../../src/site.ts";
import { LOCATED_AND_FIXED, LOCATED_ONLY, MISS, MISS_REASON, scriptedFetch, SYNTHETIC_USAGE } from "../fixtures/scripted.ts";
import type { Scripted } from "../fixtures/scripted.ts";
import { PLANTED_REPORT } from "../fixtures/synthetic-source.ts";
import { commandOptions, freshSpend, noNetwork, openDb, POOL, RATES, SLOT, spySpend, syntheticTree, tempDir } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

const KEY = screenKey("synthetic-currency-001", sha256Hex(PLANTED_REPORT));

function runArgs(out: string, attempts: number, extra: string[] = []): string[] {
  const tree = syntheticTree();
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
    POOL,
    ...extra,
  ];
}

function readRecord(out: string): ScreenRecord & { optional_static_probe: StaticProbe } {
  const record = ScreenRecordSchema.parse(JSON.parse(readFileSync(join(out, "screen.json"), "utf8")));
  if (typeof record.optional_static_probe === "string") {
    throw new Error("the record has no probe");
  }
  return { ...record, optional_static_probe: record.optional_static_probe };
}

async function run(script: Scripted[], attempts: number, extra: string[] = []) {
  const spy = spySpend(await freshSpend(db));
  const fake = scriptedFetch(script);
  const out = join(tempDir(), "out");
  const output: string[] = [];
  const code = await runCommand(commandOptions(runArgs(out, attempts, extra), spy.spend, fake.fetch, output));
  return { code, out, output: output.join(""), spy, fake };
}

describe("screen run, end to end on PGlite with the fake model", () => {
  it("passes a case no attempt finds, with one metered call per attempt and the cost settled", async () => {
    const { code, out, spy, fake } = await run([MISS, MISS, MISS, MISS], 4);
    expect(code).toBe(0);
    expect(spy.reserves.map((r) => r.call_name)).toEqual([1, 2, 3, 4].map((n) => `screen.static:${KEY}:${String(n)}`));
    expect(spy.reserves.every((r) => r.kind === "screen.static" && r.attempt_ordinal === 1 && r.pool_key === POOL)).toBe(true);
    expect(spy.reserves[0]?.runtime_profile_sha256).toBe(profileSha256(SUPER_SCREEN_PROFILE));
    expect(spy.reserves[0]?.envelope.map((line) => [line.service, line.unit, line.limit, line.enforced_by])).toEqual([
      ["token-factory.nemotron-3-super", "input_token", 65_536, "client_counter"],
      ["token-factory.nemotron-3-super", "output_token", 2_048, "request_parameter"],
    ]);
    expect(fake.bodies).toHaveLength(4);
    expect(fake.bodies[0]).toMatchObject({ model: "nvidia/nemotron-3-super-120b-a12b", max_tokens: 2_048, chat_template_kwargs: { enable_thinking: false } });
    expect(fake.bodies[0]).toHaveProperty("response_format");
    expect(fake.bodies[0]).not.toHaveProperty("temperature");

    const record = readRecord(out);
    const probe = record.optional_static_probe;
    expect(record.record).toBe("uc1-static-headroom-screen");
    expect(record.verdict).toBe("pass");
    expect(record.static_tells).toEqual([]);
    expect(record.subject).toMatchObject({ target_file: "src/report.ts", planted_site: "src/report.ts:12-12", planted_hunks: [{ start_line: 12, end_line: 12 }], planted_sha256: sha256Hex(PLANTED_REPORT) });
    expect(record.screen).toMatchObject({ binding: false, judged_on: "2026-10-13" });
    expect(probe).toMatchObject({ attempts_planned: 4, attempts_run: 4, answered: 4, hits: 0, fail_at_hits: 1, stopped: null });
    expect(probe.attempts.map((a) => [a.outcome, a.miss_kind, a.hit_range])).toEqual(Array.from({ length: 4 }, () => ["miss", "other_file", null]));
    expect(probe.attempts[0]).toMatchObject({ prompt_tokens: SYNTHETIC_USAGE.prompt_tokens, completion_tokens: SYNTHETIC_USAGE.completion_tokens, prompt_within_bound: true });

    // Settled cost: each call's reported usage at the Super rates, rounded up per line.
    const perCall = Math.ceil((SYNTHETIC_USAGE.prompt_tokens * 300_000) / 1_000_000) + Math.ceil((SYNTHETIC_USAGE.completion_tokens * 900_000) / 1_000_000);
    expect(probe.cost).toMatchObject({ settled_microusd: 4 * perCall, worst_case_microusd_per_call: 21_505, budget_microusd: 1_000_000, unsettled_operation_ids: [] });
    expect(probe.cost.reserved_microusd).toBe(4 * 21_505);
    const pool = await spy.spend.poolStatus({ pool_key: POOL });
    expect(pool.ok && pool.settled_microusd).toBe(BigInt(4 * perCall));

    expect(readdirSync(join(out, "recordings")).sort()).toEqual([1, 2, 3, 4].map((n) => `${KEY}-${String(n)}.recording.json`));
  });

  it("keeps the model's text out of the record and in the private answers file", async () => {
    const { out } = await run([MISS, LOCATED_ONLY], 2, ["--fail-at-hits", "2"]);
    const screen = readFileSync(join(out, "screen.json"), "utf8");
    expect(screen).not.toContain(MISS_REASON);
    expect(screen).not.toContain(LOCATED_ONLY.reason);
    expect(screen).not.toContain("src/format.ts:5");
    expect(readFileSync(join(out, "answers.json"), "utf8")).toContain(MISS_REASON);
  });

  it("fails a case at the first hit and stops spending", async () => {
    const { code, out, spy, fake, output } = await run([MISS, LOCATED_AND_FIXED, MISS, MISS], 4);
    expect(code).toBe(0);
    expect(spy.reserves).toHaveLength(2);
    expect(fake.bodies).toHaveLength(2);
    const record = readRecord(out);
    expect(record.verdict).toBe("fail");
    expect(record.optional_static_probe).toMatchObject({ attempts_run: 2, hits: 1, stopped: { reason: "verdict_decided", attempt: 2 } });
    expect(record.static_tells).toEqual([
      {
        location: "src/report.ts:12-12",
        kind: "model located the site and its fix gives the clean file",
        detail: "Attempt 2 of 4 answered with this range from the shown files and the symptom alone; the planted site is src/report.ts:12-12.",
      },
    ]);
    expect(record.consequences).toEqual(["Do not use this case as a UC1 paired-comparison subject; it remains usable as a factory case."]);
    expect(output).toContain("screen: fail: 1 hits in 2 of 4 attempts");
  });

  it("needs the failing count of hits before it fails", async () => {
    const { out, spy } = await run([LOCATED_ONLY, MISS, MISS], 3, ["--fail-at-hits", "2"]);
    expect(spy.reserves).toHaveLength(3);
    expect(readRecord(out).verdict).toBe("pass");
  });

  it("is inconclusive when an attempt gives no answer, and still settles every call", async () => {
    const { code, out } = await run(["http_500", "invalid", MISS], 3);
    expect(code).toBe(0);
    const record = readRecord(out);
    expect(record.verdict).toBe("inconclusive");
    const probe = record.optional_static_probe;
    expect(probe.attempts.map((a) => [a.outcome, a.failure])).toEqual([
      ["no_answer", "http_status"],
      ["no_answer", "invalid_output"],
      ["miss", null],
    ]);
    expect(probe.cost.unsettled_operation_ids).toEqual([]);
  });

  it("stops on a lost response and leaves the slot held", async () => {
    const { code, out, spy, output } = await run(["lost", MISS], 2);
    expect(code).toBe(1);
    expect(spy.reserves).toHaveLength(1);
    const record = readRecord(out);
    expect(record.verdict).toBe("inconclusive");
    expect(record.optional_static_probe.stopped).toMatchObject({ reason: "uncertain", attempt: 1 });
    expect(record.optional_static_probe.cost.unsettled_operation_ids).toHaveLength(1);
    expect(output).toContain("the slot stays held");
    const slot = await spy.spend.slotStatus({ slot_key: SLOT });
    expect(slot.ok && slot.holder).not.toBeNull();
  });

  it("refuses to start when the attempts at the worst case exceed the budget", async () => {
    const spy = spySpend(await freshSpend(db));
    const out = join(tempDir(), "out");
    const output: string[] = [];
    const args = runArgs(out, 4).map((arg) => (arg === "1000000" ? "86019" : arg));
    const code = await runCommand(commandOptions(args, spy.spend, noNetwork, output));
    expect(code).toBe(1);
    expect(spy.reserves).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
    expect(output.join("")).toContain("screen: over budget: 4 attempts at a worst case of 21505 micro-USD each need 86020 micro-USD, above the budget of 86019");
  });

  it("uses the fallback model without a provider schema and validates its reply after the call", async () => {
    const { code, out, spy, fake } = await run([LOCATED_ONLY], 1, ["--model", "kimi"]);
    expect(code).toBe(0);
    expect(fake.bodies[0]).toMatchObject({ model: "moonshotai/Kimi-K2.7-Code", max_tokens: 8_192 });
    expect(fake.bodies[0]).not.toHaveProperty("response_format");
    expect(fake.bodies[0]).not.toHaveProperty("chat_template_kwargs");
    expect(spy.reserves[0]?.runtime_profile_sha256).toBe(profileSha256(KIMI_SCREEN_PROFILE));
    expect(readRecord(out)).toMatchObject({ verdict: "fail", optional_static_probe: { model: "moonshotai/Kimi-K2.7-Code", service: "token-factory.kimi-k2.7-code" } });
  });

  it("marks the record binding only when asked", async () => {
    const { out } = await run([MISS], 1, ["--binding"]);
    expect(readRecord(out).screen.binding).toBe(true);
  });

  it("refuses a run without the screen key and sends nothing", async () => {
    const spy = spySpend(await freshSpend(db));
    const output: string[] = [];
    const code = await runCommand(commandOptions(runArgs(join(tempDir(), "out"), 1), spy.spend, noNetwork, output, { DATABASE_URL: "postgres://synthetic.example.invalid/x" }));
    expect(code).toBe(1);
    expect(spy.reserves).toHaveLength(0);
    expect(output.join("")).toContain("TOKEN_FACTORY_SCREEN_KEY is not set");
  });
});
