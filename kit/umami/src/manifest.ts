// Builds /opt/rbw/verifier/image-manifest.json at image build time. Run by the verifier's
// Node 24, which strips the types. The output holds no timestamps, so the same inputs give
// the same bytes.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

export const BUILD_OUTPUT_KINDS = ["dir", "file", "sticky", "tracked"] as const;
export type BuildOutputKind = (typeof BUILD_OUTPUT_KINDS)[number];

export interface BuildOutput {
  kind: BuildOutputKind;
  path: string;
}

export interface EnvFile {
  set: Record<string, string>;
  unset: string[];
}

export interface HashEntry {
  path: string;
  sha256: string;
}

export interface ApkPackage {
  name: string;
  version: string;
}

export interface BaseImage {
  tag: string;
  digest: string;
}

export interface BuildInput {
  path: string;
  source?: string;
  sha256: string;
}

export interface ManifestInputs {
  umamiCommit: string;
  umamiLockSha256: string;
  verifierLockSha256: string;
  /** SHA-256 of the list of tracked Umami files and their hashes, as generated from the pinned checkout. */
  appTrackedSha256: string;
  baseImages: { app: BaseImage; verifierNode: BaseImage; postgres: BaseImage };
  /** Raw version outputs: /etc/alpine-release, `node --version`, `pnpm --version`, `postgres --version`. */
  versions: { alpine: string; node: string; verifierNode: string; pnpm: string; postgres: string };
  apkInstalled: string;
  appEnv: string;
  buildEnv: string;
  buildOutputs: string;
  closure: string;
  buildInputs: BuildInput[];
}

export interface Manifest {
  schema: string;
  umami: { repository: string; commit: string; pnpmLockSha256: string; trackedFilesListSha256: string };
  baseImages: { app: BaseImage; verifierNode: BaseImage; postgres: BaseImage };
  versions: { alpine: string; node: string; verifierNode: string; pnpm: string; postgres: string; tzdata: string };
  alpinePackages: ApkPackage[];
  verifier: { lockfileSha256: string; suite: HashEntry[] };
  buildInputs: BuildInput[];
  environment: { app: EnvFile; build: EnvFile };
  buildOutputs: BuildOutput[];
  users: { "rbw-app": number; "rbw-db": number };
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

function lines(text: string): { line: string; number: number }[] {
  return text
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line !== "" && !line.startsWith("#"));
}

function byKey<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

/** Reads the launcher's env-file format: KEY=VALUE, "unset KEY", comments and blank lines. */
export function parseEnvFile(text: string): EnvFile {
  const set = new Map<string, string>();
  const unset = new Set<string>();
  for (const { line, number } of lines(text)) {
    const unsetMatch = /^unset (\S+)$/.exec(line);
    const key = unsetMatch?.[1] ?? line.slice(0, Math.max(line.indexOf("="), 0));
    if (!ENV_KEY.test(key)) {
      throw new Error(`env file line ${String(number)}: expected KEY=VALUE or "unset KEY"`);
    }
    if (unsetMatch === null) {
      set.set(key, line.slice(key.length + 1));
    } else {
      unset.add(key);
    }
  }
  for (const key of unset) {
    if (set.has(key)) {
      throw new Error(`env file both sets and unsets ${key}`);
    }
  }
  return {
    set: Object.fromEntries([...set.entries()].sort(byKey(([key]) => key))),
    unset: [...unset].sort(),
  };
}

/** Reads build-outputs.txt: "<kind> <relative path>" per line. */
export function parseBuildOutputs(text: string): BuildOutput[] {
  const outputs = lines(text).map(({ line, number }) => {
    const match = /^(\S+) (\S+)$/.exec(line);
    const kind = BUILD_OUTPUT_KINDS.find((candidate) => candidate === match?.[1]);
    const path = match?.[2] ?? "";
    const safe = path !== "" && !path.startsWith("/") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
    if (kind === undefined || !safe) {
      throw new Error(`build outputs line ${String(number)}: expected "<${BUILD_OUTPUT_KINDS.join("|")}> <relative path>"`);
    }
    return { kind, path };
  });
  return outputs.sort(byKey((output) => `${output.kind} ${output.path}`));
}

/** Reads a sha256sum list ("<hash>  <path>" per line). */
export function parseHashList(text: string): HashEntry[] {
  return lines(text).map(({ line, number }) => {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`hash list line ${String(number)}: expected "<sha256>  <path>"`);
    }
    return { path: match[2], sha256: match[1] };
  });
}

/** Reads apk's installed database (/lib/apk/db/installed): one record per package, P: and V: fields. */
export function parseApkInstalled(text: string): ApkPackage[] {
  const packages: ApkPackage[] = [];
  for (const record of text.split(/\n\s*\n/)) {
    const field = (name: string) => new RegExp(`^${name}:(.+)$`, "m").exec(record)?.[1];
    const name = field("P");
    const version = field("V");
    if (name !== undefined && version !== undefined) {
      packages.push({ name, version });
    }
  }
  return packages.sort(byKey((item) => item.name));
}

function version(label: string, raw: string, pattern: RegExp): string {
  const match = pattern.exec(raw.trim());
  if (match?.[1] === undefined) {
    throw new Error(`cannot read the ${label} version from ${JSON.stringify(raw)}`);
  }
  return match[1];
}

function checkImage(label: string, image: BaseImage): BaseImage {
  if (!/^sha256:[0-9a-f]{64}$/.test(image.digest) || image.tag === "") {
    throw new Error(`base image ${label} needs a tag and a sha256 digest`);
  }
  return { tag: image.tag, digest: image.digest };
}

