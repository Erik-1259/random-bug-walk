import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@rbw/schema";
import { ClosureFetchError, closureUrl, fetchClosure } from "../../src/fetch-closure.ts";
import { FreezeError, freezeSuite } from "../../src/freeze.ts";
import type { FreezeOptions } from "../../src/freeze.ts";
import { harnessHashes } from "../../src/harness.ts";
import type { CommandSpec } from "../../src/process.ts";
import { CANNED_TESTS, FakeRunner, commandResult, playwrightReport, tempDir } from "../helpers.ts";

const FILES: Record<string, string> = {
  "playwright.api.config.ts": "export default {};\n",
  "tests/api/alpha.spec.ts": "export const alpha = 1;\n",
  "tests/api/beta.spec.ts": "export const beta = 1;\n",
  "src/lib/analytics-query.ts": "export const origin = 'synthetic';\n",
};
const PINNED = Object.fromEntries(Object.entries(FILES).map(([path, content]) => [path, sha256Hex(Buffer.from(content))]));
const MARKER = '{"private":true,"type":"module"}\n';
const LOCK = "lockfileVersion: '9.0'\n";

function setup(listing: (spec: CommandSpec) => void = (spec) => {
  writeFileSync(spec.env.PLAYWRIGHT_JSON_OUTPUT_FILE ?? "", playwrightReport(CANNED_TESTS, ["coverage oracle is missing"]));
}) {
  const root = tempDir();
  const verifier = join(root, "verifier");
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(verifier, "suite", path)), { recursive: true });
    writeFileSync(join(verifier, "suite", path), content);
  }
  mkdirSync(join(verifier, "node_modules"), { recursive: true });
  writeFileSync(join(verifier, "pnpm-lock.yaml"), LOCK);
  writeFileSync(join(verifier, "package.json"), MARKER);
  const workDir = join(root, "work");
  mkdirSync(workDir);
  const runner = new FakeRunner((spec) => {
    listing(spec);
    return commandResult({ code: 1 });
  });
  const options: FreezeOptions = {
    closureDir: join(verifier, "suite"),
    closureList: PINNED,
    markerFile: join(verifier, "package.json"),
    verifierNodeModules: join(verifier, "node_modules"),
    verifierLockFile: join(verifier, "pnpm-lock.yaml"),
    appDir: join(root, "app"),
    workDir,
    baseUrl: "http://127.0.0.1:3000",
    nodePath: "/synthetic/node",
    nodeVersion: "v24.21.0",
    specFiles: ["tests/api/alpha.spec.ts", "tests/api/beta.spec.ts"],
  };
  return { root, verifier, runner, options };
}

