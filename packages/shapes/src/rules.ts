// Loads ast-grep YAML rule files and runs them with @ast-grep/napi, so the YAML file is the only
// definition of a rule. The napi engine does not apply `fix`, so `applyFix` expands the rule's fix
// template with the match's metavariables and commits the edits through the engine.
import { Lang, parse, type NapiConfig, type Rule, type SgNode } from "@ast-grep/napi";
import { parseAllDocuments } from "yaml";
import { decodeUtf8 } from "./hash.ts";

export class RuleFileError extends Error {
  override name = "RuleFileError";
}

const LANGUAGES = { TypeScript: Lang.TypeScript, Tsx: Lang.Tsx } as const;
type RuleLanguage = keyof typeof LANGUAGES;

// Keys the CLI would honour but this loader would not are refused, so both engines read the same rule.
const ALLOWED_KEYS = new Set(["id", "language", "severity", "message", "note", "url", "rule", "constraints", "fix", "metadata"]);

export interface LoadedRule {
  readonly id: string;
  readonly language: RuleLanguage;
  readonly config: NapiConfig;
  readonly fix: string | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface MatchSet {
  readonly root: SgNode;
  readonly matches: SgNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLanguage(value: unknown): value is RuleLanguage {
  return typeof value === "string" && Object.hasOwn(LANGUAGES, value);
}

function loadRule(value: unknown, index: number): LoadedRule {
  if (!isRecord(value)) {
    throw new RuleFileError(`rule file document ${String(index + 1)} is not a mapping`);
  }
  const { id, language, rule, constraints, fix, metadata } = value;
  if (typeof id !== "string" || id === "") {
    throw new RuleFileError(`rule file document ${String(index + 1)} has no id`);
  }
  const unknown = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length > 0) {
    throw new RuleFileError(`rule ${id} has unsupported keys: ${unknown.sort().join(", ")}`);
  }
  if (!isLanguage(language)) {
    throw new RuleFileError(`rule ${id} has an unsupported language`);
  }
  if (!isRecord(rule)) {
    throw new RuleFileError(`rule ${id} has no rule mapping`);
  }
  if (constraints !== undefined && !isRecord(constraints)) {
    throw new RuleFileError(`rule ${id} has constraints that are not a mapping`);
  }
  if (fix !== undefined && typeof fix !== "string") {
    throw new RuleFileError(`rule ${id} has a fix that is not a string`);
  }
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new RuleFileError(`rule ${id} has metadata that is not a mapping`);
  }
  // The engine validates the rule's structure when it first runs it, just below.
  const config: NapiConfig = {
    rule,
    ...(constraints === undefined ? {} : { constraints: constraints as Record<string, Rule> }),
  };
  try {
    parse(LANGUAGES[language], "").root().findAll(config);
  } catch (error) {
    throw new RuleFileError(`rule ${id} is not a valid ast-grep rule`, { cause: error });
  }
  return { id, language, config, fix, metadata: metadata ?? {} };
}

/** Loads every rule in a (possibly multi-document) YAML rule file, keyed by rule ID in file order. */
export function loadRules(bytes: Uint8Array): Map<string, LoadedRule> {
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    throw new RuleFileError("rule file is not valid UTF-8");
  }
  const documents = parseAllDocuments(text);
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new RuleFileError("rule file has no rules");
  }
  const rules = new Map<string, LoadedRule>();
  documents.forEach((document, index) => {
    const [problem] = document.errors;
    if (problem !== undefined) {
      throw new RuleFileError(`rule file is not valid YAML: ${problem.message}`);
    }
    const loaded = loadRule(document.toJS(), index);
    if (rules.has(loaded.id)) {
      throw new RuleFileError(`rule file defines ${loaded.id} twice`);
    }
    rules.set(loaded.id, loaded);
  });
  return rules;
}

export function requireRule(rules: ReadonlyMap<string, LoadedRule>, id: string): LoadedRule {
  const rule = rules.get(id);
  if (rule === undefined) {
    throw new RuleFileError(`rule file does not define ${id}`);
  }
  return rule;
}

export function matchAll(rule: LoadedRule, source: string): MatchSet {
  const root = parse(LANGUAGES[rule.language], source).root();
  return { root, matches: root.findAll(rule.config) };
}

export function findMatches(rule: LoadedRule, source: string): SgNode[] {
  return matchAll(rule, source).matches;
}

const METAVARIABLE = /\$(\$\$)?([A-Z_][A-Z0-9_]*)/g;

/** Expands a fix template with the text the match captured for each metavariable. */
export function expandFix(template: string, match: SgNode): string {
  return template.replace(METAVARIABLE, (_whole, multi: string | undefined, name: string) => {
    if (multi !== undefined) {
      throw new RuleFileError(`fix uses multi-node metavariable $$$${name}, which is not supported`);
    }
    const captured = match.getMatch(name);
    if (captured === null) {
      throw new RuleFileError(`fix uses unbound metavariable $${name}`);
    }
    return captured.text();
  });
}

/** Rewrites every match with the rule's fix and returns the new source. */
export function fixMatches(rule: LoadedRule, { root, matches }: MatchSet): string {
  const { fix } = rule;
  if (fix === undefined) {
    throw new RuleFileError(`rule ${rule.id} has no fix`);
  }
  return root.commitEdits(matches.map((match) => match.replace(expandFix(fix, match))));
}

export function applyFix(rule: LoadedRule, source: string): string {
  return fixMatches(rule, matchAll(rule, source));
}
