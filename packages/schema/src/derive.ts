import { canonicalDigest, type CanonicalDigest } from "./canonical.ts";
import type { CodeState, JobKind, JobRequest, OperationIdentity } from "./generated.ts";

/**
 * Values derived from records, shared by the code rules and the builders. Nothing here
 * validates; python/schema/src/rbw_schema/derive.py computes the same values.
 */

export interface ProfileTrial {
  trial_id: string;
  code_state: CodeState;
  added_repeat_count: number;
}

export interface TrialProfile {
  trials: readonly ProfileTrial[];
  /** Whether every trial runs the original suite; only observe runs without it. */
  originalSuite: boolean;
}

/** `<state>-01` to `<state>-<count>`; the first trial repeats the added suite `firstRepeat` times, the rest once. */
function numbered(state: CodeState, count: number, firstRepeat: number): ProfileTrial[] {
  return Array.from({ length: count }, (_, index) => ({
    trial_id: `${state}-${String(index + 1).padStart(2, "0")}`,
    code_state: state,
    added_repeat_count: index === 0 ? firstRepeat : 1,
  }));
}

/** The trials each job kind runs, in order. */
export const TRIAL_PROFILES: Readonly<Record<JobKind, TrialProfile>> = {
  kit_check: { trials: numbered("clean", 5, 20), originalSuite: true },
  observe: { trials: numbered("planted", 1, 1), originalSuite: false },
  admission: {
    trials: [...numbered("clean", 1, 1), ...numbered("fixed", 5, 20), ...numbered("planted", 5, 20), ...numbered("partial", 1, 1), ...numbered("stub", 1, 1)],
    originalSuite: true,
  },
  judge_verify: { trials: [...numbered("clean", 1, 1), ...numbered("planted", 1, 1), ...numbered("fixed", 1, 1)], originalSuite: true },
};

type JobIdentityFields = Pick<
  JobRequest,
  "project_id" | "project_policy_sha256" | "root_execution_id" | "batch_id" | "task_revision" | "kind" | "runtime_profile_sha256" | "attempt_ordinal"
>;

/** The operation identity of a job request: its own fields, its kind, and a null call name. */
export function jobOperationIdentity(fields: JobIdentityFields): OperationIdentity {
  return {
    schema_version: 1,
    project_id: fields.project_id,
    project_policy_sha256: fields.project_policy_sha256,
    root_execution_id: fields.root_execution_id,
    batch_id: fields.batch_id,
    task_revision: fields.task_revision,
    kind: fields.kind,
    runtime_profile_sha256: fields.runtime_profile_sha256,
    call_name: null,
    attempt_ordinal: fields.attempt_ordinal,
  };
}

/** Canonical bytes and SHA-256 of a job request without its payload_hash key. */
export function jobPayloadDigest(fields: Omit<JobRequest, "payload_hash"> | JobRequest): CanonicalDigest {
  const rest: Record<string, unknown> = { ...fields };
  delete rest.payload_hash;
  return canonicalDigest(rest);
}

/**
 * A key that orders UtcTime values as instants: the seconds part, then the fraction padded to
 * nine digits, so 00.3Z and 00.300Z are equal and 00.5Z is after 00Z.
 */
export function utcInstantKey(value: string): string {
  return `${value.slice(0, 19)}${value.slice(20, -1).padEnd(9, "0")}`;
}

/** Whole seconds since 1970-01-01T00:00:00Z of a UtcTime without fraction. */
export function utcSeconds(value: string): number {
  const [year, month, day, hour, minute, second] = [value.slice(0, 4), value.slice(5, 7), value.slice(8, 10), value.slice(11, 13), value.slice(14, 16), value.slice(17, 19)].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // Days from the civil date (proleptic Gregorian), with integer arithmetic only.
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const days = era * 146097 + dayOfEra - 719468;
  return days * 86400 + hour * 3600 + minute * 60 + second;
}
