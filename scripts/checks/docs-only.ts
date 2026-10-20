// Prints "true" when every changed path (one per line on stdin) is a docs path, otherwise "false".
// CI uses the result to skip the expensive jobs for documentation-only changes.
import { readFileSync } from "node:fs";
import { isEntryPoint, runMain } from "./main.ts";

/**
 * Markdown under docs/ that a test or check reads, so an edit to it alone must still run the tests.
 * `docs/uc1-preregistration/power.py --check` compares its generated block with the pre-registration,
 * and the `@rbw/factory-contract` tests read the bug request contract's code tables.
 */
export const CHECKED_DOCS: readonly string[] = ["docs/uc1-preregistration.md", "docs/product/bug-request-v1.md"];

/**
 * The single docs-path rule. A file that a test or check reads must never match it, which is
 * why root Markdown other than README.md, Markdown inside code directories (a README.md there
 * too: package tests read their own README's commands and hashes) and CHECKED_DOCS are excluded.
 */
export function isDocsPath(path: string): boolean {
  if (CHECKED_DOCS.includes(path)) {
    return false;
  }
  if (path === "LICENSE" || path === "README.md") {
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
