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

/** Names bound by `const`, `let` or `var <pattern> = await <call>` around a call, or none. */
function boundNames(call: SgNode): string[] {
  let node: SgNode | null = call.parent();
  if (kindOf(node) === "await_expression") {
    node = node?.parent() ?? null;
  }
  if (kindOf(node) !== "variable_declarator" || node === null) {
    return [];
  }
  return patternNames(fieldOf(node, "name"));
}

/**
 * The declarator binding a read's result when the binding is `const`, or none. A `let` or `var`
 * binding may be reassigned before the write, so its names never stand for the record the code read.
 */
function constReadDeclarator(read: SgNode): SgNode | undefined {
  let node: SgNode | null = read.parent();
  if (kindOf(node) === "await_expression") {
    node = node?.parent() ?? null;
  }
  const declaration = node?.parent() ?? null;
  return node !== null && kindOf(node) === "variable_declarator" && kindOf(declaration) === "lexical_declaration" && declaration?.children()[0]?.text() === "const"
    ? node
    : undefined;
}

/** Names a `const` binding of a read binds, or none (see `constReadDeclarator`). */
function constReadNames(read: SgNode | undefined): string[] {
  const declarator = read === undefined ? undefined : constReadDeclarator(read);
  return declarator === undefined ? [] : patternNames(fieldOf(declarator, "name"));
}

/**
 * Names a binding pattern binds: identifiers in binding positions only, never a default value
 * (`{ id = fallback }`) or a computed key (`{ [field]: picked }`).
 */
function patternNames(pattern: SgNode | null): string[] {
  switch (kindOf(pattern)) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      return pattern === null ? [] : [pattern.text()];
    case "pair_pattern":
      return patternNames(fieldOf(pattern, "value"));
    case "assignment_pattern":
    case "object_assignment_pattern":
      return patternNames(fieldOf(pattern, "left"));
    case "object_pattern":
    case "array_pattern":
    case "rest_pattern":
      return (pattern?.children() ?? []).flatMap((child) => patternNames(child));
    default:
      return [];
  }
}

/**
 * Whether a value text holds the read's own `id`: `<record>.id` (or `<records>[<index>].id` for a
 * list read) when the read is bound to a `const` name, the name an `id` key of a `const`
 * destructuring binds (without a default), or the read's own `where` id value when that value is
 * fixed between the read and the write `call` (see `fixedValue`).
 */
function readIdTest(read: SgNode | undefined, call: SgNode | undefined): (value: string) => boolean {
  const values = new Set<string>();
  let record: RegExp | undefined;
  if (read === undefined) {
    return () => false;
  }
  const whereId = objectEntryNodes(fieldOf(readWhereOf(read), "value")).get("id");
  if (whereId !== undefined && fixedValue(whereId, read, call)) {
    values.add(whereId.text());
  }
  const declarator = constReadDeclarator(read);
  const name = declarator === undefined ? null : fieldOf(declarator, "name");
  if (kindOf(name) === "identifier" && name !== null) {
    record = new RegExp(`^${name.text().replace(/\$/g, "\\$")}(\\[[^\\[\\]]*\\])?\\.id$`);
  } else if (kindOf(name) === "object_pattern") {
    for (const child of name?.children() ?? []) {
      if (kindOf(child) === "shorthand_property_identifier_pattern" && child.text() === "id") {
        values.add("id");
      } else if (kindOf(child) === "pair_pattern" && pairKey(child) === "id" && kindOf(fieldOf(child, "value")) === "identifier") {
        values.add(fieldOf(child, "value")?.text() ?? "");
      }
    }
  }
  values.delete("");
  const norm = (text: string): string => text.replace(/\s+/g, " ");
  return (value) => [...values].some((idValue) => norm(idValue) === norm(value)) || (record?.test(norm(value)) ?? false);
}

function referencesAfter(scope: SgNode, names: readonly string[], after: SgNode): boolean {
  return names.some((name) =>
    scope
      .findAll({
        rule: { any: [{ kind: "identifier" }, { kind: "shorthand_property_identifier" }], regex: `^${name.replace(/\$/g, "\\$")}$` },
      })
      .some((node) => node.range().start.index >= after.range().end.index),
  );
}

