import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { canonicalDigest, operationId as schemaOperationId, validateRecord } from "@rbw/schema";
import type { OperationIdentity } from "@rbw/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WRITER_PROFILE } from "../../src/config.ts";
import {
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
    expect(runtimeProfileSha256()).toBe(canonicalDigest(WRITER_PROFILE).sha256);
    // The digest before the schema's encoder replaced the local one: the bytes are the same.
    expect(runtimeProfileSha256()).toBe("906c19065ead7ecc7717df72462faa4efd1d6cbc0b4be16d8c4c7c8f904f24fd");
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

  it("is the schema's operation ID of the call's OperationIdentity", () => {
    const context = parseRunContext(CONTEXT);
    const identity: OperationIdentity = {
      schema_version: 1,
      project_id: CONTEXT.project_id,
      project_policy_sha256: CONTEXT.project_policy_sha256,
      root_execution_id: CONTEXT.root_execution_id,
      batch_id: CONTEXT.batch_id,
      task_revision: CONTEXT.task_revision,
      kind: "writer.issue",
      runtime_profile_sha256: runtimeProfileSha256(),
      call_name: `writer.issue:${CANDIDATE}:3`,
      attempt_ordinal: 2,
    };
    expect(validateRecord("CallName", identity.call_name)).toEqual([]);
    expect(operationId({ context, kind: "writer.issue", candidate: CANDIDATE, callOrdinal: 3, attemptOrdinal: 2 })).toBe(
      schemaOperationId(identity).sha256,
    );
  });

  it("derives the operation ID from every identity field", () => {
    const context = parseRunContext(CONTEXT);
    const base = { context, kind: "writer.issue" as const, candidate: CANDIDATE, callOrdinal: 1, attemptOrdinal: 1 };
    const id = operationId(base);
    const variants = [
      operationId({ ...base, kind: "writer.card" }),
      operationId({ ...base, candidate: "synthetic-candidate-2" }),
      operationId({ ...base, callOrdinal: 2 }),
      operationId({ ...base, attemptOrdinal: 2 }),
      operationId({ ...base, context: { ...context, batch_id: uuid(98) } }),
      operationId({ ...base, context: { ...context, project_id: uuid(99) } }),
    ];
    expect(new Set([id, ...variants]).size).toBe(7);
    expect(operationId({ ...base, context: { ...context, execution_id: uuid(97) } })).toBe(id);
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
    ["a null batch ID, which an OperationIdentity cannot carry", { ...CONTEXT, batch_id: null }],
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
