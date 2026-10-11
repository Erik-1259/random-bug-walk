// The site's one configuration loader. RBW_RESULTS_DIR names the results directory the pages are
// prerendered from; a relative value is resolved against the app directory, where next runs. The
// judge routes' server variables are read here too, in the route handlers only, so none of them
// reaches the client bundle.
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

export interface JudgeConfig {
  /** RBW_JUDGE_PASSCODE: the one shared judge passcode; null disables the judge routes. */
  passcode: string | null;
  /** RBW_JUDGE_RELEASE_ID and RBW_JUDGE_RELEASE_SHA256: the release the routes accept. */
  releaseId: string | null;
  releaseSha256: string | null;
  /** RBW_JUDGE_HOLD_CLEARED_AT: replays created before this time do not count for the hold. */
  holdClearedAt: string | null;
  credentials: Record<(typeof CONTROLLER_CREDENTIALS)[number], string>;
}

function value(env: Env, name: string): string | null {
  const found = env[name];
  return found === undefined || found === "" ? null : found;
}

export function loadJudgeConfig(env: Env = process.env): JudgeConfig {
  return {
    passcode: value(env, "RBW_JUDGE_PASSCODE"),
    releaseId: value(env, "RBW_JUDGE_RELEASE_ID"),
    releaseSha256: value(env, "RBW_JUDGE_RELEASE_SHA256"),
    holdClearedAt: value(env, "RBW_JUDGE_HOLD_CLEARED_AT"),
    credentials: Object.fromEntries(CONTROLLER_CREDENTIALS.map((name) => [name, env[name] ?? ""])) as JudgeConfig["credentials"],
  };
}

/** Whether the judge routes are configured for this release, so the page can offer the replay. */
export function judgeEnabled(config: JudgeConfig, releaseId: string | null): boolean {
  return config.passcode !== null && releaseId !== null && config.releaseId === releaseId && config.releaseSha256 !== null;
}
