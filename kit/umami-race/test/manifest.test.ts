import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEnvFile } from "../../umami/src/manifest.ts";
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

const BASE_MANIFEST = `${JSON.stringify(
  {
    schema: BASE_SCHEMA,
    umami: { repository: "https://github.com/umami-software/umami", commit: "ec0ff50388c264ed8ce46f00967e92f7e71476ae" },
    environment: { app: parseEnvFile(TZ_APP_ENV), build: { set: { SKIP_BUILD_GEO: "1" }, unset: [] } },
    users: { "rbw-app": 2001, "rbw-db": 2002 },
  },
  null,
  2,
)}\n`;

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
    expect(manifest.umami).toEqual(base.umami);
    expect(manifest.users).toEqual(base.users);
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
