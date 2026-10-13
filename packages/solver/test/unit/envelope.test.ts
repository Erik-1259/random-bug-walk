import { readFileSync } from "node:fs";
import { encodeCanonical } from "@rbw/schema";
import { profileSha256 } from "@rbw/writer";
import { describe, expect, it } from "vitest";
import { countSolverPromptBound, readSolverRateSheet, solverEnvelope } from "../../src/envelope.ts";
import { KIMI_SOLVER_PROFILE, SUPER_SOLVER_PROFILE } from "../../src/profile.ts";

describe("the solver rate file", () => {
  it("prices Super at $0.30/$0.90 and Kimi at $0.95/$4.00 per million tokens", () => {
    const entries = JSON.parse(new TextDecoder().decode(readSolverRateSheet())) as { service: string; unit: string; price: { microusd: number; per_units: number } }[];
    const price = (service: string, unit: string) => entries.find((e) => e.service === service && e.unit === unit)?.price;
    expect(price("token-factory.nemotron-3-super", "input_token")).toEqual({ microusd: 300_000, per_units: 1_000_000 });
    expect(price("token-factory.nemotron-3-super", "output_token")).toEqual({ microusd: 900_000, per_units: 1_000_000 });
    expect(price("token-factory.kimi-k2.7-code", "input_token")).toEqual({ microusd: 950_000, per_units: 1_000_000 });
    expect(price("token-factory.kimi-k2.7-code", "output_token")).toEqual({ microusd: 4_000_000, per_units: 1_000_000 });
  });

  it("matches harvest-review's committed prices for the same services", () => {
    const review = readFileSync(new URL("../../../harvest-review/rates.json", import.meta.url), "utf8");
    expect(JSON.parse(new TextDecoder().decode(readSolverRateSheet()))).toEqual(JSON.parse(review));
  });
});

describe("the envelope", () => {
  it("reserves each Super turn at its per-call limits, rounded up per line", () => {
    const priced = solverEnvelope(readSolverRateSheet(), SUPER_SOLVER_PROFILE);
    if (!priced.ok) {
      throw new Error(priced.detail);
    }
    expect(priced.envelope.map((line) => [line.service, line.unit, line.limit])).toEqual([
      ["token-factory.nemotron-3-super", "input_token", 131_072],
      ["token-factory.nemotron-3-super", "output_token", 8_192],
    ]);
    // ceil(131072 × 0.3) + ceil(8192 × 0.9)
    expect(priced.turn_worst_case_microusd).toBe(39_322 + 7_373);
    expect(priced.attempt_worst_case_microusd).toBe((39_322 + 7_373) * 50);
  });

  it("prices Kimi from its own lines", () => {
    const priced = solverEnvelope(readSolverRateSheet(), KIMI_SOLVER_PROFILE);
    if (!priced.ok) {
      throw new Error(priced.detail);
    }
    // ceil(131072 × 0.95) + ceil(16384 × 4)
    expect(priced.turn_worst_case_microusd).toBe(124_519 + 65_536);
  });

  it("refuses a rate file without the profile's service", () => {
    const sheet = new TextEncoder().encode(JSON.stringify([]));
    expect(solverEnvelope(sheet, SUPER_SOLVER_PROFILE)).toEqual({ ok: false, detail: "the rate file has no token-factory.nemotron-3-super input_token price" });
  });
});

describe("the profiles", () => {
  it("hash to canonical JSON and differ by model", () => {
    expect(() => encodeCanonical(SUPER_SOLVER_PROFILE.hashed)).not.toThrow();
    expect(profileSha256(SUPER_SOLVER_PROFILE)).not.toBe(profileSha256(KIMI_SOLVER_PROFILE));
  });

  it("have the digests the README lists", () => {
    expect(profileSha256(SUPER_SOLVER_PROFILE)).toBe("978b87fdd5815b13cd42e5226080060526c65ed37d5328dd50045a57fb2586d4");
    expect(profileSha256(KIMI_SOLVER_PROFILE)).toBe("2e799c711837f0168afe24ae2e67b765f7680d06167254e21113a4d6bdad14e3");
  });

  it("hash the attempt caps, so a changed cap changes runtime_profile_sha256", () => {
    const changed = { ...SUPER_SOLVER_PROFILE, hashed: { ...SUPER_SOLVER_PROFILE.hashed, attempt_caps: { ...SUPER_SOLVER_PROFILE.hashed.attempt_caps, max_turns: 51 } } };
    expect(profileSha256(changed)).not.toBe(profileSha256(SUPER_SOLVER_PROFILE));
  });

  it("carry the pre-registered caps", () => {
    expect(SUPER_SOLVER_PROFILE.hashed.attempt_caps).toEqual({ max_turns: 50, max_input_tokens: 1_500_000, max_wall_ms: 2_400_000, max_rebuilds: 8 });
    expect(SUPER_SOLVER_PROFILE.hashed.sampling.temperature).toBe(String(SUPER_SOLVER_PROFILE.temperature));
  });
});

describe("the prompt bound", () => {
  it("counts every byte of the body, tool definitions and tool calls included, plus framing", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "é" }, { role: "assistant", content: null, tool_calls: [] }], tools: [{ name: "bash" }] });
    const bytes = new TextEncoder().encode(body).length;
    expect(countSolverPromptBound(body, SUPER_SOLVER_PROFILE)).toBe(bytes + 256 + 2 * 16);
  });

  it("refuses a body with no messages", () => {
    expect(() => countSolverPromptBound("{}", SUPER_SOLVER_PROFILE)).toThrow("no messages");
  });
});
