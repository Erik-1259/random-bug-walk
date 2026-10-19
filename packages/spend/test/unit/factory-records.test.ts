import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { EVENT_TYPE_VALUES } from "@rbw/factory-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FactoryRecords } from "../../src/factory.ts";
import {
  acceptRequest,
  budgetKey,
  budgetRequest,
  event,
  factoryOperation,
  factorySetup,
  interpretation,
  recordRequest,
  records,
  requestId,
  requestRoot,
  runningEvents,
  validationRoot,
  withoutSeqAndAt,
} from "../factory-helpers.ts";
import { expectNothingWritten, expectOk, expectRefused, harness, hex, loose, openDb, uuid, type Harness } from "../helpers.ts";

let db: PGlite;
let h: Harness;
let f: FactoryRecords;

beforeAll(async () => {
  db = await openDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  h = await harness(db);
  await factorySetup(h);
  f = records(h);
});

const T0 = "2026-10-04T00:00:00.000Z";
const REQUEST = requestId(1);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function read(after = 0, limit = 200) {
  return expectOk(await f.readRequest({ request_id: REQUEST, after, limit }));
}

describe("recording a request", () => {
  beforeEach(async () => {
    expectOk(await h.spend.createBudget(budgetRequest(1)));
  });

  it("records it once, replays the same content and refuses other content with idempotency_conflict", async () => {
    const created = expectOk(await f.recordRequest(recordRequest(1)));
    expect(created).toEqual({ ok: true, replay: false, request_id: REQUEST, created_at: T0 });
    h.clock.advance(1000);
    await expectNothingWritten(h, async () => {
      expect(expectOk(await f.recordRequest(recordRequest(1)))).toEqual({ ...created, replay: true });
      expectRefused(await f.recordRequest(recordRequest(1, { request_sha256: hex(1) })), "idempotency_conflict");
      expectRefused(
        await f.recordRequest(recordRequest(1, { interpretation: interpretation(hex(8102)), interpretation_sha256: hex(8102) })),
        "idempotency_conflict",
      );
    });
    const stored = await read();
    expect(stored.request).toEqual({
      request_id: REQUEST,
      request_sha256: hex(8001),
      interpretation: interpretation(hex(8101)),
      interpretation_sha256: hex(8101),
      budget_key: budgetKey(1),
      root_execution_id: requestRoot(1),
      factory_profile_sha256: hex(8200),
      created_at: T0,
    });
  });

  it("refuses a second request on the same budget", async () => {
    expectOk(await f.recordRequest(recordRequest(1)));
    expectRefused(await f.recordRequest(recordRequest(1, { request_id: requestId(2) })), "idempotency_conflict");
  });

  it("refuses an unknown budget, a root other than the budget's, and a mismatched interpretation hash", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await f.recordRequest(recordRequest(1, { budget_key: hex(999) })), "unknown_budget");
      expectRefused(await f.recordRequest(recordRequest(1, { root_execution_id: requestRoot(2) })), "invalid_request");
      expectRefused(await f.recordRequest(recordRequest(1, { interpretation_sha256: hex(1) })), "invalid_request");
      expectRefused(await f.recordRequest(loose({ ...recordRequest(1), interpretation: [] })), "invalid_request");
      expectRefused(await f.recordRequest(loose({ ...recordRequest(1), extra: true })), "invalid_request");
    });
  });

  it("answers unknown_request for a request that was never recorded", async () => {
    expectRefused(await f.readRequest({ request_id: REQUEST, after: 0, limit: 200 }), "unknown_request");
  });
});

