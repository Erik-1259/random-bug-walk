import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixture, readFixtureEnv, writeObservation } from "@rbw/umami-fixture";
import { addedSuiteSha256, findCheckTest, fixtureCommand, loadFixtureModule, parseFixtureOutcome } from "../../src/fixture.ts";
import { parsePlaywrightReport } from "../../src/playwright-report.ts";
import { CHECKS, hex, playwrightReport, tempDir } from "../helpers.ts";

const FIXTURE_PACKAGE = fileURLToPath(new URL("../../../umami-fixture", import.meta.url));

function outcome(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      check_id: "tzarg.la-day-counts",
      repeat_index: 3,
      observed: "assertion_fail",
      failure_code: "bucket_labels_mismatch",
      duration_ms: 31,
      response_artifact_key: "responses/tzarg.la-day-counts.json",
      response_artifact_sha256: hex(5),
      ...overrides,
    }),
  );
}

function command(outputDir: string) {
  return fixtureCommand({
    nodePath: "/opt/rbw/verifier/node/bin/node",
    verifierNodeModules: "/opt/rbw/verifier/node_modules",
    configPath: "/opt/rbw/verifier/kit/umami-fixture/playwright.config.ts",
    cwd: "/opt/rbw/verifier/kit/umami-fixture",
    baseUrl: "http://127.0.0.1:3000",
    repeatIndex: 7,
    outputDir,
    tmpDir: "/var/lib/rbw/results/t/work/added/round-07/tmp",
    admin: { username: "synthetic-admin", password: "synthetic-password" },
  });
}

describe("fixture interface", () => {
  it("expects the check IDs the fixture's data file defines, in its order", () => {
    expect(loadFixture().checks.map((check) => check.check_id)).toEqual(CHECKS.map((check) => check.check_id));
  });

  it("builds the round command and its five inputs, which the fixture's own loader accepts", () => {
    const outputDir = tempDir();
    const spec = command(outputDir);
    expect(spec.args).toEqual([
      "/opt/rbw/verifier/node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      "/opt/rbw/verifier/kit/umami-fixture/playwright.config.ts",
      "--workers=1",
      "--retries=0",
    ]);
    expect(spec.env.TMPDIR).toBe("/var/lib/rbw/results/t/work/added/round-07/tmp");
    expect(Object.keys(spec.env).filter((key) => key.startsWith("API_"))).toEqual([]);
    expect(readFixtureEnv(spec.env)).toEqual({
      baseUrl: "http://127.0.0.1:3000",
      repeatIndex: 7,
      outputDir,
      credentials: { username: "synthetic-admin", password: "synthetic-password" },
    });
  });

  it("accepts the outcome file the fixture's own writer produces", () => {
    const dir = tempDir();
    const written = writeObservation(dir, {
      check_id: "tzarg.kolkata-day-counts",
      repeat_index: 2,
      observed: "assertion_fail",
      failure_code: "local_day_counts_mismatch",
      duration_ms: 41.6,
      response_body: Buffer.from('{"pageviews":[]}'),
    });
    const parsed = parseFixtureOutcome(readFileSync(join(dir, "observations", "tzarg.kolkata-day-counts.json")), "tzarg.kolkata-day-counts", 2);
    expect(parsed).toEqual({ ok: true, outcome: written });
  });

  it("accepts a well-formed outcome file for the expected check and round", () => {
    expect(parseFixtureOutcome(outcome(), "tzarg.la-day-counts", 3).ok).toBe(true);
  });

  it.each([
    ["another check's file", { check_id: "tzarg.utc-day-counts" }],
    ["another round's file", { repeat_index: 4 }],
    ["an unknown observed value", { observed: "not_run" }],
    ["a pass with a failure code", { observed: "pass", failure_code: "bucket_labels_mismatch" }],
    ["an assertion failure with a setup code", { failure_code: "auth_failed" }],
    ["a setup failure with an assertion code", { observed: "setup_fail" }],
    ["only one response field set", { response_artifact_sha256: null }],
    ["a response key outside responses/", { response_artifact_key: "../outside.json" }],
    ["a fractional duration", { duration_ms: 1.5 }],
    ["an extra field", { verdict: "pass" }],
  ])("rejects %s", (_name, overrides) => {
    expect(parseFixtureOutcome(outcome(overrides), "tzarg.la-day-counts", 3).ok).toBe(false);
  });

  it("rejects bytes that are not JSON", () => {
    expect(parseFixtureOutcome(Buffer.from("{"), "tzarg.la-day-counts", 3).ok).toBe(false);
  });

  it("finds a check's test in the report by its check ID as the test title", () => {
    const report = parsePlaywrightReport(
      playwrightReport([
        { id: "s-1", file: "tzarg.check.ts", title: "tzarg.utc-day-counts", result: "passed" },
        { id: "s-2", file: "tzarg.check.ts", title: "tzarg.la-day-counts", result: "failed" },
      ]),
      "",
    );
    expect(findCheckTest(report, "tzarg.la-day-counts")?.result).toBe("failed");
    expect(findCheckTest(report, "tzarg.kolkata-day-counts")).toBeNull();
  });

  it("loads the reset and the template copy from the fixture package's entry module", async () => {
    const module = await loadFixtureModule(FIXTURE_PACKAGE);
    expect(module.TEMPLATE_DATABASE).toBe("rbw_fixture_template");
    expect(typeof module.resetFixture).toBe("function");
    expect(typeof module.createFixtureTemplate).toBe("function");
  });

  it("refuses a fixture package without the reset", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(join(dir, "src", "index.ts"), "export const nothing = 1;\n");
    await expect(loadFixtureModule(dir)).rejects.toThrow(/resetFixture/);
  });
});

describe("added suite hash", () => {
  it("changes with a package file but not with Playwright's test-results output from an earlier round", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "playwright.config.ts"), "synthetic config");
    const before = await addedSuiteSha256(dir);
    mkdirSync(join(dir, "test-results"));
    writeFileSync(join(dir, "test-results", ".last-run.json"), '{"status":"passed"}');
    expect(await addedSuiteSha256(dir)).toBe(before);
    writeFileSync(join(dir, "playwright.config.ts"), "synthetic config, changed");
    expect(await addedSuiteSha256(dir)).not.toBe(before);
  });
});
