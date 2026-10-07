import type { PGlite } from "@electric-sql/pglite";
import type { ReserveRequest, Spend, TransitionRequest } from "@rbw/spend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { WRITER_MODEL_PROFILE, WRITER_PROFILE } from "../../src/config.ts";
import { meteredOperationId, operationId, parseRunContext, runtimeProfileSha256 } from "../../src/identity.ts";
import type { ModelProfile } from "../../src/profile.ts";
import { profileSha256 } from "../../src/profile.ts";
import { buildEnvelope, parseRateSheet } from "../../src/rates.ts";
import { createReplayFetch, makeRecording } from "../../src/recording.ts";
import type { Recording } from "../../src/recording.ts";
import { createModelProvider, meteredStructuredCall } from "../../src/writer.ts";
import type { MeteredCallOptions, MeteredRequest } from "../../src/writer.ts";
import type { FetchFunction } from "../../src/http.ts";
import { CANDIDATE, CONTEXT, RATE_ENTRIES, SYNTHETIC_USAGE, completion } from "../fixtures/cases.ts";
import { POOL, SLOT, acquire, freshSpend, openDb, rateSheetBytes } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

type TestKind = "review.synthetic";

function testProfile(model: string, service: string, role: string): ModelProfile<TestKind> {
  return {
    hashed: {
      provider: "token-factory",
      model,
      base_url: "https://api.tokenfactory.nebius.com/v1/",
      max_input_tokens: 4_096,
      max_output_tokens: 1_024,
      max_retries: 0,
      request_timeout_ms: 60_000,
      prompt_bound: { method: "utf8_bytes_plus_framing", per_message_framing_tokens: 8, per_request_framing_tokens: 128 },
    },
    request_extras: { synthetic_extra: { mode: "test" } },
    service,
    actor_role: role,
    kinds: ["review.synthetic"],
    api_key_variable: "SYNTHETIC_TEST_KEY",
  };
}

const TEST_PROFILE = testProfile("synthetic/test-model", "token-factory.test-model", "synthetic-reviewer");
const OTHER_PROFILE = testProfile("synthetic/other-model", "token-factory.other-model", "synthetic-other-reviewer");

const priced = (service: string) => [
  {
    service,
    unit: "input_token",
    price: { microusd: 100_000, per_units: 1_000_000 },
    source_url: "https://prices.example.invalid/synthetic",
  },
  {
    service,
    unit: "output_token",
    price: { microusd: 500_000, per_units: 1_000_000 },
    source_url: "https://prices.example.invalid/synthetic",
  },
];

const RATES = rateSheetBytes([
  ...RATE_ENTRIES,
  ...priced("token-factory.test-model"),
  ...priced("token-factory.other-model"),
]);

const VerdictSchema = z.strictObject({ verdict: z.enum(["fix", "not_fix"]), reason: z.string() });
const VERDICT = { verdict: "fix", reason: "the synthetic change restores the expected bucket" };

/**
 * A replay fetch whose recordings are made from each request it is shown, with the given profile's
 * model ID, so the replay path, the request key and the recording are all exercised.
 */
function synthesizingReplay(profile: ModelProfile, recordings: Recording[]): FetchFunction {
  return async (input, init) => {
    const recording = makeRecording(
      {
        requestBody: typeof init?.body === "string" ? init.body : "",
        status: 200,
        responseBody: completion(JSON.stringify(VERDICT), SYNTHETIC_USAGE),
        provenance: "synthetic",
        recordedAt: "2026-10-07T00:00:00Z",
      },
      profile,
    );
    recordings.push(recording);
    return createReplayFetch([recording])(input, init);
  };
}

interface Spied {
  spend: Spend;
  reserves: ReserveRequest[];
  transitions: TransitionRequest[];
  statusReads: string[];
}