function pairKey(pair: SgNode): string | undefined {
  return fieldOf(pair, "key")?.text();
}

function objectPairs(object: SgNode | null | undefined): SgNode[] {
  return (object?.children() ?? []).filter((child) => kindOf(child) === "pair");
}

/**
 * Whether `node` runs in the same flow as `call`: its nearest enclosing function also encloses
 * `call`. A node in a callback nested beside or below the write's scope (one that may never run)
 * does not.
 */
function inFlowOf(node: SgNode, call: SgNode): boolean {
  const fn = node.ancestors().find((ancestor) => FUNCTION_KINDS.has(kindOf(ancestor) ?? ""));
  return fn !== undefined && fn.range().start.index <= call.range().start.index && call.range().end.index <= fn.range().end.index;
}

/**
 * Whether a call is the direct operand of `await` in its own statement (`await db.m.find(...);`) or
 * initializer (`const row = await db.m.find(...);`). A read promise created earlier and awaited
 * later, or one passed to another call, may not have finished when a later write runs.
 */
function awaitedInOwnStatement(call: SgNode): boolean {
  const awaited = call.parent();
  const holder = awaited?.parent() ?? null;
  return (
    kindOf(awaited) === "await_expression" &&
    (kindOf(holder) === "expression_statement" || (kindOf(holder) === "variable_declarator" && fieldOf(holder, "value")?.id() === awaited?.id()))
  );
}

/**
 * Whether the statement holding a read sits directly in a block that also encloses `call` (the
 * write's own block or a block around it). A read in a sibling branch, such as the `if` side of an
 * `if`/`else` whose `else` side holds the write, never runs before the write in the same execution.
 */
function blockEncloses(read: SgNode, call: SgNode): boolean {
  const statement = read.ancestors().find((node) => {
    const kind = kindOf(node);
    return kind === "expression_statement" || kind === "lexical_declaration" || kind === "variable_declaration";
  });
  const block = statement?.parent();
  const blockKind = kindOf(block);
  return (
    block !== undefined &&
    block !== null &&
    (blockKind === "statement_block" || blockKind === "program") &&
    block.range().start.index <= call.range().start.index &&
    call.range().end.index <= block.range().end.index
  );
}

/**
 * The write around a guard, the outermost function enclosing it, and the read it is scored
 * against: the last read of the same model that ends before the write, in the write's flow, is
 * awaited directly in its own statement or initializer (see `awaitedInOwnStatement`), and sits in
 * a block that encloses the write (see `blockEncloses`).
 */
function writeContext(guard: SgNode): { call: SgNode; fn: SgNode; read: SgNode | undefined } | undefined {
  const call = guard.ancestors().find((node) => kindOf(node) === "call_expression");
  const write = call === undefined ? undefined : modelCall(call);
  // The outermost enclosing function: a read in it, or in any function around the write, counts,
  // but not one inside a callback the write does not run in.
  const fn = guard.ancestors().filter((node) => FUNCTION_KINDS.has(kindOf(node) ?? "")).at(-1);
  if (call === undefined || write === undefined || fn === undefined) {
    return undefined;
  }
  const read = fn
    .findAll({ rule: { kind: "call_expression" } })
    .filter((node) => {
      const found = modelCall(node);
      return found?.model === write.model && READ_METHODS.has(found.method) && before(node, call) && inFlowOf(node, call) && awaitedInOwnStatement(node) && blockEncloses(node, call);
    })
    .at(-1);
  return { call, fn, read };
}

/** The `where` pair of a read's argument object. */
function readWhereOf(read: SgNode | undefined): SgNode | undefined {
  return read === undefined ? undefined : objectPairs(fieldOf(read, "arguments")?.children().find((child) => kindOf(child) === "object")).find((pair) => pairKey(pair) === "where");
}

