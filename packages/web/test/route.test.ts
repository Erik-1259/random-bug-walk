import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dynamic, dynamicParams, generateStaticParams, GET } from "../app/runs/[root]/[...path]/route.ts";
import * as releaseRoute from "../app/releases/[release]/[...path]/route.ts";
import { DEVELOPMENT, DEVELOPMENT_ROOT, NO_RELEASE, RELEASE, RELEASE_ID, RELEASE_ROOT, releaseDir, runDir } from "./support/results.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

function get(root: string, path: string[]): Promise<Response> {
  return GET(new Request(`https://example.invalid/runs/${root}/${path.join("/")}`), { params: Promise.resolve({ root, path }) });
}

describe("published file route", () => {
  it("is prerendered for exactly the published repository files and nothing else", async () => {
    expect(dynamic).toBe("force-static");
    expect(dynamicParams).toBe(false);
    vi.stubEnv("RBW_RESULTS_DIR", NO_RELEASE);
    const params = await generateStaticParams();
    expect(params.map((item) => `${item.root}/${item.path.join("/")}`)).toEqual([
      "00000000-0000-4000-8000-000000002001/manifest.json",
      "00000000-0000-4000-8000-000000002001/logs/00000000-0000-4000-8000-000000002002/run.log",
      "00000000-0000-4000-8000-000000002001/report.md",
      "00000000-0000-4000-8000-000000002003/manifest.json",
      "00000000-0000-4000-8000-000000002003/report.md",
    ]);
  });

  it("serves a published file's exact bytes with its media type", async () => {
    vi.stubEnv("RBW_RESULTS_DIR", DEVELOPMENT);
    const path = ["results", "00000000-0000-4000-8000-000000001007", "planted-01", "tzarg.la-day-counts.json"];
    const response = await get(DEVELOPMENT_ROOT, path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(join(runDir(DEVELOPMENT, DEVELOPMENT_ROOT), ...path)))).toBe(true);
  });

  it("answers 404 for a path the manifest does not list", async () => {
    vi.stubEnv("RBW_RESULTS_DIR", DEVELOPMENT);
    expect((await get(DEVELOPMENT_ROOT, ["..", "..", "..", "package.json"])).status).toBe(404);
    expect((await get(DEVELOPMENT_ROOT, ["unlisted.json"])).status).toBe(404);
    expect((await get("00000000-0000-4000-8000-000000002001", ["report.md"])).status).toBe(404);
  });
});

function getRelease(release: string, path: string[]): Promise<Response> {
  return releaseRoute.GET(new Request(`https://example.invalid/releases/${release}/${path.join("/")}`), { params: Promise.resolve({ release, path }) });
}

describe("release file route", () => {
  it("is prerendered for release.json and the release's listed files, and for nothing without a release", async () => {
    expect(releaseRoute.dynamic).toBe("force-static");
    expect(releaseRoute.dynamicParams).toBe(false);
    vi.stubEnv("RBW_RESULTS_DIR", RELEASE);
    expect((await releaseRoute.generateStaticParams()).map((item) => `${item.release}/${item.path.join("/")}`)).toEqual([
      `${RELEASE_ID}/release.json`,
      `${RELEASE_ID}/issue-check.json`,
      `${RELEASE_ID}/issue.json`,
      `${RELEASE_ID}/recordings/card-1.recording.json`,
      `${RELEASE_ID}/recordings/issue-1.recording.json`,
    ]);
    vi.stubEnv("RBW_RESULTS_DIR", DEVELOPMENT);
    expect(await releaseRoute.generateStaticParams()).toEqual([]);
  });

  it("serves release.json and issue.json as their exact bytes", async () => {
    vi.stubEnv("RBW_RESULTS_DIR", RELEASE);
    for (const name of ["release.json", "issue.json"]) {
      const response = await getRelease(RELEASE_ID, [name]);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(join(releaseDir(RELEASE), name)))).toBe(true);
    }
  });

  it("answers 404 for a path the release does not list", async () => {
    vi.stubEnv("RBW_RESULTS_DIR", RELEASE);
    expect((await getRelease(RELEASE_ID, ["unlisted.json"])).status).toBe(404);
    expect((await getRelease(RELEASE_ID, ["..", "..", "runs", RELEASE_ROOT, "manifest.json"])).status).toBe(404);
    expect((await getRelease(RELEASE_ROOT, ["issue.json"])).status).toBe(404);
  });
});
