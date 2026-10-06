// The source rule and structural confirmation for a harvested candidate's changed file.
//
// The shape's own source rule, `dt-1.tz-arg.source` in @rbw/shapes, is pinned to one upstream
// component and commit, so candidates are matched with this package's rule for the candidate's
// call (`rules/tz-arg.candidate.yml`), run through @rbw/shapes' rule loader and the napi engine.
//
// A rule match whose time-zone argument sits on a line the commit added is confirmed when,
// structurally:
// - the parent has a function at the same nesting path (`function_missing_before` otherwise);
// - that function calls the same callee the same number of times on both sides, and one of the
//   parent's calls that no other call of the commit keeps unchanged has the same other arguments,
//   as text with whitespace normalized and apart from the time-zone argument, so the fix changed
//   this call rather than adding or replacing one (`call_added`), and that paired parent call
//   passes no time-zone value (`before_has_timezone_argument`);
// - the time-zone value is not a literal or the runtime's own zone (`timezone_is_constant`), and the name it is read from
//   is bound in the call's own function, an enclosing one, or the module (`timezone_unbound`, also
//   for a value with no name): the caller had the time zone.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { loadRules, type LoadedRule } from "@rbw/shapes";

export const CANDIDATE_RULE_FILE = fileURLToPath(new URL("../rules/tz-arg.candidate.yml", import.meta.url));
export const CANDIDATE_RULE_IDS = { TypeScript: "tz-arg.candidate.ts", Tsx: "tz-arg.candidate.tsx" } as const;

const RULE_BYTES = readFileSync(CANDIDATE_RULE_FILE);
const RULES = loadRules(RULE_BYTES);

export function candidateRuleBytes(): Uint8Array {
  return RULE_BYTES;
}

const TYPESCRIPT = /\.(ts|mts|cts)$/;
export const SOURCE_FILE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;

/** TypeScript files parse as TypeScript; TSX and every JavaScript form parse as TSX. */
export function candidateRule(path: string): LoadedRule {
  const id = TYPESCRIPT.test(path) ? CANDIDATE_RULE_IDS.TypeScript : CANDIDATE_RULE_IDS.Tsx;
  const rule = RULES.get(id);
  if (rule === undefined) {
    throw new Error(`the candidate rule file does not define ${id}`);
  }
  return rule;
}

/** Text with a word ending in a time-zone word, as the cheap filter before any blob is fetched. */
export const TIMEZONE_TEXT = /time_?zone|tz\b|zone\b/i;
/**
 * A name that is a time zone: the whole identifier, or its final camel-case or snake-case word or
 * words, is timezone, time zone, tz or zone (`userTimezone`, `user_tz`), with no word after it
 * (not `timezoneOffset`). The candidate rule file uses the same pattern.
 */
export const TIMEZONE_NAME = /(^|_)(time_?[Zz]one|tz|zone|TIME_?ZONE|TZ|ZONE)$|(Time_?[Zz]one|Tz|TZ|Zone)$/;

/** The 1-based line numbers, on the new side, of the lines a GitHub `patch` adds. */
export function addedLines(patch: string): Set<number> {
  const added = new Set<number>();
  let line = 0;
  for (const text of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header !== null) {
      line = Number(header[1]);
    } else if (text.startsWith("+")) {
      added.add(line);
      line += 1;
    } else if (text.startsWith(" ")) {
      line += 1;
    }
  }
  return added;
}

/** The text of the lines a patch adds. */
export function addedText(patch: string): string {
  return patch
    .split("\n")
    .filter((text) => text.startsWith("+"))
    .join("\n");
}

export type MatchOutcome =
  | { readonly status: "confirmed"; readonly before_call: string; readonly before_line: number; readonly timezone: string }
  | { readonly status: "rejected"; readonly reason: ConfirmReason; readonly detail: string };

export type ConfirmReason = "function_missing_before" | "call_added" | "before_has_timezone_argument" | "timezone_is_constant" | "timezone_unbound";

export interface FileMatch {
  readonly line: number;
  readonly call: string;
  readonly callee: string;
  readonly function: string;
  readonly outcome: MatchOutcome;
}

const FUNCTION_KINDS = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "generator_function_declaration",
  "generator_function",
]);