describe("freeze", () => {
  it("lists the suite with --list under the run's environment, never opting in to destructive runs", async () => {
    const { runner, options } = setup();
    const result = await freezeSuite(options, runner);
    const call = runner.calls[0];
    expect(call?.args.slice(1)).toEqual(["test", "--list", "--config=rbw-api.config.ts", "--workers=1", "--retries=0", "--max-failures=0"]);
    expect(call?.env).toMatchObject({ API_COVERAGE: "report", PLAYWRIGHT_BASE_URL: "http://127.0.0.1:3000" });
    expect(call?.env).not.toHaveProperty("API_ALLOW_DESTRUCTIVE");
    expect(call?.env).not.toHaveProperty("API_SKIP_SEED");
    expect(result.manifest.test_count).toBe(5);
    expect(result.sha256).toBe(sha256Hex(result.bytes));
    expect(result.manifest.verifier_lock_sha256).toBe(sha256Hex(Buffer.from(LOCK)));
    expect(result.manifest.closure).toEqual(PINNED);
    expect(result.manifest.harness).toEqual(harnessHashes(Buffer.from(MARKER)));
    expect(readFileSync(join(call?.cwd ?? "", "package.json"), "utf8")).toBe(MARKER);
  });

  it("does not trust the --list exit code, which the upstream coverage reporter makes 1", async () => {
    const { runner, options } = setup();
    expect((await freezeSuite(options, runner)).list_exit_code).toBe(1);
  });

  it("reports whether --list ran global setup, from the coverage directory global setup creates first", async () => {
    const quiet = setup();
    expect((await freezeSuite(quiet.options, quiet.runner)).list_ran_global_setup).toBe(false);
    const noisy = setup((spec) => {
      mkdirSync(join(spec.cwd, "tests/api/.runtime/127.0.0.1-3000/coverage"), { recursive: true });
      writeFileSync(spec.env.PLAYWRIGHT_JSON_OUTPUT_FILE ?? "", playwrightReport(CANNED_TESTS));
    });
    expect((await freezeSuite(noisy.options, noisy.runner)).list_ran_global_setup).toBe(true);
  });

  it("refuses a verifier closure that differs from the pinned files", async () => {
    const { runner, options, verifier } = setup();
    writeFileSync(join(verifier, "suite", "tests/api/beta.spec.ts"), "export const beta = 2;\n");
    await expect(freezeSuite(options, runner)).rejects.toThrow(/tests\/api\/beta\.spec\.ts/);
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses a closure list that leaves out the analytics-query module the suite imports", async () => {
    const { runner, options } = setup();
    const closureList = Object.fromEntries(Object.entries(PINNED).filter(([path]) => path !== "src/lib/analytics-query.ts"));
    await expect(freezeSuite({ ...options, closureList }, runner)).rejects.toThrow(/src\/lib\/analytics-query\.ts/);
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses a listing in which a spec file failed to load", async () => {
    const { runner, options } = setup((spec) => {
      writeFileSync(spec.env.PLAYWRIGHT_JSON_OUTPUT_FILE ?? "", playwrightReport(CANNED_TESTS.filter((test) => test.file !== "beta.spec.ts")));
    });
    await expect(freezeSuite(options, runner)).rejects.toThrow(/beta\.spec\.ts/);
  });

  it("refuses when the listing wrote no report", async () => {
    const { runner, options } = setup(() => undefined);
    await expect(freezeSuite(options, runner)).rejects.toBeInstanceOf(FreezeError);
  });
});

describe("fetch-closure", () => {
  it("downloads every pinned file from the pinned commit and writes them when all hashes match", async () => {
    const dest = tempDir();
    const urls: string[] = [];
    const count = await fetchClosure(
      dest,
      (url) => {
        urls.push(url);
        const path = Object.keys(FILES).find((key) => url.endsWith(`/${key}`)) ?? "";
        return Promise.resolve(new Response(FILES[path] ?? ""));
      },
      PINNED,
    );
    expect(count).toBe(4);
    expect(urls).toContain(closureUrl("src/lib/analytics-query.ts"));
    expect(closureUrl("src/lib/analytics-query.ts")).toBe(
      "https://raw.githubusercontent.com/umami-software/umami/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/lib/analytics-query.ts",
    );
    expect(readFileSync(join(dest, "tests/api/beta.spec.ts"), "utf8")).toBe(FILES["tests/api/beta.spec.ts"]);
  });

  it("writes nothing when any file differs from its pinned hash", async () => {
    const dest = tempDir();
    const fetchFile = (url: string): Promise<Response> =>
      Promise.resolve(new Response(url.endsWith("alpha.spec.ts") ? "export const alpha = 9;\n" : (FILES[Object.keys(FILES).find((key) => url.endsWith(`/${key}`)) ?? ""] ?? "")));
    await expect(fetchClosure(dest, fetchFile, PINNED)).rejects.toThrow(ClosureFetchError);
    await expect(fetchClosure(dest, fetchFile, PINNED)).rejects.toThrow(/tests\/api\/alpha\.spec\.ts/);
    expect(() => readFileSync(join(dest, "tests/api/beta.spec.ts"))).toThrow();
  });

  it("refuses an HTTP error even when its body happens to match", async () => {
    const dest = tempDir();
    await expect(
      fetchClosure(dest, () => Promise.resolve(new Response("", { status: 404 })), { "empty.txt": sha256Hex(Buffer.from("")) }),
    ).rejects.toThrow(/empty\.txt/);
  });
});
