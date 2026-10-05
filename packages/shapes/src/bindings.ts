// Scope helpers over ast-grep nodes: where a name is bound inside a function, and which
// function encloses a node. Binding checks count every site that declares or assigns the name,
// so a shadowing or reassignment anywhere in the function makes a check fail closed.
import type { SgNode } from "@ast-grep/napi";

const FUNCTION_KINDS = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "generator_function_declaration",
  "generator_function",
]);

// Parent kind -> the fields of that parent in which an identifier is a binding or a write.
const BINDING_FIELDS: Readonly<Partial<Record<string, readonly string[]>>> = {
  variable_declarator: ["name"],
  required_parameter: ["pattern"],
  optional_parameter: ["pattern"],
  pair_pattern: ["value"],
  assignment_pattern: ["left"],
  object_assignment_pattern: ["left"],
  assignment_expression: ["left"],
  augmented_assignment_expression: ["left"],
  update_expression: ["argument"],
  function_declaration: ["name"],
  function_expression: ["name"],
  generator_function_declaration: ["name"],
  class_declaration: ["name"],
  arrow_function: ["parameter"],
  catch_clause: ["parameter"],
  for_in_statement: ["left"],
};

// Parent kinds whose identifier children are bindings regardless of field.
const BINDING_CONTAINERS = new Set(["array_pattern", "rest_pattern"]);

/**
 * The first child in a tree-sitter field. The napi typings resolve field names only for typed
 * grammars, so untyped nodes go through this one structural view.
 */
export function fieldOf(node: SgNode | null | undefined, name: string): SgNode | null {
  if (node === null || node === undefined) {
    return null;
  }
  return (node as unknown as { field(name: string): SgNode | null }).field(name);
}

export function kindOf(node: SgNode | null | undefined): string | undefined {
  return node === null || node === undefined ? undefined : String(node.kind());
}

function sameNode(a: SgNode | null | undefined, b: SgNode): boolean {
  return a?.id() === b.id();
}

function isBindingIdentifier(node: SgNode): boolean {
  const parent = node.parent();
  const kind = kindOf(parent);
  if (parent === null || kind === undefined) {
    return false;
  }
  if (BINDING_CONTAINERS.has(kind)) {
    return true;
  }
  return (BINDING_FIELDS[kind] ?? []).some((field) => sameNode(fieldOf(parent, field), node));
}

/** Every node in `scope` that binds, assigns or updates `name`, in source order. */
export function bindingSites(scope: SgNode, name: string): SgNode[] {
  const shorthand = scope.findAll({ rule: { kind: "shorthand_property_identifier_pattern", regex: `^${name}$` } });
  const identifiers = scope.findAll({ rule: { kind: "identifier", regex: `^${name}$` } }).filter(isBindingIdentifier);
  return [...shorthand, ...identifiers].sort((a, b) => a.range().start.index - b.range().start.index);
}

export function enclosingFunction(node: SgNode): SgNode | undefined {
  return node.ancestors().find((ancestor) => FUNCTION_KINDS.has(kindOf(ancestor) ?? ""));
}

export function functionName(node: SgNode): string | undefined {
  return fieldOf(node, "name")?.text();
}

/** 1-based line of a node's first character. */
export function lineOf(node: SgNode): number {
  return node.range().start.line + 1;
}

/**
 * The variable declarator that destructures `name` under the same key in a const declaration,
 * as in `const { name } = value` or `const { name = fallback } = value`, or undefined.
 */
export function destructuringDeclarator(site: SgNode, name: string): SgNode | undefined {
  if (kindOf(site) !== "shorthand_property_identifier_pattern" || site.text() !== name) {
    return undefined;
  }
  const parent = site.parent();
  const property = kindOf(parent) === "object_assignment_pattern" && sameNode(fieldOf(parent, "left"), site) ? parent : site;
  const pattern = property?.parent();
  const declarator = pattern?.parent();
  if (kindOf(pattern) !== "object_pattern" || kindOf(declarator) !== "variable_declarator" || !pattern || !declarator) {
    return undefined;
  }
  if (!sameNode(fieldOf(declarator, "name"), pattern)) {
    return undefined;
  }
  const declaration = declarator.parent();
  if (kindOf(declaration) !== "lexical_declaration" || declaration?.child(0)?.text() !== "const") {
    return undefined;
  }
  return declarator;
}
