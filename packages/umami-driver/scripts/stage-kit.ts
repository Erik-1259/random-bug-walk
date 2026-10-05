// Stages the directory that the kit image takes as `--build-context rbw-kit=<dir>`, and that lands
// in /opt/rbw/verifier/kit/:
//
//   umami-driver/              this package's package.json and src/
//   umami-fixture/             the fixture's package.json, playwright.config.ts, src/, checks/ and data/
//   schema/                    @rbw/schema's package.json, src/, schema/ and registry/
//   node_modules/@rbw/schema   a symlink to ../../schema
//   node_modules/<name>        copies of @rbw/schema's runtime dependencies (ajv and its own)
//
// Node refuses to strip types from .ts files whose real path is under node_modules, so @rbw/schema
// is linked, not copied. @playwright/test and pg are not staged: the driver and the fixture resolve
// them from the verifier's own node_modules, the one copy the suite also uses.
//
//   node packages/umami-driver/scripts/stage-kit.ts --dest <dir>
//
// Prints the staged fixture's added_suite_sha256.
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { addedSuiteSha256 } from "../src/fixture.ts";

const PACKAGES: readonly { from: string; to: string; parts: readonly string[] }[] = [
  { from: "packages/umami-driver", to: "umami-driver", parts: ["package.json", "src"] },
  { from: "packages/umami-fixture", to: "umami-fixture", parts: ["package.json", "playwright.config.ts", "src", "checks", "data"] },
  { from: "packages/schema", to: "schema", parts: ["package.json", "src", "schema", "registry"] },
];

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

export async function stageKit(repoRoot: string, dest: string): Promise<{ addedSuiteSha256: string }> {
  if (existsSync(dest) && (await readdir(dest)).length > 0) throw new Error(`${dest} is not empty`);
  for (const pkg of PACKAGES) {
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
  const { values } = parseArgs({ options: { dest: { type: "string" } } });
  if (values.dest === undefined) {
    process.stderr.write("usage: stage-kit.ts --dest <dir>\n");
    process.exitCode = 2;
  } else {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const staged = await stageKit(repoRoot, resolve(values.dest));
    process.stdout.write(`added_suite_sha256=${staged.addedSuiteSha256}\n`);
  }
}
