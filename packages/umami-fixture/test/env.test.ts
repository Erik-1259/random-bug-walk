import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readFixtureEnv } from "../src/index.ts";

const outputDir = mkdtempSync(join(tmpdir(), "rbw-umami-fixture-env-"));

afterAll(() => {
  rmSync(outputDir, { recursive: true, force: true });
});

const base = {
  RBW_FIXTURE_BASE_URL: "http://fixture.invalid:3100",
  RBW_FIXTURE_REPEAT_INDEX: "2",
  RBW_FIXTURE_OUTPUT_DIR: outputDir,
};

describe("readFixtureEnv", () => {
  it("reads the inputs and defaults to the disposable install's synthetic admin login", () => {
    expect(readFixtureEnv(base)).toEqual({
      baseUrl: "http://fixture.invalid:3100",
      repeatIndex: 2,
      outputDir,
      credentials: { username: "admin", password: "umami" },
    });
  });

  it("takes the admin login from the environment when set", () => {
    const env = { ...base, RBW_FIXTURE_ADMIN_USERNAME: "synthetic-admin", RBW_FIXTURE_ADMIN_PASSWORD: "synthetic-password" };
    expect(readFixtureEnv(env).credentials).toEqual({ username: "synthetic-admin", password: "synthetic-password" });
  });

  it.each(["", "0", "-1", "1.5", "01", "two", " 2"])("rejects the repeat index %j", (value) => {
    expect(() => readFixtureEnv({ ...base, RBW_FIXTURE_REPEAT_INDEX: value })).toThrow(/RBW_FIXTURE_REPEAT_INDEX/);
  });

  it.each(["", "fixture.invalid", "ftp://fixture.invalid"])("rejects the base URL %j", (value) => {
    expect(() => readFixtureEnv({ ...base, RBW_FIXTURE_BASE_URL: value })).toThrow(/RBW_FIXTURE_BASE_URL/);
  });

  it("rejects a missing output directory", () => {
    expect(() => readFixtureEnv({ ...base, RBW_FIXTURE_OUTPUT_DIR: join(outputDir, "missing") })).toThrow(/RBW_FIXTURE_OUTPUT_DIR/);
    expect(() => readFixtureEnv({ ...base, RBW_FIXTURE_OUTPUT_DIR: undefined })).toThrow(/RBW_FIXTURE_OUTPUT_DIR/);
  });

  it("never echoes the password in an error", () => {
    const env = { ...base, RBW_FIXTURE_REPEAT_INDEX: "0", RBW_FIXTURE_ADMIN_PASSWORD: "synthetic-secret-value" };
    expect(() => readFixtureEnv(env)).toThrow(expect.objectContaining({ message: expect.not.stringContaining("synthetic-secret-value") as unknown }));
  });
});
