import { readFileSync } from "node:fs";

/** The single data file of fixture rc-1-backup-code-001. Everything else reads it; nothing retypes it. */
export const FIXTURE_FILE = new URL("../data/rc-1-backup-code-001.v1.json", import.meta.url);

/** ADM-06 is not applicable to this family (see the data file's adm06 reason), so there is no partial or stub state. */
export const CODE_STATES = ["clean", "fixed", "planted"] as const;
export type CodeState = (typeof CODE_STATES)[number];

export const OBSERVED_VALUES = ["pass", "assertion_fail", "setup_fail"] as const;
export type Observed = (typeof OBSERVED_VALUES)[number];

/**
 * double_spend and backup_code_reused are this fixture's assertion failures; the other three are
 * the setup failure codes the protected driver already accepts.
 */
export const FAILURE_CODES = ["double_spend", "backup_code_reused", "unrelated_failure", "auth_failed", "seed_failed"] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export const CHECK_KINDS = ["serial_reuse", "concurrent_double_spend"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const ADM05_TRIALS = ["fixed-01", "planted-01"] as const;

export interface BackupCode {
  id: string;
  /** Synthetic plaintext, uppercase, as a user would type it. */
  plaintext: string;
  /** bcrypt hash at 10 rounds, the form Umami stores. */
  code_hash: string;
}

export interface FixtureCheck {
  check_id: string;
  kind: CheckKind;
  /** The backup code this check spends; each check has its own. */
  backup_code_id: string;
}

export interface ExpectedOutcome {
  check_id: string;
  observed: Observed;
  failure_code: FailureCode | null;
}

export interface Fixture {
  schema_version: 1;
  fixture_id: string;
  shape: "RC-1";
  host: { upstream: string; commit: string };
  /** The one line the planted mutation changes, as the pinned source holds it and as planted. */
  target: { path: string; clean_line: string; planted_line: string };
  /** The two-factor state baked into the template database for the pinned migration's admin user. */
  two_factor: { user_id: string; row_id: string; secret_column: string; backup_codes: BackupCode[] };
  checks: FixtureCheck[];
  outcome_vectors: Record<CodeState, ExpectedOutcome[]>;
  /** The declared vectors for the 20 repetitions in the first fixed and first planted copy. */
  adm05: { repetitions: 20; trials: Record<(typeof ADM05_TRIALS)[number], ExpectedOutcome[]> };
  adm06: { status: "not_applicable"; reason: string };
}

export class FixtureError extends Error {
  override name = "FixtureError";
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = Record<string, Json>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BCRYPT_10 = /^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/;
const SYNTHETIC_ID = /^synthetic-[a-z0-9-]+$/;
const BACKUP_CODE_COUNT = 10;

function fail(message: string): never {
  throw new FixtureError(`fixture data file: ${message}`);
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key] ?? null)]),
    );
  }
  return value;
}

