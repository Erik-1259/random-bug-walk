// The declared repetition protocol of the Umami catalog: the existing judge_verify trial profile
// (one copy per state, one round of the checks in each), which the admission importer accepts.
// It is read from the catalog alone, so a candidate's worst case is priced before anything runs.
import { TRIAL_PROFILES, canonicalDigest } from "@rbw/schema";
import type { CodeState } from "@rbw/schema";
import type { CopyState, Protocol, ProtocolState } from "@rbw/factory-contract";

export const PROTOCOL_ID = "umami-time-zone-repeatability";
export const PROTOCOL_VERSION = "1";

/** The judge_verify trial that runs each copy state, and the copy state each trial's code state is. */
export const TRIAL_OF_STATE: Readonly<Record<CopyState, string>> = { clean: "clean-01", buggy: "planted-01", fixed: "fixed-01" };
export const CODE_STATE_OF: Readonly<Record<CopyState, CodeState>> = { clean: "clean", buggy: "planted", fixed: "fixed" };

/**
 * The rules the adapter applies when it reads a copy's record set and combines copies; the README
 * describes each one.
 */
export const VALID_TRIAL_RULES = [
  "umami.frozen-job",
  "umami.admission-import",
  "umami.own-trial-only",
  "umami.original-suite-identity",
  "umami.declared-failure-code",
  "umami.min-valid-runs",
] as const;

/** One state's copies and rounds, read from the judge_verify trial profile. */
function stateOf(state: CopyState): ProtocolState {
  const trials = TRIAL_PROFILES.judge_verify.trials.filter((trial) => trial.code_state === CODE_STATE_OF[state]);
  const rounds = trials[0]?.added_repeat_count ?? 0;
  if (trials.length === 0 || trials.some((trial) => trial.added_repeat_count !== rounds)) {
    throw new Error(`the judge_verify profile has no uniform ${state} trials`);
  }
  return { copies: trials.length, rounds_per_copy: rounds, min_valid_runs: trials.length * rounds };
}

const PROTOCOL_BODY = {
  protocol_id: PROTOCOL_ID,
  version: PROTOCOL_VERSION,
  per_state: { clean: stateOf("clean"), buggy: stateOf("buggy"), fixed: stateOf("fixed") },
  valid_trial_rules: [...VALID_TRIAL_RULES],
};

/** The protocol with its sha256: the canonical hash of every other field. */
export const UMAMI_PROTOCOL: Protocol = { ...PROTOCOL_BODY, sha256: canonicalDigest(PROTOCOL_BODY).sha256 };

/** Whether a protocol is this one, field for field. */
export function isUmamiProtocol(protocol: Protocol): boolean {
  return canonicalDigest(protocol).sha256 === canonicalDigest(UMAMI_PROTOCOL).sha256;
}
