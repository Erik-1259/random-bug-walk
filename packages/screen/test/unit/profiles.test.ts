import { readFileSync } from "node:fs";
import { profileSha256 } from "@rbw/writer";
import { describe, expect, it } from "vitest";
import { budgetRefusal, worstCasePerCall } from "../../src/budget.ts";
import { KIMI_SCREEN_PROFILE, MAX_ATTEMPTS, SUPER_SCREEN_PROFILE } from "../../src/profiles.ts";
import { LINE_TOLERANCE, MAX_CLAIM_LINES } from "../../src/score.ts";
import { RATES, README } from "../support.ts";

const rates = readFileSync(RATES);
const readme = readFileSync(README, "utf8");

describe("screen profiles and rates", () => {
  it("prices both profiles from the screen's own rate file", () => {
    expect(worstCasePerCall(rates, SUPER_SCREEN_PROFILE)).toEqual({ ok: true, input_microusd: 19_661, output_microusd: 1_844, per_call_microusd: 21_505 });
    expect(worstCasePerCall(rates, KIMI_SCREEN_PROFILE)).toEqual({ ok: true, input_microusd: 196_608, output_microusd: 122_880, per_call_microusd: 319_488 });
  });

  it("refuses a rate file without the profile's service", () => {
    const other = new TextEncoder().encode(
      JSON.stringify([{ service: "token-factory.other", unit: "input_token", price: { microusd: 1, per_units: 1 }, source_url: "https://example.invalid/" }]),
    );
    expect(worstCasePerCall(other, SUPER_SCREEN_PROFILE)).toEqual({ ok: false, detail: "the rate file has no token-factory.nemotron-3.5-super-vl input_token price" });
  });

  it("hashes distinct profiles that send no temperature and carry their kind", () => {
    expect(profileSha256(SUPER_SCREEN_PROFILE)).not.toBe(profileSha256(KIMI_SCREEN_PROFILE));
    for (const profile of [SUPER_SCREEN_PROFILE, KIMI_SCREEN_PROFILE]) {
      expect(profile.hashed).toMatchObject({ kind: "screen.static", sampling: "provider_default", max_retries: 0 });
      expect(Object.keys(profile.request_extras)).not.toContain("temperature");
    }
  });

  it("fits the budget exactly at attempts times the worst case", () => {
    expect(budgetRefusal(4, 21_505, 86_020)).toBeNull();
    expect(budgetRefusal(4, 21_505, 86_019)).toMatch(/above the budget/);
  });
});

describe("README", () => {
  it("states the limits, worst cases and scoring constants the code uses", () => {
    for (const fact of [
      "| Super | `nvidia/Nemotron-3.5-Super-VL` | 65,536 | 2,048 | 300,000 | 19,661 + 1,844 = **21,505** |",
      "| Kimi | `moonshotai/Kimi-K3` | 65,536 | 8,192 | 600,000 | 196,608 + 122,880 = **319,488** |",
      `at most ${String(MAX_ATTEMPTS)} attempts`,
      `${String(LINE_TOLERANCE)} lines`,
      `${String(MAX_CLAIM_LINES)} lines`,
      "`TOKEN_FACTORY_SCREEN_KEY`",
      "172,040",
      "2,555,904",
    ]) {
      expect(readme).toContain(fact);
    }
  });
});
