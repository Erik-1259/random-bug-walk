import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { FetchFunction } from "../../src/http.ts";
import { profileSha256 } from "../../src/profile.ts";
import type { HashedProfile, ModelProfile } from "../../src/profile.ts";
import { createModelProvider, meteredStructuredCall } from "../../src/writer.ts";
import type { MeteredOutcome } from "../../src/writer.ts";
import { CANDIDATE, CONTEXT, SYNTHETIC_USAGE, completion } from "../fixtures/cases.ts";
import { POOL, SLOT, acquire, freshSpend, openDb, rateSheetBytes } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

type TestKind = "review.synthetic";

function testProfile(structuredOutput: HashedProfile["structured_output"]): ModelProfile<TestKind> {
  return {
    hashed: {
      provider: "token-factory",
      model: "synthetic/test-model",
      base_url: "https://api.tokenfactory.nebius.com/v1/",
      max_input_tokens: 4_096,
      max_output_tokens: 1_024,
      max_retries: 0,
      request_timeout_ms: 60_000,
      structured_output: structuredOutput,
      prompt_bound: { method: "utf8_bytes_plus_framing", per_message_framing_tokens: 8, per_request_framing_tokens: 128 },
    },
    request_extras: {},
    service: "token-factory.test-model",
    actor_role: "synthetic-reviewer",
    kinds: ["review.synthetic"],
    api_key_variable: "SYNTHETIC_TEST_KEY",
  };
}

const STRICT = testProfile("json_schema_strict");
const AFTER = testProfile("validated_after");

const RATES = rateSheetBytes(
  ["input_token", "output_token"].map((unit) => ({
    service: "token-factory.test-model",
    unit,
    price: { microusd: 100_000, per_units: 1_000_000 },
    source_url: "https://prices.example.invalid/synthetic",
  })),
);

const VerdictSchema = z.strictObject({ verdict: z.enum(["fix", "not_fix"]), reason: z.string() });
const VERDICT = { verdict: "fix", reason: "the synthetic change restores the expected bucket" };

/** Calls once under `profile`, answering with `content`; returns the outcome and the body sent. */
async function callWith(profile: ModelProfile<TestKind>, content: string): Promise<{ outcome: MeteredOutcome<z.infer<typeof VerdictSchema>, TestKind>; body: Record<string, unknown> }> {
  const { spend } = await freshSpend(db);
  await acquire(spend);
  const sent: string[] = [];
  const fetch: FetchFunction = (_input, init) => {
    sent.push(typeof init?.body === "string" ? init.body : "");
    return Promise.resolve(new Response(completion(content, SYNTHETIC_USAGE), { status: 200, headers: { "content-type": "application/json" } }));
  };
  const outcome = await meteredStructuredCall(
    { spend, provider: createModelProvider(profile, { fetch }), context: CONTEXT, poolKey: POOL, allocationKey: null, slotKey: SLOT, rateSheet: RATES },
    { kind: "review.synthetic", candidate: CANDIDATE, prompt: { system: "Synthetic reviewer instructions.", user: "Synthetic fix to review." }, schema: VerdictSchema },
  );
  expect(sent).toHaveLength(1);
  return { outcome, body: JSON.parse(sent[0] ?? "") as Record<string, unknown> };
}

describe("structured output validated after the call", () => {
  it("hashes the mode, so the two profiles differ only in it and in their digest", () => {
    expect(profileSha256(AFTER)).not.toBe(profileSha256(STRICT));
  });

  it("sends the strict JSON schema under json_schema_strict", async () => {
    const { outcome, body } = await callWith(STRICT, JSON.stringify(VERDICT));
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    expect(outcome).toMatchObject({ ok: true, output: VERDICT, call: { status: "completed", failure: null } });
  });

  it("sends no response_format under validated_after, and accepts a reply that is exactly the JSON object", async () => {
    const { outcome, body } = await callWith(AFTER, `\n${JSON.stringify(VERDICT)}\n`);
    expect(body).not.toHaveProperty("response_format");
    expect(body).toMatchObject({ model: "synthetic/test-model", max_tokens: 1_024 });
    expect(outcome).toMatchObject({ ok: true, output: VERDICT, call: { status: "completed", failure: null } });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.settlement).toMatchObject({ state: "reconciled" });
  });

  it.each([
    ["prose around the JSON", `Here is my answer: ${JSON.stringify(VERDICT)} Thanks.`],
    ["a fenced JSON block", `\`\`\`json\n${JSON.stringify(VERDICT)}\n\`\`\``],
    ["invalid JSON", '{"verdict": "fix", "reason": '],
    ["JSON that fails the schema", JSON.stringify({ verdict: "maybe", reason: "synthetic" })],
    ["JSON with an extra field", JSON.stringify({ ...VERDICT, extra: true })],
  ])("treats %s as invalid output under validated_after, settling the usage", async (_name, content) => {
    const { outcome } = await callWith(AFTER, content);
    expect(outcome).toMatchObject({ ok: true, output: null, call: { status: "failed", failure: "invalid_output", http_status: 200 } });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.settlement).toMatchObject({ state: "reconciled" });
  });
});
