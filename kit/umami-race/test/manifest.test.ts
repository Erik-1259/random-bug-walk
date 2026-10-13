import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, parseEnvFile, renderManifest } from "../../umami/src/manifest.ts";
import {
  BASE_SCHEMA,
  buildRaceManifest,
  checkAppEnv,
  parseLatency,
  PROXY,
  RACE_SCHEMA,
  renderRaceManifest,
  type RaceInputs,
} from "../src/race-manifest.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const TZ_APP_ENV = read("../../umami/etc/app.environment");
const RACE_APP_ENV = read("../etc/app.environment");
const HASHES = read("../toxiproxy.sha256");
const AMD64 = "556d891134a3c582dc1e1a3f7335fd55142e5965769855a00b944e13e48302fc";
const ARM64 = "53e770c1c3035b5a9f1bc629fce537db1f95f62b26f4ebe6e756afd701cf077c";

const hash = (fill: string) => fill.repeat(64);
const digest = (fill: string) => `sha256:${hash(fill)}`;

// A full time-zone kit manifest from kit/umami's own builder, so every base field is present.
const BASE_MANIFEST = renderManifest(
  buildManifest({
    umamiCommit: "ec0ff50388c264ed8ce46f00967e92f7e71476ae",
    umamiLockSha256: hash("a"),
    verifierLockSha256: hash("b"),
    appTrackedSha256: hash("c"),
    baseImages: {
      app: { tag: "node:22-alpine", digest: digest("1") },
      verifierNode: { tag: "node:24-alpine", digest: digest("2") },
      postgres: { tag: "postgres:15-alpine", digest: digest("3") },
    },
    versions: { alpine: "3.24.2", node: "v22.23.3", verifierNode: "v24.21.0", pnpm: "12.3.4", postgres: "postgres (PostgreSQL) 15.19" },
    apkInstalled: "P:tzdata\nV:2026d-r0\n\nP:busybox\nV:1.37.0-r31\n",
    appEnv: TZ_APP_ENV,
    buildEnv: "SKIP_BUILD_GEO=1\n",
    buildOutputs: "dir .next\nfile next-env.d.ts\n",
    closure: `${hash("d")}  playwright.api.config.ts\n`,
    buildInputs: [{ path: "src/proxy.ts", source: "docker/proxy.ts", sha256: hash("f") }],
  }),
);

function inputs(overrides: Partial<RaceInputs> = {}): RaceInputs {
  return {
    baseManifest: BASE_MANIFEST,
    appEnv: RACE_APP_ENV,
    raceEnv: "RBW_RACE_LATENCY_MS=0\n",
    toxiproxyHashes: HASHES,
    toxiproxySha256: AMD64,
    toxiproxyVersion: "2.12.0",
    arch: "amd64",
    ...overrides,
  };
}

describe("committed Toxiproxy hashes", () => {
  it("pins the amd64 and arm64 v2.12.0 server binaries by the hashes in the release's checksums.txt", () => {
    expect(HASHES).toContain(`${AMD64}  toxiproxy-server-linux-amd64\n`);
    expect(HASHES).toContain(`${ARM64}  toxiproxy-server-linux-arm64\n`);
    expect(HASHES).toMatch(/v2\.12\.0/);
  });
});

describe("race app environment", () => {
  it("is the time-zone kit's app environment with DATABASE_URL on the proxy port", () => {
    expect(() => {
      checkAppEnv(parseEnvFile(TZ_APP_ENV), parseEnvFile(RACE_APP_ENV));
    }).not.toThrow();
    expect(parseEnvFile(RACE_APP_ENV).set.DATABASE_URL).toMatch(/@127\.0\.0\.1:5433\/umami$/);
  });

  it("rejects a DATABASE_URL that still points straight at Postgres", () => {
    expect(() => {
      checkAppEnv(parseEnvFile(TZ_APP_ENV), parseEnvFile(TZ_APP_ENV));
    }).toThrow(/must be the base one on 127\.0\.0\.1:5433/);
  });

  it("rejects any other difference from the base environment", () => {
    const changed = parseEnvFile(RACE_APP_ENV.replace("DISABLE_BOT_CHECK=1", "DISABLE_BOT_CHECK=0"));
    expect(() => {
      checkAppEnv(parseEnvFile(TZ_APP_ENV), changed);
    }).toThrow(/more than DATABASE_URL/);
    const unsetDropped = parseEnvFile(RACE_APP_ENV.replace("unset REDIS_URL\n", ""));
    expect(() => {
      checkAppEnv(parseEnvFile(TZ_APP_ENV), unsetDropped);
    }).toThrow(/more than DATABASE_URL/);
  });
});

