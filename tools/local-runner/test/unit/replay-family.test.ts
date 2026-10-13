// A judge replay reads its family and race latency back from the frozen job: the race fixture's
// vectors in the expected trials, and the latency whose copy profile hash the request names.
import { describe, expect, it } from "vitest";
import type { CodeState } from "@rbw/schema";
import { FAMILIES, MAX_RACE_LATENCY_MS, frozenJobFamily, latencyOfProfile, profileSha256 } from "../../src/index.ts";
import type { FamilyId, FrozenJob } from "../../src/index.ts";

/** A frozen judge job whose three trials expect the family's fixture vectors, under the given profile hash. */
function frozen(family: FamilyId, profile: string, states: readonly CodeState[] = ["clean", "planted", "fixed"]): FrozenJob {
  const vectors = FAMILIES[family].loadFixture().outcome_vectors;
  return {
    request: { runtime_profile_sha256: profile },
    expected: {
      trials: states.map((state) => ({
        trial_id: `${state}-01`,
        code_state: state,
        patch_sha256: null,
        original_suite_sha256: "a".repeat(64),
        original_test_ids: [],
        added_suite_sha256: "b".repeat(64),
        added_repeat_count: 1,
        expected_checks: (vectors[state] ?? []).map((row) => ({ check_id: row.check_id, expected: row.observed, failure_code: row.failure_code })),
      })) as FrozenJob["expected"]["trials"],
    },
  };
}

describe("frozenJobFamily", () => {
  it("reads a race job's family and its latency from the expected vectors and the profile hash", () => {
    expect(frozenJobFamily(frozen("race", profileSha256(75)))).toEqual({ ok: true, family: "race", raceLatencyMs: 75 });
    expect(frozenJobFamily(frozen("race", profileSha256(0)))).toEqual({ ok: true, family: "race", raceLatencyMs: 0 });
    expect(frozenJobFamily(frozen("race", profileSha256(MAX_RACE_LATENCY_MS)))).toEqual({ ok: true, family: "race", raceLatencyMs: MAX_RACE_LATENCY_MS });
  });

  it("refuses a race job under the plain copy profile, which names no latency and is the time-zone family's", () => {
    const outcome = frozenJobFamily(frozen("race", profileSha256()));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toMatch(/race job's runtime profile is the plain copy profile, with no race latency/);
  });

  it("reads a time-zone job as the default family with no latency, as every replay was before", () => {
    expect(frozenJobFamily(frozen("time-zone", profileSha256()))).toEqual({ ok: true, family: "time-zone", raceLatencyMs: null });
    // Another family's vectors (here, the time-zone ones with the race profile) are never read as race.
    expect(frozenJobFamily(frozen("time-zone", profileSha256(75)))).toEqual({ ok: true, family: "time-zone", raceLatencyMs: null });
  });

  it("does not take a job as race when only some trials expect the race fixture's vectors", () => {
    const mixed = frozen("race", profileSha256(75));
    const timeZone = frozen("time-zone", profileSha256());
    const [first] = timeZone.expected.trials;
    if (first === undefined) throw new Error("synthetic: no trial");
    const trials = [...mixed.expected.trials.slice(0, 2), first];
    expect(frozenJobFamily({ ...mixed, expected: { trials } })).toEqual({ ok: true, family: "time-zone", raceLatencyMs: null });
  });

  it("refuses a race job whose profile hash is no latency's copy profile", () => {
    const outcome = frozenJobFamily(frozen("race", "c".repeat(64)));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toMatch(/runtime profile is not the copy profile at any latency from 0 to 10000 ms/);
  });
});

describe("latencyOfProfile", () => {
  it("inverts profileSha256 over every latency the proxy accepts", () => {
    expect(latencyOfProfile(profileSha256())).toBeNull();
    for (const ms of [0, 1, 50, 75, 9999, MAX_RACE_LATENCY_MS]) expect(latencyOfProfile(profileSha256(ms))).toBe(ms);
    expect(latencyOfProfile(profileSha256(MAX_RACE_LATENCY_MS + 1))).toBeUndefined();
    expect(latencyOfProfile("d".repeat(64))).toBeUndefined();
  });
});
