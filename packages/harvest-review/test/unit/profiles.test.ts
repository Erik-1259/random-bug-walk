import { readFileSync } from "node:fs";
import { buildEnvelope, parseRateSheet, profileSha256 } from "@rbw/writer";
import type { ModelProfile } from "@rbw/writer";
import { describe, expect, it } from "vitest";
import { KIMI_PROFILE, REVIEW_MODELS, SUPER_PROFILE } from "../../src/profiles.ts";
import { MAX_CANDIDATES } from "../../src/review.ts";
import { RATES } from "../support.ts";

function worstCase(profile: ModelProfile): number {
  const sheet = parseRateSheet(readFileSync(RATES));
  if (!sheet.ok) {
    throw new Error(sheet.detail);
  }
  const priced = buildEnvelope(sheet.entries, profile);
  if (!priced.ok) {
    throw new Error(priced.detail);
  }
  return priced.envelope.reduce((sum, line) => {
    const price = line.price;
    if (price === null) {
      throw new Error("an unpriced line");
    }
    return sum + Math.ceil((line.limit * price.microusd) / price.per_units);
  }, 0);
}

describe("the two review profiles", () => {
  it.each([
    [SUPER_PROFILE, "nvidia/nemotron-3-super-120b-a12b", "token-factory.nemotron-3-super", 1_024, 60_000, "json_schema_strict"],
    [KIMI_PROFILE, "moonshotai/Kimi-K2.7-Code", "token-factory.kimi-k2.7-code", 4_096, 120_000, "validated_after"],
  ])("hash the frozen limits and the model %s", (profile, model, service, maxOutputTokens, requestTimeoutMs, structuredOutput) => {
    expect(profile.hashed).toMatchObject({
      provider: "token-factory",
      model,
      base_url: "https://api.tokenfactory.nebius.com/v1/",
      max_input_tokens: 65_536,
      max_output_tokens: maxOutputTokens,
      max_retries: 0,
      request_timeout_ms: requestTimeoutMs,
      structured_output: structuredOutput,
      prompt_bound: { method: "utf8_bytes_plus_framing", per_message_framing_tokens: 16, per_request_framing_tokens: 256 },
      request_extras: profile.request_extras,
    });
    expect(profile).toMatchObject({
      service,
      actor_role: "harvest-review",
      kinds: ["harvest.review"],
      api_key_variable: "TOKEN_FACTORY_REVIEW_KEY",
    });
  });

  it("turns Super's thinking off as the writer does, and adds nothing to Kimi's requests", () => {
    expect(SUPER_PROFILE.request_extras).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(KIMI_PROFILE.request_extras).toEqual({});
  });

  it("keeps each profile's runtime_profile_sha256 at its committed value", () => {
    expect(profileSha256(SUPER_PROFILE)).toBe("bdc6abef90a2e86ddd1210d334350a73d833ce89e1a17c715c7e33dfaf2221bd");
    expect(profileSha256(KIMI_PROFILE)).toBe("9ab16d385a6e2fafb90352dcf7d2190173e294499fa810164f5173eb077f6992");
  });

  it("orders Super first at ordinal 1 and Kimi second at ordinal 2", () => {
    expect(REVIEW_MODELS.map((model) => [model.name, model.ordinal, model.profile])).toEqual([
      ["super", 1, SUPER_PROFILE],
      ["kimi", 2, KIMI_PROFILE],
    ]);
  });

  it("prices the worst case at 20,583 micro-USD per Super call and 78,644 per Kimi call, 793,816 for 8 candidates", () => {
    // ceil(65536 × 0.30) + ceil(1024 × 0.90), and ceil(65536 × 0.95) + ceil(4096 × 4.00) micro-USD.
    expect(worstCase(SUPER_PROFILE)).toBe(19_661 + 922);
    expect(worstCase(KIMI_PROFILE)).toBe(62_260 + 16_384);
    expect(worstCase(SUPER_PROFILE) + worstCase(KIMI_PROFILE)).toBe(99_227);
    expect(MAX_CANDIDATES * (worstCase(SUPER_PROFILE) + worstCase(KIMI_PROFILE))).toBe(793_816);
  });

  it("fits 8 candidates' request timeouts, 8 × (60 s + 120 s) = 24 minutes, in a 30-minute job", () => {
    const perCandidate = SUPER_PROFILE.hashed.request_timeout_ms + KIMI_PROFILE.hashed.request_timeout_ms;
    expect(MAX_CANDIDATES * perCandidate).toBe(24 * 60_000);
    expect(MAX_CANDIDATES * perCandidate).toBeLessThanOrEqual(30 * 60_000);
  });
});
