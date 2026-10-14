// A synthetic host tree and fakes for the site finder and the screen. Nothing here is taken from
// a real host.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { endpointOf, modelCalls } from "../src/symptom.ts";
import type { ClassRule, FindSites, Screen, ScreenBudget, ScreenJob, ScreenModel, ScreenResult, Site, Symptom } from "../src/types.ts";

export const CLEAN: Record<string, string> = {
  "src/alpha.ts": "export function alpha(store, id) {\n  const row = store.read(id);\n  store.lock(id);\n  return row;\n}\n",
  "src/beta.ts": "export function beta(store, id) {\n  store.lock(id);\n  return store.read(id);\n}\n",
  "src/gamma.ts": "export const gamma = (list) => list.filter(Boolean);\n",
  "README.md": "synthetic host\n",
  ".git/HEAD": "ref: refs/heads/main\n",
  "node_modules/dep/index.js": "module.exports = 1;\n",
};

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeHost(): string {
  const dir = tempDir("rbw-candidates-host-");
  for (const [path, text] of Object.entries(CLEAN)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

/** A unified diff of `file` that replaces the first `from` with `to` in its clean text. */
export function diffFor(file: string, from: string, to: string): string {
  const clean = CLEAN[file] ?? "";
  return createTwoFilesPatch(`a/${file}`, `b/${file}`, clean, clean.replace(from, to));
}

export function site(file: string, from: string, to: string, confidence: number, line = 2): Site {
  return { file, line, diff: diffFor(file, from, to), confidence };
}

/** Three plantable sites with distinct confidences. */
export function threeSites(): Site[] {
  return [
    site("src/alpha.ts", "  store.lock(id);\n", "", 0.5, 3),
    site("src/beta.ts", "  store.lock(id);\n", "", 0.9, 2),
    site("src/gamma.ts", "filter(Boolean)", "filter((x) => x)", 0.7, 1),
  ];
}

export const RULE: ClassRule = { id: "XX-1.synthetic", path: "rules/xx-1.synthetic.yml", text: "id: xx-1.synthetic\n" };
export const SYMPTOM: Symptom = { text: "A record is sometimes written twice." };
export const MODEL: ScreenModel = "super";

/**
 * The per-candidate symptom fixture: the fixed symptom text plus the site's file and line, so each
 * candidate gets its own symptom and a test can tell which site a symptom was made for.
 */
export const symptomFor = (s: Site): Symptom => ({ text: `${SYMPTOM.text} (${s.file}:${String(s.line)})` });

export function finder(sites: readonly Site[]): FindSites & { calls: number } {
  const fn = Object.assign(
    function fakeFindSites(): readonly Site[] {
      fn.calls += 1;
      return sites;
    },
    { calls: 0 },
  );
  return fn;
}

export interface ScreenCall {
  tree: string;
  budget: ScreenBudget;
  symptom: Symptom;
  targetPath: string;
  cleanText: string;
  model: ScreenModel;
  /** The text of each synthetic source file as the screen saw it. */
  files: Record<string, string>;
  hasGit: boolean;
  hasNodeModules: boolean;
}

/** A screen that returns results in order (or throws an Error result) and records what it saw. */
export function scripted(results: readonly unknown[]): Screen & { calls: ScreenCall[] } {
  const calls: ScreenCall[] = [];
  const fn = Object.assign(
    function fakeScreen(job: ScreenJob): ScreenResult {
      const tree = job.plantedTree;
      const files: Record<string, string> = {};
      for (const path of ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"]) {
        files[path] = readFileSync(join(tree, path), "utf8");
      }
      calls.push({
        tree,
        budget: job.budget,
        symptom: job.symptom,
        targetPath: job.targetPath,
        cleanText: job.cleanText,
        model: job.model,
        files,
        hasGit: existsSync(join(tree, ".git")),
        hasNodeModules: existsSync(join(tree, "node_modules")),
      });
      const result = results[calls.length - 1];
      if (result instanceof Error) throw result;
      return result as ScreenResult;
    },
    { calls },
  );
  return fn;
}

const KEYWORDS = new Set(["const", "let", "await", "async", "if", "else", "return", "new", "true", "null", "function"]);

/**
 * The code identifiers on a diff's changed lines that a symptom must not repeat: every identifier of
 * three or more characters, except language keywords, the model names and the endpoint's own path
 * segments (both of which a user would name). Also every method and `<model>.<method>` pair of the
 * model calls anywhere in the diff, context lines included.
 */
export function siteIdentifiers(s: Site): string[] {
  const changed = s.diff
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line))
    .join("\n");
  const calls = modelCalls(s.diff);
  const allowed = new Set([...calls.map((call) => call.model), ...(endpointOf(s.file)?.split(/[/:]/) ?? []), "db", "client"]);
  const words = [...new Set(changed.match(/[A-Za-z_$][\w$]{2,}/g) ?? [])].filter((word) => !KEYWORDS.has(word) && !allowed.has(word));
  const methods = [...new Set(calls.map((call) => call.method))].filter((method) => !words.includes(method));
  return [...words, ...methods, ...new Set(calls.map((call) => `${call.model}.${call.method}`))];
}

/** The identifiers from `siteIdentifiers` that appear in `text` as whole words. */
export function leakedIdentifiers(s: Site, text: string): string[] {
  return siteIdentifiers(s).filter((word) => new RegExp(`(^|[^\\w$])${word.replace(/[.$]/g, "\\$&")}($|[^\\w$])`).test(text));
}

export const miss =(attempts = 3, costMicrousd = 100_000): ScreenResult => ({ verdict: "not_located", hits: 0, attempts, costMicrousd });
export const hit = (hits = 1, attempts = 3, costMicrousd = 100_000): ScreenResult => ({ verdict: "located", hits, attempts, costMicrousd });
