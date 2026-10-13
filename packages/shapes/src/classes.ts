// Finds every site of a bug class in a host source tree. A class rule file holds, per class, a
// fixed-form rule with a fix and a planted-form rule (`<id>.planted`). Each fixed-form match is one
// candidate site: the fix is applied to that match alone, the result must match the planted-form
// rule at the edited spot, and the site gets a git-style diff and a structural confidence computed
// from signals the rule cannot express (order of the read and the write, what the write's result
// feeds, and so on). Nothing here reads a model or the network.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SgNode } from "@ast-grep/napi";
import { formatPatch, structuredPatch } from "diff";
import { enclosingFunction, fieldOf, functionName, kindOf } from "./bindings.ts";
import { decodeUtf8, sha256Hex } from "./hash.ts";
import { RuleFileError, fixEdit, loadRules, matchAll, type LoadedRule, type RuleLanguage } from "./rules.ts";

export const CLASS_RULE_FILE = fileURLToPath(new URL("../rules/race.class.yml", import.meta.url));

export type ConfidenceLevel = "high" | "medium" | "low";

export interface SiteConfidence {
  /** Sum of the weights of the signals that hold, from 0 to 1, rounded to two decimals. */
  readonly score: number;
  /** `high` from 0.75, `medium` from 0.45, otherwise `low`; always `low` when the planted form is not confirmed. */
  readonly level: ConfidenceLevel;
  readonly signals: Readonly<Record<string, boolean>>;
}

export interface SiteRecord {
  readonly class_id: string;
  readonly rule_id: string;
  /** Path relative to the scanned root, with `/` separators. */
  readonly path: string;
  /** 1-based line and column of the matched node. */
  readonly line: number;
  readonly column: number;
  /** Name of the nearest named enclosing function, or null at module level or in an anonymous function. */
  readonly function: string | null;
  readonly matched: string;
  readonly original_sha256: string;
  readonly result_sha256: string;
  /** The planted-form rule matches the rewritten file at the edited spot. */
  readonly planted_form_confirmed: boolean;
  readonly diff: string;
  readonly confidence: SiteConfidence;
}

export interface SiteReport {
  readonly rule_sha256: string;
  readonly classes: readonly string[];
  readonly files_scanned: number;
  readonly site_count: number;
  readonly sites: readonly SiteRecord[];
}

/** A fixed-form rule with a fix, paired with its planted-form rule. */
export interface ClassRule {
  readonly classId: string;
  readonly fixed: LoadedRule;
  readonly planted: LoadedRule;
}

/** Loads the class rules: every rule with a fix and a matching `<id>.planted` rule. */
export function loadClassRules(bytes: Uint8Array): ClassRule[] {
  const rules = loadRules(bytes);
  const classes: ClassRule[] = [];
  for (const rule of rules.values()) {
    if (rule.fix === undefined) {
      continue;
    }
    const planted = rules.get(`${rule.id}.planted`);
    if (planted === undefined) {
      throw new RuleFileError(`class rule ${rule.id} has no ${rule.id}.planted rule`);
    }
    const classId = rule.metadata.class_id;
    if (typeof classId !== "string" || classId === "" || planted.metadata.class_id !== classId) {
      throw new RuleFileError(`class rule ${rule.id} and its planted rule must share a metadata.class_id`);
    }
    classes.push({ classId, fixed: rule, planted });
  }
  if (classes.length === 0) {
    throw new RuleFileError("rule file has no class rule with a fix");
  }
  return classes;
}

type Signals = Record<string, boolean>;

const WEIGHTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "RACE.guarded-write": {
    read_before_write: 0.3,
    read_checks_guard: 0.25,
    write_result_used: 0.2,
    identity_from_read: 0.15,
    await_between: 0.1,
  },
  "RACE.check-then-act": {
    not_in_batch_transaction: 0.3,
    create_covers_where: 0.25,
    where_is_object: 0.2,
    request_handler: 0.25,
  },
};