/**
 * Whether every entry the rewrite leaves in the guard's `where` pins the record the code read: an
 * `id` entry whose value is the read's own id (see `readIdTest`), or a direct entry of the read's
 * own `where` with the same key and the same value text, when that value is fixed (see
 * `fixedValue`). Any other entry, including an `id` from
 * elsewhere or a read key with a different value, may write another record or keep the write
 * conditional, so the planted form is then not confirmed. When the write sits in a function nested
 * inside the read's, the same text may name a different binding there (a callback parameter can
 * shadow the read's value or its id), so the form is never confirmed.
 */
function survivorsPinRecord(guard: SgNode): boolean {
  const context = writeContext(guard);
  const read = context?.read;
  const nearestFunction = (node: SgNode): SgNode | undefined => node.ancestors().find((ancestor) => FUNCTION_KINDS.has(kindOf(ancestor) ?? ""));
  const nested = read !== undefined && context !== undefined && nearestFunction(read)?.id() !== nearestFunction(context.call)?.id();
  if (nested) {
    return false;
  }
  const readEntries = objectEntries(fieldOf(readWhereOf(read), "value"));
  const holdsReadId = readIdTest(read, context?.call);
  const norm = (text: string | undefined): string | undefined => text?.replace(/\s+/g, " ");
  return (guard.parent()?.children() ?? [])
    .filter((child) => child.id() !== guard.id() && (kindOf(child) === "pair" || kindOf(child) === "shorthand_property_identifier"))
    .every((child) => {
      const key = kindOf(child) === "pair" ? pairKey(child) : child.text();
      const value = kindOf(child) === "pair" ? fieldOf(child, "value")?.text() : child.text();
      if (key === "id") {
        return value !== undefined && holdsReadId(value);
      }
      return key !== undefined && readEntries.has(key) && norm(readEntries.get(key)) === norm(value) && fixedValue(kindOf(child) === "pair" ? fieldOf(child, "value") : child, read, context?.call);
    });
}

const LITERAL_KINDS = new Set(["string", "number", "true", "false", "null"]);

/**
 * Whether a value cannot change between the read and the write: a literal, or a name bound by
 * `const` in a declaration that is a direct statement of the write's own function body and ends
 * before the read, when no other declaration of that name in the function sits in a block around
 * the read or the write. A `let` or `var` binding, a parameter, a `const` in an inner block or any
 * other expression may hold a different value, or name a different binding, at the write than at
 * the read, so the same text need not hold the value the read used.
 */
function fixedValue(value: SgNode | null | undefined, read: SgNode | undefined, call: SgNode | undefined): boolean {
  if (value === null || value === undefined || read === undefined || call === undefined) {
    return false;
  }
  const valueKind = kindOf(value) ?? "";
  if (LITERAL_KINDS.has(valueKind) || (valueKind === "template_string" && !value.children().some((child) => kindOf(child) === "template_substitution"))) {
    return true;
  }
  if (valueKind !== "identifier" && valueKind !== "shorthand_property_identifier") {
    return false;
  }
  const name = value.text();
  const nearestFunction = (node: SgNode): SgNode | undefined => node.ancestors().find((ancestor) => FUNCTION_KINDS.has(kindOf(ancestor) ?? ""));
  const fn = nearestFunction(call);
  const body = fn === undefined ? null : fieldOf(fn, "body");
  if (fn === undefined || body === null || kindOf(body) !== "statement_block") {
    return false;
  }
  const declares = (declaration: SgNode): boolean =>
    declaration
      .children()
      .filter((child) => kindOf(child) === "variable_declarator")
      .some((declarator) => patternNames(fieldOf(declarator, "name")).includes(name));
  const top = body
    .children()
    .find((statement) => kindOf(statement) === "lexical_declaration" && statement.children()[0]?.text() === "const" && declares(statement) && before(statement, read));
  if (top === undefined) {
    return false;
  }
  const encloses = (scope: SgNode, node: SgNode): boolean => scope.range().start.index <= node.range().start.index && node.range().end.index <= scope.range().end.index;
  // Every other binding of the name in this function, with the node its scope covers.
  const shadows = fn
    .findAll({ rule: { any: [{ kind: "variable_declarator" }, { kind: "for_in_statement" }, { kind: "catch_clause" }, { kind: "function_declaration" }, { kind: "class_declaration" }] } })
    .filter((node) => nearestFunction(node)?.id() === fn.id())
    .flatMap((node): SgNode[] => {
      switch (kindOf(node)) {
        case "variable_declarator":
          return node.parent()?.id() !== top.id() && patternNames(fieldOf(node, "name")).includes(name) ? [node.parent()?.parent() ?? fn] : [];
        case "for_in_statement":
          return patternNames(fieldOf(node, "left")).includes(name) ? [node] : [];
        case "catch_clause":
          return patternNames(fieldOf(node, "parameter")).includes(name) ? [node] : [];
        default:
          return fieldOf(node, "name")?.text() === name ? [node.parent() ?? fn] : [];
      }
    });
  return !shadows.some((scope) => encloses(scope, read) || encloses(scope, call));
}

