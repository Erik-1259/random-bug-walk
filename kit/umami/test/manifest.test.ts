import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  parseApkInstalled,
  parseBuildOutputs,
  parseEnvFile,
  parseHashList,
  renderManifest,
  type ManifestInputs,
} from "../src/manifest.ts";
import { kitRoot } from "./kit-files.ts";

const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
const hash = (fill: string) => fill.repeat(64);

const apkInstalled = [
  "C:Q1synthetic=",
  "P:zlib",
  "V:1.3.1-r2",
  "A:aarch64",
  "",
  "P:tzdata",
  "V:2026d-r0",
  "",
  "P:busybox",
  "V:1.37.0-r31",
  "",
].join("\n");

function inputs(overrides: Partial<ManifestInputs> = {}): ManifestInputs {
  return {
    umamiCommit: "ec0ff50388c264ed8ce46f00967e92f7e71476ae",
    umamiLockSha256: hash("a"),
    verifierLockSha256: hash("b"),
    appTrackedSha256: hash("c"),
    baseImages: {
      app: { tag: "node:22-alpine", digest: digest("1") },
      verifierNode: { tag: "node:24-alpine", digest: digest("2") },
      postgres: { tag: "postgres:15-alpine", digest: digest("3") },
    },
    versions: {
      alpine: "3.24.2",
      node: "v22.23.3",
      verifierNode: "v24.21.0",
      pnpm: "12.3.4",
      postgres: "postgres (PostgreSQL) 15.19",
    },
    apkInstalled,
    appEnv: "TZ=UTC\nAPP_SECRET=synthetic-secret\nunset REDIS_URL\n",
    buildEnv: "# comment\nSKIP_BUILD_GEO=1\nunset CLOUD_MODE\n",
    buildOutputs: "dir .next\nfile next-env.d.ts\n",
    closure: `${hash("d")}  playwright.api.config.ts\n${hash("e")}  tests/api/paths.ts\n`,
    buildInputs: [{ path: "src/proxy.ts", source: "docker/proxy.ts", sha256: hash("f") }],
    ...overrides,
  };
}

describe("parsers", () => {
  it("reads env files with values containing = and explicit unsets", () => {
    expect(parseEnvFile("# c\n\nA=x=y\nunset B\nC=\n")).toEqual({ set: { A: "x=y", C: "" }, unset: ["B"] });
  });

  it("rejects env lines without a key", () => {
    expect(() => parseEnvFile("=x\n")).toThrow(/line 1/);
    expect(() => parseEnvFile("export A=1\n")).toThrow(/line 1/);
  });

  it("rejects an env key that is both set and unset", () => {
    expect(() => parseEnvFile("A=1\nunset A\n")).toThrow(/A/);
  });

  it("reads build outputs and rejects unknown kinds or unsafe paths", () => {
    expect(parseBuildOutputs("dir .next\n# c\nsticky packages/mcp\n")).toEqual([
      { kind: "dir", path: ".next" },
      { kind: "sticky", path: "packages/mcp" },
    ]);
    expect(() => parseBuildOutputs("folder .next\n")).toThrow(/line 1/);
    expect(() => parseBuildOutputs("dir ../etc\n")).toThrow(/line 1/);
    expect(() => parseBuildOutputs("dir /etc\n")).toThrow(/line 1/);
  });

  it("reads sha256sum lists and rejects malformed lines", () => {
    expect(parseHashList(`${hash("a")}  x/y.ts\n`)).toEqual([{ path: "x/y.ts", sha256: hash("a") }]);
    expect(() => parseHashList(`${hash("a")} x/y.ts\n`)).toThrow(/line 1/);
  });

  it("reads the apk database sorted by package name", () => {
    expect(parseApkInstalled(apkInstalled)).toEqual([
      { name: "busybox", version: "1.37.0-r31" },
      { name: "tzdata", version: "2026d-r0" },
      { name: "zlib", version: "1.3.1-r2" },
    ]);
  });
});

