// Flags inflated wording in public docs. Prints "path:line: term" per match.
// Exit codes: 0 clean, 1 matches found, 2 the check cannot run.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isEntryPoint, runMain } from "./main.ts";

/**
 * Tracked files in scope, as git glob pathspecs. Add new public copy here.
 * Other Markdown, such as agent instruction files at the root, is deliberately out of scope.
 */
export const PROSE_FILE_SET: readonly string[] = [":(glob)**/README.md", ":(glob)docs/**/*.md", ":(glob)docs/**/*.mdx"];

const apostrophe = "['’]?";
const separator = "(?:-|\\s+)";
const space = "\\s+";

const termSources: readonly string[] = [
  "leverag(?:e|es|ed|ing)",
  "utiliz(?:e|es|ed|ing)",
  "robust",
  "seamless(?:ly)?",
  "effortless(?:ly)?",
  "revolutionary",
  "guarantee(?:s|d|ing)?",
  `it${apostrophe}s${space}that${space}easy`,
  `don${apostrophe}t${space}miss${space}out`,
  `world${apostrophe}s${space}first`,
  `state${separator}of${separator}the${separator}art`,
  `cutting${separator}edge`,
  `game${separator}changing`,
];

// Whole words: no letter, digit or underscore directly before or after the match.
const termPattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${termSources.join("|")})(?![\\p{L}\\p{N}_])`, "giu");

export interface ProseMatch {
  path: string;
  line: number;
  term: string;
}

export function findTerms(path: string, content: string): ProseMatch[] {
  const matches: ProseMatch[] = [];
  content.split(/\r\n|\n|\r/).forEach((text, index) => {
    for (const match of text.matchAll(termPattern)) {
      matches.push({ path, line: index + 1, term: match[0].toLowerCase().replace(/\s+/g, " ") });
    }
  });
  return matches;
}

function trackedFiles(): string[] | undefined {
  const result = spawnSync("git", ["ls-files", "-z", "--", ...PROSE_FILE_SET], { encoding: "utf8" });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.split("\0").filter((path) => path !== "");
}

function main(): number {
  const files = trackedFiles();
  if (files === undefined) {
    process.stderr.write("prose: cannot run: not inside a git work tree\n");
    return 2;
  }
  const matches: ProseMatch[] = [];
  for (const path of files) {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      process.stderr.write(`prose: cannot run: ${path} is not readable (${(error as NodeJS.ErrnoException).code ?? "error"})\n`);
      return 2;
    }
    matches.push(...findTerms(path, content));
  }
  for (const match of matches) {
    process.stdout.write(`${match.path}:${String(match.line)}: ${match.term}\n`);
  }
  process.stdout.write(`prose: checked ${String(files.length)} files, ${String(matches.length)} matches\n`);
  return matches.length === 0 ? 0 : 1;
}

if (isEntryPoint(import.meta)) {
  runMain("prose", main);
}