// Parent kind -> the fields in which an identifier child declares a name.
const BINDING_FIELDS: Readonly<Partial<Record<string, readonly string[]>>> = {
  variable_declarator: ["name"],
  required_parameter: ["pattern"],
  optional_parameter: ["pattern"],
  pair_pattern: ["value"],
  assignment_pattern: ["left"],
  object_assignment_pattern: ["left"],
  function_declaration: ["name"],
  generator_function_declaration: ["name"],
  class_declaration: ["name"],
  arrow_function: ["parameter"],
  catch_clause: ["parameter"],
  import_specifier: ["name", "alias"],
  namespace_import: [],
};
const BINDING_CONTAINERS = new Set(["array_pattern", "rest_pattern", "import_clause", "namespace_import", "formal_parameters"]);

function kindOf(node: SgNode | null | undefined): string {
  return node === null || node === undefined ? "" : String(node.kind());
}

/** The first child in a field. The napi typings resolve field names only for typed grammars. */
function fieldOf(node: SgNode | null | undefined, name: string): SgNode | null {
  if (node === null || node === undefined) {
    return null;
  }
  return (node as unknown as { field(name: string): SgNode | null }).field(name);
}

function argumentsOf(call: SgNode): SgNode[] {
  return fieldOf(call, "arguments")?.namedChildren().filter((node) => kindOf(node) !== "comment") ?? [];
}

function enclosingFunctions(node: SgNode): SgNode[] {
  return node.ancestors().filter((ancestor) => FUNCTION_KINDS.has(kindOf(ancestor)));
}

function functionLabel(fn: SgNode): string {
  const name = fieldOf(fn, "name")?.text();
  if (name !== undefined) {
    return name;
  }
  const parent = fn.parent();
  if (kindOf(parent) === "variable_declarator") {
    return fieldOf(parent, "name")?.text() ?? "<anonymous>";
  }
  if (kindOf(parent) === "pair") {
    return fieldOf(parent, "key")?.text() ?? "<anonymous>";
  }
  return "<anonymous>";
}

/** The names of the functions around a node, outermost first, or `<module>` at top level. */
function functionPath(node: SgNode): string {
  const names = enclosingFunctions(node).reverse().map(functionLabel);
  return names.length === 0 ? "<module>" : names.join("/");
}

function calleeOf(call: SgNode): string {
  return fieldOf(call, "function")?.text() ?? "";
}

// Expressions that pass a value through: the value's name is the name of the inner expression.
const PASS_THROUGH = new Set(["parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression", "await_expression"]);
const LITERALS = new Set(["string", "number", "true", "false", "null", "undefined"]);

/**
 * The name a time-zone value is read from: the leftmost name of a member chain or call such as
 * `user?.settings.timezone` or `getZone()`, through casts, `await`, and the left side of `??`
 * and `||` fallbacks. `this` counts as a name. Undefined for a literal or an expression with no name.
 */
function rootName(node: SgNode): string | undefined {
  let current: SgNode | null = node;
  for (;;) {
    const kind = kindOf(current);
    if (kind === "member_expression" || kind === "subscript_expression") {
      current = fieldOf(current, "object");
    } else if (kind === "call_expression") {
      current = fieldOf(current, "function");
    } else if (PASS_THROUGH.has(kind)) {
      current = current?.namedChildren().find((child) => kindOf(child) !== "comment") ?? null;
    } else if (kind === "binary_expression" && ["??", "||"].includes(fieldOf(current, "operator")?.text() ?? "")) {
      current = fieldOf(current, "left");
    } else {
      break;
    }
  }
  const kind = kindOf(current);
  return current !== null && (kind === "identifier" || kind === "this") && current.text() !== "undefined" ? current.text() : undefined;
}

// Calls that return the runtime's own time zone, as in `dayjs.tz.guess()` or
// `Intl.DateTimeFormat().resolvedOptions()`: such a value was never selected by the caller.
const ENVIRONMENT_ZONE = {
  rule: { kind: "call_expression", has: { field: "function", kind: "member_expression", has: { field: "property", regex: "^(guess|resolvedOptions)$" } } },
} as const;

function readsEnvironmentZone(node: SgNode): boolean {
  return node.matches(ENVIRONMENT_ZONE) || node.find(ENVIRONMENT_ZONE) !== null;
}

