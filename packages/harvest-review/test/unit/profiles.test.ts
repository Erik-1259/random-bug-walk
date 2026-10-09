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
    [SUPER_PROFILE, "nvidia/nemotron-3-super-120b-a12b", "token-factory.nemotron-3-super", 4_096, 120_000],
    [KIMI_PROFILE, "moonshotai/Kimi-K2.7-Code", "token-factory.kimi-k2.7-code", 32_768, 1_200_000],
  ])("hash the frozen limits and the model %s", (profile, model, service, maxOutputTokens, requestTimeoutMs) => {
    expect(profile.hashed).toMatchObject({
      provider: "token-factory",
      model,
      base_url: "https://api.tokenfactory.nebius.com/v1/",
      max_input_tokens: 65_536,
      max_output_tokens: maxOutputTokens,
      max_retries: 0,
      request_timeout_ms: requestTimeoutMs,
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
    expect(profileSha256(SUPER_PROFILE)).toBe("ea1e2ebde4ac4b49080e997c7fa4d96e2aaa9e5656d0d2d99c34ef1d205651b7");
    expect(profileSha256(KIMI_PROFILE)).toBe("debb9d0eb0a14795e3017e8bbdb1233b62bd00eeb8b74bf891fe66a2f4b22bce");
  });

  it("orders Super first at ordinal 1 and Kimi second at ordinal 2", () => {
    expect(REVIEW_MODELS.map((model) => [model.name, model.ordinal, model.profile])).toEqual([
      ["super", 1, SUPER_PROFILE],
      ["kimi", 2, KIMI_PROFILE],
    ]);
  });

  it("prices the worst case at 23,348 micro-USD per Super call and 193,332 per Kimi call, 1,733,440 for 8 candidates", () => {
    // ceil(65536 × 0.30) + ceil(4096 × 0.90), and ceil(65536 × 0.95) + ceil(32768 × 4.00) micro-USD.
    expect(worstCase(SUPER_PROFILE)).toBe(19_661 + 3_687);
    expect(worstCase(KIMI_PROFILE)).toBe(62_260 + 131_072);
    expect(worstCase(SUPER_PROFILE) + worstCase(KIMI_PROFILE)).toBe(216_680);
    expect(MAX_CANDIDATES * (worstCase(SUPER_PROFILE) + worstCase(KIMI_PROFILE))).toBe(1_733_440);
  });
});
