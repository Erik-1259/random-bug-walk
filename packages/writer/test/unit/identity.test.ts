import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WRITER_PROFILE } from "../../src/config.ts";
import {
  callName,
  canonicalJson,
  operationId,
  parseRunContext,
  payloadHash,
  runtimeProfileSha256,
} from "../../src/identity.ts";
import { actualMicrousd, buildEnvelope, parseRateSheet, rateSheetSha256 } from "../../src/rates.ts";
import { CANDIDATE, CONTEXT, RATE_ENTRIES, uuid } from "../fixtures/cases.ts";
import { POOL, SLOT, freshSpend, openDb, rateSheetBytes } from "../support.ts";
import { createWriter, createWriterProvider } from "../../src/writer.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("canonical JSON and hashes", () => {
  it("sorts keys at every level and has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: null }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":null,"z":1}]},"b":1}',
    );
  });

  it("digests the frozen writer profile", () => {
    expect(runtimeProfileSha256()).toBe(sha(canonicalJson(WRITER_PROFILE)));
    expect(WRITER_PROFILE).toMatchObject({
      model: "nvidia/Nemotron-3_5-Lightning",
      base_url: "https://api.tokenfactory.nebius.com/v1/",
      max_input_tokens: 32768,
      max_output_tokens: 8192,
      max_calls_per_candidate: 12,
      max_retries: 0,
      enable_thinking: false,
    });
    expect(Object.isFrozen(WRITER_PROFILE)).toBe(true);
  });

  it("hashes the exact payload bytes", () => {
    expect(payloadHash('{"a":1}')).toBe(sha('{"a":1}'));
    expect(payloadHash('{"a":1}')).not.toBe(payloadHash('{ "a":1}'));
  });

  it("derives the operation ID from every identity field", () => {
    const context = parseRunContext(CONTEXT);
    const base = { context, kind: "writer.issue" as const, candidate: CANDIDATE, callOrdinal: 1 };
    const id = operationId(base);
    expect(id).toBe(
      sha(
        canonicalJson({
          attempt_ordinal: 1,
          batch_id: CONTEXT.batch_id,
          call_ordinal: 1,
          candidate: CANDIDATE,
          kind: "writer.issue",
          project_id: CONTEXT.project_id,
          project_policy_sha256: CONTEXT.project_policy_sha256,
          root_execution_id: CONTEXT.root_execution_id,
          runtime_profile_sha256: runtimeProfileSha256(),
          task_revision: CONTEXT.task_revision,
        }),
      ),
    );
    const variants = [
      operationId({ ...base, kind: "writer.card" }),
      operationId({ ...base, candidate: "synthetic-candidate-2" }),
      operationId({ ...base, callOrdinal: 2 }),
      operationId({ ...base, context: { ...context, batch_id: null } }),
      operationId({ ...base, context: { ...context, project_id: uuid(99) } }),
    ];
    expect(new Set([id, ...variants]).size).toBe(6);
  });

  it("builds call names that fit the spend label format", () => {
    expect(callName("writer.issue", CANDIDATE, 12)).toBe(`writer.issue.${CANDIDATE}.12`);
    expect(callName("writer.issue", CANDIDATE, 12)).toMatch(/^[a-z0-9._-]{1,64}$/);
  });
});

describe("the run context", () => {
  it("accepts the synthetic context", () => {
    expect(parseRunContext(CONTEXT)).toEqual(CONTEXT);
  });

  it.each([
    ["an unknown field", { ...CONTEXT, pool_key: POOL }],
    ["a missing field", { ...CONTEXT, execution_id: undefined }],
    ["an uppercase UUID", { ...CONTEXT, project_id: uuid(0xabc).toUpperCase() }],
    ["a short hash", { ...CONTEXT, task_revision: "abc" }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseRunContext(value)).toThrow(/run context/);
  });

  it("is validated when the writer is constructed", async () => {
    const { spend } = await freshSpend(db);
    expect(() =>
      createWriter({
        spend,
        provider: createWriterProvider({ fetch: () => Promise.reject(new Error("unused")) }),
        context: { ...CONTEXT, extra: true },
        poolKey: POOL,
        allocationKey: null,
        slotKey: SLOT,
        rateSheet: rateSheetBytes(),
      }),
    ).toThrow(/run context/);
  });
});

describe("rates and the envelope", () => {
  it("hashes the exact bytes of the rate file", () => {
    const bytes = rateSheetBytes();
    expect(rateSheetSha256(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("builds the two token lines with their limits and enforcement", () => {
    const sheet = parseRateSheet(rateSheetBytes());
    if (!sheet.ok) {
      throw new Error(sheet.detail);
    }
    expect(buildEnvelope(sheet.entries)).toEqual({
      ok: true,
      envelope: [
        {
          service: "token-factory",
          unit: "input_token",
          limit: 32768,
          enforced_by: "client_counter",
          price: RATE_ENTRIES[0]?.price,
        },
        {
          service: "token-factory",
          unit: "output_token",
          limit: 8192,
          enforced_by: "request_parameter",
          price: RATE_ENTRIES[1]?.price,
        },
      ],
    });
  });

  it("computes ceil(quantity × microusd ÷ per_units) exactly", () => {
    expect(actualMicrousd(1, { microusd: 60_000, per_units: 1_000_000 })).toBe(1);
    expect(actualMicrousd(0, { microusd: 60_000, per_units: 1_000_000 })).toBe(0);
    expect(actualMicrousd(1_000_000, { microusd: 60_000, per_units: 1_000_000 })).toBe(60_000);
    expect(actualMicrousd(1_000_001, { microusd: 60_000, per_units: 1_000_000 })).toBe(60_001);
    expect(actualMicrousd(9_007_199_254_740_991, { microusd: 3, per_units: 7 })).toBe(3_860_228_252_031_854);
  });
});
