// Prints "true" when every changed path (one per line on stdin) is a docs path, otherwise "false".
// CI uses the result to skip the expensive jobs for documentation-only changes.
import { readFileSync } from "node:fs";
import { isEntryPoint, runMain } from "./main.ts";

/**
 * The single docs-path rule. A file that a test or check reads must never match it, which is
 * why root Markdown other than README.md and Markdown inside code directories are excluded.
 */
export function isDocsPath(path: string): boolean {
  if (path === "LICENSE" || path === "README.md" || path.endsWith("/README.md")) {
    return true;
  }
  return path.startsWith("docs/") && (path.endsWith(".md") || path.endsWith(".mdx"));
}

export function isDocsOnly(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(isDocsPath);
}

export function parsePaths(input: string): string[] {
  return input
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");
}

if (isEntryPoint(import.meta)) {
  runMain("docs-only", () => {
    process.stdout.write(`${String(isDocsOnly(parsePaths(readFileSync(0, "utf8"))))}\n`);
    return 0;
  });
}
