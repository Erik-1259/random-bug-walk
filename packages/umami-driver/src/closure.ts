// The pristine suite closure and its per-trial copies. Every trial runs the suite from a fresh copy
// outside the app directory, whose node_modules is a link to the verifier's own, so no import the
// suite makes can resolve into the app copy or the app's node_modules.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Hex } from "@rbw/schema";

/** Directories the suite itself writes while it runs; they are never closure files. */
const RUNTIME_DIRS = new Set(["node_modules", "test-results", ".runtime"]);

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Hashes the listed files under a root. Absent files are reported, never hashed as empty. */
export async function hashFiles(
  root: string,
  paths: readonly string[],
): Promise<{ hashes: Record<string, string>; missing: string[] }> {
  const hashes: Record<string, string> = {};
  const missing: string[] = [];
  for (const path of [...paths].sort()) {
    try {
      hashes[path] = sha256Hex(await readFile(join(root, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(path);
    }
  }
  return { hashes, missing };
}

/** Every regular file under a root, as sorted POSIX paths, leaving out the suite's runtime directories. */
async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!RUNTIME_DIRS.has(entry.name)) files.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    } else if (entry.isSymbolicLink() && !RUNTIME_DIRS.has(entry.name)) {
      files.push(path);
    }
  }
  return files.sort();
}

/**
 * Copies the listed closure files into a new per-trial suite directory at their original
 * relative paths, writes the harness files, and links node_modules to the verifier's. A listed
 * file that is absent from the source is left absent, for the integrity check to report.
 */
export async function prepareSuiteCopy(options: {
  closureDir: string;
  suiteDir: string;
  verifierNodeModules: string;
  closurePaths: readonly string[];
  harness: Readonly<Record<string, Uint8Array>>;
}): Promise<void> {
  await mkdir(options.suiteDir, { recursive: true });
  for (const path of options.closurePaths) {
    const source = join(options.closureDir, path);
    if (!existsSync(source)) continue;
    await mkdir(dirname(join(options.suiteDir, path)), { recursive: true });
    await copyFile(source, join(options.suiteDir, path));
  }
  for (const [name, content] of Object.entries(options.harness)) {
    await writeFile(join(options.suiteDir, name), content);
  }
  await symlink(resolve(options.verifierNodeModules), join(options.suiteDir, "node_modules"), "dir");
}

export interface ClosureIntegrity {
  changed: string[];
  missing: string[];
  extra: string[];
  harness_changed: string[];
}

/** Compares a suite copy with the manifest's closure hashes and the harness files it should hold. */
export async function closureIntegrity(
  suiteDir: string,
  closure: Readonly<Record<string, string>>,
  harnessFiles: Readonly<Record<string, Uint8Array>>,
): Promise<ClosureIntegrity> {
  const expected = Object.keys(closure);
  const { hashes, missing } = await hashFiles(suiteDir, expected);
  const changed = expected.filter((path) => hashes[path] !== undefined && hashes[path] !== closure[path]).sort();
  const harnessNames = new Set(Object.keys(harnessFiles));
  const extra = (await listFiles(suiteDir)).filter((path) => !(path in closure) && !harnessNames.has(path));
  const harness = await hashFiles(suiteDir, [...harnessNames]);
  const harnessChanged = Object.entries(harnessFiles)
    .filter(([name, bytes]) => harness.hashes[name] !== sha256Hex(bytes))
    .map(([name]) => name)
    .sort();
  return { changed, missing, extra, harness_changed: harnessChanged };
}

export function integrityProblems(integrity: ClosureIntegrity): number {
  return integrity.changed.length + integrity.missing.length + integrity.extra.length + integrity.harness_changed.length;
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** Playwright 1.63.0's extension lookups for relative imports (transform/esmLoader.js, kExtLookups). */
const EXTENSION_LOOKUPS: readonly (readonly [string, readonly string[]])[] = [
  [".js", [".jsx", ".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".cjs", [".cts"]],
  [".mjs", [".mts"]],
  ["", [".js", ".ts", ".jsx", ".tsx", ".cjs", ".mjs", ".cts", ".mts"]],
];

function withExtension(path: string): string | null {
  if (isFile(path)) return path;
  for (const [extension, others] of EXTENSION_LOOKUPS) {
    if (!path.endsWith(extension)) continue;
    for (const other of others) {
      const candidate = path.slice(0, path.length - extension.length) + other;
      if (isFile(candidate)) return candidate;
    }
    break;
  }
  return null;
}

/**
 * Resolves a relative import the way Playwright's loader does: the exact file, then its extension
 * lookups, then a directory's index. Only relative specifiers are accepted; package imports go to
 * node_modules, which the isolation check covers.
 */
export function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new Error(`only relative specifiers can be resolved here, not ${specifier}`);
  }
  const target = resolve(dirname(fromFile), specifier);
  const file = withExtension(target);
  if (file !== null) return file;
  if (isDirectory(target)) {
    if (isFile(join(target, "package.json"))) return target;
    return withExtension(join(target, "index"));
  }
  return null;
}

export const ANALYTICS_QUERY_IMPORT = { from: "tests/api/report-migration.spec.ts", specifier: "../../src/lib/analytics-query" };

export interface ImportProbe {
  specifier: string;
  from: string;
  /** The resolved file relative to the suite copy, or null when it does not resolve inside it. */
  resolved: string | null;
  sha256: string | null;
}

/** Resolves the suite's one import of app code from inside a suite copy and hashes the target. */
export function probeAnalyticsQuery(suiteDir: string): ImportProbe {
  const resolved = resolveRelativeImport(join(suiteDir, ANALYTICS_QUERY_IMPORT.from), ANALYTICS_QUERY_IMPORT.specifier);
  const inside = resolved !== null && !relative(suiteDir, resolved).startsWith("..") && !isAbsolute(relative(suiteDir, resolved));
  return {
    specifier: ANALYTICS_QUERY_IMPORT.specifier,
    from: ANALYTICS_QUERY_IMPORT.from,
    resolved: inside ? toPosix(relative(suiteDir, resolved)) : null,
    sha256: inside ? sha256Hex(readFileSync(resolved)) : null,
  };
}

function isWithin(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/**
 * Checks that nothing the suite imports can come from the app: the copy is not inside the app
 * directory, its node_modules is the verifier's, and no ancestor directory holds a node_modules
 * that Node's lookup could fall back to.
 */
export function checkSuiteIsolation(options: { suiteDir: string; appDir: string; verifierNodeModules: string }): string[] {
  const problems: string[] = [];
  const suiteDir = realpathSync(options.suiteDir);
  const appDir = existsSync(options.appDir) ? realpathSync(options.appDir) : resolve(options.appDir);
  if (isWithin(suiteDir, appDir)) problems.push("the suite copy is inside the app directory");
  const link = join(suiteDir, "node_modules");
  if (!existsSync(link) || !lstatSync(link).isSymbolicLink() || realpathSync(link) !== realpathSync(options.verifierNodeModules)) {
    problems.push("the suite copy's node_modules is not a link to the verifier's node_modules");
  }
  for (let dir = dirname(suiteDir); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules"))) {
      problems.push(`an ancestor directory of the suite copy holds a node_modules (${toPosix(relative(suiteDir, dir))})`);
    }
    if (dirname(dir) === dir) break;
  }
  return problems;
}
