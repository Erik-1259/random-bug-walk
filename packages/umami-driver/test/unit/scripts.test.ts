import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProofJob } from "../../scripts/proof-job.ts";
import { stageKit } from "../../scripts/stage-kit.ts";
import { addedSuiteSha256 } from "../../src/fixture.ts";
import { RefusedInput, readJob } from "../../src/job.ts";
import { encodeSuiteManifest } from "../../src/manifest.ts";
import { hex, tempDir } from "../helpers.ts";
import { verifier } from "../trial-harness.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * The added_suite_sha256 of the released time-zone family's staged fixture: the value the
 * released kit image's fixture hashes to, and the one tools/local-runner/README.md records.
 * Staging another family's fixture must never change it.
 */
const TZ_ADDED_SUITE_SHA256 = "42c50a8bf10c9d4139584f8f8d7e602293e91e0e9cc1d7abfbd3a13e5694c1ca";

/** Every file's SHA-256 and every symlink's target under a directory, by relative path. */
function treeDigest(root: string): Record<string, string> {
  const digest: Record<string, string> = {};
  const visit = (prefix: string): void => {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) digest[path] = `-> ${readlinkSync(join(root, path))}`;
      else if (entry.isDirectory()) visit(path);
      else digest[path] = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
    }
  };
  visit("");
  return digest;
}

describe("staging the driver and fixture for the kit image", () => {
  it("lays out the driver, the fixture and the schema, with @rbw/schema linked and its dependencies copied", async () => {
    const dest = join(tempDir(), "kit");
    const staged = await stageKit(REPO, dest);
    for (const path of ["umami-driver/src/cli.ts", "umami-driver/package.json", "umami-fixture/playwright.config.ts", "umami-fixture/data/umami-tz-arg-001.v1.json", "schema/schema/records.schema.json"]) {
      expect(existsSync(join(dest, path))).toBe(true);
    }
    expect(lstatSync(join(dest, "node_modules/@rbw/schema")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, "node_modules/@rbw/schema"))).toBe("../../schema");
    expect(lstatSync(join(dest, "node_modules/ajv")).isDirectory()).toBe(true);
    expect(existsSync(join(dest, "node_modules/@playwright"))).toBe(false);
    expect(existsSync(join(dest, "node_modules/pg"))).toBe(false);
    expect(existsSync(join(dest, "umami-driver/test"))).toBe(false);
    expect(staged.addedSuiteSha256).toBe(await addedSuiteSha256(join(dest, "umami-fixture")));
  });

  it("stages the time-zone fixture by default, byte for byte as when it is named, with its unchanged added_suite_sha256", async () => {
    const byDefault = join(tempDir(), "kit");
    const named = join(tempDir(), "kit");
    const staged = await stageKit(REPO, byDefault);
    await stageKit(REPO, named, { fixturePackage: "packages/umami-fixture" });
    expect(treeDigest(byDefault)).toEqual(treeDigest(named));
    expect(existsSync(join(byDefault, "umami-fixture/data/umami-tz-arg-001.v1.json"))).toBe(true);
    expect(staged.addedSuiteSha256).toBe(TZ_ADDED_SUITE_SHA256);
  });

  it("stages a named fixture package into the same umami-fixture slot, leaving the driver and the schema as by default", async () => {
    const byDefault = join(tempDir(), "kit");
    const race = join(tempDir(), "kit");
    const tz = await stageKit(REPO, byDefault);
    const staged = await stageKit(REPO, race, { fixturePackage: "packages/umami-fixture-rc1" });
    expect(existsSync(join(race, "umami-fixture/data/rc-1-backup-code-001.v1.json"))).toBe(true);
    expect(existsSync(join(race, "umami-fixture/checks/rc1.check.ts"))).toBe(true);
    expect(existsSync(join(race, "umami-fixture/data/umami-tz-arg-001.v1.json"))).toBe(false);
    expect(existsSync(join(race, "umami-fixture/test"))).toBe(false);
    expect(staged.addedSuiteSha256).toBe(await addedSuiteSha256(join(race, "umami-fixture")));
    expect(staged.addedSuiteSha256).not.toBe(tz.addedSuiteSha256);
    const outsideFixture = (digest: Record<string, string>) => Object.fromEntries(Object.entries(digest).filter(([path]) => !path.startsWith("umami-fixture/")));
    expect(outsideFixture(treeDigest(race))).toEqual(outsideFixture(treeDigest(byDefault)));
  });

  it.each(["packages/schema", "packages/umami-driver", "packages/umami-fixturex", "../umami-fixture", "packages/umami-fixture/../schema", "/tmp/umami-fixture-x"])("refuses %s as a fixture package", async (path) => {
    await expect(stageKit(REPO, join(tempDir(), "kit"), { fixturePackage: path })).rejects.toThrow(/--fixture-package/);
  });

  it("takes --fixture-package on the command line and prints the staged fixture's hash", async () => {
    const dest = join(tempDir(), "kit");
    const result = spawnSync(process.execPath, [join(REPO, "packages/umami-driver/scripts/stage-kit.ts"), "--dest", dest, "--fixture-package", "packages/umami-fixture-rc1"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`added_suite_sha256=${await addedSuiteSha256(join(dest, "umami-fixture"))}\n`);
    expect(existsSync(join(dest, "umami-fixture/data/rc-1-backup-code-001.v1.json"))).toBe(true);
  });

  it("gives a staged driver that starts from a verifier root, resolving its imports there", async () => {
    const root = tempDir();
    const dest = join(root, "verifier", "kit");
    await stageKit(REPO, dest);
    mkdirSync(join(root, "verifier", "node_modules"), { recursive: true });
    symlinkSync(realpathSync(join(REPO, "packages/umami-driver/node_modules/pg")), join(root, "verifier", "node_modules", "pg"));
    const result = spawnSync(process.execPath, [join(dest, "umami-driver/src/cli.ts")], { encoding: "utf8" });
    expect(result.stderr).toContain("usage: cli.ts run|freeze|fetch-closure");
    expect(result.status).toBe(2);
  });
});

describe("the proof job", () => {
  it("builds a kit_check job whose expected trials carry the frozen suite and the fixture's clean vector", () => {
    const v = verifier(tempDir());
    const job = buildProofJob({ suiteManifest: encodeSuiteManifest(v.manifest).bytes, addedSuiteSha256: hex(4), imageDigest: `sha256:${hex(8)}` });
    const input = readJob(job.requestBytes, (key) => (key === job.request.expected_trials_key ? job.expectedTrialsBytes : null), "clean-01");
    expect(input.request.kind).toBe("kit_check");
    expect(input.trial).toMatchObject({
      original_suite_sha256: v.encoded.sha256,
      original_test_ids: v.manifest.tests.map((test) => test.id),
      added_suite_sha256: hex(4),
      added_repeat_count: 20,
    });
    expect(input.trial.expected_checks.map((check) => [check.check_id, check.expected])).toEqual([
      ["tzarg.utc-day-counts", "pass"],
      ["tzarg.la-day-counts", "pass"],
      ["tzarg.auckland-day-counts", "pass"],
      ["tzarg.kolkata-day-counts", "pass"],
    ]);
    expect(input.request.image_digest).toBe(`sha256:${hex(8)}`);
    expect(() => readJob(job.requestBytes, () => job.expectedTrialsBytes, "planted-01")).toThrow(RefusedInput);
  });
});