describe("accepting a request", () => {
  function accept(n = 1, overrides: { cap?: number; message?: string; required?: number } = {}) {
    return f.acceptRequest({
      budget: budgetRequest(n, {
        cap_microusd: overrides.cap ?? 1_000_000,
        pool_required_microusd: overrides.required ?? 200_000,
      }),
      request: recordRequest(n),
      accepted_message: overrides.message ?? "Request accepted.",
    });
  }

  it("creates the budget, records the request and appends request_accepted as seq 1", async () => {
    const accepted = expectOk(await accept());
    expect(accepted).toEqual({ ok: true, replay: false, request_id: REQUEST, budget_key: budgetKey(1), created_at: T0, seq: 1 });
    const stored = await read();
    expect(stored.events).toEqual([
      { seq: 1, at: T0, type: "request_accepted", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Request accepted.", data: {} },
    ]);
    expect(expectOk(await h.spend.budgetStatus({ budget_key: budgetKey(1) })).cap_microusd).toBe(1_000_000n);
  });

  it("replays the same acceptance and writes nothing", async () => {
    expectOk(await accept());
    h.clock.advance(1000);
    await expectNothingWritten(h, async () => {
      expect(expectOk(await accept()).replay).toBe(true);
    });
  });

  it("writes nothing at all when any part conflicts or the pool cannot cover the worker", async () => {
    expectOk(await accept());
    await expectNothingWritten(h, async () => {
      expectRefused(await accept(1, { cap: 999_999 }), "idempotency_conflict");
      expectRefused(await accept(1, { message: "Another message." }), "idempotency_conflict");
    });
    // Request 2's budget would be new, but the request conflicts with request 1's: the budget is not kept.
    await expectNothingWritten(h, async () => {
      expectRefused(
        await f.acceptRequest({
          budget: budgetRequest(2),
          request: recordRequest(1, { budget_key: budgetKey(2), root_execution_id: requestRoot(2) }),
          accepted_message: "Request accepted.",
        }),
        "idempotency_conflict",
      );
      expectRefused(await accept(3, { required: 40_000_001 }), "insufficient_funds");
    });
    expectRefused(await h.spend.budgetStatus({ budget_key: budgetKey(2) }), "unknown_budget");
    // The refused IDs stay free: request 3 can start later with other content.
    expectOk(await accept(3, { cap: 500_000 }));
  });

  it("refuses a request whose budget part names another budget or root", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(
        await f.acceptRequest({ budget: budgetRequest(1), request: recordRequest(2), accepted_message: "Request accepted." }),
        "invalid_request",
      );
    });
  });
});

