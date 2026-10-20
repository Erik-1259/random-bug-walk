import { TRIAL_PROFILES, canonicalDigest } from "@rbw/schema";
import { DEFAULT_PHASE_LIMITS } from "@rbw/umami-driver/limits";
import { validateContract } from "@rbw/factory-contract/validate";
import { describe, expect, it } from "vitest";
import { COPY_LIMITS } from "../src/copy-plans.ts";
import { TRIAL_OF_STATE, UMAMI_PROTOCOL, VALID_TRIAL_RULES, isUmamiProtocol } from "../src/protocol.ts";

describe("the protocol umami-time-zone-repeatability, version 1", () => {
  it("is the judge_verify trial profile: one copy per state, one round each, every run required", () => {
    expect(validateContract("Protocol", UMAMI_PROTOCOL)).toEqual([]);
    expect(UMAMI_PROTOCOL.protocol_id).toBe("umami-time-zone-repeatability");
    expect(UMAMI_PROTOCOL.version).toBe("1");
    const one = { copies: 1, rounds_per_copy: 1, min_valid_runs: 1 };
    expect(UMAMI_PROTOCOL.per_state).toEqual({ clean: one, buggy: one, fixed: one });
    expect(TRIAL_PROFILES.judge_verify.trials.map((trial) => [trial.trial_id, trial.code_state, trial.added_repeat_count])).toEqual([
      ["clean-01", "clean", 1],
      ["planted-01", "planted", 1],
      ["fixed-01", "fixed", 1],
    ]);
    expect(Object.values(TRIAL_OF_STATE)).toEqual(TRIAL_PROFILES.judge_verify.trials.map((trial) => trial.trial_id));
  });

  it("hashes every field but its own sha256, and names the rules interpret applies", () => {
    const { sha256, ...body } = UMAMI_PROTOCOL;
    expect(sha256).toBe(canonicalDigest(body).sha256);
    expect(UMAMI_PROTOCOL.valid_trial_rules).toEqual([...VALID_TRIAL_RULES]);
    expect(isUmamiProtocol(structuredClone(UMAMI_PROTOCOL))).toBe(true);
    expect(isUmamiProtocol({ ...UMAMI_PROTOCOL, per_state: { ...UMAMI_PROTOCOL.per_state, buggy: { copies: 2, rounds_per_copy: 1, min_valid_runs: 2 } } })).toBe(false);
  });

  it("declares the 240 s tests phase within the 720 s copy limit, with one round of the checks per copy", () => {
    expect(DEFAULT_PHASE_LIMITS.tests_ms).toBe(240_000);
    expect(COPY_LIMITS.timeout_s).toBe(720);
    expect(DEFAULT_PHASE_LIMITS.tests_ms).toBeLessThan(COPY_LIMITS.timeout_s * 1000);
    expect(UMAMI_PROTOCOL.per_state.buggy.rounds_per_copy).toBe(1);
  });
});