const READ_METHODS = new Set(["findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "findMany", "count"]);
const HTTP_HANDLERS = /^(GET|POST|PUT|PATCH|DELETE)$/;
const FUNCTION_KINDS = new Set(["function_declaration", "function_expression", "arrow_function", "method_definition"]);

function before(a: SgNode, b: SgNode): boolean {
  return a.range().end.index <= b.range().start.index;
}

/** The `model` and `method` of a call shaped `<client>.<model>.<method>(...)`. */
function modelCall(call: SgNode): { model: string; method: string } | undefined {
  const callee = fieldOf(call, "function");
  const object = fieldOf(callee, "object");
  if (kindOf(callee) !== "member_expression" || kindOf(object) !== "member_expression") {
    return undefined;
  }
  const method = fieldOf(callee, "property")?.text();
  const model = fieldOf(object, "property")?.text();
  return method === undefined || model === undefined ? undefined : { model, method };
}

/** Names bound by `const <pattern> = await <call>` around a call, or none. */
function boundNames(call: SgNode): string[] {
  let node: SgNode | null = call.parent();
  if (kindOf(node) === "await_expression") {
    node = node?.parent() ?? null;
  }
  if (kindOf(node) !== "variable_declarator" || node === null) {
    return [];
  }
  const name = fieldOf(node, "name");
  if (kindOf(name) === "identifier" && name !== null) {
    return [name.text()];
  }
  return (name?.findAll({ rule: { any: [{ kind: "shorthand_property_identifier_pattern" }, { kind: "identifier" }] } }) ?? []).map((n) =>
    n.text(),
  );
}

function referencesAfter(scope: SgNode, names: readonly string[], after: SgNode): boolean {
  return names.some((name) =>
    scope
      .findAll({ rule: { kind: "identifier", regex: `^${name.replace(/\$/g, "\\$")}$` } })
      .some((node) => node.range().start.index >= after.range().end.index),
  );
}

function pairKey(pair: SgNode): string | undefined {
  return fieldOf(pair, "key")?.text();
}

function objectPairs(object: SgNode | null | undefined): SgNode[] {
  return (object?.children() ?? []).filter((child) => kindOf(child) === "pair");
}

function guardedWriteSignals(guard: SgNode): Signals {
  const call = guard.ancestors().find((node) => kindOf(node) === "call_expression");
  const write = call === undefined ? undefined : modelCall(call);
  const fn = guard.ancestors().find((node) => FUNCTION_KINDS.has(kindOf(node) ?? ""));
  if (call === undefined || write === undefined || fn === undefined) {
    return { read_before_write: false, read_checks_guard: false, write_result_used: false, identity_from_read: false, await_between: false };
  }
  const reads = fn
    .findAll({ rule: { kind: "call_expression" } })
    .filter((node) => {
      const read = modelCall(node);
      return read?.model === write.model && READ_METHODS.has(read.method) && before(node, call);
    });
  const read = reads.at(-1);
  const key = pairKey(guard);
  const value = fieldOf(guard, "value")?.text().replace(/\s+/g, " ");
  // Only the read's own `where` filters; a `select` or `include` naming the field does not.
  const readWhere = read === undefined ? undefined : objectPairs(fieldOf(read, "arguments")?.children().find((child) => kindOf(child) === "object")).find((pair) => pairKey(pair) === "where");
  const readFilters =
    readWhere?.findAll({ rule: { kind: "pair" } }).some((pair) => pairKey(pair) === key && fieldOf(pair, "value")?.text().replace(/\s+/g, " ") === value) ?? false;
  const readNames = read === undefined ? [] : boundNames(read);
  // The code tests the guarded field of what it read (`if (seat.status !== 'open')`) before writing.
  const testedInCode =
    read !== undefined &&
    fn
      .findAll({ rule: { kind: "member_expression" } })
      .some(
        (node) =>
          before(read, node) &&
          node.range().end.index <= call.range().end.index &&
          fieldOf(node, "property")?.text() === key &&
          readNames.includes(fieldOf(node, "object")?.text() ?? ""),
      );
  const where = guard.parent();
  const identity =
    where
      ?.children()
      .filter((child) => child.id() !== guard.id() && (kindOf(child) === "pair" || kindOf(child) === "shorthand_property_identifier"))
      .some((child) =>
        // A shorthand entry (`where: { id, ... }`) is its own name; a pair holds the name as a descendant.
        kindOf(child) === "shorthand_property_identifier"
          ? readNames.includes(child.text())
          : readNames.some((name) => child.findAll({ rule: { kind: "identifier", regex: `^${name.replace(/\$/g, "\\$")}$` } }).length > 0),
      ) ?? false;
  const awaitBetween =
    read !== undefined &&
    fn.findAll({ rule: { kind: "await_expression" } }).some((node) => before(read, node) && before(node, call));
  return {
    read_before_write: read !== undefined,
    read_checks_guard: readFilters || testedInCode,
    write_result_used: referencesAfter(fn, boundNames(call), call),
    identity_from_read: identity,
    await_between: awaitBetween,
  };
}

function objectEntries(object: SgNode | null | undefined): Map<string, string> {
  const entries = new Map<string, string>();
  for (const child of object?.children() ?? []) {
    if (kindOf(child) === "pair") {
      entries.set(pairKey(child) ?? "", fieldOf(child, "value")?.text() ?? "");
    } else if (kindOf(child) === "shorthand_property_identifier") {
      entries.set(child.text(), child.text());
    }
  }
  return entries;
}

function upsertSignals(call: SgNode, path: string): Signals {
  const where = call.getMatch("WHERE");
  const create = call.getMatch("CREATE");
  const whereEntries = kindOf(where) === "object" ? objectEntries(where) : new Map<string, string>();
  const createEntries = kindOf(create) === "object" ? objectEntries(create) : new Map<string, string>();
  // Only an upsert in the array passed to `$transaction([...])` is batched; one inside an
  // interactive `$transaction(async (tx) => ...)` callback can run the split form.
  let inBatch = false;
  for (const node of call.ancestors()) {
    if (FUNCTION_KINDS.has(kindOf(node) ?? "")) {
      break;
    }
    const args = node.parent();
    if (kindOf(node) === "array" && kindOf(args) === "arguments" && /(^|\.)\$transaction$/.test(fieldOf(args?.parent(), "function")?.text() ?? "")) {
      inBatch = true;
      break;
    }
  }
  const handler = call.ancestors().some((node) => HTTP_HANDLERS.test(functionName(node) ?? ""));
  return {
    not_in_batch_transaction: !inBatch,
    create_covers_where: whereEntries.size > 0 && [...whereEntries].every(([key, value]) => createEntries.get(key) === value),
    where_is_object: kindOf(where) === "object",
    request_handler: handler || path.split("/").includes("api"),
  };
}

function signalsFor(classId: string, match: SgNode, path: string): Signals {
  if (classId === "RACE.guarded-write") {
    return guardedWriteSignals(match);
  }
  if (classId === "RACE.check-then-act") {
    return upsertSignals(match, path);
  }
  return {};
}

function confidence(classId: string, signals: Signals, plantedConfirmed: boolean): SiteConfidence {
  const weights = WEIGHTS[classId] ?? {};
  const raw = Object.entries(weights).reduce((sum, [name, weight]) => sum + (signals[name] === true ? weight : 0), 0);
  const score = Math.round(raw * 100) / 100;
  const level: ConfidenceLevel = !plantedConfirmed ? "low" : score >= 0.75 ? "high" : score >= 0.45 ? "medium" : "low";
  return { score, level, signals };
}

function nearestFunctionName(node: SgNode): string | null {
  for (let fn = enclosingFunction(node); fn !== undefined; fn = enclosingFunction(fn)) {
    const name = functionName(fn) ?? (kindOf(fn.parent()) === "variable_declarator" ? fieldOf(fn.parent(), "name")?.text() : undefined);
    if (name !== undefined) {
      return name;
    }
  }
  return null;
}

function languageFor(path: string): RuleLanguage {
  return path.endsWith(".tsx") ? "Tsx" : "TypeScript";
}

/** Every site of every class in one file. `path` is the repository-relative path used in diffs. */
export function findSitesInSource(classes: readonly ClassRule[], path: string, source: string): SiteRecord[] {
  const language = languageFor(path);
  const originalSha = sha256Hex(source);
  const sites: SiteRecord[] = [];
  for (const { classId, fixed, planted } of classes) {
    const { root, matches } = matchAll(fixed, source, language);
    for (const match of matches) {
      const edit = fixEdit(fixed, match);
      const result = root.commitEdits([edit]);
      const plantedConfirmed = matchAll(planted, result, language).matches.some(
        (node) => node.range().start.index <= edit.startPos && node.range().end.index >= edit.startPos,
      );
      const patch = structuredPatch(`a/${path}`, `b/${path}`, source, result, undefined, undefined, { context: 3 });
      const start = match.range().start;
      sites.push({
        class_id: classId,
        rule_id: fixed.id,
        path,
        line: start.line + 1,
        column: start.column + 1,
        function: nearestFunctionName(match),
        matched: match.text(),
        original_sha256: originalSha,
        result_sha256: sha256Hex(result),
        planted_form_confirmed: plantedConfirmed,
        diff: formatPatch({ ...patch, isGit: true }),
        confidence: confidence(classId, signalsFor(classId, match, path), plantedConfirmed),
      });
    }
  }
  return sites;
}

const SOURCE_FILE = /\.(ts|tsx)$/;
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);

/** Source files under `root`, as sorted paths relative to it with `/` separators. */
export function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) {
          walk(full);
        }
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  if (!statSync(root).isDirectory()) {
    throw new Error(`${root} is not a directory`);
  }
  walk(root);
  return files.sort();
}

function compareSites(a: SiteRecord, b: SiteRecord): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.column - b.column || (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0);
}

/**
 * Runs the class rules over every `.ts` and `.tsx` file under `root` (skipping `node_modules`,
 * build output and declaration files). `prefix` is prepended to each path in the report and its
 * diffs, so they read as repository paths (for example `src/`).
 */
export function findSites(root: string, ruleBytes: Uint8Array, prefix = ""): SiteReport {
  const classes = loadClassRules(ruleBytes);
  const files = sourceFiles(root);
  const sites: SiteRecord[] = [];
  for (const file of files) {
    const source = decodeUtf8(readFileSync(join(root, file)));
    if (source !== undefined) {
      sites.push(...findSitesInSource(classes, `${prefix}${file}`, source));
    }
  }
  sites.sort(compareSites);
  return {
    rule_sha256: sha256Hex(ruleBytes),
    classes: classes.map((rule) => rule.classId),
    files_scanned: files.length,
    site_count: sites.length,
    sites,
  };
}