describe("latency", () => {
  it("accepts whole milliseconds from 0 to 10000", () => {
    expect(parseLatency("RBW_RACE_LATENCY_MS=0\n")).toBe(0);
    expect(parseLatency("# comment\nRBW_RACE_LATENCY_MS=250\n")).toBe(250);
    expect(parseLatency("RBW_RACE_LATENCY_MS=10000\n")).toBe(10000);
  });

  it.each(["", "-1", "1.5", "007", "10001", "99999", "1e3", " 5"])("rejects %j", (value) => {
    expect(() => parseLatency(`RBW_RACE_LATENCY_MS=${value}\n`)).toThrow();
  });

  it("rejects a missing value and any other key", () => {
    expect(() => parseLatency("")).toThrow();
    expect(() => parseLatency("RBW_RACE_LATENCY_MS=5\nOTHER=1\n")).toThrow(/only RBW_RACE_LATENCY_MS/);
  });
});

describe("race manifest", () => {
  it("records the base manifest's hash, the pinned binary, the proxy and the toxic", () => {
    const manifest = buildRaceManifest(inputs({ raceEnv: "RBW_RACE_LATENCY_MS=40\n" }));
    expect(manifest.schema).toBe(RACE_SCHEMA);
    expect(manifest.race.baseManifest).toEqual({
      schema: BASE_SCHEMA,
      sha256: createHash("sha256").update(BASE_MANIFEST).digest("hex"),
    });
    expect(manifest.race.toxiproxy).toEqual({
      version: "2.12.0",
      binary: "toxiproxy-server-linux-amd64",
      source: "https://github.com/Shopify/toxiproxy/releases/download/v2.12.0/toxiproxy-server-linux-amd64",
      sha256: AMD64,
    });
    expect(manifest.race.proxy).toEqual({ name: "postgres", api: "127.0.0.1:8474", listen: "127.0.0.1:5433", upstream: "127.0.0.1:5432" });
    expect(manifest.race.toxic).toEqual({ name: "latency_downstream", type: "latency", stream: "downstream", toxicity: 1, latencyMs: 40, jitterMs: 0 });
  });

  it("replaces the app environment and keeps every other base field", () => {
    const manifest = buildRaceManifest(inputs());
    const base = JSON.parse(BASE_MANIFEST) as Record<string, unknown>;
    expect(manifest.environment.app.set.DATABASE_URL).toMatch(/:5433\/umami$/);
    expect(manifest.environment.build).toEqual({ set: { SKIP_BUILD_GEO: "1" }, unset: [] });
    const without = (value: object, keys: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
    const raceRest = without(manifest, ["schema", "environment", "race"]);
    const baseRest = without(base, ["schema", "environment"]);
    expect(Object.keys(baseRest).sort()).toEqual([
      "alpinePackages",
      "baseImages",
      "buildInputs",
      "buildOutputs",
      "umami",
      "users",
      "verifier",
      "versions",
    ]);
    expect(raceRest).toEqual(baseRest);
  });

  it("picks the hash for the target architecture", () => {
    expect(buildRaceManifest(inputs({ arch: "arm64", toxiproxySha256: ARM64 })).race.toxiproxy.sha256).toBe(ARM64);
    expect(() => buildRaceManifest(inputs({ arch: "arm64", toxiproxySha256: AMD64 }))).toThrow(/differs from the pinned/);
    expect(() => buildRaceManifest(inputs({ arch: "riscv64" }))).toThrow(/unsupported architecture/);
  });

  it("refuses a binary whose hash is not the pinned one", () => {
    expect(() => buildRaceManifest(inputs({ toxiproxySha256: "0".repeat(64) }))).toThrow(/differs from the pinned/);
  });

  it("refuses another Toxiproxy version and a base that is not a time-zone kit manifest", () => {
    expect(() => buildRaceManifest(inputs({ toxiproxyVersion: "2.11.0" }))).toThrow(/not the pinned 2\.12\.0/);
    expect(() => buildRaceManifest(inputs({ baseManifest: BASE_MANIFEST.replace(BASE_SCHEMA, RACE_SCHEMA) }))).toThrow(/schema/);
  });

  it("refuses an app environment that bypasses the proxy", () => {
    expect(() => buildRaceManifest(inputs({ appEnv: TZ_APP_ENV }))).toThrow(/DATABASE_URL/);
  });

  it("renders the same bytes for the same inputs", () => {
    const first = renderRaceManifest(buildRaceManifest(inputs()));
    expect(renderRaceManifest(buildRaceManifest(inputs()))).toBe(first);
    expect(first.endsWith("}\n")).toBe(true);
    expect(first).not.toMatch(/"(created|timestamp|date)"/i);
  });

  it("keeps the proxy constants in step with the race app environment", () => {
    expect(parseEnvFile(RACE_APP_ENV).set.DATABASE_URL).toContain(`@${PROXY.listen}/`);
    expect(parseEnvFile(TZ_APP_ENV).set.DATABASE_URL).toContain(`@${PROXY.upstream}/`);
  });
});

describe("race-manifest CLI", () => {
  const script = new URL("../src/race-manifest.ts", import.meta.url).pathname;
  const FLAGS = ["base-manifest", "app-env", "race-env", "toxiproxy-hashes", "toxiproxy-binary", "toxiproxy-version", "arch"] as const;

  /** Writes the CLI's input files to a fresh directory; the fake binary stands in for toxiproxy-server. */
  function files(binary: string, hashes?: string) {
    const dir = mkdtempSync(join(tmpdir(), "rbw-race-manifest-"));
    const file = (name: string, text: string) => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    };
    const binarySha = createHash("sha256").update(binary).digest("hex");
    const args: Record<(typeof FLAGS)[number], string> = {
      "base-manifest": file("base-image-manifest.json", BASE_MANIFEST),
      "app-env": file("app.environment", RACE_APP_ENV),
      "race-env": file("race.environment", "# from the build\nRBW_RACE_LATENCY_MS=40\n"),
      "toxiproxy-hashes": file("toxiproxy.sha256", hashes ?? `${binarySha}  toxiproxy-server-linux-amd64\n`),
      "toxiproxy-binary": file("toxiproxy-server", binary),
      "toxiproxy-version": "2.12.0",
      arch: "amd64",
    };
    return { binarySha, out: join(dir, "image-manifest.json"), args };
  }

  function run(out: string, args: Partial<Record<(typeof FLAGS)[number], string>>) {
    const argv = [script, "--out", out, ...Object.entries(args).flatMap(([name, value]) => [`--${name}`, value])];
    return spawnSync(process.execPath, argv, { encoding: "utf8" });
  }

  it("hashes the binary file, maps each flag to its input and writes the manifest owner-only", () => {
    const { out, args, binarySha } = files("fake toxiproxy-server\n");
    const result = run(out, args);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(readFileSync(out, "utf8")) as ReturnType<typeof buildRaceManifest>;
    expect(manifest.race.toxiproxy.sha256).toBe(binarySha);
    expect(manifest.race.toxic.latencyMs).toBe(40);
    expect(manifest.environment.app.set.DATABASE_URL).toMatch(/@127\.0\.0\.1:5433\/umami$/);
    expect(manifest.race.baseManifest.sha256).toBe(createHash("sha256").update(BASE_MANIFEST).digest("hex"));
    expect(readFileSync(out, "utf8")).toBe(renderRaceManifest(manifest));
  });

  it("refuses a binary that is not the pinned one and writes nothing", () => {
    const { out, args } = files("fake toxiproxy-server\n", HASHES);
    const result = run(out, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("race-manifest: the Toxiproxy binary's hash differs from the pinned toxiproxy-server-linux-amd64 hash\n");
    expect(() => readFileSync(out)).toThrow();
  });

  it.each(FLAGS)("exits 1 naming --%s when it is missing", (flag) => {
    const { out, args } = files("fake toxiproxy-server\n");
    const result = run(out, Object.fromEntries(Object.entries(args).filter(([name]) => name !== flag)));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`race-manifest: --${flag} is required\n`);
    expect(() => readFileSync(out)).toThrow();
  });
});
