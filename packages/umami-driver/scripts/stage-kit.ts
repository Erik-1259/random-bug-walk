// Stages the directory that the kit image takes as `--build-context rbw-kit=<dir>`, and that lands
// in /opt/rbw/verifier/kit/:
//
//   umami-driver/              this package's package.json and src/
//   umami-fixture/             the fixture's package.json, playwright.config.ts, src/, checks/ and data/,
//                              from packages/umami-fixture unless --fixture-package names another
//                              fixture package (each bug family stages its own into this one slot)
//   schema/                    @rbw/schema's package.json, src/, schema/ and registry/
//   node_modules/@rbw/schema   a symlink to ../../schema
//   node_modules/<name>        copies of @rbw/schema's runtime dependencies (ajv and its own)
//
// Node refuses to strip types from .ts files whose real path is under node_modules, so @rbw/schema
// is linked, not copied. @playwright/test and pg are not staged: the driver and the fixture resolve
// them from the verifier's own node_modules, the one copy the suite also uses.
//
//   node packages/umami-driver/scripts/stage-kit.ts --dest <dir> [--fixture-package packages/<name>]
//
// Prints the staged fixture's added_suite_sha256.
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { addedSuiteSha256 } from "../src/fixture.ts";

/** The fixture package staged when none is named: the released time-zone family's. */
export const DEFAULT_FIXTURE_PACKAGE = "packages/umami-fixture";

const FIXTURE_PARTS = ["package.json", "playwright.config.ts", "src", "checks", "data"] as const;

function packages(fixturePackage: string): readonly { from: string; to: string; parts: readonly string[] }[] {
  return [
    { from: "packages/umami-driver", to: "umami-driver", parts: ["package.json", "src"] },
    { from: fixturePackage, to: "umami-fixture", parts: FIXTURE_PARTS },
    { from: "packages/schema", to: "schema", parts: ["package.json", "src", "schema", "registry"] },
  ];
}

/** A fixture package path: packages/umami-fixture or packages/umami-fixture-<name>. */
function checkFixturePackage(path: string): string {
  if (!/^packages\/umami-fixture(?:-[a-z0-9]+)*$/.test(path)) {
    throw new Error(`--fixture-package must be packages/umami-fixture or packages/umami-fixture-<name>, not ${path}`);
  }
  return path;
}

interface PackageJson {
  version?: string;
  dependencies?: Record<string, string>;
}

async function readPackage(dir: string): Promise<PackageJson> {
  return JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as PackageJson;
}

/** The real directory a package name resolves to from a directory, by Node's node_modules lookup. */
async function resolvePackage(fromDir: string, name: string): Promise<string> {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpath(candidate);
    if (dirname(dir) === dir) throw new Error(`cannot resolve ${name} from ${fromDir}`);
  }
}

/** Copies a package's runtime dependencies, and theirs, flat into node_modules; a version conflict is refused. */
async function copyDependencies(fromDir: string, nodeModules: string, copied: Map<string, string>): Promise<void> {
  for (const name of Object.keys((await readPackage(fromDir)).dependencies ?? {})) {
    const source = await resolvePackage(fromDir, name);
    const version = (await readPackage(source)).version ?? "";
    const existing = copied.get(name);
    if (existing !== undefined) {
      if (existing !== version) throw new Error(`${name} is needed at ${existing} and ${version}; a flat node_modules cannot hold both`);
      continue;
    }
    copied.set(name, version);
    await cp(source, join(nodeModules, name), {
      recursive: true,
      dereference: true,
      filter: (path) => !relative(source, path).split(sep).includes("node_modules"),
    });
    await copyDependencies(source, nodeModules, copied);
  }
}

export async function stageKit(repoRoot: string, dest: string, options: { fixturePackage?: string } = {}): Promise<{ addedSuiteSha256: string }> {
  const fixturePackage = checkFixturePackage(options.fixturePackage ?? DEFAULT_FIXTURE_PACKAGE);
  if (existsSync(dest) && (await readdir(dest)).length > 0) throw new Error(`${dest} is not empty`);
  for (const pkg of packages(fixturePackage)) {
    for (const part of pkg.parts) {
      await cp(join(repoRoot, pkg.from, part), join(dest, pkg.to, part), { recursive: true });
    }
  }
  const nodeModules = join(dest, "node_modules");
  await mkdir(join(nodeModules, "@rbw"), { recursive: true });
  await symlink("../../schema", join(nodeModules, "@rbw", "schema"), "dir");
  await copyDependencies(await realpath(join(repoRoot, "packages/schema")), nodeModules, new Map());
  return { addedSuiteSha256: await addedSuiteSha256(join(dest, "umami-fixture")) };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { dest: { type: "string" }, "fixture-package": { type: "string" } } });
  if (values.dest === undefined) {
    process.stderr.write("usage: stage-kit.ts --dest <dir> [--fixture-package packages/<name>]\n");
    process.exitCode = 2;
  } else {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const staged = await stageKit(repoRoot, resolve(values.dest), { fixturePackage: values["fixture-package"] });
    process.stdout.write(`added_suite_sha256=${staged.addedSuiteSha256}\n`);
  }
}