describe("request events", () => {
  beforeEach(async () => {
    await acceptRequest(h, 1);
  });

  it("numbers appended events consecutively and returns them as contract events", async () => {
    const fixtureEvents = runningEvents();
    for (const [i, e] of fixtureEvents.slice(1).entries()) {
      h.clock.advance(10);
      const appended = expectOk(await f.appendEvent({ ...withoutSeqAndAt(e), request_id: REQUEST, event_key: `fixture:${String(i + 2)}` }));
      expect(appended.seq).toBe(i + 2);
      expect(appended.replay).toBe(false);
    }
    const stored = await read();
    expect(stored.events.map((e) => withoutSeqAndAt(e))).toEqual(fixtureEvents.map((e) => withoutSeqAndAt(e)));
    expect(stored.events.map((e) => e.seq)).toEqual(fixtureEvents.map((_e, i) => i + 1));
    expect(stored.events[1]?.at).toBe("2026-10-04T00:00:00.010Z");
    expect(stored.last_seq).toBe(fixtureEvents.length);
    expect(stored.next_after).toBe(fixtureEvents.length);
    expect(stored.last_event_at).toBe(stored.events.at(-1)?.at);
  });

  it("gives concurrent appends consecutive sequence numbers", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_v, i) => f.appendEvent(event(REQUEST, `concurrent:${String(i)}`, { message: `synthetic ${String(i)}` }))),
    );
    const seqs = results.map((r) => expectOk(r).seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_v, i) => i + 2));
    expect((await read()).events.map((e) => e.seq)).toEqual(Array.from({ length: 13 }, (_v, i) => i + 1));
  });

  it("replays the same event key with the same content and refuses other content", async () => {
    const first = expectOk(await f.appendEvent(event(REQUEST, "worker_started")));
    h.clock.advance(1000);
    await expectNothingWritten(h, async () => {
      expect(expectOk(await f.appendEvent(event(REQUEST, "worker_started")))).toEqual({ ...first, replay: true });
      expectRefused(await f.appendEvent(event(REQUEST, "worker_started", { message: "Different." })), "idempotency_conflict");
      expectRefused(await f.appendEvent(event(REQUEST, "worker_started", { type: "stop_requested" })), "idempotency_conflict");
    });
  });

  it("returns events after a seq, up to the limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      expectOk(await f.appendEvent(event(REQUEST, `e:${String(i)}`)));
    }
    const page = await read(2, 2);
    expect(page.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(page.next_after).toBe(4);
    expect(page.last_seq).toBe(6);
    const empty = await read(6, 200);
    expect(empty.events).toEqual([]);
    expect(empty.next_after).toBe(6);
  });

  it("after request_finished admits only budget, attention and validation events", async () => {
    expectOk(
      await f.appendEvent(event(REQUEST, "finished", { type: "request_finished", data: { outcome: "fulfilled", stop_code: "fulfilled" } })),
    );
    await expectNothingWritten(h, async () => {
      expectRefused(await f.appendEvent(event(REQUEST, "late")), "event_not_allowed");
      expectRefused(
        await f.appendEvent(event(REQUEST, "finished-again", { type: "request_finished", data: { outcome: "cancelled", stop_code: "cancelled_by_user" } })),
        "event_not_allowed",
      );
    });
    expectOk(
      await f.appendEvent(
        event(REQUEST, "budget", { type: "budget_updated", data: { reserved_microusd: 0, spent_microusd: 1, remaining_microusd: 2 } }),
      ),
    );
    expectOk(await f.appendEvent(event(REQUEST, "attention", { type: "attention", data: { code: "needs_reconciliation" } })));
    expectOk(await f.appendEvent(event(REQUEST, "cleared", { type: "attention_cleared", data: { code: "needs_reconciliation" } })));
    expectOk(await f.appendEvent(event(REQUEST, "v-start", { type: "validation_started", data: { validation_id: uuid(9) } })));
    expectOk(
      await f.appendEvent(event(REQUEST, "v-end", { type: "validation_finished", data: { validation_id: uuid(9), result: "passed" } })),
    );
    // The finishing event itself still replays.
    expect(
      expectOk(
        await f.appendEvent(event(REQUEST, "finished", { type: "request_finished", data: { outcome: "fulfilled", stop_code: "fulfilled" } })),
      ).replay,
    ).toBe(true);
  });

  it.each([
    ["an unknown type", { type: "synthetic_type" }],
    ["a malformed candidate_id", { candidate_id: "synthetic" }],
    ["a malformed item_key", { item_key: "Synthetic Key" }],
    ["data that is not an object", { data: [] }],
    ["a message above 2,000 characters", { message: "m".repeat(2001) }],
    ["a message with a terminal escape", { message: "\u001b[2JAll fulfilled" }],
    ["a missing field", { case_id: undefined }],
  ])("refuses %s as invalid_request", async (_label, overrides) => {
    await expectNothingWritten(h, async () => {
      expectRefused(await f.appendEvent(loose({ ...event(REQUEST, "bad"), ...overrides })), "invalid_request");
    });
  });

  it("accepts any message text the contract allows, line breaks included", async () => {
    const message = "First line.\nSecond line\twith a tab.";
    expectOk(await f.appendEvent(event(REQUEST, "multi-line", { message })));
    expect((await read()).events.at(-1)?.message).toBe(message);
  });

  it("returns stored data exactly as stored, also under keys that name amounts", async () => {
    const data = { reserved_microusd: 1, spent_microusd: 2, remaining_microusd: 3 };
    expectOk(await f.appendEvent(event(REQUEST, "budget", { type: "budget_updated", data })));
    expect((await read()).events.at(-1)?.data).toEqual(data);
    const validationId = uuid(9300);
    expectOk(await f.recordValidation({ validation_id: validationId, request_id: REQUEST, case_id: hex(71), root_execution_id: validationRoot(3) }));
    expectOk(
      await f.appendValidationEvent({
        validation_id: validationId,
        event_key: "settled",
        type: "settled",
        data: { cost_microusd: "1200", note_microusd: "not a number", copies_quantity: "3" },
      }),
    );
    const stored = expectOk(await f.readValidation({ validation_id: validationId, after: 0, limit: 10 }));
    expect(stored.events[0]?.data).toEqual({ cost_microusd: "1200", note_microusd: "not a number", copies_quantity: "3" });
  });

  it("keeps request_accepted first and only first", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await f.appendEvent(event(REQUEST, "accepted-again", { type: "request_accepted", message: "Request accepted." })), "event_not_allowed");
    });
    expectOk(await h.spend.createBudget(budgetRequest(2)));
    expectOk(await f.recordRequest(recordRequest(2)));
    await expectNothingWritten(h, async () => {
      expectRefused(await f.appendEvent(event(requestId(2), "worker_started")), "event_not_allowed");
    });
    expect(expectOk(await f.appendEvent(event(requestId(2), "request_accepted", { type: "request_accepted" }))).seq).toBe(1);
  });

  it("refuses a malformed event key and an unknown request", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await f.appendEvent(event(REQUEST, "Bad Key")), "invalid_request");
      expectRefused(await f.appendEvent(event(requestId(2), "worker_started")), "unknown_request");
    });
  });

  it("stores exactly the contract's event types", async () => {
    const rows = await h.sql("SELECT factory_event_types() AS types");
    expect(rows).toEqual([{ types: [...EVENT_TYPE_VALUES] }]);
  });
});

