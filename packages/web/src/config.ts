// The site's one configuration loader. RBW_RESULTS_DIR names the results directory the pages are
// prerendered from; a relative value is resolved against the app directory, where next runs. The
// judge and factory routes' server variables are read here too, in the route handlers only, so none
// of them reaches the client bundle.
import { resolve } from "node:path";

export const DEFAULT_RESULTS_DIR = "fixtures/development-2026-10-06";

export interface SiteConfig {
  resultsDir: string;
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadSiteConfig(env: Env = process.env, cwd: string = process.cwd()): SiteConfig {
  const value = env.RBW_RESULTS_DIR;
  return { resultsDir: resolve(cwd, value === undefined || value === "" ? DEFAULT_RESULTS_DIR : value) };
}

/** The credentials the controller sandbox receives as environment values, with the route's OIDC token. */
export const CONTROLLER_CREDENTIALS = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "DATABASE_URL", "BLOB_PRIVATE_STORE_ID"] as const;

/** The most releases the judge allowlist may name: as many as the site shows. */
export const MAX_ALLOWED_RELEASES = 99;

/** One release the judge routes accept: its ID and the SHA-256 of its release.json bytes. */
export interface AllowedRelease {
  releaseId: string;
  sha256: string;
}

/** RBW_JUDGE_RELEASES, parsed: the allowlist, or why it was refused. */
export type ReleaseList = { ok: true; releases: AllowedRelease[] } | { ok: false; error: string };

export interface JudgeConfig {
  /** RBW_JUDGE_PASSCODE: the one shared judge passcode; null disables the judge routes. */
  passcode: string | null;
  /** RBW_JUDGE_RELEASE_ID and RBW_JUDGE_RELEASE_SHA256: the one release the routes accept when RBW_JUDGE_RELEASES is unset. */
  releaseId: string | null;
  releaseSha256: string | null;
  /** RBW_JUDGE_RELEASES: the releases the routes accept; null when it is unset, so the single pair above applies. */
  releaseList: ReleaseList | null;
  /** RBW_JUDGE_HOLD_CLEARED_AT: replays created before this time do not count for the hold. */
  holdClearedAt: string | null;
  credentials: Record<(typeof CONTROLLER_CREDENTIALS)[number], string>;
}