function checkHash(label: string, value: string): string {
  if (!SHA256.test(value)) {
    throw new Error(`${label} is not a SHA-256 hex digest`);
  }
  return value;
}

export function buildManifest(inputs: ManifestInputs): Manifest {
  const alpinePackages = parseApkInstalled(inputs.apkInstalled);
  const tzdata = alpinePackages.find((item) => item.name === "tzdata");
  if (tzdata === undefined) {
    throw new Error("tzdata is not installed");
  }
  if (!/^[0-9a-f]{40}$/.test(inputs.umamiCommit)) {
    throw new Error("the Umami commit is not a full commit hash");
  }
  return {
    schema: "rbw-umami-kit-image-manifest/1",
    umami: {
      repository: "https://github.com/umami-software/umami",
      commit: inputs.umamiCommit,
      pnpmLockSha256: checkHash("the Umami lockfile hash", inputs.umamiLockSha256),
      trackedFilesListSha256: checkHash("the tracked files list hash", inputs.appTrackedSha256),
    },
    baseImages: {
      app: checkImage("app", inputs.baseImages.app),
      verifierNode: checkImage("verifierNode", inputs.baseImages.verifierNode),
      postgres: checkImage("postgres", inputs.baseImages.postgres),
    },
    versions: {
      alpine: version("alpine", inputs.versions.alpine, /^([0-9]+\.[0-9]+\.[0-9]+)$/),
      node: version("node", inputs.versions.node, /^v([0-9]+\.[0-9]+\.[0-9]+)$/),
      verifierNode: version("verifier node", inputs.versions.verifierNode, /^v([0-9]+\.[0-9]+\.[0-9]+)$/),
      pnpm: version("pnpm", inputs.versions.pnpm, /^([0-9]+\.[0-9]+\.[0-9]+)$/),
      postgres: version("postgres", inputs.versions.postgres, /^postgres \(PostgreSQL\) ([0-9]+\.[0-9]+)$/),
      tzdata: tzdata.version,
    },
    alpinePackages,
    verifier: {
      lockfileSha256: checkHash("the verifier lockfile hash", inputs.verifierLockSha256),
      suite: parseHashList(inputs.closure).sort(byKey((entry) => entry.path)),
    },
    buildInputs: inputs.buildInputs
      .map((input) => ({ ...input, sha256: checkHash(`build input ${input.path}`, input.sha256) }))
      .sort(byKey((input) => input.path)),
    environment: { app: parseEnvFile(inputs.appEnv), build: parseEnvFile(inputs.buildEnv) },
    buildOutputs: parseBuildOutputs(inputs.buildOutputs),
    users: { "rbw-app": 2001, "rbw-db": 2002 },
  };
}

export function renderManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function image(flag: string, value: string | undefined): BaseImage {
  const index = value?.lastIndexOf("=") ?? -1;
  if (value === undefined || index <= 0) {
    throw new Error(`--${flag} must be <tag>=<digest>`);
  }
  return { tag: value.slice(0, index), digest: value.slice(index + 1) };
}

function main(argv: string[]): void {
  const stringFlags = [
    "out", "umami-commit", "umami-lock", "verifier-lock", "app-tracked", "app-image", "verifier-image",
    "postgres-image", "alpine-release", "node-version", "verifier-node-version", "pnpm-version",
    "postgres-version", "apk-installed", "app-env", "build-env", "build-outputs", "closure",
  ] as const;
  const options: ParseArgsOptionsConfig = {
    ...Object.fromEntries(stringFlags.map((name) => [name, { type: "string" }])),
    "build-input": { type: "string", multiple: true },
  };
  const { values } = parseArgs({ args: argv, options, strict: true });
  const flag = (name: (typeof stringFlags)[number]): string => {
    const value = values[name];
    if (typeof value !== "string" || value === "") {
      throw new Error(`--${name} is required`);
    }
    return value;
  };
  const text = (name: (typeof stringFlags)[number]) => readFileSync(flag(name), "utf8");
  const rawBuildInputs = values["build-input"];
  const specs = Array.isArray(rawBuildInputs) ? rawBuildInputs.filter((spec) => typeof spec === "string") : [];
  const buildInputs = specs.map((spec) => {
    const parts = spec.split("=");
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => part === "")) {
      throw new Error("--build-input must be <path>=<file> or <path>=<source>=<file>");
    }
    const file = parts.at(-1) ?? "";
    const input: BuildInput = { path: parts[0] ?? "", sha256: sha256File(file) };
    if (parts.length === 3) {
      input.source = parts[1] ?? "";
    }
    return input;
  });
  const manifest = buildManifest({
    umamiCommit: flag("umami-commit"),
    umamiLockSha256: sha256File(flag("umami-lock")),
    verifierLockSha256: sha256File(flag("verifier-lock")),
    appTrackedSha256: sha256File(flag("app-tracked")),
    baseImages: {
      app: image("app-image", flag("app-image")),
      verifierNode: image("verifier-image", flag("verifier-image")),
      postgres: image("postgres-image", flag("postgres-image")),
    },
    versions: {
      alpine: text("alpine-release"),
      node: flag("node-version"),
      verifierNode: flag("verifier-node-version"),
      pnpm: flag("pnpm-version"),
      postgres: flag("postgres-version"),
    },
    apkInstalled: text("apk-installed"),
    appEnv: text("app-env"),
    buildEnv: text("build-env"),
    buildOutputs: text("build-outputs"),
    closure: text("closure"),
    buildInputs,
  });
  writeFileSync(flag("out"), renderManifest(manifest), { mode: 0o600 });
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`manifest: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
