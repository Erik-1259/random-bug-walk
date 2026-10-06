import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEVELOPMENT, DEVELOPMENT_ROOT, NO_RELEASE, runDir } from "./support/results.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));
const SERVER_APP = join(APP, ".next", "server", "app");

function build(resultsDir: string): void {
  const result = spawnSync(join(APP, "node_modules", ".bin", "next"), ["build"], {
    cwd: APP,
    env: { ...process.env, RBW_RESULTS_DIR: resultsDir, NEXT_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
}

function prerendered(): string[] {
  const manifest = JSON.parse(readFileSync(join(APP, ".next", "prerender-manifest.json"), "utf8")) as { routes: Record<string, unknown> };
  return Object.keys(manifest.routes).sort();
}

// One test builds both fixtures in turn, because both builds write the same .next directory.
describe("next build", () => {
  it("prerenders the case page, the catalog and every published file for each fixture", () => {
    build(NO_RELEASE);
    expect(prerendered()).toEqual([
      "/",
      "/_global-error",
      "/_not-found",
      "/catalog",
      "/runs/00000000-0000-4000-8000-000000002001/logs/00000000-0000-4000-8000-000000002002/run.log",
      "/runs/00000000-0000-4000-8000-000000002001/manifest.json",
      "/runs/00000000-0000-4000-8000-000000002001/report.md",
      "/runs/00000000-0000-4000-8000-000000002003/manifest.json",
      "/runs/00000000-0000-4000-8000-000000002003/report.md",
    ]);
    const empty = readFileSync(join(SERVER_APP, "index.html"), "utf8");
    expect(empty).toContain("No validated blind-spot example yet");
    expect(empty).toContain("No published run holds an observed symptom yet.");
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Run verified replay<\/button>/);
    expect(readFileSync(join(SERVER_APP, "catalog.html"), "utf8")).toContain("00000000-0000-4000-8000-000000002005");

    build(DEVELOPMENT);
    expect(prerendered()).toContain(`/runs/${DEVELOPMENT_ROOT}/generated/symptom.json`);
    const page = readFileSync(join(SERVER_APP, "index.html"), "utf8");
    expect([...page.matchAll(/data-cell="(\d)"/g)].map((match) => match[1])).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(page).toContain("Development evidence, not validated");
    const body = join(SERVER_APP, "runs", DEVELOPMENT_ROOT, "report.md.body");
    expect(existsSync(body)).toBe(true);
    expect(readFileSync(body).equals(readFileSync(join(runDir(DEVELOPMENT, DEVELOPMENT_ROOT), "report.md")))).toBe(true);
  }, 600_000);
});