function value(env: Env, name: string): string | null {
  const found = env[name];
  return found === undefined || found === "" ? null : found;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Parses RBW_JUDGE_RELEASES: `<release_id>=<sha256>` pairs separated by commas or white space, 1 to
 * MAX_ALLOWED_RELEASES of them, each release ID once. Anything else refuses the whole list, so no
 * release is accepted.
 */
export function parseReleaseList(text: string): ReleaseList {
  const items = text.split(/[\s,]+/).filter((item) => item !== "");
  if (items.length === 0) return { ok: false, error: "RBW_JUDGE_RELEASES names no release" };
  if (items.length > MAX_ALLOWED_RELEASES) return { ok: false, error: `RBW_JUDGE_RELEASES names ${String(items.length)} releases; at most ${String(MAX_ALLOWED_RELEASES)} are supported` };
  const releases: AllowedRelease[] = [];
  for (const item of items) {
    const [releaseId = "", sha256 = "", ...rest] = item.split("=");
    if (rest.length > 0 || !UUID.test(releaseId) || !SHA256.test(sha256)) return { ok: false, error: `RBW_JUDGE_RELEASES entry ${item} is not <release_id>=<sha256>` };
    if (releases.some((found) => found.releaseId === releaseId)) return { ok: false, error: `RBW_JUDGE_RELEASES names release ${releaseId} twice` };
    releases.push({ releaseId, sha256 });
  }
  return { ok: true, releases };
}

export function loadJudgeConfig(env: Env = process.env): JudgeConfig {
  // Empty counts as unset, as for every variable here; a value with no pair in it is refused.
  const list = value(env, "RBW_JUDGE_RELEASES");
  return {
    passcode: value(env, "RBW_JUDGE_PASSCODE"),
    releaseId: value(env, "RBW_JUDGE_RELEASE_ID"),
    releaseSha256: value(env, "RBW_JUDGE_RELEASE_SHA256"),
    releaseList: list === null ? null : parseReleaseList(list),
    holdClearedAt: value(env, "RBW_JUDGE_HOLD_CLEARED_AT"),
    credentials: Object.fromEntries(CONTROLLER_CREDENTIALS.map((name) => [name, env[name] ?? ""])) as JudgeConfig["credentials"],
  };
}

/**
 * The releases the judge routes accept: RBW_JUDGE_RELEASES when it is set (none when it was refused),
 * otherwise the single RBW_JUDGE_RELEASE_ID and RBW_JUDGE_RELEASE_SHA256 pair when both are set.
 */
export function allowedReleases(config: JudgeConfig): AllowedRelease[] {
  if (config.releaseList !== null) return config.releaseList.ok ? config.releaseList.releases : [];
  if (config.releaseId === null || config.releaseSha256 === null) return [];
  return [{ releaseId: config.releaseId, sha256: config.releaseSha256 }];
}

/** Whether the judge routes are configured for this release, so the page can offer the replay. */
export function judgeEnabled(config: JudgeConfig, releaseId: string | null): boolean {
  return config.passcode !== null && releaseId !== null && allowedReleases(config).some((allowed) => allowed.releaseId === releaseId);
}

/**
 * The factory routes' mode: `live` uses the wired dependencies, `test` the deterministic fakes of
 * contract section 15.1, and `refused` answers every factory call `unavailable`, because test mode
 * was asked for on a Vercel deployment.
 */
export type FactoryMode = "live" | "test" | "refused";

/** Where live mode runs the factory worker: a Vercel sandbox, or a child process of the local server. */
export type FactoryWorkerBackend = "sandbox" | "local";

export interface FactoryConfig {
  mode: FactoryMode;
  /** RBW_JUDGE_PASSCODE: the factory session is an HMAC of the judges' passcode; null disables it. */
  passcode: string | null;
  /** RBW_FACTORY_TEST_FIXTURES: the contract fixtures test mode replays, resolved against the app directory. */
  testFixturesDir: string;
  /** DATABASE_URL: the spend ledger live mode records in; null leaves live mode not configured. */
  databaseUrl: string | null;
  /** VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID for the worker sandboxes; null unless all three are set. */
  sandbox: { token: string; teamId: string; projectId: string } | null;
  /** RBW_FACTORY_WORKER_IMAGE: the worker image pinned by digest, for the sandbox backend. */
  workerImage: string | null;
  /** RBW_FACTORY_PACKAGES_DIR: the prepared packages directory, resolved against the app directory. */
  packagesDir: string | null;
  /**
   * RBW_FACTORY_WORKER_BACKEND: `sandbox` (the default) or `local`; null for any other value, and for
   * `local` whenever VERCEL_ENV is set, so a deployment never runs workers as local processes.
   */
  workerBackend: FactoryWorkerBackend | null;
  /** The repository root, two levels above the app directory: the local backend runs its worker command from it. */
  repoRoot: string;
}

export const DEFAULT_FACTORY_TEST_FIXTURES = "../../docs/product/fixtures/bug-request-v1";

/**
 * RBW_FACTORY_TEST_MODE=1 selects test mode, which keeps its records in one server process's memory. It
 * is refused on any Vercel deployment (VERCEL_ENV preview or production), where instances do not share
 * that memory; a local `next dev` or `vercel dev` (VERCEL_ENV unset or development) keeps it. Live
 * mode reads the ledger, the worker launch and the prepared packages directory from the variables
 * named on FactoryConfig.
 */
export function loadFactoryConfig(env: Env = process.env, cwd: string = process.cwd()): FactoryConfig {
  const test = value(env, "RBW_FACTORY_TEST_MODE") === "1";
  const environment = value(env, "VERCEL_ENV");
  const deployed = environment === "preview" || environment === "production";
  const token = value(env, "VERCEL_TOKEN");
  const teamId = value(env, "VERCEL_TEAM_ID");
  const projectId = value(env, "VERCEL_PROJECT_ID");
  const packagesDir = value(env, "RBW_FACTORY_PACKAGES_DIR");
  const backend = value(env, "RBW_FACTORY_WORKER_BACKEND") ?? "sandbox";
  return {
    mode: test ? (deployed ? "refused" : "test") : "live",
    passcode: value(env, "RBW_JUDGE_PASSCODE"),
    testFixturesDir: resolve(cwd, value(env, "RBW_FACTORY_TEST_FIXTURES") ?? DEFAULT_FACTORY_TEST_FIXTURES),
    databaseUrl: value(env, "DATABASE_URL"),
    sandbox: token === null || teamId === null || projectId === null ? null : { token, teamId, projectId },
    workerImage: value(env, "RBW_FACTORY_WORKER_IMAGE"),
    packagesDir: packagesDir === null ? null : resolve(cwd, packagesDir),
    workerBackend: backend === "sandbox" ? "sandbox" : backend === "local" && environment === null ? "local" : null,
    repoRoot: resolve(cwd, "../.."),
  };
}
