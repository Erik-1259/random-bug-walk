import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";
import { loadSiteConfig } from "./src/config.ts";

/** The pinned rate sheet the judge route prices the controller and the copies with. */
const RATE_SHEET = new URL("../envelope/rate-sheets/v1.json", import.meta.url);

/**
 * The judge routes run as functions that do not hold the results directory, so the build freezes
 * what they read into the server bundle: the one release's release.json text and the rate sheet.
 * The pages check the release in full when they prerender; the route checks its SHA-256 against
 * RBW_JUDGE_RELEASE_SHA256 at request time.
 */
function frozenJudge(): string {
  const releases = join(loadSiteConfig().resultsDir, "repository", "releases");
  const [releaseId, ...others] = existsSync(releases) ? readdirSync(releases) : [];
  if (releaseId === undefined || others.length > 0) return "";
  const release = readFileSync(join(releases, releaseId, "release.json"), "utf8");
  const rateSheet = readFileSync(RATE_SHEET, "utf8");
  return JSON.stringify({ release, rateSheet });
}

const config: NextConfig = {
  // The record packages read their schema files next to their sources at load time, so Node
  // loads them from the workspace instead of the bundler. The judge routes import the controller's
  // slim judge entry by name, and the bundler builds it into them with what it imports, the schema
  // file included.
  serverExternalPackages: ["@rbw/schema", "@rbw/admission"],
  poweredByHeader: false,
  env: { RBW_JUDGE_FROZEN: frozenJudge() },
};

export default config;
