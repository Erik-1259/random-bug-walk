import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALL_WORST_CASE_MICROUSD, CANDIDATE, CONTEXT, EXCLUDED_IDENTIFIERS, RATE_ENTRIES, SYNTHETIC_USAGE, cardSource, symptom } from "../fixtures/cases.ts";
import { createReplayFetch } from "../../src/recording.ts";
import { WriterInterruptedError, createWriter, createWriterProvider } from "../../src/writer.ts";
import { POOL, SLOT, acquire, committedRecordings, freshSpend, openDb, operationCount, rateSheetBytes, rig } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

const committedReplay = async () => createReplayFetch(await committedRecordings());

const issue = (variant: string) => ({
  candidate: CANDIDATE,
  symptom: symptom(variant),
  excludedIdentifiers: EXCLUDED_IDENTIFIERS,
});

describe("reserve, launch, settle", () => {
  it("runs reserve → launching → fetch → terminal → settle, in that order", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeIssue(issue("valid"));
    expect(outcome.ok).toBe(true);
    expect(r.events).toEqual(["reserve", "transition:launching", "fetch", "transition:terminal", "settle"]);
  });

  it("refuses with insufficient_funds when the pool is smaller than one call's worst case, with no call and no retry", async () => {
    const r = await rig(db, { cap: CALL_WORST_CASE_MICROUSD - 1 });
    const outcome = await r.writer.writeIssue(issue("valid"));
    expect(outcome).toMatchObject({ ok: false, code: "insufficient_funds" });
    expect(r.fetchSpy.calls).toHaveLength(0);
    expect(r.events).toEqual(["reserve"]);
    expect(await operationCount(db, r.schema)).toBe(0);
  });

  it("fits a pool of exactly one call's worst case", async () => {
    const r = await rig(db, { cap: CALL_WORST_CASE_MICROUSD });
    const outcome = await r.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.reserved_microusd).toBe(BigInt(CALL_WORST_CASE_MICROUSD));
  });

  it("settles known usage at ceil(quantity × price) and releases the rest; the operation becomes reconciled", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeIssue(issue("valid"));
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    const inputCost = Math.ceil((SYNTHETIC_USAGE.prompt_tokens * 60_000) / 1_000_000);
    const outputCost = Math.ceil((SYNTHETIC_USAGE.completion_tokens * 240_000) / 1_000_000);
    expect(outcome.call.usage).toEqual(SYNTHETIC_USAGE);
    expect(outcome.call.settlement).toMatchObject({
      settled_microusd: BigInt(inputCost + outputCost),
      retained_microusd: 0n,
      released_microusd: BigInt(CALL_WORST_CASE_MICROUSD - inputCost - outputCost),
      state: "reconciled",
    });
    const status = await r.rawSpend.operationStatus({ operation_id: outcome.call.operation_id });
    expect(status).toMatchObject({ ok: true, state: "reconciled", open_microusd: 0n });
  });

  it("settles missing usage as unknown, keeps the full worst case and stays terminal", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeIssue(issue("missing-usage"));
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.status).toBe("completed");
    expect(outcome.call.usage).toEqual({ prompt_tokens: null, completion_tokens: null });
    expect(outcome.call.settlement).toMatchObject({
      settled_microusd: 0n,
      retained_microusd: BigInt(CALL_WORST_CASE_MICROUSD),
      released_microusd: 0n,
      state: "terminal",
    });
    const status = await r.rawSpend.operationStatus({ operation_id: outcome.call.operation_id });
    expect(status).toMatchObject({ ok: true, state: "terminal", open_microusd: BigInt(CALL_WORST_CASE_MICROUSD) });
  });

  it("settles an HTTP 500 without usage as failed and unknown", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeIssue(issue("http-500"));
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(r.events).toEqual(["reserve", "transition:launching", "fetch", "transition:terminal", "settle"]);
    expect(outcome.call.settlement).toMatchObject({ retained_microusd: BigInt(CALL_WORST_CASE_MICROUSD), state: "terminal" });
  });

  it("records a lost response as uncertain, with no retry and no settlement", async () => {
    const r = await rig(db, {
      fetch: () => Promise.reject(new TypeError("synthetic connection reset")),
    });
    const outcome = await r.writer.writeIssue(issue("valid"));
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.status).toBe("uncertain");
    expect(outcome.call.failure).toBe("lost_response");
    expect(outcome.call.settlement).toBeNull();
    expect(r.fetchSpy.calls).toHaveLength(1);
    expect(r.events).toEqual(["reserve", "transition:launching", "fetch", "transition:uncertain"]);
    const status = await r.rawSpend.operationStatus({ operation_id: outcome.call.operation_id });
    expect(status).toMatchObject({ ok: true, state: "uncertain" });
  });

  it("records a response body that breaks off as a lost response", async () => {
    const r = await rig(db, {
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"id":'));
                controller.error(new Error("synthetic reset after headers"));
              },
            }),
            { status: 200 },
          ),
        ),
    });
    const outcome = await r.writer.writeIssue(issue("valid"));
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.status).toBe("uncertain");
    expect(r.events.at(-1)).toBe("transition:uncertain");
  });

  it("runs overlapping calls of one writer one at a time, each with its own ordinal", async () => {
    const r = await rig(db);
    const [card, issueOutcome] = await Promise.all([
      r.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") }),
      r.writer.writeIssue(issue("valid")),
    ]);
    if (!card.ok || !issueOutcome.ok) {
      throw new Error("expected both calls to run");
    }
    expect([card.call.call_ordinal, issueOutcome.call.call_ordinal]).toEqual([1, 2]);
    expect([card.call.status, issueOutcome.call.status]).toEqual(["completed", "completed"]);
    expect(r.fetchSpy.calls).toHaveLength(2);
    expect(r.events).toEqual([
      "reserve", "transition:launching", "fetch", "transition:terminal", "settle",
      "reserve", "transition:launching", "fetch", "transition:terminal", "settle",
    ]);
  });

  it("names the operation when the ledger fails after the reservation", async () => {
    const base = await rig(db);
    const r = await rig(db, {
      existing: {
        spend: { ...base.rawSpend, settle: () => Promise.reject(new Error("synthetic connection lost")) },
        schema: base.schema,
      },
      acquireSlot: false,
    });
    const error: unknown = await r.writer.writeIssue(issue("valid")).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(WriterInterruptedError);
    const operationId = (error as WriterInterruptedError).operation_id;
    expect(await base.rawSpend.operationStatus({ operation_id: operationId })).toMatchObject({ ok: true, state: "terminal" });
  });

  it("refuses with slot_not_held when the root does not hold the slot, before reserving", async () => {
    const r = await rig(db, { acquireSlot: false });
    const outcome = await r.writer.writeIssue(issue("valid"));
    expect(outcome).toMatchObject({ ok: false, code: "slot_not_held" });
    expect(r.events).toEqual([]);
    expect(r.fetchSpy.calls).toHaveLength(0);
  });
});

