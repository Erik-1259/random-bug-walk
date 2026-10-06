import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeCanonical } from "@rbw/schema";
import { suiteEnvironmentManifest } from "../../src/environment.ts";
import { buildSuiteManifest, encodeSuiteManifest, parseSuiteManifest } from "../../src/manifest.ts";
import { parsePlaywrightReport } from "../../src/playwright-report.ts";
import { CANNED_TESTS, hex, playwrightReport } from "../helpers.ts";

const SPEC_FILES = ["tests/api/alpha.spec.ts", "tests/api/beta.spec.ts"];

function manifestArgs(overrides: Partial<Parameters<typeof buildSuiteManifest>[0]> = {}): Parameters<typeof buildSuiteManifest>[0] {
  return {
    report: parsePlaywrightReport(playwrightReport(CANNED_TESTS), "tests/api/"),
    closure: { "tests/api/alpha.spec.ts": hex(10), "tests/api/beta.spec.ts": hex(11), "src/lib/analytics-query.ts": hex(12) },
    harness: { "rbw-api.config.ts": hex(13), "package.json": hex(14) },
    verifierLockSha256: hex(15),
    environment: suiteEnvironmentManifest({ baseUrl: "http://127.0.0.1:3000", nodeVersion: "v24.21.0" }),
    specFiles: SPEC_FILES,
    umamiCommit: "ec0ff50388c264ed8ce46f00967e92f7e71476ae",
    ...overrides,
  };
}

describe("suite manifest", () => {
  it("enumerates every listed test by ID, file and title path, including each parameterized case", () => {
    const manifest = buildSuiteManifest(manifestArgs());
    expect(manifest.test_count).toBe(5);
    expect(manifest.tests).toContainEqual({
      id: "synthetic0002-bbbb0002",
      file: "tests/api/beta.spec.ts",
      title_path: ["Beta", "migration", "retention report migrates"],
    });
    expect(manifest.tests.filter((test) => test.file === "tests/api/beta.spec.ts")).toHaveLength(3);
    expect(manifest.tests.map((test) => test.id)).toEqual([...manifest.tests.map((test) => test.id)].sort());
  });

  it("refuses a listing in which a pinned spec file contributes no test", () => {
    expect(() => buildSuiteManifest(manifestArgs({ specFiles: [...SPEC_FILES, "tests/api/gamma.spec.ts"] }))).toThrow(
      /gamma\.spec\.ts/,
    );
  });

  it("refuses a listing with duplicate test IDs", () => {
    const duplicated = [...CANNED_TESTS, { id: "synthetic0001-aaaa0001", file: "alpha.spec.ts", title: "a second title" }];
    expect(() =>
      buildSuiteManifest(manifestArgs({ report: parsePlaywrightReport(playwrightReport(duplicated), "tests/api/") })),
    ).toThrow(/duplicate/);
  });

  it("encodes with the shared canonical encoder and hashes the exact bytes", () => {
    const manifest = buildSuiteManifest(manifestArgs());
    const { bytes, sha256 } = encodeSuiteManifest(manifest);
    expect(Buffer.from(bytes).equals(Buffer.from(encodeCanonical(manifest)))).toBe(true);
    expect(Buffer.from(bytes).toString("utf8")).not.toContain("\n");
    expect(sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(parseSuiteManifest(bytes)).toEqual(manifest);
  });

  it("rejects a manifest file that is not canonical bytes", () => {
    const spaced = Buffer.from(JSON.stringify(buildSuiteManifest(manifestArgs()), null, 2));
    expect(() => parseSuiteManifest(spaced)).toThrow(/canonical/);
  });

  it("changes its hash when any closure byte, the wrapper config or the verifier lock changes", () => {
    const base = encodeSuiteManifest(buildSuiteManifest(manifestArgs())).sha256;
    const variants = [
      manifestArgs({ closure: { ...manifestArgs().closure, "src/lib/analytics-query.ts": hex(99) } }),
      manifestArgs({ harness: { ...manifestArgs().harness, "rbw-api.config.ts": hex(99) } }),
      manifestArgs({ verifierLockSha256: hex(99) }),
      manifestArgs({ environment: suiteEnvironmentManifest({ baseUrl: "http://127.0.0.1:3001", nodeVersion: "v24.21.0" }) }),
    ];
    const hashes = variants.map((args) => encodeSuiteManifest(buildSuiteManifest(args)).sha256);
    for (const hash of hashes) {
      expect(hash).not.toBe(base);
    }
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("records API_COVERAGE=report and the run arguments in its environment manifest", () => {
    const manifest = buildSuiteManifest(manifestArgs());
    expect(manifest.environment.variables.API_COVERAGE).toBe("report");
    expect(manifest.environment.run_args).toEqual([
      "test",
      "--config=rbw-api.config.ts",
      "--workers=1",
      "--retries=0",
      "--max-failures=0",
    ]);
    expect(manifest.environment.list_args).toContain("--list");
  });

  it("rejects a manifest file whose test count disagrees with its tests", () => {
    const manifest = { ...buildSuiteManifest(manifestArgs()), test_count: 4 };
    expect(() => parseSuiteManifest(encodeCanonical(manifest))).toThrow(/test_count/);
  });
});
