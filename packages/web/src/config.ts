// The site's one configuration loader. RBW_RESULTS_DIR names the results directory the pages are
// prerendered from; a relative value is resolved against the app directory, where next runs. The
// judge and factory routes' server variables are read here too, in the route handlers only, so none
// of them reaches the client bundle.
import { resolve } from "node:path";
import { OTF_DEFAULTS } from "./otf/contract.ts";

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

/** The bug designer's default model: NVIDIA Nemotron 3 Super on Nebius Token Factory. */
export const DEFAULT_ASSIST_MODEL = "nvidia/nemotron-3-super-120b-a12b";
/** A model ID as Token Factory names them: provider/model, plain characters only. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface AssistConfig {
  /** RBW_ASSIST_TOKEN_FACTORY_KEY: the Token Factory key the designer's model calls use; null leaves them unavailable. */
  tokenFactoryKey: string | null;
  /** RBW_ASSIST_TAVILY_KEY: the Tavily key the designer's web searches use; null leaves them unavailable. */
  tavilyKey: string | null;
  /** RBW_ASSIST_MODEL: the model ID, DEFAULT_ASSIST_MODEL when unset or not a plain provider/model ID. */
  model: string;
}

/** The bug designer's server variables. Each is optional; a route whose key is missing answers assist_unavailable. */
export function loadAssistConfig(env: Env = process.env): AssistConfig {
  const model = value(env, "RBW_ASSIST_MODEL");
  return {
    tokenFactoryKey: value(env, "RBW_ASSIST_TOKEN_FACTORY_KEY"),
    tavilyKey: value(env, "RBW_ASSIST_TAVILY_KEY"),
    model: model !== null && MODEL_ID.test(model) ? model : DEFAULT_ASSIST_MODEL,
  };
}

/** A loopback origin with no path: http://localhost, 127.0.0.1 or [::1], with an optional port. */
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

/**
 * RBW_ASSIST_TEST_PROVIDER_ORIGIN: test only. A local stub standing in for Token Factory (at
 * /v1/chat/completions) and Tavily (at /search). It is honored only in factory test mode on a local
 * server (RBW_FACTORY_TEST_MODE=1 and VERCEL_ENV unset or development) and only for a loopback http
 * origin; anywhere else it is ignored and the designer calls the real providers.
 */
export function assistTestProviderOrigin(env: Env = process.env): string | null {
  const origin = value(env, "RBW_ASSIST_TEST_PROVIDER_ORIGIN");
  const environment = value(env, "VERCEL_ENV");
  const local = environment === null || environment === "development";
  return origin !== null && LOOPBACK_ORIGIN.test(origin) && value(env, "RBW_FACTORY_TEST_MODE") === "1" && local ? origin : null;
}

// ---- On-the-fly bug creation (OTF). Every OTF variable is read here, the power and cron ones too,
// so the route modules share one reading of them. docs/otf/SPEC.md describes what each one does.

/** One build lane as configured: the lane IDs are assigned lane-1, lane-2, ... in order. */
export interface OtfLaneConfig {
  model: string;
  model_label: string;
  price_in_usd_per_m: string;
  price_out_usd_per_m: string;
}

export interface OtfConfig {
  /**
   * RBW_OTF_BUILDER_SECRET: the builder routes' HMAC secret, at least OTF_SECRET_MIN_CHARS long;
   * null when unset or shorter. Without it every OTF route answers unavailable (fail closed).
   */
  builderSecret: string | null;
  /** DATABASE_URL: the database whose `otf` schema holds the jobs; null leaves OTF unavailable. */
  databaseUrl: string | null;
  /** RBW_OTF_LANES: a JSON array of 1 to 4 lanes; null when unset or invalid, which leaves OTF unavailable. */
  lanes: OtfLaneConfig[] | null;
  /** Why RBW_OTF_LANES was refused, for the log (never its value); null when it parsed or is unset. */
  lanesError: string | null;
  /** RBW_OTF_MAX_ACTIVE: build jobs running at once. */
  maxActive: number;
  /** RBW_OTF_MAX_QUEUED: jobs waiting beyond the active ones. */
  maxQueued: number;
  /** RBW_OTF_MAX_PER_DAY: jobs created per UTC day. */
  maxPerDay: number;
  /** RBW_OTF_SPEND_CAP_MICROUSD: total reported OTF model spend before creates are refused and builds stopped. */
  spendCapMicrousd: number;
  /** RBW_OTF_MAX_USD_LANE and RBW_OTF_MAX_USD_JOB: the model spend caps sent with each build job. */
  maxUsdLane: string;
  maxUsdJob: string;
  /** RBW_OTF_DEADLINE_MIN: minutes from claim to the job deadline. */
  deadlineMs: number;
  /** RBW_OTF_VM_HOURS_PER_DAY: builder machine hours per UTC day. */
  vmHoursPerDay: number;
  /**
   * RBW_NEBIUS_SA_ID, RBW_NEBIUS_SA_KEY_ID, RBW_NEBIUS_SA_PRIVATE_KEY and RBW_NEBIUS_VM_ID: the
   * power-only service-account key and the one instance it may start and stop; null unless all four are set.
   */
  nebius: { serviceAccountId: string; keyId: string; privateKey: string; instanceId: string } | null;
  /** CRON_SECRET: the bearer token Vercel Cron sends to the power cron route; null disables that route. */
  cronSecret: string | null;
}