function spied(spend: Spend): Spied {
  const out: Spied = { spend, reserves: [], transitions: [], statusReads: [] };
  out.spend = {
    ...spend,
    reserve: (request) => {
      out.reserves.push(request);
      return spend.reserve(request);
    },
    transition: (request) => {
      out.transitions.push(request);
      return spend.transition(request);
    },
    operationStatus: (request) => {
      out.statusReads.push(request.operation_id);
      return spend.operationStatus(request);
    },
  };
  return out;
}

async function ledger(): Promise<Spied> {
  const { spend } = await freshSpend(db);
  await acquire(spend);
  return spied(spend);
}

function options(spend: Spend, profile: ModelProfile<TestKind>, fetch: FetchFunction): MeteredCallOptions<TestKind> {
  return {
    spend,
    provider: createModelProvider(profile, { fetch }),
    context: CONTEXT,
    poolKey: POOL,
    allocationKey: null,
    slotKey: SLOT,
    rateSheet: RATES,
  };
}

const request = (callOrdinal?: number): MeteredRequest<z.infer<typeof VerdictSchema>, TestKind> => ({
  kind: "review.synthetic",
  candidate: CANDIDATE,
  prompt: { system: "Synthetic reviewer instructions.", user: "Synthetic fix to review." },
  schema: VerdictSchema,
  ...(callOrdinal === undefined ? {} : { callOrdinal }),
});

describe("the writer's identity", () => {
  it("keeps runtime_profile_sha256 at its value on main", () => {
    expect(runtimeProfileSha256()).toBe("906c19065ead7ecc7717df72462faa4efd1d6cbc0b4be16d8c4c7c8f904f24fd");
    expect(profileSha256(WRITER_MODEL_PROFILE)).toBe("906c19065ead7ecc7717df72462faa4efd1d6cbc0b4be16d8c4c7c8f904f24fd");
    expect(WRITER_MODEL_PROFILE.hashed).toBe(WRITER_PROFILE);
  });

  it("keeps the operation ID of a fixed context, kind, candidate and ordinal at its value on main", () => {
    const context = parseRunContext(CONTEXT);
    const identity = { context, kind: "writer.issue" as const, candidate: CANDIDATE, callOrdinal: 3, attemptOrdinal: 1 };
    expect(operationId(identity)).toBe("d0a43728eaaa33517611323dbde082f3961a32bcc943937814079a8cfb7620eb");
    expect(meteredOperationId(WRITER_MODEL_PROFILE, identity)).toBe(
      "d0a43728eaaa33517611323dbde082f3961a32bcc943937814079a8cfb7620eb",
    );
    expect(
      operationId({ context, kind: "writer.card", candidate: CANDIDATE, callOrdinal: 1, attemptOrdinal: 2 }),
    ).toBe("e7288d8b76b4ae85db0b7701477c1f46c06c58b894fcb0707875a301b5874ecc");
  });

  it("keeps the writer's unhashed config", () => {
    expect(WRITER_MODEL_PROFILE).toMatchObject({
      request_extras: { chat_template_kwargs: { enable_thinking: false } },
      service: "token-factory",
      actor_role: "writer",
      kinds: ["writer.card", "writer.issue"],
      api_key_variable: "TOKEN_FACTORY_WRITER_KEY",
    });
  });
});

