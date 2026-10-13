// A synthetic host tree and fakes for the site finder and the screen. Nothing here is taken from
// a real host.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTwoFilesPatch } from "diff";
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

/** The per-candidate symptom fixture: one fixed symptom for every site, so tests can assert on it. */
export const symptomFor = (): Symptom => SYMPTOM;

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

export const miss = (attempts = 3, costMicrousd = 100_000): ScreenResult => ({ verdict: "not_located", hits: 0, attempts, costMicrousd });
export const hit = (hits = 1, attempts = 3, costMicrousd = 100_000): ScreenResult => ({ verdict: "located", hits, attempts, costMicrousd });