describe("heartbeats", () => {
  beforeEach(async () => {
    await acceptRequest(h, 1);
  });

  it("reports the latest request heartbeat as last_heartbeat_at and never adds an event", async () => {
    expect((await read()).last_heartbeat_at).toBeNull();
    expectOk(await f.recordHeartbeat({ request_id: REQUEST, validation_id: null }));
    h.clock.advance(30_000);
    const latest = expectOk(await f.recordHeartbeat({ request_id: REQUEST, validation_id: null }));
    expect(latest.recorded_at).toBe("2026-10-04T00:00:30.000Z");
    const stored = await read();
    expect(stored.last_heartbeat_at).toBe("2026-10-04T00:00:30.000Z");
    expect(stored.last_seq).toBe(1);
  });

  it("keeps a validation run's heartbeats apart from the request's", async () => {
    const validationId = uuid(9001);
    expectOk(await f.recordValidation({ validation_id: validationId, request_id: REQUEST, case_id: hex(31), root_execution_id: validationRoot(1) }));
    h.clock.advance(5000);
    expectOk(await f.recordHeartbeat({ request_id: REQUEST, validation_id: validationId }));
    expect((await read()).last_heartbeat_at).toBeNull();
    const validation = expectOk(await f.readValidation({ validation_id: validationId, after: 0, limit: 10 }));
    expect(validation.validation.last_heartbeat_at).toBe("2026-10-04T00:00:05.000Z");
    expect((await read()).validations[0]?.last_heartbeat_at).toBe("2026-10-04T00:00:05.000Z");
  });

  it("refuses an unknown request and a validation of another request", async () => {
    await acceptRequest(h, 2);
    expectOk(await f.recordValidation({ validation_id: uuid(9001), request_id: REQUEST, case_id: hex(31), root_execution_id: validationRoot(1) }));
    await expectNothingWritten(h, async () => {
      expectRefused(await f.recordHeartbeat({ request_id: requestId(3), validation_id: null }), "unknown_request");
      expectRefused(await f.recordHeartbeat({ request_id: requestId(2), validation_id: uuid(9001) }), "unknown_validation");
    });
  });
});

describe("stop requests", () => {
  beforeEach(async () => {
    await acceptRequest(h, 1);
  });

  it("records one stop, replays the same one and refuses another actor", async () => {
    const stop = expectOk(await f.recordStop({ request_id: REQUEST, actor_role: "web" }));
    expect(stop).toEqual({ ok: true, replay: false, recorded_at: T0 });
    h.clock.advance(1000);
    await expectNothingWritten(h, async () => {
      expect(expectOk(await f.recordStop({ request_id: REQUEST, actor_role: "web" }))).toEqual({ ...stop, replay: true });
      expectRefused(await f.recordStop({ request_id: REQUEST, actor_role: "worker" }), "idempotency_conflict");
    });
    expect((await read()).stop).toEqual({ actor_role: "web", recorded_at: T0 });
  });

  it("refuses an unknown request", async () => {
    expectRefused(await f.recordStop({ request_id: requestId(2), actor_role: "web" }), "unknown_request");
  });
});