function object(value: Json | undefined, path: string, keys: readonly string[]): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${path} must be an object`);
  }
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    fail(`${path} must have exactly the keys ${keys.join(", ")}`);
  }
  return value;
}

function array(value: Json | undefined, path: string): Json[] {
  if (!Array.isArray(value)) {
    return fail(`${path} must be an array`);
  }
  return value;
}

function string(value: Json | undefined, path: string): string {
  if (typeof value !== "string" || value === "") {
    return fail(`${path} must be a non-empty string`);
  }
  return value;
}

function matching(value: Json | undefined, pattern: RegExp, path: string): string {
  const text = string(value, path);
  if (!pattern.test(text)) {
    fail(`${path} does not have the expected form`);
  }
  return text;
}

function exact<T extends Json>(value: Json | undefined, expected: T, path: string): T {
  if (value !== expected) {
    fail(`${path} must be ${JSON.stringify(expected)}`);
  }
  return expected;
}

function oneOf<T extends string>(value: Json | undefined, options: readonly T[], path: string): T {
  return options.find((option) => option === value) ?? fail(`${path} is not one of ${options.join(", ")}`);
}

function parseTwoFactor(value: Json | undefined): Fixture["two_factor"] {
  const row = object(value, "two_factor", ["user_id", "row_id", "secret_column", "backup_codes"]);
  const codes = array(row.backup_codes, "two_factor.backup_codes").map((item, index): BackupCode => {
    const path = `two_factor.backup_codes[${String(index)}]`;
    const code = object(item, path, ["id", "plaintext", "code_hash"]);
    const plaintext = string(code.plaintext, `${path}.plaintext`);
    if (plaintext !== plaintext.toUpperCase() || !plaintext.startsWith("SYNTHETIC-")) {
      fail(`${path}.plaintext must be uppercase and start with SYNTHETIC-`);
    }
    return { id: matching(code.id, SYNTHETIC_ID, `${path}.id`), plaintext, code_hash: matching(code.code_hash, BCRYPT_10, `${path}.code_hash`) };
  });
  if (codes.length !== BACKUP_CODE_COUNT || new Set(codes.map((code) => code.id)).size !== codes.length || new Set(codes.map((code) => code.plaintext)).size !== codes.length) {
    fail(`two_factor.backup_codes must hold ${String(BACKUP_CODE_COUNT)} codes with unique ids and plaintexts`);
  }
  return {
    user_id: matching(row.user_id, UUID, "two_factor.user_id"),
    row_id: matching(row.row_id, SYNTHETIC_ID, "two_factor.row_id"),
    secret_column: matching(row.secret_column, SYNTHETIC_ID, "two_factor.secret_column"),
    backup_codes: codes,
  };
}

function parseChecks(value: Json | undefined, codes: readonly BackupCode[]): FixtureCheck[] {
  const checks = array(value, "checks").map((item, index): FixtureCheck => {
    const path = `checks[${String(index)}]`;
    const row = object(item, path, ["check_id", "kind", "backup_code_id"]);
    const codeId = string(row.backup_code_id, `${path}.backup_code_id`);
    if (!codes.some((code) => code.id === codeId)) {
      fail(`${path}.backup_code_id names no backup code`);
    }
    return { check_id: string(row.check_id, `${path}.check_id`), kind: oneOf(row.kind, CHECK_KINDS, `${path}.kind`), backup_code_id: codeId };
  });
  if (checks.map((check) => check.kind).join(",") !== "serial_reuse,concurrent_double_spend") {
    fail("checks must be the serial_reuse control followed by the concurrent_double_spend check");
  }
  if (new Set(checks.map((check) => check.check_id)).size !== checks.length || new Set(checks.map((check) => check.backup_code_id)).size !== checks.length) {
    fail("checks must have unique check ids and spend different backup codes");
  }
  return checks;
}

function parseVector(value: Json | undefined, path: string, checks: readonly FixtureCheck[]): ExpectedOutcome[] {
  const rows = array(value, path).map((item, index): ExpectedOutcome => {
    const rowPath = `${path}[${String(index)}]`;
    const row = object(item, rowPath, ["check_id", "observed", "failure_code"]);
    const observed = oneOf(row.observed, OBSERVED_VALUES, `${rowPath}.observed`);
    const failureCode = row.failure_code === null ? null : oneOf(row.failure_code, FAILURE_CODES, `${rowPath}.failure_code`);
    if ((observed === "pass") !== (failureCode === null)) {
      fail(`${rowPath} must pair pass with a null failure code`);
    }
    return { check_id: string(row.check_id, `${rowPath}.check_id`), observed, failure_code: failureCode };
  });
  if (rows.map((row) => row.check_id).join(",") !== checks.map((check) => check.check_id).join(",")) {
    fail(`${path} must list the checks in order`);
  }
  return rows;
}

function sameVector(left: readonly ExpectedOutcome[], right: readonly ExpectedOutcome[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Validates the data file's bytes and returns it typed. The file must be canonical JSON: keys
 * sorted at every level, two-space indent and a trailing newline. Re-rendering the parsed value
 * must reproduce the bytes, which also rejects duplicate keys.
 */
export function parseFixture(text: string): Fixture {
  let parsed: Json;
  try {
    parsed = JSON.parse(text) as Json;
  } catch (error) {
    throw new FixtureError("fixture data file: not valid JSON", { cause: error });
  }
  if (`${JSON.stringify(sortKeys(parsed), null, 2)}\n` !== text) {
    fail("not in canonical form (sorted keys, no duplicate keys, two-space indent, trailing newline)");
  }
  const root = object(parsed, "$", ["schema_version", "fixture_id", "shape", "host", "target", "two_factor", "checks", "outcome_vectors", "adm05", "adm06"]);
  const host = object(root.host, "host", ["upstream", "commit"]);
  const target = object(root.target, "target", ["path", "clean_line", "planted_line"]);
  const twoFactor = parseTwoFactor(root.two_factor);
  const checks = parseChecks(root.checks, twoFactor.backup_codes);
  const vectors = object(root.outcome_vectors, "outcome_vectors", CODE_STATES);
  const outcomeVectors = {
    clean: parseVector(vectors.clean, "outcome_vectors.clean", checks),
    fixed: parseVector(vectors.fixed, "outcome_vectors.fixed", checks),
    planted: parseVector(vectors.planted, "outcome_vectors.planted", checks),
  };
  for (const vector of Object.values(outcomeVectors)) {
    const control = vector[0];
    if (control?.observed !== "pass") {
      fail("the serial_reuse control must pass in every code state");
    }
  }
  const adm05 = object(root.adm05, "adm05", ["repetitions", "trials"]);
  const adm05Trials = object(adm05.trials, "adm05.trials", ADM05_TRIALS);
  const adm05Vectors = {
    "fixed-01": parseVector(adm05Trials["fixed-01"], "adm05.trials.fixed-01", checks),
    "planted-01": parseVector(adm05Trials["planted-01"], "adm05.trials.planted-01", checks),
  };
  if (!sameVector(adm05Vectors["fixed-01"], outcomeVectors.fixed) || !sameVector(adm05Vectors["planted-01"], outcomeVectors.planted)) {
    fail("adm05.trials must repeat the fixed and planted outcome vectors");
  }
  const adm06 = object(root.adm06, "adm06", ["status", "reason"]);
  return {
    schema_version: exact(root.schema_version, 1, "schema_version"),
    fixture_id: string(root.fixture_id, "fixture_id"),
    shape: exact(root.shape, "RC-1", "shape"),
    host: { upstream: string(host.upstream, "host.upstream"), commit: matching(host.commit, /^[0-9a-f]{40}$/, "host.commit") },
    target: {
      path: string(target.path, "target.path"),
      clean_line: string(target.clean_line, "target.clean_line"),
      planted_line: string(target.planted_line, "target.planted_line"),
    },
    two_factor: twoFactor,
    checks,
    outcome_vectors: outcomeVectors,
    adm05: { repetitions: exact(adm05.repetitions, 20, "adm05.repetitions"), trials: adm05Vectors },
    adm06: { status: exact(adm06.status, "not_applicable", "adm06.status"), reason: string(adm06.reason, "adm06.reason") },
  };
}

let cached: Fixture | undefined;

/** Reads and validates the committed data file once per process. */
export function loadFixture(): Fixture {
  cached ??= parseFixture(readFileSync(FIXTURE_FILE, "utf8"));
  return cached;
}

/** The backup code a check spends. */
export function backupCodeFor(fixture: Fixture, check: FixtureCheck): BackupCode {
  const code = fixture.two_factor.backup_codes.find((candidate) => candidate.id === check.backup_code_id);
  if (code === undefined) {
    throw new FixtureError(`no backup code ${check.backup_code_id}`);
  }
  return code;
}