function guardedWriteSignals(guard: SgNode): Signals {
  const context = writeContext(guard);
  if (context === undefined) {
    return { read_before_write: false, read_checks_guard: false, write_result_used: false, identity_from_read: false, await_between: false };
  }
  const { call, fn, read } = context;
  const key = pairKey(guard);
  const value = fieldOf(guard, "value")?.text().replace(/\s+/g, " ");
  // Only direct fields of the read's own `where` filter the written model; a `select` or `include`
  // naming the field, or a nested relation filter (`owner: { active: true }`), does not.
  const readWhere = readWhereOf(read);
  const readFilters = objectPairs(fieldOf(readWhere, "value")).some(
    (pair) => pairKey(pair) === key && fieldOf(pair, "value")?.text().replace(/\s+/g, " ") === value,
  );
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
          inFlowOf(node, call) &&
          fieldOf(node, "property")?.text() === key &&
          readNames.includes(fieldOf(node, "object")?.text() ?? ""),
      );
  // Only a `const` binding gives the write its identity: a `let` or `var` may be reassigned first.
  const identityNames = constReadNames(read);
  const where = guard.parent();
  const identity =
    where
      ?.children()
      .filter((child) => child.id() !== guard.id() && (kindOf(child) === "pair" || kindOf(child) === "shorthand_property_identifier"))
      .some((child) =>
        // A shorthand entry (`where: { id, ... }`) is its own name; a pair holds the name as a descendant.
        kindOf(child) === "shorthand_property_identifier"
          ? identityNames.includes(child.text())
          : identityNames.some((name) => child.findAll({ rule: { kind: "identifier", regex: `^${name.replace(/\$/g, "\\$")}$` } }).length > 0),
      ) ?? false;
  const awaitBetween =
    read !== undefined &&
    fn.findAll({ rule: { kind: "await_expression" } }).some((node) => before(read, node) && before(node, call) && inFlowOf(node, call));
  return {
    read_before_write: read !== undefined,
    read_checks_guard: readFilters || testedInCode,
    write_result_used: referencesAfter(guard.ancestors().find((node) => FUNCTION_KINDS.has(kindOf(node) ?? "")) ?? fn, boundNames(call), call),
    identity_from_read: identity,
    await_between: awaitBetween,
  };
}

/** The value node of each direct entry of an object literal, by key (a shorthand entry is its own value). */
function objectEntryNodes(object: SgNode | null | undefined): Map<string, SgNode> {
  const entries = new Map<string, SgNode>();
  for (const child of object?.children() ?? []) {
    const value = kindOf(child) === "pair" ? fieldOf(child, "value") : kindOf(child) === "shorthand_property_identifier" ? child : null;
    if (value !== null) {
      entries.set(kindOf(child) === "pair" ? (pairKey(child) ?? "") : child.text(), value);
    }
  }
  return entries;
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
  // Only an upsert in the array passed to `$transaction([...])` is batched. The rule already leaves
  // out every upsert inside a `$transaction(...)` argument, so this is a second check.
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
      const plantedConfirmed =
        matchAll(planted, result, language).matches.some((node) => node.range().start.index <= edit.startPos && node.range().end.index >= edit.startPos) &&
        (classId !== "RACE.guarded-write" || survivorsPinRecord(match));
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