describe("evidence", () => {
  const CASE = hex(41);
  const JSON_TEXT = '{"case_id":"synthetic","copies":[1,2,3],"note":"café"}';

  beforeEach(async () => {
    await acceptRequest(h, 1);
  });

  it("stores the exact text, checks its hash and replays the same evidence", async () => {
    const recorded = expectOk(await f.recordEvidence({ request_id: REQUEST, case_id: CASE, sha256: sha256(JSON_TEXT), evidence_json: JSON_TEXT }));
    expect(recorded).toEqual({ ok: true, replay: false, recorded_at: T0 });
    const stored = expectOk(await f.readEvidence({ request_id: REQUEST, case_id: CASE }));
    expect(stored).toEqual({ ok: true, request_id: REQUEST, case_id: CASE, sha256: sha256(JSON_TEXT), evidence_json: JSON_TEXT, recorded_at: T0 });
    expect((await read()).evidence).toEqual([{ case_id: CASE, sha256: sha256(JSON_TEXT), recorded_at: T0 }]);
    await expectNothingWritten(h, async () => {
      expect(expectOk(await f.recordEvidence({ request_id: REQUEST, case_id: CASE, sha256: sha256(JSON_TEXT), evidence_json: JSON_TEXT })).replay).toBe(true);
      const other = '{"case_id":"synthetic"}';
      expectRefused(await f.recordEvidence({ request_id: REQUEST, case_id: CASE, sha256: sha256(other), evidence_json: other }), "idempotency_conflict");
    });
  });

  it("refuses a hash that does not match, text that is not a JSON object, and unknown targets", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await f.recordEvidence({ request_id: REQUEST, case_id: CASE, sha256: hex(1), evidence_json: JSON_TEXT }), "invalid_request");
      expectRefused(await f.recordEvidence({ request_id: REQUEST, case_id: CASE, sha256: sha256("[1]"), evidence_json: "[1]" }), "invalid_request");
      expectRefused(await f.recordEvidence({ request_id: REQUEST, case_id: CASE, sha256: sha256("{"), evidence_json: "{" }), "invalid_request");
      expectRefused(
        await f.recordEvidence({ request_id: requestId(2), case_id: CASE, sha256: sha256(JSON_TEXT), evidence_json: JSON_TEXT }),
        "unknown_request",
      );
    });
    expectRefused(await f.readEvidence({ request_id: REQUEST, case_id: CASE }), "unknown_evidence");
    expectRefused(await f.readEvidence({ request_id: requestId(2), case_id: CASE }), "unknown_request");
  });
});

