// Loads ast-grep YAML rule files and runs them with @ast-grep/napi, so the YAML file is the only
// definition of a rule. The napi engine does not apply `fix`, so `applyFix` expands the rule's fix
// template with the match's metavariables and commits the edits through the engine, widening each
// edit over the fix's `expandStart` and `expandEnd` siblings as the ast-grep CLI does.
import { Lang, parse, type Edit, type NapiConfig, type Rule, type SgNode } from "@ast-grep/napi";
import { parseAllDocuments } from "yaml";
import { decodeUtf8 } from "./hash.ts";

export class RuleFileError extends Error {
  override name = "RuleFileError";
}

const LANGUAGES = { TypeScript: Lang.TypeScript, Tsx: Lang.Tsx } as const;
export type RuleLanguage = keyof typeof LANGUAGES;

// Keys the CLI would honor but this loader would not are refused, so both engines read the same rule.
const ALLOWED_KEYS = new Set(["id", "language", "severity", "message", "note", "url", "rule", "constraints", "utils", "fix", "metadata"]);
const FIX_KEYS = new Set(["template", "expandStart", "expandEnd"]);

export interface LoadedRule {
  readonly id: string;
  readonly language: RuleLanguage;
  readonly config: NapiConfig;
  /** The fix template, from either a plain `fix` string or the `template` of a fix mapping. */
  readonly fix: string | undefined;
  /** Sibling rules that widen the fixed range backward (`expandStart`) or forward (`expandEnd`). */
  readonly expand: { readonly start?: Rule; readonly end?: Rule };
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
  const { id, language, rule, constraints, utils, fix, metadata } = value;
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
  if (utils !== undefined && !isRecord(utils)) {
    throw new RuleFileError(`rule ${id} has utils that are not a mapping`);
  }
  const { template, expand } = loadFix(id, fix);
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new RuleFileError(`rule ${id} has metadata that is not a mapping`);
  }
  // The engine validates the rule's structure when it first runs it, just below.
  const config: NapiConfig = {
    rule,
    ...(constraints === undefined ? {} : { constraints: constraints as Record<string, Rule> }),
    ...(utils === undefined ? {} : { utils: utils as Record<string, Rule> }),
  };
  try {
    parse(LANGUAGES[language], "").root().findAll(config);
  } catch (error) {
    throw new RuleFileError(`rule ${id} is not a valid ast-grep rule`, { cause: error });
  }
  for (const sibling of [expand.start, expand.end]) {
    try {
      if (sibling !== undefined) {
        parse(LANGUAGES[language], "").root().findAll({ rule: sibling });
      }
    } catch (error) {
      throw new RuleFileError(`rule ${id} has a fix expansion that is not a valid ast-grep rule`, { cause: error });
    }
  }
  return { id, language, config, fix: template, expand, metadata: metadata ?? {} };
}

function loadFix(id: string, fix: unknown): { template: string | undefined; expand: LoadedRule["expand"] } {
  if (fix === undefined || typeof fix === "string") {
    return { template: fix, expand: {} };
  }
  if (!isRecord(fix) || typeof fix.template !== "string") {
    throw new RuleFileError(`rule ${id} has a fix that is neither a string nor a mapping with a template`);
  }
  const unknown = Object.keys(fix).filter((key) => !FIX_KEYS.has(key));
  if (unknown.length > 0) {
    throw new RuleFileError(`rule ${id} has unsupported fix keys: ${unknown.sort().join(", ")}`);
  }
  const { expandStart, expandEnd } = fix;
  if ((expandStart !== undefined && !isRecord(expandStart)) || (expandEnd !== undefined && !isRecord(expandEnd))) {
    throw new RuleFileError(`rule ${id} has a fix expansion that is not a mapping`);
  }
  return {
    template: fix.template,
    expand: {
      ...(expandStart === undefined ? {} : { start: expandStart }),
      ...(expandEnd === undefined ? {} : { end: expandEnd }),
    },
  };
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

/** Runs a rule over a source. `language` overrides the rule's own, so a TypeScript rule can read a `.tsx` file. */
export function matchAll(rule: LoadedRule, source: string, language: RuleLanguage = rule.language): MatchSet {
  const root = parse(LANGUAGES[language], source).root();
  return { root, matches: root.findAll(rule.config) };
}

export function findMatches(rule: LoadedRule, source: string): SgNode[] {
  return matchAll(rule, source).matches;
}

const METAVARIABLE = /\$(\$\$)?([A-Z_][A-Z0-9_]*)/g;

/** The leading whitespace of the line that holds `offset`. */
function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start, offset))?.[0] ?? "";
}

/** Removes up to `width` leading whitespace characters from every line after the first. */
function deindent(text: string, width: number): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? line : line.slice(Math.min(width, /^[ \t]*/.exec(line)?.[0].length ?? 0))))
    .join("\n");
}

/** Prefixes every non-empty line after the first with `indent`. */
function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 || line === "" ? line : `${indent}${line}`))
    .join("\n");
}

/**
 * Expands a fix template with the text the match captured for each metavariable. Multi-line text
 * is re-indented the way the ast-grep CLI does it: a capture loses the indentation of the line it
 * starts on and takes that of its template line, and the whole replacement takes the indentation
 * of the line the match starts on, so a capture keeps its shape relative to the rewritten code.
 */
export function expandFix(template: string, match: SgNode): string {
  const source = match.getRoot().root().text();
  const expanded = template.replace(METAVARIABLE, (_whole, multi: string | undefined, name: string, offset: number) => {
    if (multi !== undefined) {
      throw new RuleFileError(`fix uses multi-node metavariable $$$${name}, which is not supported`);
    }
    const captured = match.getMatch(name);
    if (captured === null) {
      throw new RuleFileError(`fix uses unbound metavariable $${name}`);
    }
    const own = lineIndent(source, captured.range().start.index).length;
    return indentLines(deindent(captured.text(), own), lineIndent(template, offset));
  });
  return indentLines(expanded, lineIndent(source, match.range().start.index));
}

/**
 * The edit the rule's fix makes at one match. The range grows over each run of adjacent siblings
 * that match the fix's `expandStart` (before the match) or `expandEnd` (after it).
 */
export function fixEdit(rule: LoadedRule, match: SgNode): Edit {
  const { fix, expand } = rule;
  if (fix === undefined) {
    throw new RuleFileError(`rule ${rule.id} has no fix`);
  }
  const edit = match.replace(expandFix(fix, match));
  let { startPos, endPos } = edit;
  if (expand.start !== undefined) {
    let node = match.prev();
    while (node?.matches({ rule: expand.start }) === true) {
      startPos = node.range().start.index;
      node = node.prev();
    }
  }
  if (expand.end !== undefined) {
    let node = match.next();
    while (node?.matches({ rule: expand.end }) === true) {
      endPos = node.range().end.index;
      node = node.next();
    }
  }
  return { ...edit, startPos, endPos };
}

/** Rewrites every match with the rule's fix and returns the new source. */
export function fixMatches(rule: LoadedRule, { root, matches }: MatchSet): string {
  return root.commitEdits(matches.map((match) => fixEdit(rule, match)));
}

export function applyFix(rule: LoadedRule, source: string): string {
  return fixMatches(rule, matchAll(rule, source));
}