function isLiteral(node: SgNode): boolean {
  const kind = kindOf(node);
  if (kind === "template_string") {
    return !node.namedChildren().some((child) => kindOf(child) === "template_substitution");
  }
  return LITERALS.has(kind) || (kind === "identifier" && node.text() === "undefined");
}

type TimezoneValue =
  | { readonly node: SgNode; readonly kind: "name"; readonly name: string }
  | { readonly node: SgNode; readonly kind: "constant"; readonly text: string }
  | { readonly node: SgNode; readonly kind: "unresolved"; readonly text: string };

/** The time-zone value a call passes directly, read the same way the candidate rule matches it. */
function timezoneArgument(call: SgNode): TimezoneValue | undefined {
  const valueOf = (node: SgNode, value: SgNode): TimezoneValue => {
    if (readsEnvironmentZone(value)) {
      return { node, kind: "constant", text: value.text() };
    }
    const name = rootName(value);
    if (name !== undefined) {
      return { node, kind: "name", name };
    }
    return isLiteral(value) ? { node, kind: "constant", text: value.text() } : { node, kind: "unresolved", text: value.text() };
  };
  for (const argument of argumentsOf(call)) {
    const kind = kindOf(argument);
    if (kind === "identifier" && TIMEZONE_NAME.test(argument.text())) {
      return { node: argument, kind: "name", name: argument.text() };
    }
    if (kind === "member_expression" && TIMEZONE_NAME.test(fieldOf(argument, "property")?.text() ?? "")) {
      return valueOf(argument, argument);
    }
    if (kind === "object") {
      for (const property of argument.namedChildren()) {
        if (kindOf(property) === "shorthand_property_identifier" && TIMEZONE_NAME.test(property.text())) {
          return { node: property, kind: "name", name: property.text() };
        }
        const value = fieldOf(property, "value");
        if (kindOf(property) === "pair" && TIMEZONE_NAME.test(fieldOf(property, "key")?.text() ?? "") && value !== null) {
          return valueOf(property, value);
        }
      }
    }
  }
  return undefined;
}

/** Whether the commit added a line of the call's time-zone argument (or, failing that, of the call). */
function addsTimezone(call: SgNode, added: ReadonlySet<number>): boolean {
  const { start, end } = (timezoneArgument(call)?.node ?? call).range();
  for (let line = start.line + 1; line <= end.line + 1; line += 1) {
    if (added.has(line)) {
      return true;
    }
  }
  return false;
}

function declaresName(node: SgNode): boolean {
  const parent = node.parent();
  const kind = kindOf(parent);
  if (parent === null) {
    return false;
  }
  if (BINDING_CONTAINERS.has(kind)) {
    return true;
  }
  return (BINDING_FIELDS[kind] ?? []).some((field) => fieldOf(parent, field)?.id() === node.id());
}

/** Whether `name` is declared in the call's function, an enclosing function or at module level. */
function isBound(root: SgNode, call: SgNode, name: string): boolean {
  if (name === "this") {
    return true;
  }
  const scopes = new Set(enclosingFunctions(call).map((fn) => fn.id()));
  const escaped = name.replace(/[$]/g, "\\$");
  const sites = [
    ...root.findAll({ rule: { kind: "shorthand_property_identifier_pattern", regex: `^${escaped}$` } }),
    ...root.findAll({ rule: { kind: "identifier", regex: `^${escaped}$` } }).filter(declaresName),
  ];
  return sites.some((site) => {
    const [owner] = enclosingFunctions(site);
    // A function's own name is declared in the scope around it, and its parameters inside it.
    const declaredBy = owner !== undefined && fieldOf(owner, "name")?.id() === site.id() ? enclosingFunctions(owner)[0] : owner;
    return declaredBy === undefined || scopes.has(declaredBy.id());
  });
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * A call's arguments as text with whitespace normalized, leaving out its time-zone argument (a whole
 * argument or an object property) and any trailing empty objects, so that `f(d)`, `f(d, {})` and
 * `f(d, { timeZone: tz })` have the same other arguments.
 */