describe("validation runs", () => {
  const CASE = hex(51);
  const VALIDATION = uuid(9100);

  beforeEach(async () => {
    await acceptRequest(h, 1);
  });

  function validation(overrides: Partial<{ validation_id: string; request_id: string; case_id: string; root_execution_id: string }> = {}) {
    return { validation_id: VALIDATION, request_id: REQUEST, case_id: CASE, root_execution_id: validationRoot(1), ...overrides };
  }

  it("records a run once, replays it on the same path and refuses the ID on another case or request", async () => {
    await acceptRequest(h, 2);
    const recorded = expectOk(await f.recordValidation(validation()));
    expect(recorded).toEqual({ ok: true, replay: false, recorded_at: T0 });
    await expectNothingWritten(h, async () => {
      expect(expectOk(await f.recordValidation(validation())).replay).toBe(true);
      expectRefused(await f.recordValidation(validation({ case_id: hex(52) })), "idempotency_conflict");
      expectRefused(await f.recordValidation(validation({ request_id: requestId(2) })), "idempotency_conflict");
      // A second run may not reuse the first run's root.
      expectRefused(await f.recordValidation(validation({ validation_id: uuid(9101) })), "idempotency_conflict");
    });
  });

  it("finds a run by its ID alone, with its request and case", async () => {
    expectRefused(await f.readValidation({ validation_id: VALIDATION, after: 0, limit: 10 }), "unknown_validation");
    expectOk(await f.recordValidation(validation()));
    const found = expectOk(await f.readValidation({ validation_id: VALIDATION, after: 0, limit: 10 }));
    expect(found).toEqual({
      ok: true,
      validation: {
        validation_id: VALIDATION,
        request_id: REQUEST,
        case_id: CASE,
        root_execution_id: validationRoot(1),
        recorded_at: T0,
        last_heartbeat_at: null,
      },
      events: [],
      next_after: 0,
      last_seq: 0,
    });
    expect((await read()).validations).toEqual([found.validation]);
  });

  it("refuses a budget's root as a validation root, and an unknown request", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await f.recordValidation(validation({ root_execution_id: requestRoot(1) })), "invalid_request");
      expectRefused(await f.recordValidation(validation({ request_id: requestId(3) })), "unknown_request");
    });
  });

  it("refuses a root whose reservations are charged to another request's budget", async () => {
    await acceptRequest(h, 2);
    expectOk(
      await h.spend.budgetReserve({
        budget_key: budgetKey(2),
        role: "validation",
        reservation: factoryOperation(1, validationRoot(1), 10),
      }),
    );
    await expectNothingWritten(h, async () => {
      expectRefused(await f.recordValidation(validation()), "invalid_request");
    });
    expectOk(await f.recordValidation(validation({ request_id: requestId(2) })));
  });

  it("keeps a recorded run's root out of other budgets: no other budget charges it, no budget takes it as its root", async () => {
    await acceptRequest(h, 2);
    expectOk(await f.recordValidation(validation()));
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.budgetReserve({ budget_key: budgetKey(2), role: "validation", reservation: factoryOperation(1, validationRoot(1), 10) }),
        "invalid_request",
      );
      expectRefused(await h.spend.createBudget(budgetRequest(3, { root_execution_id: validationRoot(1) })), "invalid_request");
    });
    expectOk(
      await h.spend.budgetReserve({ budget_key: budgetKey(1), role: "validation", reservation: factoryOperation(1, validationRoot(1), 10) }),
    );
  });

  it("numbers its events consecutively, replays an event key and refuses other content", async () => {
    expectOk(await f.recordValidation(validation()));
    const started = expectOk(await f.appendValidationEvent({ validation_id: VALIDATION, event_key: "started", type: "running", data: {} }));
    expect(started).toEqual({ ok: true, replay: false, seq: 1, at: T0 });
    h.clock.advance(20);
    const results = await Promise.all(
      [1, 2, 3].map((i) =>
        f.appendValidationEvent({ validation_id: VALIDATION, event_key: `copy:${String(i)}`, type: "copy_finished", data: { copy: i } }),
      ),
    );
    expect(results.map((r) => expectOk(r).seq).sort()).toEqual([2, 3, 4]);
    await expectNothingWritten(h, async () => {
      expect(expectOk(await f.appendValidationEvent({ validation_id: VALIDATION, event_key: "started", type: "running", data: {} })).replay).toBe(true);
      expectRefused(
        await f.appendValidationEvent({ validation_id: VALIDATION, event_key: "started", type: "running", data: { other: true } }),
        "idempotency_conflict",
      );
      expectRefused(await f.appendValidationEvent({ validation_id: uuid(9999), event_key: "started", type: "running", data: {} }), "unknown_validation");
      expectRefused(await f.appendValidationEvent({ validation_id: VALIDATION, event_key: "x", type: "Not A Type", data: {} }), "invalid_request");
    });
    const page = expectOk(await f.readValidation({ validation_id: VALIDATION, after: 1, limit: 2 }));
    expect(page.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(page.events[0]).toMatchObject({ at: "2026-10-04T00:00:00.020Z", type: "copy_finished" });
    expect(page.next_after).toBe(3);
    expect(page.last_seq).toBe(4);
  });
});

describe("root owners", () => {
  it("names the request or the validation run a root execution belongs to", async () => {
    await acceptRequest(h, 1);
    expectOk(await f.recordValidation({ validation_id: uuid(9200), request_id: REQUEST, case_id: hex(61), root_execution_id: validationRoot(1) }));
    expect(expectOk(await f.readRoot({ root_execution_id: requestRoot(1) }))).toEqual({
      ok: true,
      root_execution_id: requestRoot(1),
      request_id: REQUEST,
      validation_id: null,
    });
    expect(expectOk(await f.readRoot({ root_execution_id: validationRoot(1) }))).toEqual({
      ok: true,
      root_execution_id: validationRoot(1),
      request_id: REQUEST,
      validation_id: uuid(9200),
    });
    expectRefused(await f.readRoot({ root_execution_id: validationRoot(2) }), "unknown_request");
  });
});

describe("read limits", () => {
  it.each([
    ["a zero limit", { limit: 0 }],
    ["a limit above 1000", { limit: 1001 }],
    ["a negative after", { after: -1 }],
  ])("refuses %s", async (_label, overrides) => {
    await acceptRequest(h, 1);
    expectRefused(await f.readRequest(loose({ request_id: REQUEST, after: 0, limit: 200, ...overrides })), "invalid_request");
  });
});
