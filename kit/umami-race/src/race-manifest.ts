// Builds the race kit image's /opt/rbw/verifier/image-manifest.json at image build time, from the
// time-zone kit image's manifest (kept beside it as base-image-manifest.json) and the race overlay's
// inputs. Run by the verifier's Node 24, which strips the types. The output holds no timestamps, so
// the same inputs give the same bytes.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseEnvFile, parseHashList, type EnvFile, type Manifest } from "../../umami/src/manifest.ts";
import { readLatencyFile } from "./proxy-check.ts";

export { MAX_LATENCY_MS } from "./proxy-check.ts";

export const BASE_SCHEMA = "rbw-umami-kit-image-manifest/1";
export const RACE_SCHEMA = "rbw-umami-race-kit-image-manifest/1";
export const TOXIPROXY_VERSION = "2.12.0";

/** The proxy that rbw-proxy creates; the race selftest and rbw-proxy check hold the same values. */
export const PROXY = {
  name: "postgres",
  api: "127.0.0.1:8474",
  listen: "127.0.0.1:5433",
  upstream: "127.0.0.1:5432",
} as const;

export const TOXIC = { name: "latency_downstream", type: "latency", stream: "downstream", toxicity: 1, jitterMs: 0 } as const;

export interface RaceInputs {
  /** The time-zone kit image's manifest, as written by kit/umami/src/manifest.ts. */
  baseManifest: string;
  /** The race overlay's app.environment. */
  appEnv: string;
  /** /opt/rbw/etc/race.environment, which holds RBW_RACE_LATENCY_MS. */
  raceEnv: string;
  /** toxiproxy.sha256, one line per Linux architecture. */
  toxiproxyHashes: string;
  toxiproxySha256: string;
  toxiproxyVersion: string;
  /** Docker's TARGETARCH: amd64 or arm64. */
  arch: string;
}

export interface RaceManifest extends Omit<Manifest, "schema"> {
  schema: typeof RACE_SCHEMA;
  race: {
    baseManifest: { schema: string; sha256: string };
    toxiproxy: { version: string; binary: string; source: string; sha256: string };
    proxy: typeof PROXY;
    toxic: { name: string; type: string; stream: string; toxicity: number; latencyMs: number; jitterMs: number };
  };
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Reads RBW_RACE_LATENCY_MS: the same rule rbw-proxy applies in the image, through proxy-check.ts. */
export function parseLatency(raceEnv: string): number {
  return readLatencyFile(raceEnv);
}

/**
 * Checks that the race app environment is the base one with only DATABASE_URL moved from the
 * Postgres port to the proxy listener, so the overlay changes nothing else the app sees.
 */
export function checkAppEnv(base: EnvFile, race: EnvFile): void {
  const baseUrl = base.set.DATABASE_URL ?? "";
  const expected = baseUrl.replace(`@${PROXY.upstream}/`, `@${PROXY.listen}/`);
  if (baseUrl === "" || expected === baseUrl) {
    throw new Error(`the base DATABASE_URL does not point at ${PROXY.upstream}`);
  }
  if (race.set.DATABASE_URL !== expected) {
    throw new Error(`the race DATABASE_URL must be the base one on ${PROXY.listen}`);
  }
  const rest = (env: EnvFile) => JSON.stringify({ set: { ...env.set, DATABASE_URL: "" }, unset: env.unset });
  if (rest(base) !== rest(race)) {
    throw new Error("the race app environment differs from the base one in more than DATABASE_URL");
  }
}

export function buildRaceManifest(inputs: RaceInputs): RaceManifest {
  const base = JSON.parse(inputs.baseManifest) as Manifest;
  if (base.schema !== BASE_SCHEMA) {
    throw new Error(`the base manifest's schema is ${base.schema}, expected ${BASE_SCHEMA}`);
  }
  if (inputs.toxiproxyVersion !== TOXIPROXY_VERSION) {
    throw new Error(`Toxiproxy ${inputs.toxiproxyVersion} is not the pinned ${TOXIPROXY_VERSION}`);
  }
  if (inputs.arch !== "amd64" && inputs.arch !== "arm64") {
    throw new Error(`unsupported architecture ${inputs.arch}`);
  }
  const binary = `toxiproxy-server-linux-${inputs.arch}`;
  const pinned = parseHashList(inputs.toxiproxyHashes).find((entry) => entry.path === binary);
  if (pinned === undefined) {
    throw new Error(`toxiproxy.sha256 has no entry for ${binary}`);
  }
  if (pinned.sha256 !== inputs.toxiproxySha256) {
    throw new Error(`the Toxiproxy binary's hash differs from the pinned ${binary} hash`);
  }
  const app = parseEnvFile(inputs.appEnv);
  checkAppEnv(base.environment.app, app);
  return {
    ...base,
    schema: RACE_SCHEMA,
    environment: { app, build: base.environment.build },
    race: {
      baseManifest: { schema: base.schema, sha256: sha256(inputs.baseManifest) },
      toxiproxy: {
        version: inputs.toxiproxyVersion,
        binary,
        source: `https://github.com/Shopify/toxiproxy/releases/download/v${inputs.toxiproxyVersion}/${binary}`,
        sha256: pinned.sha256,
      },
      proxy: PROXY,
      toxic: {
        name: TOXIC.name,
        type: TOXIC.type,
        stream: TOXIC.stream,
        toxicity: TOXIC.toxicity,
        latencyMs: parseLatency(inputs.raceEnv),
        jitterMs: TOXIC.jitterMs,
      },
    },
  };
}

export function renderRaceManifest(manifest: RaceManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function main(argv: string[]): void {
  const names = ["out", "base-manifest", "app-env", "race-env", "toxiproxy-hashes", "toxiproxy-binary", "toxiproxy-version", "arch"] as const;
  const { values } = parseArgs({
    args: argv,
    options: Object.fromEntries(names.map((name) => [name, { type: "string" as const }])),
    strict: true,
  });
  const flag = (name: (typeof names)[number]): string => {
    const value = values[name];
    if (typeof value !== "string" || value === "") {
      throw new Error(`--${name} is required`);
    }
    return value;
  };
  const manifest = buildRaceManifest({
    baseManifest: readFileSync(flag("base-manifest"), "utf8"),
    appEnv: readFileSync(flag("app-env"), "utf8"),
    raceEnv: readFileSync(flag("race-env"), "utf8"),
    toxiproxyHashes: readFileSync(flag("toxiproxy-hashes"), "utf8"),
    toxiproxySha256: sha256(readFileSync(flag("toxiproxy-binary"))),
    toxiproxyVersion: flag("toxiproxy-version"),
    arch: flag("arch"),
  });
  writeFileSync(flag("out"), renderRaceManifest(manifest), { mode: 0o600 });
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`race-manifest: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
