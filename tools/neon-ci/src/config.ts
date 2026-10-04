export const DEFAULT_API_BASE = "https://console.neon.tech/api/v2";

const PROJECT_ID_PATTERN = /^[a-z0-9-]+$/;
const BRANCH_ID_PATTERN = /^br-[a-z0-9-]+$/;

export interface Config {
  apiKey: string;
  projectId: string;
  apiBase: string;
}

export type ConfigResult = { config: Config } | { error: string };

export function isBranchId(value: string): boolean {
  return BRANCH_ID_PATTERN.test(value);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The API base override is for tests: https anywhere, or http on loopback only. */
function validateApiBase(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const allowed = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  return allowed ? raw.replace(/\/+$/, "") : undefined;
}

/** The one config loader: NEON_API_KEY and NEON_PROJECT_ID (both secrets) come from the environment. */
export function loadConfig(env: Record<string, string | undefined>, apiBaseOverride?: string): ConfigResult {
  const apiKey = env.NEON_API_KEY ?? "";
  const projectId = env.NEON_PROJECT_ID ?? "";
  const missing = [apiKey === "" ? "NEON_API_KEY" : "", projectId === "" ? "NEON_PROJECT_ID" : ""].filter(
    (name) => name !== "",
  );
  if (missing.length > 0) {
    return { error: `missing configuration: ${missing.join(", ")} (repository secrets; not available to fork or Dependabot pull requests)` };
  }
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    return { error: "invalid NEON_PROJECT_ID: expected lowercase letters, digits and hyphens" };
  }
  let apiBase = DEFAULT_API_BASE;
  if (apiBaseOverride !== undefined) {
    const checked = validateApiBase(apiBaseOverride);
    if (checked === undefined) {
      return { error: "invalid --api-base: expected an https URL, or http on the loopback interface" };
    }
    apiBase = checked;
  }
  return { config: { apiKey, projectId, apiBase } };
}
