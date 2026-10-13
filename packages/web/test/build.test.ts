import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEVELOPMENT, DEVELOPMENT_ROOT, NO_RELEASE, RELEASE, RELEASE_ID, releaseDir, runDir } from "./support/results.ts";

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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  });
}

/** Runs the built app with `next start` and the given judge variables, and calls `check` with its URL. */
async function withServer(env: Record<string, string>, check: (url: string) => Promise<void>): Promise<void> {
  const port = await freePort();
  const child = spawn(join(APP, "node_modules", ".bin", "next"), ["start", "-p", String(port), "-H", "127.0.0.1"], { cwd: APP, env: { ...process.env, ...env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "ignore" });
  const url = `http://127.0.0.1:${String(port)}`;
  try {
    for (let attempt = 0; ; attempt += 1) {
      const up = await fetch(url).then(
        () => true,
        () => false,
      );
      if (up) break;
      if (attempt > 120) throw new Error("synthetic: next start did not come up");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await check(url);
  } finally {
    child.kill();
  }
}

async function judgePost(url: string, passcode: string): Promise<Record<string, unknown>> {
  const session = await fetch(`${url}/api/judge/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode }) });
  expect(session.status).toBe(200);
  const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const response = await fetch(`${url}/api/judge`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ request_id: "00000000-0000-4000-8000-00000000d001" }) });
  return (await response.json()) as Record<string, unknown>;
}

// One test builds the three fixtures in turn, because every build writes the same .next directory.
describe("next build", () => {
  it("prerenders the case page, the catalog and every published and release file for each fixture, and the judge route reads the frozen release", async () => {
    build(NO_RELEASE);
    expect(prerendered()).toEqual([
      "/",
      "/_global-error",
      "/_not-found",
      "/catalog",
      "/runs/00000000-0000-4000-8000-000000002001",
      "/runs/00000000-0000-4000-8000-000000002001/logs/00000000-0000-4000-8000-000000002002/run.log",
      "/runs/00000000-0000-4000-8000-000000002001/manifest.json",
      "/runs/00000000-0000-4000-8000-000000002001/report.md",
      "/runs/00000000-0000-4000-8000-000000002003",
      "/runs/00000000-0000-4000-8000-000000002003/manifest.json",
      "/runs/00000000-0000-4000-8000-000000002003/report.md",
    ]);
    const empty = readFileSync(join(SERVER_APP, "index.html"), "utf8");
    expect(empty).toContain("No validated blind-spot example yet");
    expect(empty).toContain("No published run holds an observed symptom yet.");
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Plant and verify this example<\/button>/);
    expect(readFileSync(join(SERVER_APP, "catalog.html"), "utf8")).toContain("00000000-0000-4000-8000-000000002005");

    build(DEVELOPMENT);
    expect(prerendered()).toContain(`/runs/${DEVELOPMENT_ROOT}/generated/symptom.json`);
    const page = readFileSync(join(SERVER_APP, "index.html"), "utf8");
    expect([...page.matchAll(/data-cell="(\d)"/g)].map((match) => match[1])).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(page).toContain("Development evidence, not validated");
    // The case page links the run's file index page; the index page lists the files.
    expect(page).toContain(`href="/runs/${DEVELOPMENT_ROOT}"`);
    expect(page).not.toContain(`href="/runs/${DEVELOPMENT_ROOT}/generated/symptom.json"`);
    expect(prerendered()).toContain(`/runs/${DEVELOPMENT_ROOT}`);
    const index = readFileSync(join(SERVER_APP, "runs", `${DEVELOPMENT_ROOT}.html`), "utf8");
    expect(index).toContain(`Files of run ${DEVELOPMENT_ROOT}`);
    expect(index).toContain(`href="/runs/${DEVELOPMENT_ROOT}/generated/symptom.json"`);
    const body = join(SERVER_APP, "runs", DEVELOPMENT_ROOT, "report.md.body");
    expect(existsSync(body)).toBe(true);
    expect(readFileSync(body).equals(readFileSync(join(runDir(DEVELOPMENT, DEVELOPMENT_ROOT), "report.md")))).toBe(true);
    expect(prerendered().some((route) => route.startsWith("/releases/"))).toBe(false);

    build(RELEASE);
    expect(prerendered()).toContain(`/releases/${RELEASE_ID}/release.json`);
    const releasePage = readFileSync(join(SERVER_APP, "index.html"), "utf8");
    expect(releasePage).toContain("Validated blind-spot example");
    expect(releasePage).not.toContain("No validated blind-spot example yet");
    expect(releasePage).toContain(RELEASE_ID);
    const releaseBody = join(SERVER_APP, "releases", RELEASE_ID, "release.json.body");
    expect(readFileSync(releaseBody).equals(readFileSync(join(releaseDir(RELEASE), "release.json")))).toBe(true);

    // The built judge route reads the frozen release and rate sheet: with the configured release it
    // passes route step 2 and stops at the OIDC token, which a local run does not have; with
    // another release hash it stops at step 2.
    const passcode = "synthetic-build-passcode";
    const sha256 = createHash("sha256").update(readFileSync(join(releaseDir(RELEASE), "release.json"))).digest("hex");
    const judge = { RBW_JUDGE_PASSCODE: passcode, RBW_JUDGE_RELEASE_ID: RELEASE_ID };
    await withServer({ ...judge, RBW_JUDGE_RELEASE_SHA256: sha256 }, async (url) => {
      expect(await judgePost(url, passcode)).toMatchObject({ state: "unavailable", reason: "token" });
      const refused = await fetch(`${url}/api/judge/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: "synthetic-wrong" }) });
      expect(refused.status).toBe(401);
    });
    await withServer({ ...judge, RBW_JUDGE_RELEASE_SHA256: "0".repeat(64) }, async (url) => {
      expect(await judgePost(url, passcode)).toMatchObject({ state: "unavailable", reason: "release" });
    });
  }, 600_000);
});
