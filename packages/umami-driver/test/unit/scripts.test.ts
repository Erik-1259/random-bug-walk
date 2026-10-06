import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
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
