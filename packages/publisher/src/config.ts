import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { InvalidInput } from "./errors.ts";
import { passesAllowlist, splitCommand } from "./process.ts";

export const packageDir = fileURLToPath(new URL("..", import.meta.url));
/** The repository this publisher runs from; the state directory must lie outside it. */
export const repositoryRoot = resolve(packageDir, "..", "..");

export const DEFAULT_DEPLOY_KEY_ENV = "RBW_RESULTS_DEPLOY_KEY_FILE";
export const DEFAULT_STORE_TOKEN_ENV = "RBW_PUBLIC_STORE_TOKEN";
export const DEFAULT_KNOWN_HOSTS = join(packageDir, "config", "github_known_hosts");
/** The C2 scanner run by this Node binary, as separate tokens so no path is ever split. */
export const DEFAULT_SCANNER: readonly string[] = [process.execPath, join(repositoryRoot, "tools", "publication", "src", "cli.ts")];

export interface Limits {
  pushAttempts: number;
  metadataRequests: number;
  newPublicBytes: number;
  transferBytes: number;
  storeOperations: number;
}

export const DEFAULT_LIMITS: Limits = {
  pushAttempts: 3,
  metadataRequests: 6,
  newPublicBytes: 64 * 1024 * 1024,
  transferBytes: 128 * 1024 * 1024,
  storeOperations: 200,
};

export type Destination =
  | { mode: "local"; remote: string; store: string }
  | {
      mode: "real";
      repositoryUrl: string;
      artifactBaseUri: string;
      deployKeyEnv: string;
      storeTokenEnv: string;
      knownHosts: string;
    };

export interface PublishConfig {
  policyFile: string;
  rootRunFile: string;
  stagingDir: string;
  stateDir: string;
  patternFile: string;
  redactionValuesFile: string | null;
  branch: string;
  replace: boolean;
  destination: Destination;
  scanner: string[];
  gitleaks: string | null;
  scanTimeoutMs: number;
  largeObjectThreshold: number;
  limits: Limits;
}

export interface PolicyConfig {
  projectId: string;
  outputRepository: string;
  artifactBaseUri: string;
  policyVersion: number;
  out: string;
}

export interface StatusConfig {
  stateDir: string;
}

type Values = Record<string, string | boolean | undefined>;

function parse(argv: readonly string[], options: Record<string, { type: "string" | "boolean" }>): Values {
  try {
    const { values } = parseArgs({ args: [...argv], options, strict: true, allowPositionals: false });
    return values;
  } catch {
    throw new InvalidInput("usage");
  }
}

function text(values: Values, name: string): string | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new InvalidInput(`invalid_${name}`);
  return value;
}

function required(values: Values, name: string): string {
  const value = text(values, name);
  if (value === undefined) throw new InvalidInput(`missing_${name}`);
  return value;
}

function path(values: Values, name: string): string {
  return resolve(required(values, name));
}

function positiveInteger(values: Values, name: string, fallback: number): number {
  const value = text(values, name);
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidInput(`invalid_${name}`);
  return Number(value);
}

function variableName(values: Values, name: string, fallback: string): string {
  const value = text(values, name) ?? fallback;
  // A credential variable that child processes would inherit is refused.
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value) || passesAllowlist(value)) throw new InvalidInput(`invalid_${name}`);
  return value;
}

/**
 * Splits a configured command on spaces. A relative token that names an existing file, such as
 * `tools/publication/src/cli.ts`, is resolved against the invocation directory, because the
 * scanner runs from a temporary directory.
 */
export function resolveCommand(command: string): string[] {
  return splitCommand(command).map((token) => (!token.startsWith("-") && !isAbsolute(token) && token.includes("/") && existsSync(resolve(token)) ? resolve(token) : token));
}

/** A conservative subset of git's branch-name rules. */
export function isBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.endsWith(".")
  );
}

const PUBLISH_OPTIONS = {
  policy: { type: "string" },
  "root-run": { type: "string" },
  staging: { type: "string" },
  state: { type: "string" },
  patterns: { type: "string" },
  "redaction-values": { type: "string" },
  branch: { type: "string" },
  replace: { type: "boolean" },
  real: { type: "boolean" },
  "repository-url": { type: "string" },
  "artifact-base-uri": { type: "string" },
  "local-remote": { type: "string" },
  "local-store": { type: "string" },
  "deploy-key-env": { type: "string" },
  "store-token-env": { type: "string" },
  scanner: { type: "string" },
  gitleaks: { type: "string" },
  "scan-timeout-ms": { type: "string" },
  "large-threshold-bytes": { type: "string" },
  "limit-push-attempts": { type: "string" },
  "limit-metadata-requests": { type: "string" },
  "limit-new-public-bytes": { type: "string" },
  "limit-transfer-bytes": { type: "string" },
  "limit-store-operations": { type: "string" },
} as const;

