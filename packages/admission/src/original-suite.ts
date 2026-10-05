import { CanonicalError, canonicalDigest, parseCanonical, validateRecord } from "@rbw/schema";

/**
 * Reader for the per-test original-suite outcomes that the driver writes as an artifact. The
 * shared schema has no record for them yet, so this module is the one home of the local format;
 * if the driver's format differs when it lands, only this module changes.
 *
 * The artifact is an ArtifactManifest entry with kind original_suite_outcomes and media type
 * application/json, holding canonical JSON:
 *   { "schema_version": 1, "trial_id", "original_suite_sha256", "tests": [{ "test_id", "outcome" }] }
 * where outcome is passed, failed or skipped, tests are sorted by test_id in code point order and
 * unique, and unknown fields are refused. The importer checks trial_id and original_suite_sha256
 * against the result and the expected trial.
 */
export const ORIGINAL_SUITE_OUTCOMES_KIND = "original_suite_outcomes";
export const ORIGINAL_SUITE_OUTCOMES_MEDIA_TYPE = "application/json";

const OUTCOMES = ["passed", "failed", "skipped"] as const;
type TestOutcome = (typeof OUTCOMES)[number];

export interface OriginalSuiteOutcomes {
  schema_version: 1;
  trial_id: string;
  original_suite_sha256: string;
  tests: { test_id: string; outcome: TestOutcome }[];
}

export type OriginalSuiteRead = { ok: true; value: OriginalSuiteOutcomes } | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => key in value);
}

function isTest(value: unknown): value is { test_id: string; outcome: TestOutcome } {
  return (
    isObject(value) &&
    hasExactKeys(value, ["test_id", "outcome"]) &&
    validateRecord("TestId", value.test_id).length === 0 &&
    (OUTCOMES as readonly unknown[]).includes(value.outcome)
  );
}

function fail(error: string): OriginalSuiteRead {
  return { ok: false, error };
}

/** Parses the artifact's bytes: canonical bytes, then the fields, then the order of tests. */
export function readOriginalSuiteOutcomes(bytes: Uint8Array): OriginalSuiteRead {
  let value: unknown;
  try {
    value = parseCanonical(bytes);
  } catch (error) {
    if (error instanceof CanonicalError) return fail("canonical");
    throw error;
  }
  if (!Buffer.from(canonicalDigest(value).bytes).equals(bytes)) return fail("canonical");
  if (!isObject(value) || !hasExactKeys(value, ["schema_version", "trial_id", "original_suite_sha256", "tests"])) return fail("fields");
  if (value.schema_version !== 1) return fail("schema_version");
  if (validateRecord("TrialId", value.trial_id).length > 0) return fail("trial_id");
  if (validateRecord("Sha256", value.original_suite_sha256).length > 0) return fail("original_suite_sha256");
  const tests = value.tests;
  if (!Array.isArray(tests) || !tests.every(isTest)) return fail("tests");
  if (!tests.every((test, index) => index === 0 || (tests[index - 1]?.test_id ?? "") < test.test_id)) return fail("tests_order");
  return { ok: true, value: { schema_version: 1, trial_id: value.trial_id as string, original_suite_sha256: value.original_suite_sha256 as string, tests } };
}
