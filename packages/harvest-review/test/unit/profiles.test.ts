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
    [SUPER_PROFILE, "nvidia/Nemotron-3.5-Super-VL", "token-factory.nemotron-3.5-super-vl", 1_024, 60_000, "json_schema_strict"],
    [KIMI_PROFILE, "moonshotai/Kimi-K3", "token-factory.kimi-k3", 8_192, 600_000, "validated_after"],
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
    expect(profileSha256(SUPER_PROFILE)).toBe("83c666efceb23fdc9ac61dc071c1da97446a16be042dc710536d30567d43900a");
    expect(profileSha256(KIMI_PROFILE)).toBe("a63e12d079537348a80cdee0d7f64b598e8966f41c545bdfff1e65b58177aada");
  });

  it("orders Super first at ordinal 1 and Kimi second at ordinal 2", () => {
    expect(REVIEW_MODELS.map((model) => [model.name, model.ordinal, model.profile])).toEqual([
      ["super", 1, SUPER_PROFILE],
      ["kimi", 2, KIMI_PROFILE],
    ]);
  });

  it("prices the worst case at 20,583 micro-USD per Super call and 319,488 per Kimi call, 2,720,568 for 8 candidates", () => {
    // ceil(65536 × 0.30) + ceil(1024 × 0.90), and ceil(65536 × 3.00) + ceil(8192 × 15.00) micro-USD.
    expect(worstCase(SUPER_PROFILE)).toBe(19_661 + 922);
    expect(worstCase(KIMI_PROFILE)).toBe(196_608 + 122_880);
    expect(worstCase(SUPER_PROFILE) + worstCase(KIMI_PROFILE)).toBe(340_071);
    expect(MAX_CANDIDATES * (worstCase(SUPER_PROFILE) + worstCase(KIMI_PROFILE))).toBe(2_720_568);
  });

  it("fits 8 candidates' request timeouts, 8 × (60 s + 600 s) = 88 minutes, in a 120-minute job", () => {
    const perCandidate = SUPER_PROFILE.hashed.request_timeout_ms + KIMI_PROFILE.hashed.request_timeout_ms;
    expect(MAX_CANDIDATES * perCandidate).toBe(88 * 60_000);
    expect(MAX_CANDIDATES * perCandidate).toBeLessThanOrEqual(120 * 60_000);
  });
});
