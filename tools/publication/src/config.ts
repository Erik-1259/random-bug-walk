import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_TIMEOUT_MS } from "./run.ts";

/** Environment variable that names the gitleaks command when no flag gives one. */
export const GITLEAKS_COMMAND_VARIABLE = "RBW_GITLEAKS_COMMAND";

/** A flag value wins over the environment variable, which wins over the default. */
export function resolveSetting(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv,
  variable: string,
  fallback?: string,
): string | undefined {
  if (flagValue !== undefined) return flagValue;
  const fromEnv = env[variable];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return fallback;
}

export function resolveGitleaksCommand(flagValue: string | undefined, env: NodeJS.ProcessEnv): string {
  return resolveSetting(flagValue, env, GITLEAKS_COMMAND_VARIABLE, "gitleaks") ?? "gitleaks";
}

export interface HelperConfig {
  mode: "serve" | "once";
  inboxRoot: string;
  registryPath: string;
  stateDir: string;
  patternFile: string;
  gitleaksCommand: string;
  ghCommand: string;
  pollIntervalMs: number;
  /** Extra environment variable names passed to the push, remote reads and gh. */
  passEnv: string[];
  /** Time limits for git, gh and gitleaks children, in milliseconds. */
  timeouts: ChildTimeouts;
}

export interface ChildTimeouts {
  git: number;
  gh: number;
  gitleaks: number;
}

const HELPER_SETTINGS = {
  inbox: "RBW_INBOX",
  registry: "RBW_REGISTRY",
  state: "RBW_STATE_DIR",
  patterns: "RBW_PATTERNS",
  gitleaks: GITLEAKS_COMMAND_VARIABLE,
  gh: "RBW_GH_COMMAND",
  "poll-interval-ms": "RBW_POLL_INTERVAL_MS",
  "pass-env": "RBW_PASS_ENV",
  "git-timeout-ms": "RBW_GIT_TIMEOUT_MS",
  "gh-timeout-ms": "RBW_GH_TIMEOUT_MS",
  "gitleaks-timeout-ms": "RBW_GITLEAKS_TIMEOUT_MS",
} as const;

export const HELPER_USAGE = `usage: node tools/publication/src/helper.ts <serve|once>
  --inbox <dir>             host inbox root (${HELPER_SETTINGS.inbox})
  --registry <file>         host-only registry file (${HELPER_SETTINGS.registry})
  --state <dir>             host-only state directory (${HELPER_SETTINGS.state})
  --patterns <file>         private pattern file (${HELPER_SETTINGS.patterns})
  --gitleaks <command>      gitleaks command, default gitleaks (${HELPER_SETTINGS.gitleaks})
  --gh <command>            gh command, default gh (${HELPER_SETTINGS.gh})
  --poll-interval-ms <ms>   serve poll interval, default 2000 (${HELPER_SETTINGS["poll-interval-ms"]})
  --pass-env <names>        comma-separated extra variables for push and gh (${HELPER_SETTINGS["pass-env"]})
  --git-timeout-ms <ms>     limit for each git child, default ${String(DEFAULT_TIMEOUT_MS.git)} (${HELPER_SETTINGS["git-timeout-ms"]})
  --gh-timeout-ms <ms>      limit for each gh child, default ${String(DEFAULT_TIMEOUT_MS.gh)} (${HELPER_SETTINGS["gh-timeout-ms"]})
  --gitleaks-timeout-ms <ms> limit for each gitleaks child, default ${String(DEFAULT_TIMEOUT_MS.gitleaks)} (${HELPER_SETTINGS["gitleaks-timeout-ms"]})`;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The single loader for helper settings: flags first, then environment variables. */
export function loadHelperConfig(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): HelperConfig | string {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries(Object.keys(HELPER_SETTINGS).map((name) => [name, { type: "string" as const }])),
    });
  } catch (error) {
    return error instanceof Error ? error.message : "invalid arguments";
  }
  const [mode, ...rest] = parsed.positionals;
  if ((mode !== "serve" && mode !== "once") || rest.length > 0) return "expected the mode serve or once";
  const value = (name: keyof typeof HELPER_SETTINGS, fallback?: string): string | undefined => {
    const flag = parsed.values[name];
    return resolveSetting(typeof flag === "string" ? flag : undefined, env, HELPER_SETTINGS[name], fallback);
  };
  const inboxRoot = value("inbox");
  const registryPath = value("registry");
  const stateDir = value("state");
  const patternFile = value("patterns");
  if (inboxRoot === undefined || registryPath === undefined || stateDir === undefined || patternFile === undefined) {
    return "the inbox, registry, state directory and pattern file are required";
  }
  const pollIntervalMs = Number(value("poll-interval-ms", "2000"));
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50) return "the poll interval must be an integer of at least 50";
  const passEnv = (value("pass-env", "") ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  if (!passEnv.every((name) => ENV_NAME.test(name))) return "pass-env must list environment variable names";
  const limit = (name: "git-timeout-ms" | "gh-timeout-ms" | "gitleaks-timeout-ms", fallback: number): number =>
    Number(value(name, String(fallback)));
  const timeouts: ChildTimeouts = {
    git: limit("git-timeout-ms", DEFAULT_TIMEOUT_MS.git),
    gh: limit("gh-timeout-ms", DEFAULT_TIMEOUT_MS.gh),
    gitleaks: limit("gitleaks-timeout-ms", DEFAULT_TIMEOUT_MS.gitleaks),
  };
  if (!Object.values(timeouts).every((ms) => Number.isInteger(ms) && ms >= 100)) return "each timeout must be an integer of at least 100";
  const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(cwd, path));
  return {
    mode,
    inboxRoot: absolute(inboxRoot),
    registryPath: absolute(registryPath),
    stateDir: absolute(stateDir),
    patternFile: absolute(patternFile),
    gitleaksCommand: value("gitleaks", "gitleaks") ?? "gitleaks",
    ghCommand: value("gh", "gh") ?? "gh",
    pollIntervalMs,
    passEnv,
    timeouts,
  };
}
