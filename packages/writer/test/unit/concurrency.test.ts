import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_CALLS_PER_CANDIDATE } from "../../src/config.ts";
import { ObservedFetch } from "../../src/http.ts";
import { createWriter, createWriterProvider } from "../../src/writer.ts";
import { CANDIDATE, CONTEXT, EXCLUDED_IDENTIFIERS, cardSource, symptom } from "../fixtures/cases.ts";
import { POOL, SLOT, committedRecordings, freshSpend, acquire, openDb, rateSheetBytes, spyFetch } from "../support.ts";
import { createReplayFetch } from "../../src/recording.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

async function sharedLedgerWriters() {
  const { spend } = await freshSpend(db);
  await acquire(spend);
  const replay = createReplayFetch(await committedRecordings());
  const make = () =>
    createWriter({
      spend,
      provider: createWriterProvider({ fetch: spyFetch(replay, []).fetch }),
      context: CONTEXT,
      poolKey: POOL,
      allocationKey: null,
      slotKey: SLOT,
      rateSheet: rateSheetBytes(),
    });
  return { make };
}

describe("concurrent writers on one candidate", () => {
  it("never reserve the same ordinal and never exceed the shared call limit", async () => {
    const { make } = await sharedLedgerWriters();
    const cardWriter = make();
    const issueWriter = make();
    const runs: Promise<{ ok: boolean; ordinal: number | null }>[] = [];
    for (let n = 0; n < MAX_CALLS_PER_CANDIDATE; n += 1) {
      runs.push(
        cardWriter.writeCard({ candidate: CANDIDATE, source: cardSource("valid") }).then((o) => ({
          ok: o.ok,
          ordinal: o.ok ? o.call.call_ordinal : null,
        })),
        issueWriter
          .writeIssue({ candidate: CANDIDATE, symptom: symptom("valid"), excludedIdentifiers: EXCLUDED_IDENTIFIERS })
          .then((o) => ({ ok: o.ok, ordinal: o.ok ? o.call.call_ordinal : null })),
      );
    }
    const results = await Promise.all(runs);
    const ordinals = results.flatMap((r) => (r.ordinal === null ? [] : [r.ordinal]));
    expect(new Set(ordinals).size).toBe(ordinals.length);
    expect(ordinals.sort((a, b) => a - b)).toEqual(Array.from({ length: MAX_CALLS_PER_CANDIDATE }, (_, i) => i + 1));
  });
});

describe("one provider runs one call at a time", () => {
  it("refuses a second send while the first awaits its response", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent = 0;
    const observed = new ObservedFetch(async () => {
      sent += 1;
      await gate;
      return new Response("first", { status: 200 });
    });
    const first = observed.send("body-a", async () => {
      await observed.fetch("https://example.invalid/", { method: "POST", body: "body-a" });
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await observed.send("body-b", async () => {
      await observed.fetch("https://example.invalid/", { method: "POST", body: "body-b" });
    });
    expect(second.exchange).toEqual({ kind: "not_sent", reason: "provider_busy" });
    expect(sent).toBe(1);
    release();
    expect((await first).exchange).toEqual({ kind: "response", status: 200, body: "first" });
  });

  it("keeps each call's response with its own operation", async () => {
    const observed = new ObservedFetch((_input, init) => Promise.resolve(new Response(`echo:${typeof init?.body === "string" ? init.body : ""}`, { status: 200 })));
    const run = (body: string) =>
      observed.send(body, async () => {
        await observed.fetch("https://example.invalid/", { method: "POST", body });
      });
    const [a, b] = await Promise.all([run("body-a"), run("body-b")]);
    expect(a.exchange).toEqual({ kind: "response", status: 200, body: "echo:body-a" });
    expect(b.exchange).toEqual({ kind: "not_sent", reason: "provider_busy" });
    const c = await run("body-c");
    expect(c.exchange).toEqual({ kind: "response", status: 200, body: "echo:body-c" });
  });
});

describe("a second writer on a provider that is inside another writer's send", () => {
  it("gets a request_not_sent call settled at zero, not an exception, even at preview", async () => {
    const { spend } = await freshSpend(db);
    await acquire(spend);
    const replay = createReplayFetch(await committedRecordings());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent = 0;
    let entered: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const provider = createWriterProvider({
      fetch: async (input, init) => {
        sent += 1;
        entered();
        await gate;
        return replay(input, init);
      },
    });
    const make = () =>
      createWriter({
        spend,
        provider,
        context: CONTEXT,
        poolKey: POOL,
        allocationKey: null,
        slotKey: SLOT,
        rateSheet: rateSheetBytes(),
      });
    const first = make().writeIssue({
      candidate: CANDIDATE,
      symptom: symptom("valid"),
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    await inFlight;
    const second = await make().writeCard({ candidate: "synthetic-candidate-2", source: cardSource("valid") });
    expect(sent).toBe(1);
    if (!second.ok) {
      throw new Error(second.code);
    }
    expect(second.call).toMatchObject({ status: "failed", failure: "request_not_sent" });
    expect(second.call.settlement).toMatchObject({ settled_microusd: 0n, retained_microusd: 0n, state: "reconciled" });
    release();
    expect(await first).toMatchObject({ ok: true });
  });

  it("can still render a preview while another call is in flight", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed = new ObservedFetch(async () => {
      await gate;
      return new Response("first", { status: 200 });
    });
    const first = observed.send("body-a", async () => {
      await observed.fetch("https://example.invalid/", { method: "POST", body: "body-a" });
    });
    const body = await observed.preview(async () => {
      await observed.fetch("https://example.invalid/", { method: "POST", body: "body-b" });
    });
    expect(body).toBe("body-b");
    release();
    expect((await first).exchange).toEqual({ kind: "response", status: 200, body: "first" });
  });
});
