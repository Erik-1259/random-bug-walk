// Lists every admission rule ID in docs/admission-rules.md with its implementation and test markers,
// and fails when a rule marked "implemented" lacks either, or when a marker names an unknown ID.
// Prints "ADM-NN <status> implementation=<n> tests=<n>" per ID, with marker locations beneath.
// Exit codes: 0 pass, 1 a violation, 2 the check cannot run (no git work tree, malformed document).
//
// Marker convention (static: the file set comes from git ls-files, so untracked files are ignored):
//   implementation: a comment containing the ID as a whole token (`//`, `/*`, a leading `*` or `#`
//     before it) in a tracked, non-test .ts, .tsx, .js, .mjs or .py file under packages/, tools/ or python/.
//   test: the ID in the first string argument of describe/it/test (.each included; .skip and .todo
//     excluded) on the line of the call in *.test.ts(x), or `adm_NN` in a test function or class name
//     in test_*.py and *_test.py.
// Limits: the check is static, so it cannot tell whether a test runs (the test floors cover that),
// and it cannot tell whether a marked implementation does what the rule says.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isEntryPoint, runMain } from "./main.ts";

const DOCUMENT = "docs/admission-rules.md";

/** Tracked files that can carry markers, as git pathspecs. This check's own files and docs are excluded. */
export const MARKER_FILE_SET: readonly string[] = [
  ":(glob)**/*.ts",
  ":(glob)**/*.tsx",
  ":(glob)**/*.js",
  ":(glob)**/*.mjs",
  ":(glob)**/*.py",
  ":(glob,exclude)scripts/checks/**",
  ":(glob,exclude)docs/**",
];

const IMPLEMENTATION_ROOTS: readonly string[] = ["packages/", "tools/", "python/"];
const STATUSES: readonly string[] = ["planned", "implemented", "retired"];
const CELLS = 5;

const ID_SOURCE = "(?<![\\p{L}\\p{N}_])ADM-(\\d{2})(?!\\d)";
const LEADING_STAR = /^\s*\*/;
// Text before a test call on its line: nothing, or an arrow body opening such as "describe(..., () => {".
const TEST_CALL_PREFIX = /^[\s;{}]*(?:.*=>\s*\{\s*)?$/;
const TS_TEST_HEAD = /(?<![\w.$])(describe|it|test)((?:\.\w+(?:\([^()]*\))?)*)/g;
const PY_TEST_NAME = /^\s*(?:async\s+)?(?:def|class)\s+(\w+)/;
const PY_ID_IN_NAME = /(?:adm|ADM)_(\d{2})(?!\d)/g;

type Kind = "implementation" | "test";

interface Marker {
  id: string;
  kind: Kind;
  path: string;
  line: number;
}

interface Rule {
  id: string;
  status: string;
}

class CannotRun extends Error {}

function idsIn(text: string): string[] {
  return [...text.matchAll(new RegExp(ID_SOURCE, "gu"))].map((match) => `ADM-${match[1] ?? ""}`);
}

function isTestFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /\.test\.tsx?$/.test(name) || /^test_.*\.py$/.test(name) || name.endsWith("_test.py");
}

function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const row = raw.trim();
    if (!row.startsWith("|")) {
      continue;
    }
    const cells = row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim());
    const id = cells[0] ?? "";
    if (!/^ADM-\d{2}$/.test(id)) {
      continue;
    }
    if (cells.length !== CELLS) {
      throw new CannotRun(`${DOCUMENT}: ${id} has ${String(cells.length)} cells, expected ${String(CELLS)}`);
    }
    const status = cells[1] ?? "";
    if (!STATUSES.includes(status)) {
      throw new CannotRun(`${DOCUMENT}: ${id} has status "${status}", expected one of ${STATUSES.join(", ")}`);
    }
    if (rules.some((rule) => rule.id === id)) {
      throw new CannotRun(`${DOCUMENT}: ${id} appears more than once`);
    }
    rules.push({ id, status });
  }
  if (rules.length === 0) {
    throw new CannotRun(`${DOCUMENT}: no ADM rows found`);
  }
  return rules.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Index where a comment starts, ignoring comment characters inside string literals; -1 when there is none.
 * Python comments start with "#", other files with "//" or "/*"; a "#" that opens a line counts in any file.
 * Regular expression literals are not tracked, so a quote inside one can hide a comment on its line.
 */
