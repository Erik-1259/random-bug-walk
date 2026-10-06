// The site's one configuration loader. RBW_RESULTS_DIR names the results directory the pages are
// prerendered from; a relative value is resolved against the app directory, where next runs.
import { resolve } from "node:path";

export const DEFAULT_RESULTS_DIR = "fixtures/development-2026-10-06";

export interface SiteConfig {
  resultsDir: string;
}

export function loadSiteConfig(env: Readonly<Record<string, string | undefined>> = process.env, cwd: string = process.cwd()): SiteConfig {
  const value = env.RBW_RESULTS_DIR;
  return { resultsDir: resolve(cwd, value === undefined || value === "" ? DEFAULT_RESULTS_DIR : value) };
}
