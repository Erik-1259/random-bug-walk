// The fixture package (@rbw/umami-fixture) as the driver uses it, from its README's "Interface for
// the protected driver": one round is
// `playwright test --config <fixture>/playwright.config.ts --workers=1 --retries=0`, which writes
// report.json, responses/<check_id>.json and observations/<check_id>.json into an empty directory.
// In the kit the package sits in the verifier, outside any node_modules, so the driver loads its
// reset by path rather than by package name.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ASSERTION_FAILURE_CODE_VALUES, encodeCanonical, sha256Hex, validateRecord } from "@rbw/schema";
import type { AssertionFailureCode, TrialReason } from "@rbw/schema";
import type { FixtureModule } from "./database.ts";
import { RUNNER_PATH } from "./environment.ts";
import type { ParsedReport, ReportedTest } from "./playwright-report.ts";
import type { CommandSpec } from "./process.ts";

/** The setup failure codes the fixture writes; each is a shared trial reason. */
export const SETUP_FAILURE_CODES = ["auth_failed", "seed_failed", "unrelated_failure"] as const satisfies readonly TrialReason[];
type SetupFailureCode = (typeof SETUP_FAILURE_CODES)[number];

/** The fixture's combinations of an observed value and its failure code. */
type GradedOutcome =
  | { observed: "pass"; failure_code: null }
  | { observed: "assertion_fail"; failure_code: AssertionFailureCode }
  | { observed: "setup_fail"; failure_code: SetupFailureCode };

/** One check's outcome file, as the fixture writes it. */
export type FixtureOutcome = {
  check_id: string;
  repeat_index: number;
  duration_ms: number;
  /** Relative to the round's output directory: responses/<check_id>.json. */
  response_artifact_key: string | null;
  response_artifact_sha256: string | null;
} & GradedOutcome;

export interface AdminCredentials {
  username: string;
  password: string;
}

export function fixtureCommand(options: {
  nodePath: string;
  verifierNodeModules: string;
  configPath: string;
  cwd: string;
  baseUrl: string;
  repeatIndex: number;
  outputDir: string;
  /** Playwright's own scratch output goes to the operating system's temporary directory. */
  tmpDir: string;
  admin: AdminCredentials;
}): CommandSpec {
  return {
    command: options.nodePath,
    args: [join(options.verifierNodeModules, "@playwright/test/cli.js"), "test", "--config", options.configPath, "--workers=1", "--retries=0"],
    cwd: options.cwd,
    env: {
      FORCE_COLOR: "0",
      HOME: dirname(options.outputDir),
      PATH: RUNNER_PATH,
      TMPDIR: options.tmpDir,
      TZ: "UTC",
      RBW_FIXTURE_BASE_URL: options.baseUrl,
      RBW_FIXTURE_REPEAT_INDEX: String(options.repeatIndex),
      RBW_FIXTURE_OUTPUT_DIR: options.outputDir,
      RBW_FIXTURE_ADMIN_USERNAME: options.admin.username,
      RBW_FIXTURE_ADMIN_PASSWORD: options.admin.password,
    },
  };
}

const OUTCOME_FIELDS = [
  "check_id",
  "repeat_index",
  "observed",
  "failure_code",
  "duration_ms",
  "response_artifact_key",
  "response_artifact_sha256",
];

export type OutcomeParse = { ok: true; outcome: FixtureOutcome } | { ok: false; problem: string };