describe("rates per profile", () => {
  it("prices each profile from its own service's entries, with its own limits", () => {
    const sheet = parseRateSheet(RATES);
    if (!sheet.ok) {
      throw new Error(sheet.detail);
    }
    expect(buildEnvelope(sheet.entries)).toEqual({
      ok: true,
      envelope: [
        { service: "token-factory", unit: "input_token", limit: 32_768, enforced_by: "client_counter", price: RATE_ENTRIES[0]?.price },
        { service: "token-factory", unit: "output_token", limit: 8_192, enforced_by: "request_parameter", price: RATE_ENTRIES[1]?.price },
      ],
    });
    expect(buildEnvelope(sheet.entries, TEST_PROFILE)).toEqual({
      ok: true,
      envelope: [
        {
          service: "token-factory.test-model",
          unit: "input_token",
          limit: 4_096,
          enforced_by: "client_counter",
          price: { microusd: 100_000, per_units: 1_000_000 },
        },
        {
          service: "token-factory.test-model",
          unit: "output_token",
          limit: 1_024,
          enforced_by: "request_parameter",
          price: { microusd: 500_000, per_units: 1_000_000 },
        },
      ],
    });
  });

  it("refuses a profile whose service has no entries", () => {
    const sheet = parseRateSheet(rateSheetBytes());
    if (!sheet.ok) {
      throw new Error(sheet.detail);
    }
    expect(buildEnvelope(sheet.entries, TEST_PROFILE)).toEqual({
      ok: false,
      detail: "the rate file has no token-factory.test-model input_token price",
    });
  });
});

describe("a second profile, end to end", () => {
  it("reserves, sends, records and transitions with the test profile's values", async () => {
    const l = await ledger();
    const recordings: Recording[] = [];
    const sent: string[] = [];
    const replay = synthesizingReplay(TEST_PROFILE, recordings);
    const fetch: FetchFunction = (input, init) => {
      sent.push(typeof init?.body === "string" ? init.body : "");
      return replay(input, init);
    };
    const outcome = await meteredStructuredCall(options(l.spend, TEST_PROFILE, fetch), request());
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.output).toEqual(VERDICT);
    expect(outcome.call).toMatchObject({ kind: "review.synthetic", call_ordinal: 1, status: "completed" });

    const reserve = l.reserves[0];
    expect(l.reserves).toHaveLength(1);
    expect(reserve?.runtime_profile_sha256).toBe(profileSha256(TEST_PROFILE));
    expect(reserve?.runtime_profile_sha256).not.toBe(runtimeProfileSha256());
    expect(reserve?.envelope.map((line) => [line.service, line.unit, line.limit])).toEqual([
      ["token-factory.test-model", "input_token", 4_096],
      ["token-factory.test-model", "output_token", 1_024],
    ]);
    // ceil(4096 × 0.1) + ceil(1024 × 0.5)
    expect(outcome.call.reserved_microusd).toBe(410n + 512n);

    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0] ?? "") as Record<string, unknown>;
    expect(body.model).toBe("synthetic/test-model");
    expect(body.max_tokens).toBe(1_024);
    expect(body.synthetic_extra).toEqual({ mode: "test" });
    expect(body).not.toHaveProperty("chat_template_kwargs");

    expect(recordings).toHaveLength(1);
    expect(recordings[0]?.model_id).toBe("synthetic/test-model");

    expect(l.transitions.map((t) => [t.to_state, t.actor_role])).toEqual([
      ["launching", "synthetic-reviewer"],
      ["terminal", "synthetic-reviewer"],
    ]);
    expect(outcome.call.settlement).toMatchObject({ state: "reconciled" });
  });

  it("counts the prompt bound with the profile's framing and refuses above its input limit", async () => {
    const l = await ledger();
    const outcome = await meteredStructuredCall(options(l.spend, TEST_PROFILE, synthesizingReplay(TEST_PROFILE, [])), request());
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    const body = JSON.parse(outcome.call.request_body) as { response_format: unknown };
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    expect(outcome.call.input_token_bound).toBe(
      128 + 2 * 8 + bytes("Synthetic reviewer instructions.") + bytes("Synthetic fix to review.") + bytes(JSON.stringify(body.response_format)),
    );

    const large = await meteredStructuredCall(options(l.spend, TEST_PROFILE, synthesizingReplay(TEST_PROFILE, [])), {
      ...request(),
      prompt: { system: "Synthetic reviewer instructions.", user: "x".repeat(4_096) },
    });
    expect(large).toMatchObject({ ok: false, code: "prompt_too_large" });
    expect(l.reserves).toHaveLength(1);
  });

  it("refuses a kind the profile does not list, before reserving", async () => {
    const l = await ledger();
    const outcome = await meteredStructuredCall(options(l.spend, TEST_PROFILE, synthesizingReplay(TEST_PROFILE, [])), {
      ...request(),
      kind: "writer.issue" as TestKind,
    });
    expect(outcome).toMatchObject({ ok: false, code: "invalid_input" });
    expect(l.reserves).toHaveLength(0);
  });
});