describe("buildManifest", () => {
  it("records versions, the tzdata version, packages, hashes, environment and outputs", () => {
    const manifest = buildManifest(inputs());
    expect(manifest.versions).toEqual({
      alpine: "3.24.2",
      node: "22.23.3",
      verifierNode: "24.21.0",
      pnpm: "12.3.4",
      postgres: "15.19",
      tzdata: "2026d-r0",
    });
    expect(manifest.umami).toEqual({
      repository: "https://github.com/umami-software/umami",
      commit: "ec0ff50388c264ed8ce46f00967e92f7e71476ae",
      pnpmLockSha256: hash("a"),
      trackedFilesListSha256: hash("c"),
    });
    expect(manifest.verifier.suite).toEqual([
      { path: "playwright.api.config.ts", sha256: hash("d") },
      { path: "tests/api/paths.ts", sha256: hash("e") },
    ]);
    expect(manifest.environment.app).toEqual({ set: { APP_SECRET: "synthetic-secret", TZ: "UTC" }, unset: ["REDIS_URL"] });
    expect(manifest.buildOutputs).toEqual([
      { kind: "dir", path: ".next" },
      { kind: "file", path: "next-env.d.ts" },
    ]);
    expect(manifest.alpinePackages).toHaveLength(3);
  });

  it("fails when tzdata is not installed", () => {
    expect(() => buildManifest(inputs({ apkInstalled: "P:zlib\nV:1\n" }))).toThrow(/tzdata/);
  });

  it("fails on a digest that is not a sha256 digest", () => {
    const bad = inputs();
    bad.baseImages.app.digest = "latest";
    expect(() => buildManifest(bad)).toThrow(/app/);
  });

  it("fails on a version string it cannot read", () => {
    expect(() => buildManifest(inputs({ versions: { ...inputs().versions, postgres: "unknown" } }))).toThrow(/postgres/);
  });

  it("renders identically for the same inputs in any order, with no timestamps", () => {
    const shuffled = inputs({
      appEnv: "unset REDIS_URL\nAPP_SECRET=synthetic-secret\nTZ=UTC\n",
      buildOutputs: "file next-env.d.ts\ndir .next\n",
    });
    const first = renderManifest(buildManifest(inputs()));
    expect(renderManifest(buildManifest(shuffled))).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    expect(first).not.toMatch(/20[0-9]{2}-[0-9]{2}-[0-9]{2}T/);
  });
});

describe("manifest CLI", () => {
  it("writes the manifest from files and flags, hashing the files it is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "rbw-manifest-"));
    const file = (name: string, content: string) => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    };
    const lock = file("lock.yaml", "lockfileVersion: '9.0'\n");
    const out = join(dir, "manifest.json");
    const args = [
      join(kitRoot, "src/manifest.ts"),
      "--out", out,
      "--umami-commit", "ec0ff50388c264ed8ce46f00967e92f7e71476ae",
      "--umami-lock", lock,
      "--verifier-lock", lock,
      "--app-tracked", lock,
      "--app-image", `node:22-alpine=${digest("1")}`,
      "--verifier-image", `node:24-alpine=${digest("2")}`,
      "--postgres-image", `postgres:15-alpine=${digest("3")}`,
      "--alpine-release", file("alpine-release", "3.24.2\n"),
      "--node-version", "v22.23.3",
      "--verifier-node-version", "v24.21.0",
      "--pnpm-version", "12.3.4",
      "--postgres-version", "postgres (PostgreSQL) 15.19",
      "--apk-installed", file("installed", apkInstalled),
      "--app-env", file("app.environment", "TZ=UTC\n"),
      "--build-env", file("build.environment", "SKIP_BUILD_GEO=1\n"),
      "--build-outputs", file("outputs.txt", "dir .next\n"),
      "--closure", file("closure.sha256", `${hash("d")}  playwright.api.config.ts\n`),
      "--build-input", `src/proxy.ts=docker/proxy.ts=${lock}`,
    ];
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const manifest = JSON.parse(readFileSync(out, "utf8")) as ReturnType<typeof buildManifest>;
    const lockHash = createHash("sha256").update("lockfileVersion: '9.0'\n").digest("hex");
    expect(manifest.umami.pnpmLockSha256).toBe(lockHash);
    expect(manifest.verifier.lockfileSha256).toBe(lockHash);
    expect(manifest.buildInputs).toEqual([
      { path: "src/proxy.ts", source: "docker/proxy.ts", sha256: lockHash },
    ]);
    expect(manifest.versions.alpine).toBe("3.24.2");
  });

  it("exits non-zero and writes nothing when an input is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rbw-manifest-"));
    const out = join(dir, "manifest.json");
    const result = spawnSync(process.execPath, [join(kitRoot, "src/manifest.ts"), "--out", out], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(out)).toThrow();
  });
});