/** Validates one outcome file for the expected check and round. */
export function parseFixtureOutcome(bytes: Buffer, checkId: string, repeatIndex: number): OutcomeParse {
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, problem: "outcome file is not valid JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, problem: "outcome is not an object" };
  const value = data as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== [...OUTCOME_FIELDS].sort().join(",")) return { ok: false, problem: "outcome fields differ from the interface" };
  if (value.check_id !== checkId) return { ok: false, problem: "outcome is for another check" };
  if (value.repeat_index !== repeatIndex) return { ok: false, problem: "outcome is for another round" };
  const graded = gradedOutcome(value.observed, value.failure_code);
  if (typeof graded === "string") return { ok: false, problem: graded };
  const duration = value.duration_ms;
  if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 0) {
    return { ok: false, problem: "duration_ms is not a non-negative integer" };
  }
  const key = value.response_artifact_key;
  const hash = value.response_artifact_sha256;
  if ((key === null) !== (hash === null)) return { ok: false, problem: "response key and hash must both be set or both be null" };
  if (key !== null && key !== `responses/${checkId}.json`) return { ok: false, problem: "response key is not responses/<check_id>.json" };
  if (hash !== null && (typeof hash !== "string" || validateRecord("Sha256", hash).length > 0)) {
    return { ok: false, problem: "response hash is not a lowercase SHA-256" };
  }
  return {
    ok: true,
    outcome: {
      check_id: checkId,
      repeat_index: repeatIndex,
      ...graded,
      duration_ms: duration,
      response_artifact_key: key === null ? null : `responses/${checkId}.json`,
      response_artifact_sha256: hash,
    },
  };
}

/** The observed value and its failure code, when they are one of the fixture's combinations; otherwise the problem. */
function gradedOutcome(observed: unknown, code: unknown): GradedOutcome | string {
  if (observed === "pass") return code === null ? { observed, failure_code: null } : "a pass has a failure code";
  if (observed === "assertion_fail") {
    const known = ASSERTION_FAILURE_CODE_VALUES.find((item) => item === code);
    return known === undefined ? "unknown assertion failure code" : { observed, failure_code: known };
  }
  if (observed === "setup_fail") {
    const known = SETUP_FAILURE_CODES.find((item) => item === code);
    return known === undefined ? "unknown setup failure code" : { observed, failure_code: known };
  }
  return "unknown observed value";
}

/** The report's test for a check: the one test whose title path contains the check ID as a whole title. */
export function findCheckTest(report: ParsedReport, checkId: string): ReportedTest | null {
  const matches = report.tests.filter((test) => test.title_path.includes(checkId));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * The SHA-256 of the fixture package: canonical JSON of every file's path and hash, leaving out
 * node_modules and the top-level test-results directory, where Playwright writes each round's
 * run state next to the fixture's config.
 */
export async function addedSuiteSha256(dir: string): Promise<string> {
  const hashes: Record<string, string> = {};
  const visit = async (prefix: string): Promise<void> => {
    for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "node_modules" && path !== "test-results") await visit(path);
      else if (entry.isFile()) hashes[path] = sha256Hex(await readFile(join(dir, path)));
    }
  };
  await visit("");
  return sha256Hex(encodeCanonical(hashes));
}

/**
 * Loads the template copy and the reset from the fixture package's entry module,
 * `<fixture>/src/index.ts`: `createFixtureTemplate`, `resetFixture` and `TEMPLATE_DATABASE`.
 */
export async function loadFixtureModule(dir: string): Promise<FixtureModule> {
  const module = (await import(pathToFileURL(join(dir, "src", "index.ts")).href)) as Record<string, unknown>;
  const { createFixtureTemplate, resetFixture, TEMPLATE_DATABASE } = module;
  if (typeof createFixtureTemplate !== "function" || typeof resetFixture !== "function" || typeof TEMPLATE_DATABASE !== "string") {
    throw new Error("the fixture package does not export createFixtureTemplate, resetFixture and TEMPLATE_DATABASE");
  }
  return {
    TEMPLATE_DATABASE,
    createFixtureTemplate: async (connectionString) => {
      await (createFixtureTemplate as (connectionString: string) => Promise<void>)(connectionString);
    },
    resetFixture: async (connectionString) => {
      await (resetFixture as (connectionString: string) => Promise<void>)(connectionString);
    },
  };
}