function commentStart(line: string, python: boolean): number {
  if (LEADING_STAR.test(line)) {
    return 0;
  }
  if (!python && line.trimStart().startsWith("#")) {
    return line.indexOf("#");
  }
  let quote = "";
  for (let index = 0; index < line.length; index++) {
    const char = line.charAt(index);
    if (quote !== "") {
      if (char === "\\") {
        index++;
      } else if (char === quote) {
        quote = "";
      }
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (python ? char === "#" : char === "/" && (line[index + 1] === "/" || line[index + 1] === "*")) {
      return index;
    }
  }
  return -1;
}

function implementationIds(line: string, python: boolean): string[] {
  const start = commentStart(line, python);
  return start < 0 ? [] : idsIn(line.slice(start));
}

function typeScriptTestIds(line: string): string[] {
  const found: string[] = [];
  for (const head of line.matchAll(TS_TEST_HEAD)) {
    const modifiers = head[2] ?? "";
    if (!TEST_CALL_PREFIX.test(line.slice(0, head.index))) {
      continue;
    }
    if (/\.(?:skip|todo)\b/.test(modifiers)) {
      continue;
    }
    const rest = line.slice(head.index + head[0].length);
    const generated = /\.(?:each|for)\b/.test(modifiers);
    const direct = /^\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(rest);
    const call = direct ?? (generated ? /^[^]*?[)`]\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(rest) : null);
    found.push(...idsIn(call?.[2] ?? ""));
  }
  return found;
}

function pythonTestIds(line: string): string[] {
  const name = PY_TEST_NAME.exec(line)?.[1] ?? "";
  return [...name.matchAll(PY_ID_IN_NAME)].map((match) => `ADM-${match[1] ?? ""}`);
}

function markersIn(path: string, content: string): Marker[] {
  const test = isTestFile(path);
  const python = path.endsWith(".py");
  const underRoot = IMPLEMENTATION_ROOTS.some((root) => path.startsWith(root));
  const markers: Marker[] = [];
  content.split(/\r\n|\n|\r/).forEach((text, index) => {
    const line = index + 1;
    if (test) {
      const ids = python ? pythonTestIds(text) : typeScriptTestIds(text);
      for (const id of new Set(ids)) {
        markers.push({ id, kind: "test", path, line });
      }
    } else if (underRoot) {
      for (const id of new Set(implementationIds(text, python))) {
        markers.push({ id, kind: "implementation", path, line });
      }
    }
  });
  return markers;
}

function trackedFiles(): string[] | undefined {
  const result = spawnSync("git", ["ls-files", "-z", "--", ...MARKER_FILE_SET], { encoding: "utf8" });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.split("\0").filter((path) => path !== "");
}

/** A tracked file that was deleted from the work tree has no markers. */
function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw new CannotRun(`${path} is not readable (${(error as NodeJS.ErrnoException).code ?? "error"})`, { cause: error });
  }
}

function readDocument(): string | undefined {
  try {
    return readFileSync(DOCUMENT, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new CannotRun(`${DOCUMENT} is not readable (${(error as NodeJS.ErrnoException).code ?? "error"})`, { cause: error });
  }
}

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

function check(): number {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) {
    throw new CannotRun("not inside a git work tree");
  }
  process.chdir(top.stdout.trim());
  const files = trackedFiles();
  if (files === undefined) {
    throw new CannotRun("not inside a git work tree");
  }
  const markers = files.flatMap((path) => markersIn(path, readText(path)));
  const document = readDocument();
  if (document === undefined) {
    if (markers.length === 0) {
      out("no admission rules document; nothing to check");
      return 0;
    }
    out(`error: ${DOCUMENT} is missing but admission markers exist`);
    for (const marker of markers) {
      out(`${marker.path}:${String(marker.line)}: ${marker.id}`);
    }
    return 1;
  }

  const rules = parseRules(document);
  const known = new Set(rules.map((rule) => rule.id));
  let failed = false;
  for (const rule of rules) {
    const own = markers.filter((marker) => marker.id === rule.id);
    const implementation = own.filter((marker) => marker.kind === "implementation");
    const tests = own.filter((marker) => marker.kind === "test");
    out(`${rule.id} ${rule.status} implementation=${String(implementation.length)} tests=${String(tests.length)}`);
    for (const marker of [...implementation, ...tests]) {
      out(`  ${marker.path}:${String(marker.line)}`);
    }
    if (rule.status === "implemented") {
      if (implementation.length === 0) {
        out(`error: ${rule.id} implemented but has no implementation`);
        failed = true;
      }
      if (tests.length === 0) {
        out(`error: ${rule.id} implemented but has no test`);
        failed = true;
      }
    } else if (rule.status === "planned" && implementation.length > 0 && tests.length > 0) {
      out(`note: ${rule.id} is planned but has an implementation and a test; set its status to implemented`);
    } else if (rule.status === "retired" && tests.length > 0) {
      out(`error: ${rule.id} retired but still has a test marker`);
      failed = true;
    }
  }
  for (const marker of markers.filter((candidate) => !known.has(candidate.id))) {
    out(`${marker.path}:${String(marker.line)}: unknown ${marker.id}`);
    failed = true;
  }
  return failed ? 1 : 0;
}

if (isEntryPoint(import.meta)) {
  runMain("admission-ids", check);
}
