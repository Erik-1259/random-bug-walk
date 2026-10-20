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

  it("fits the 240 s tests phase and the 720 s copy limit with the headroom the published judge replays measured", () => {
    // The three published judge replays of the released case (runs dd28e4f2, 9a403b66 and
    // dd8a971d) ran this exact profile on Sandbox amd64: tests phases 76.7 to 99.3 s, and copy run
    // times 172.7 to 206.0 s.
    const measured = { tests_phase_ms: [87_689, 87_792, 80_373, 88_704, 99_027, 87_935, 91_230, 99_274, 76_736], copy_run_ms: [179_515, 175_295, 174_595, 177_620, 205_969, 172_715, 199_761, 204_232, 173_040] };
    const testsLimit = DEFAULT_PHASE_LIMITS.tests_ms;
    const copyLimit = COPY_LIMITS.timeout_s * 1000;
    expect(Math.max(...measured.tests_phase_ms)).toBeLessThan(testsLimit / 2);
    expect(Math.max(...measured.copy_run_ms)).toBeLessThan(copyLimit / 3);
    expect(UMAMI_PROTOCOL.per_state.buggy.rounds_per_copy).toBe(1);
  });
});
