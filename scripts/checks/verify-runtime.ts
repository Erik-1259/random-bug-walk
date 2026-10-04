// Build step for the check scripts, which have no compile output: confirms that each script
// loads under Node's type stripping and imports only node: built-ins or sibling .ts modules,
// because called CI runs execute them from a checkout without installed packages.
// Exit codes: 0 every script passes, 1 a script fails, 2 the check cannot run.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isEntryPoint, runMain } from "./main.ts";

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

export function importSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1] ?? "");
}

export function isAllowedSpecifier(specifier: string): boolean {
  return specifier.startsWith("node:") || (/^\.\.?\//.test(specifier) && specifier.endsWith(".ts"));
}

function checkScripts(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split("\\").join("/"))
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.split("/").includes("test"))
    .sort();
}

function loads(file: string): boolean {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(file).href)});`],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

function main(): number {
  const { values } = parseArgs({ options: { dir: { type: "string" } } });
  const dir = values.dir ?? fileURLToPath(new URL(".", import.meta.url));
  const scripts = checkScripts(dir);
  if (scripts.length === 0) {
    throw new Error(`no check scripts found in ${dir}`);
  }
  const problems: string[] = [];
  for (const script of scripts) {
    const file = join(dir, script);
    const name = relative(dir, file);
    const disallowed = importSpecifiers(readFileSync(file, "utf8")).filter((specifier) => !isAllowedSpecifier(specifier));
    for (const specifier of disallowed) {
      problems.push(`${name}: imports ${specifier}, which is not a node: built-in or a relative .ts module`);
    }
    if (disallowed.length === 0 && !loads(file)) {
      problems.push(`${name}: does not load under Node`);
    }
  }
  for (const problem of problems) {
    process.stdout.write(`${problem}\n`);
  }
  if (problems.length > 0) {
    return 1;
  }
  process.stdout.write(`verify-runtime: ${String(scripts.length)} check scripts load under Node with standard-library imports only\n`);
  return 0;
}

if (isEntryPoint(import.meta)) {
  runMain("verify-runtime", main);
}
