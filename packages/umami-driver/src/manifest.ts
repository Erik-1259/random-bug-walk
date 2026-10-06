// The frozen original-suite manifest: every test Playwright enumerates with `--list` on the clean
// kit, the hashes of everything that decides which tests exist and how they run, and the runner's
// environment. Its SHA-256 is the expected trial's original_suite_sha256.
import { CanonicalError, canonicalDigest, encodeCanonical, parseCanonical, validateRecord } from "@rbw/schema";
import type { EnvironmentManifest } from "./environment.ts";
import type { ParsedReport } from "./playwright-report.ts";

export const SUITE_MANIFEST_VERSION = 1;

export interface SuiteTest {
  id: string;
  file: string;
  title_path: string[];
}

export interface SuiteManifest {
  schema_version: number;
  umami_commit: string;
  /** SHA-256 of every pristine closure file, by path relative to the suite root. */
  closure: Record<string, string>;
  /** SHA-256 of the verifier-owned files written into each copy (the wrapper config and the module marker). */
  harness: Record<string, string>;
  verifier_lock_sha256: string;
  environment: EnvironmentManifest;
  spec_files: string[];
  /** Every enumerated test, sorted by ID. */
  tests: SuiteTest[];
  test_count: number;
}

export class ManifestError extends Error {}

export function buildSuiteManifest(args: {
  report: ParsedReport;
  closure: Record<string, string>;
  harness: Record<string, string>;
  verifierLockSha256: string;
  environment: EnvironmentManifest;
  specFiles: readonly string[];
  umamiCommit: string;
}): SuiteManifest {
  const tests = args.report.tests
    .map((test) => ({ id: test.id, file: test.file, title_path: [...test.title_path] }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set<string>();
  for (const test of tests) {
    if (ids.has(test.id)) throw new ManifestError(`the listing has duplicate test ID ${test.id}`);
    ids.add(test.id);
  }
  const files = new Set(tests.map((test) => test.file));
  const silent = args.specFiles.filter((file) => !files.has(file));
  if (silent.length > 0) {
    throw new ManifestError(`the listing has no tests from ${silent.join(", ")}; the spec files did not all load`);
  }
  const unknown = [...files].filter((file) => !args.specFiles.includes(file));
  if (unknown.length > 0) throw new ManifestError(`the listing has tests from unpinned files: ${unknown.join(", ")}`);
  return {
    schema_version: SUITE_MANIFEST_VERSION,
    umami_commit: args.umamiCommit,
    closure: { ...args.closure },
    harness: { ...args.harness },
    verifier_lock_sha256: args.verifierLockSha256,
    environment: args.environment,
    spec_files: [...args.specFiles].sort(),
    tests,
    test_count: tests.length,
  };
}

export function encodeSuiteManifest(manifest: SuiteManifest): { bytes: Uint8Array; sha256: string } {
  return canonicalDigest(manifest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSha256(value: unknown): value is string {
  return validateRecord("Sha256", value).length === 0;
}

function isHashMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isSha256);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isEnvironment(value: unknown): value is EnvironmentManifest {
  return (
    isRecord(value) &&
    isStringMap(value.variables) &&
    isStringMap(value.after_identity_check) &&
    isStringArray(value.absent) &&
    isStringArray(value.run_args) &&
    isStringArray(value.list_args) &&
    typeof value.playwright_cli === "string" &&
    typeof value.playwright_version === "string" &&
    typeof value.node_version === "string"
  );
}

/** Reads a frozen manifest file: canonical bytes, then its shape, then that its count matches its tests. */
export function parseSuiteManifest(bytes: Uint8Array): SuiteManifest {
  let data: unknown;
  try {
    data = parseCanonical(bytes);
  } catch (error) {
    if (error instanceof CanonicalError) throw new ManifestError("suite manifest is not canonical JSON");
    throw error;
  }
  if (!Buffer.from(encodeCanonical(data)).equals(Buffer.from(bytes))) throw new ManifestError("suite manifest is not canonical bytes");
  if (!isRecord(data)) throw new ManifestError("suite manifest must be a JSON object");
  if (data.schema_version !== SUITE_MANIFEST_VERSION) throw new ManifestError("suite manifest has an unknown schema_version");
  if (typeof data.umami_commit !== "string") throw new ManifestError("suite manifest has no umami_commit");
  if (!isHashMap(data.closure) || !isHashMap(data.harness)) throw new ManifestError("suite manifest closure or harness hashes are malformed");
  if (!isSha256(data.verifier_lock_sha256)) throw new ManifestError("suite manifest verifier_lock_sha256 is malformed");
  if (!isEnvironment(data.environment)) throw new ManifestError("suite manifest environment is malformed");
  if (!isStringArray(data.spec_files)) throw new ManifestError("suite manifest spec_files is malformed");
  const tests = data.tests;
  if (
    !Array.isArray(tests) ||
    !tests.every(
      (test) => isRecord(test) && typeof test.id === "string" && typeof test.file === "string" && isStringArray(test.title_path),
    )
  ) {
    throw new ManifestError("suite manifest tests are malformed");
  }
  if (data.test_count !== tests.length) throw new ManifestError("suite manifest test_count does not match its tests");
  if (new Set(tests.map((test) => (test as SuiteTest).id)).size !== tests.length) {
    throw new ManifestError("suite manifest has duplicate test IDs");
  }
  return data as unknown as SuiteManifest;
}