function otherArguments(call: SgNode): string {
  const skipped = timezoneArgument(call)?.node.id();
  const texts = argumentsOf(call).flatMap((argument) => {
    if (argument.id() === skipped) {
      return [];
    }
    if (kindOf(argument) !== "object") {
      return [squash(argument.text())];
    }
    const properties = argument.namedChildren().filter((property) => kindOf(property) !== "comment" && property.id() !== skipped);
    return [`{${properties.map((property) => squash(property.text())).join(", ")}}`];
  });
  while (texts.at(-1) === "{}") {
    texts.pop();
  }
  return texts.join("\n");
}

function callsIn(root: SgNode, callee: string, path: string): SgNode[] {
  return root.findAll({ rule: { kind: "call_expression" } }).filter((call) => calleeOf(call) === callee && functionPath(call) === path);
}

function hasFunctionPath(root: SgNode, path: string): boolean {
  if (path === "<module>") {
    return true;
  }
  const functions = root.findAll({ rule: { any: [...FUNCTION_KINDS].map((kind) => ({ kind })) } });
  return functions.some((fn) => [...enclosingFunctions(fn).reverse(), fn].map(functionLabel).join("/") === path);
}

function judge(beforeRoot: SgNode, afterRoot: SgNode, call: SgNode): MatchOutcome {
  const callee = calleeOf(call);
  const path = functionPath(call);
  if (!hasFunctionPath(beforeRoot, path)) {
    return { status: "rejected", reason: "function_missing_before", detail: `the parent has no function ${path}` };
  }
  const afterCalls = callsIn(afterRoot, callee, path);
  const beforeCalls = callsIn(beforeRoot, callee, path);
  if (afterCalls.length !== beforeCalls.length) {
    return {
      status: "rejected",
      reason: "call_added",
      detail: `${path} calls ${callee} ${String(beforeCalls.length)} times before and ${String(afterCalls.length)} after`,
    };
  }
  // A parent call that another call of the commit keeps unchanged is not a partner. The parent call
  // at the same position is preferred when several have the same other arguments.
  const unchanged = afterCalls.filter((candidate) => candidate.id() !== call.id()).map((candidate) => squash(candidate.text()));
  const free = beforeCalls.filter((candidate) => {
    const kept = unchanged.indexOf(squash(candidate.text()));
    if (kept === -1) {
      return true;
    }
    unchanged.splice(kept, 1);
    return false;
  });
  const others = otherArguments(call);
  const partners = free.filter((candidate) => otherArguments(candidate) === others);
  const positional = beforeCalls[afterCalls.findIndex((candidate) => candidate.id() === call.id())];
  const paired = partners.find((candidate) => candidate.id() === positional?.id()) ?? partners[0];
  if (paired === undefined) {
    return { status: "rejected", reason: "call_added", detail: `no call to ${callee} in the parent's ${path} has the other arguments of ${squash(call.text())}` };
  }
  if (timezoneArgument(paired) !== undefined) {
    return { status: "rejected", reason: "before_has_timezone_argument", detail: `the parent call ${paired.text()} already passes a time zone` };
  }
  const value = timezoneArgument(call);
  if (value === undefined || value.kind === "constant") {
    return { status: "rejected", reason: "timezone_is_constant", detail: `the time zone is the literal or runtime zone ${value?.text ?? "value"}` };
  }
  if (value.kind === "unresolved") {
    return { status: "rejected", reason: "timezone_unbound", detail: `no name supplies the time-zone value ${value.text}` };
  }
  if (!isBound(afterRoot, call, value.name)) {
    return { status: "rejected", reason: "timezone_unbound", detail: `${value.name} is not bound in ${path} or around it` };
  }
  return { status: "confirmed", before_call: paired.text(), before_line: paired.range().start.line + 1, timezone: value.name };
}

/** Every candidate-rule match whose time-zone argument the commit added, each with its confirmation outcome. */
export function examineFile(path: string, before: string, after: string, added: ReadonlySet<number>): FileMatch[] {
  const rule = candidateRule(path);
  const afterRoot = parse(Lang[rule.language], after).root();
  const matches = afterRoot.findAll(rule.config).filter((call) => addsTimezone(call, added));
  if (matches.length === 0) {
    return [];
  }
  const beforeRoot = parse(Lang[rule.language], before).root();
  return matches.map((call) => ({
    line: call.range().start.line + 1,
    call: call.text(),
    callee: calleeOf(call),
    function: functionPath(call),
    outcome: judge(beforeRoot, afterRoot, call),
  }));
}