/** The one configuration loader: flags only, with the documented defaults. Credentials are read later, in real mode only. */
export function loadPublishConfig(argv: readonly string[]): PublishConfig {
  const values = parse(argv, PUBLISH_OPTIONS);
  const real = values.real === true;
  const realFlags = ["repository-url", "artifact-base-uri", "deploy-key-env", "store-token-env"];
  const localFlags = ["local-remote", "local-store"];
  for (const flag of real ? localFlags : realFlags) if (values[flag] !== undefined) throw new InvalidInput("mixed_destination_flags");
  const destination: Destination = real
    ? {
        mode: "real",
        repositoryUrl: required(values, "repository-url"),
        artifactBaseUri: required(values, "artifact-base-uri"),
        deployKeyEnv: variableName(values, "deploy-key-env", DEFAULT_DEPLOY_KEY_ENV),
        storeTokenEnv: variableName(values, "store-token-env", DEFAULT_STORE_TOKEN_ENV),
        // Host-key pinning always uses the committed file; no flag replaces it.
        knownHosts: DEFAULT_KNOWN_HOSTS,
      }
    : { mode: "local", remote: path(values, "local-remote"), store: path(values, "local-store") };
  const branch = text(values, "branch") ?? "main";
  if (!isBranchName(branch)) throw new InvalidInput("invalid_branch");
  const scannerText = text(values, "scanner");
  const scanner = scannerText === undefined ? [...DEFAULT_SCANNER] : resolveCommand(scannerText);
  const redactionValues = text(values, "redaction-values");
  const gitleaksText = text(values, "gitleaks");
  return {
    policyFile: path(values, "policy"),
    rootRunFile: path(values, "root-run"),
    stagingDir: path(values, "staging"),
    stateDir: path(values, "state"),
    patternFile: path(values, "patterns"),
    redactionValuesFile: redactionValues === undefined ? null : resolve(redactionValues),
    branch,
    replace: values.replace === true,
    destination,
    scanner,
    gitleaks: gitleaksText === undefined ? null : resolveCommand(gitleaksText).join(" "),
    scanTimeoutMs: positiveInteger(values, "scan-timeout-ms", 600_000),
    largeObjectThreshold: positiveInteger(values, "large-threshold-bytes", 1024 * 1024),
    limits: {
      pushAttempts: positiveInteger(values, "limit-push-attempts", DEFAULT_LIMITS.pushAttempts),
      metadataRequests: positiveInteger(values, "limit-metadata-requests", DEFAULT_LIMITS.metadataRequests),
      newPublicBytes: positiveInteger(values, "limit-new-public-bytes", DEFAULT_LIMITS.newPublicBytes),
      transferBytes: positiveInteger(values, "limit-transfer-bytes", DEFAULT_LIMITS.transferBytes),
      storeOperations: positiveInteger(values, "limit-store-operations", DEFAULT_LIMITS.storeOperations),
    },
  };
}

export function loadPolicyConfig(argv: readonly string[]): PolicyConfig {
  const values = parse(argv, {
    "project-id": { type: "string" },
    "output-repository": { type: "string" },
    "artifact-base-uri": { type: "string" },
    "policy-version": { type: "string" },
    out: { type: "string" },
  });
  const version = required(values, "policy-version");
  if (!/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(Number(version))) throw new InvalidInput("invalid_policy-version");
  return {
    projectId: required(values, "project-id"),
    outputRepository: required(values, "output-repository"),
    artifactBaseUri: required(values, "artifact-base-uri"),
    policyVersion: Number(version),
    out: path(values, "out"),
  };
}

export function loadStatusConfig(argv: readonly string[]): StatusConfig {
  return { stateDir: path(parse(argv, { state: { type: "string" } }), "state") };
}

/**
 * True when `inner` is `outer` or lies below it. Both must be absolute. Besides the spelling,
 * it compares the identity (device and inode) of `outer` with each existing ancestor of
 * `inner`, so a differently cased path on a case-insensitive filesystem, or a path through a
 * symlink, still counts as the same location.
 */
export function isInside(inner: string, outer: string): boolean {
  if (!isAbsolute(inner) || !isAbsolute(outer)) return false;
  const a = resolve(inner);
  const b = resolve(outer);
  if (a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`)) return true;
  const target = statSync(b, { throwIfNoEntry: false });
  if (target === undefined) return false;
  for (let current = a; ; current = dirname(current)) {
    const stats = statSync(current, { throwIfNoEntry: false });
    if (stats?.dev === target.dev && stats.ino === target.ino) return true;
    if (dirname(current) === current) return false;
  }
}