export const OTF_SECRET_MIN_CHARS = 32;
/** The default total OTF model spend cap: $40 (decision E15's recommendation), in micro-USD. */
export const DEFAULT_OTF_SPEND_CAP_MICROUSD = 40_000_000;
const OTF_LANES_MAX = 4;
const OTF_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$/;
const OTF_USD = /^\d{1,6}(?:\.\d{1,6})?$/;

/** A whole number in [min, max] from the variable, or the fallback when it is unset or not one. */
function wholeNumber(env: Env, name: string, fallback: number, min: number, max: number): number {
  const found = value(env, name);
  if (found === null || !/^\d{1,15}$/.test(found)) return fallback;
  const parsed = Number(found);
  return parsed >= min && parsed <= max ? parsed : fallback;
}

function usd(env: Env, name: string, fallback: string): string {
  const found = value(env, name);
  return found !== null && OTF_USD.test(found) ? found : fallback;
}

/** Parses RBW_OTF_LANES: [{model, model_label, price_in_usd_per_m, price_out_usd_per_m}, ...], 1 to 4 lanes. */
export function parseOtfLanes(text: string): { ok: true; lanes: OtfLaneConfig[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "RBW_OTF_LANES is not JSON" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > OTF_LANES_MAX) return { ok: false, error: `RBW_OTF_LANES must be an array of 1 to ${String(OTF_LANES_MAX)} lanes` };
  const lanes: OtfLaneConfig[] = [];
  for (const [index, item] of (parsed as unknown[]).entries()) {
    const lane = item as Partial<Record<keyof OtfLaneConfig, unknown>> | null;
    const keys = typeof item === "object" && item !== null ? Object.keys(item).sort().join(",") : "";
    const ok =
      lane !== null &&
      keys === "model,model_label,price_in_usd_per_m,price_out_usd_per_m" &&
      typeof lane.model === "string" &&
      OTF_MODEL.test(lane.model) &&
      typeof lane.model_label === "string" &&
      lane.model_label.length > 0 &&
      lane.model_label.length <= 120 &&
      typeof lane.price_in_usd_per_m === "string" &&
      OTF_USD.test(lane.price_in_usd_per_m) &&
      typeof lane.price_out_usd_per_m === "string" &&
      OTF_USD.test(lane.price_out_usd_per_m);
    if (!ok) return { ok: false, error: `RBW_OTF_LANES lane ${String(index + 1)} is not {model, model_label, price_in_usd_per_m, price_out_usd_per_m}` };
    lanes.push({ model: lane.model as string, model_label: lane.model_label as string, price_in_usd_per_m: lane.price_in_usd_per_m as string, price_out_usd_per_m: lane.price_out_usd_per_m as string });
  }
  return { ok: true, lanes };
}

export function loadOtfConfig(env: Env = process.env): OtfConfig {
  const secret = value(env, "RBW_OTF_BUILDER_SECRET");
  const lanesText = value(env, "RBW_OTF_LANES");
  const lanes = lanesText === null ? null : parseOtfLanes(lanesText);
  const saId = value(env, "RBW_NEBIUS_SA_ID");
  const keyId = value(env, "RBW_NEBIUS_SA_KEY_ID");
  const privateKey = value(env, "RBW_NEBIUS_SA_PRIVATE_KEY");
  const instanceId = value(env, "RBW_NEBIUS_VM_ID");
  return {
    builderSecret: secret !== null && secret.length >= OTF_SECRET_MIN_CHARS ? secret : null,
    databaseUrl: value(env, "DATABASE_URL"),
    lanes: lanes?.ok === true ? lanes.lanes : null,
    lanesError: lanes?.ok === false ? lanes.error : null,
    maxActive: wholeNumber(env, "RBW_OTF_MAX_ACTIVE", OTF_DEFAULTS.max_active, 1, 16),
    maxQueued: wholeNumber(env, "RBW_OTF_MAX_QUEUED", OTF_DEFAULTS.max_queued, 0, 100),
    maxPerDay: wholeNumber(env, "RBW_OTF_MAX_PER_DAY", OTF_DEFAULTS.max_per_day, 0, 1000),
    spendCapMicrousd: wholeNumber(env, "RBW_OTF_SPEND_CAP_MICROUSD", DEFAULT_OTF_SPEND_CAP_MICROUSD, 0, 1_000_000_000_000),
    maxUsdLane: usd(env, "RBW_OTF_MAX_USD_LANE", OTF_DEFAULTS.max_usd_lane),
    maxUsdJob: usd(env, "RBW_OTF_MAX_USD_JOB", OTF_DEFAULTS.max_usd_job),
    deadlineMs: wholeNumber(env, "RBW_OTF_DEADLINE_MIN", OTF_DEFAULTS.deadline_ms / 60_000, 5, 180) * 60_000,
    vmHoursPerDay: wholeNumber(env, "RBW_OTF_VM_HOURS_PER_DAY", OTF_DEFAULTS.vm_hours_per_day, 0, 24),
    nebius: saId === null || keyId === null || privateKey === null || instanceId === null ? null : { serviceAccountId: saId, keyId, privateKey, instanceId },
    cronSecret: value(env, "CRON_SECRET"),
  };
}

/** Whether the OTF routes can run at all: a builder secret, a database and the lanes. */
export function otfConfigured(config: OtfConfig): boolean {
  return config.builderSecret !== null && config.databaseUrl !== null && config.lanes !== null;
}