describe("prices", () => {
  it("refuses with unknown_price when the output_token line has no price, writing nothing and calling nothing", async () => {
    const r = await rig(db, { rateSheet: rateSheetBytes(RATE_ENTRIES.filter((e) => e.unit !== "output_token")) });
    const outcome = await r.writer.writeIssue(issue("valid"));
    expect(outcome).toMatchObject({ ok: false, code: "unknown_price" });
    expect(r.events).toEqual([]);
    expect(r.fetchSpy.calls).toHaveLength(0);
    expect(await operationCount(db, r.schema)).toBe(0);
  });

  it.each([
    ["an empty rate file", new Uint8Array()],
    ["a rate file that is not JSON", new TextEncoder().encode("synthetic")],
    ["a duplicated line", rateSheetBytes([...RATE_ENTRIES, RATE_ENTRIES[0]])],
    ["a fractional price", rateSheetBytes([{ ...RATE_ENTRIES[0], price: { microusd: 0.5, per_units: 1 } }, RATE_ENTRIES[1]])],
  ])("refuses %s with unknown_price", async (_name, bytes) => {
    const r = await rig(db, { rateSheet: bytes });
    const outcome = await r.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") });
    expect(outcome).toMatchObject({ ok: false, code: "unknown_price" });
    expect(r.events).toEqual([]);
  });
});

describe("settlement of calls that never reached the provider", () => {
  it("settles an unmatched replay at zero on every line and frees the reservation", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeIssue({ ...issue("no-such-case"), candidate: "synthetic-unrecorded" });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.failure).toBe("request_not_sent");
    expect(outcome.call.settlement).toMatchObject({
      settled_microusd: 0n,
      retained_microusd: 0n,
      released_microusd: BigInt(CALL_WORST_CASE_MICROUSD),
      state: "reconciled",
    });
    const status = await r.rawSpend.operationStatus({ operation_id: outcome.call.operation_id });
    expect(status).toMatchObject({ ok: true, state: "reconciled", open_microusd: 0n });
  });

  it("settles a call that finds the provider busy at zero", async () => {
    const { spend } = await freshSpend(db);
    await acquire(spend);
    const real = createWriterProvider({ fetch: await committedReplay() });
    // A send started while another is in flight, as a second writer on the same provider would make.
    const send = real.observed.send.bind(real.observed);
    real.observed.send = async (body, action) => {
      const nested: { result?: Awaited<ReturnType<typeof send>> } = {};
      await send(body, async () => {
        nested.result = await send(body, action);
      });
      if (nested.result === undefined) {
        throw new Error("the nested send did not run");
      }
      return nested.result;
    };
    const writer = createWriter({
      spend,
      provider: real,
      context: CONTEXT,
      poolKey: POOL,
      allocationKey: null,
      slotKey: SLOT,
      rateSheet: rateSheetBytes(),
    });
    const outcome = await writer.writeIssue(issue("valid"));
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.failure).toBe("request_not_sent");
    expect(outcome.call.settlement).toMatchObject({ settled_microusd: 0n, retained_microusd: 0n, state: "reconciled" });
  });

  it("keeps the whole reservation when the response is lost", async () => {
    const r = await rig(db, { fetch: () => Promise.reject(new TypeError("synthetic connection reset")) });
    const outcome = await r.writer.writeIssue(issue("valid"));
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.usage).toEqual({ prompt_tokens: null, completion_tokens: null });
    const status = await r.rawSpend.operationStatus({ operation_id: outcome.call.operation_id });
    expect(status).toMatchObject({ ok: true, state: "uncertain", open_microusd: BigInt(CALL_WORST_CASE_MICROUSD) });
  });
});