describe("a fixed ordinal", () => {
  it("reserves exactly the given ordinal at attempt 1 under two profiles, with no slot scan", async () => {
    const l = await ledger();
    const first = await meteredStructuredCall(options(l.spend, TEST_PROFILE, synthesizingReplay(TEST_PROFILE, [])), request(1));
    const second = await meteredStructuredCall(options(l.spend, OTHER_PROFILE, synthesizingReplay(OTHER_PROFILE, [])), request(2));
    if (!first.ok || !second.ok) {
      throw new Error("a fixed-ordinal call was refused");
    }
    expect(l.statusReads).toEqual([]);
    expect(l.reserves.map((r) => [r.call_name, r.attempt_ordinal, r.previous_operation_id])).toEqual([
      [`review.synthetic:${CANDIDATE}:1`, 1, null],
      [`review.synthetic:${CANDIDATE}:2`, 1, null],
    ]);
    const context = parseRunContext(CONTEXT);
    const identity = { context, kind: "review.synthetic", candidate: CANDIDATE, attemptOrdinal: 1 };
    expect(first.call.operation_id).toBe(meteredOperationId(TEST_PROFILE, { ...identity, callOrdinal: 1 }));
    expect(second.call.operation_id).toBe(meteredOperationId(OTHER_PROFILE, { ...identity, callOrdinal: 2 }));
    expect(l.reserves.map((r) => r.envelope[0]?.service)).toEqual(["token-factory.test-model", "token-factory.other-model"]);
    expect(l.transitions.map((t) => t.actor_role)).toEqual([
      "synthetic-reviewer",
      "synthetic-reviewer",
      "synthetic-other-reviewer",
      "synthetic-other-reviewer",
    ]);
  });

  it("is not limited by the per-candidate cap", async () => {
    const l = await ledger();
    const outcome = await meteredStructuredCall(options(l.spend, TEST_PROFILE, synthesizingReplay(TEST_PROFILE, [])), request(13));
    expect(outcome).toMatchObject({ ok: true, call: { call_ordinal: 13 } });
    expect(l.statusReads).toEqual([]);
  });

  it("refuses a replay of the same fixed-ordinal call as operation_replayed, sending nothing", async () => {
    const l = await ledger();
    const sent: string[] = [];
    const replay = synthesizingReplay(TEST_PROFILE, []);
    const fetch: FetchFunction = (input, init) => {
      sent.push("fetch");
      return replay(input, init);
    };
    const first = await meteredStructuredCall(options(l.spend, TEST_PROFILE, fetch), request(1));
    expect(first.ok).toBe(true);
    const again = await meteredStructuredCall(options(l.spend, TEST_PROFILE, fetch), request(1));
    expect(again).toMatchObject({ ok: false, code: "operation_replayed" });
    expect(again.ok ? null : again.operation_id).toBe(first.ok ? first.call.operation_id : "none");
    expect(sent).toHaveLength(1);
  });

  it.each([0, -1, 1.5])("refuses the ordinal %s before reserving", async (ordinal) => {
    const l = await ledger();
    const outcome = await meteredStructuredCall(
      options(l.spend, TEST_PROFILE, synthesizingReplay(TEST_PROFILE, [])),
      request(ordinal),
    );
    expect(outcome).toMatchObject({ ok: false, code: "invalid_input" });
    expect(l.reserves).toHaveLength(0);
  });
});
