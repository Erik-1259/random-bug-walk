// A candidate rule file: one ast-grep document per parser language, loaded with @rbw/shapes' rule
// loader. TypeScript files parse as TypeScript; TSX and every JavaScript form parse as TSX.
import { readFileSync } from "node:fs";
import { loadRules, type LoadedRule } from "@rbw/shapes";

export interface RuleIds {
  readonly TypeScript: string;
  readonly Tsx: string;
}

export interface CandidateRules {
  /** The rule file's absolute path. */
  readonly file: string;
  readonly ids: RuleIds;
  /** The rule file's bytes, as hashed into the funnel. */
  readonly bytes: Uint8Array;
  /** The rule for a file's parser language. */
  rule(path: string): LoadedRule;
}

const TYPESCRIPT = /\.(ts|mts|cts)$/;
export const SOURCE_FILE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;

/** The parser language of a source file: TypeScript for `.ts`, `.mts` and `.cts`, TSX otherwise. */
export function parserLanguage(path: string): "TypeScript" | "Tsx" {
  return TYPESCRIPT.test(path) ? "TypeScript" : "Tsx";
}

export function loadCandidateRules(file: string, ids: RuleIds): CandidateRules {
  const bytes = readFileSync(file);
  const rules = loadRules(bytes);
  return {
    file,
    ids,
    bytes,
    rule(path) {
      const id = ids[parserLanguage(path)];
      const rule = rules.get(id);
      if (rule === undefined) {
        throw new Error(`the candidate rule file does not define ${id}`);
      }
      return rule;
    },
  };
}
