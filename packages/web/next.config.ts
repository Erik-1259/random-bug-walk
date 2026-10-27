import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_REGISTRY } from "@rbw/case-validate/registry";
import type { NextConfig } from "next";
import { loadSiteConfig } from "./src/config.ts";
import { freezeTaskReport } from "./src/factory-server/live/task-report-frozen.ts";

/** The pinned rate sheet the judge route prices the controller and the copies with, and the factory routes their work. */
const RATE_SHEET = new URL("../envelope/rate-sheets/v1.json", import.meta.url);

/**
 * The judge routes run as functions that do not hold the results directory, so the build freezes
 * what they read into the server bundle: every release's release.json text and the rate sheet.
 * The pages check the releases in full when they prerender (and refuse more than 99); the route
 * accepts a release only when its ID and the SHA-256 of its frozen text are on the allowlist
 * (RBW_JUDGE_RELEASES, or RBW_JUDGE_RELEASE_ID with RBW_JUDGE_RELEASE_SHA256) at request time.
 */
function frozenJudge(): string {
  const dir = join(loadSiteConfig().resultsDir, "repository", "releases");
  const ids = existsSync(dir) ? readdirSync(dir).sort() : [];
  const releases = ids.flatMap((id) => {
    const path = join(dir, id, "release.json");
    return existsSync(path) ? [readFileSync(path, "utf8")] : [];
  });
  if (releases.length === 0) return "";
  const rateSheet = readFileSync(RATE_SHEET, "utf8");
  return JSON.stringify({ releases, rateSheet });
}

/** The task-report adapter's baseline, catalog and protocols, read here from its files (task-report-frozen.ts). */
function frozenTaskReport(): string {
  const registration = HOST_REGISTRY.get("task-report");
  return registration === null ? "" : freezeTaskReport(registration.adapter);
}

/**
 * The factory routes' functions hold the prepared packages directory at this path in the app
 * directory: the deploy copies it there before the build (it is never committed), the build traces
 * every file under it into each factory route, and RBW_FACTORY_PACKAGES_DIR names it.
 */
const FACTORY_PACKAGES = "factory-packages";

const config: NextConfig = {
  // The record packages read their schema files next to their sources at load time, so Node
  // loads them from the workspace instead of the bundler. The judge routes import the controller's
  // slim judge entry by name, and the bundler builds it into them with what it imports, the schema
  // file included. The factory routes check their bodies with the contract package's validator,
  // which reads its schema file the same way, and use the factory core's identities, whose package
  // reads its criteria catalog file next to its sources.
  serverExternalPackages: ["@rbw/schema", "@rbw/admission", "@rbw/factory-contract", "@rbw/factory"],
  poweredByHeader: false,
  // The factory routes price with the same pinned rate sheet, frozen as its text, and offer the
  // task-report host from its adapter's frozen read-only part.
  env: { RBW_JUDGE_FROZEN: frozenJudge(), RBW_FACTORY_RATE_SHEET: readFileSync(RATE_SHEET, "utf8"), RBW_FACTORY_TASK_REPORT_FROZEN: frozenTaskReport() },
  // The bundled host registry registers the frozen task-report adapter (src/factory-server/live/tools.ts).
  turbopack: { resolveAlias: { "@rbw/host-task-report/adapter": "./src/factory-server/live/task-report-frozen.ts" } },
  // A glob that matches nothing adds nothing, so a build without the directory is unchanged.
  outputFileTracingIncludes: { "/api/factory/**": [`./${FACTORY_PACKAGES}/**/*`] },
  // Only for the local check that serves a build from its traced files alone (README, "Deploying on Vercel").
  ...(process.env.RBW_WEB_STANDALONE === "1" ? { output: "standalone" as const } : {}),
};

export default config;
