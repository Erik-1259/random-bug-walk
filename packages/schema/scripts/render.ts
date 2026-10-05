import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, three levels above this file. */
export const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SCHEMA_SOURCE = "packages/schema/schema/records.schema.json";
const COMMAND = "pnpm --filter @rbw/schema run generate";

export interface RenderedFile {
  /** Repository-relative path. */
  path: string;
  content: string;
}

type SchemaNode = Record<string, unknown>;

function isNode(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodes(value: unknown): SchemaNode[] {
  if (!Array.isArray(value)) throw new Error("expected an array of schemas");
  return value.map((item) => {
    if (!isNode(item)) throw new Error("expected a schema object");
    return item;
  });
}

function refName(node: SchemaNode): string | null {
  const ref = node.$ref;
  if (typeof ref !== "string") return null;
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) throw new Error(`unsupported $ref ${ref}`);
  return ref.slice(prefix.length);
}

function literal(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  throw new Error("unsupported literal");
}

function pyLiteral(value: unknown): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  return literal(value);
}

function constantName(defName: string): string {
  return `${defName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}_VALUES`;
}

/** Literal values of a string enum definition, or null when the definition is not one. */
function enumValues(node: SchemaNode): string[] | null {
  if (node.type !== "string" || !Array.isArray(node.enum)) return null;
  return node.enum.map((value) => {
    if (typeof value !== "string") throw new Error("enum values must be strings");
    return value;
  });
}

interface Language {
  ref(name: string): string;
  literalUnion(values: readonly unknown[]): string;
  union(parts: readonly string[]): string;
  array(item: string): string;
  primitive(type: string): string;
}

const typescript: Language = {
  ref: (name) => name,
  literalUnion: (values) => values.map(literal).join(" | "),
  union: (parts) => parts.join(" | "),
  array: (item) => (/^[A-Za-z0-9]+$/.test(item) ? `${item}[]` : `(${item})[]`),
  primitive: (type) => ({ string: "string", integer: "number", boolean: "boolean", null: "null" })[type] ?? fail(type),
};

const python: Language = {
  ref: (name) => name,
  literalUnion: (values) => `Literal[${values.map(pyLiteral).join(", ")}]`,
  union: (parts) => parts.join(" | "),
  array: (item) => `list[${item}]`,
  primitive: (type) => ({ string: "str", integer: "int", boolean: "bool", null: "None" })[type] ?? fail(type),
};

function fail(type: string): never {
  throw new Error(`unsupported type ${type}`);
}

/** Maps a property or alias schema to a type expression. Object schemas must be named definitions. */
function typeOf(node: SchemaNode, lang: Language): string {
  const name = refName(node);
  if (name !== null) return lang.ref(name);
  if ("const" in node) return lang.literalUnion([node.const]);
  if (Array.isArray(node.enum)) return lang.literalUnion(node.enum);
  if (node.anyOf !== undefined) return lang.union(nodes(node.anyOf).map((item) => typeOf(item, lang)));
  if (node.oneOf !== undefined) return lang.union(nodes(node.oneOf).map((item) => typeOf(item, lang)));
  if (node.type === "array") {
    if (!isNode(node.items)) throw new Error("arrays need items");
    return lang.array(typeOf(node.items, lang));
  }
  if (node.type === "object") throw new Error("inline objects are not supported; use a named definition");
  if (typeof node.type === "string") return lang.primitive(node.type);
  throw new Error("unsupported schema node");
}

function properties(node: SchemaNode): [string, SchemaNode][] {
  if (!isNode(node.properties)) throw new Error("object definitions need properties");
  const required = Array.isArray(node.required) ? node.required : [];
  const entries = Object.entries(node.properties).map(([key, value]): [string, SchemaNode] => {
    if (!isNode(value)) throw new Error("property schemas must be objects");
    return [key, value];
  });
  for (const [key] of entries) if (!required.includes(key)) throw new Error(`property ${key} must be required`);
  if (node.additionalProperties !== false) throw new Error("object definitions must forbid unknown fields");
  return entries;
}

function definitions(schema: SchemaNode): [string, SchemaNode][] {
  if (!isNode(schema.$defs)) throw new Error("schema needs $defs");
  return Object.entries(schema.$defs).map(([name, node]): [string, SchemaNode] => {
    if (!isNode(node)) throw new Error("definitions must be objects");
    return [name, node];
  });
}

function renderTypescript(schema: SchemaNode): string {
  const defs = definitions(schema);
  const lines = [
    `// Derived from ${SCHEMA_SOURCE}; regenerate with ${COMMAND}.`,
    "",
    `export const DEF_NAMES = [${defs.map(([name]) => JSON.stringify(name)).join(", ")}] as const;`,
    "export type DefName = (typeof DEF_NAMES)[number];",
  ];
  for (const [name, node] of defs) {
    lines.push("");
    const values = enumValues(node);
    if (values !== null) {
      const constant = constantName(name);
      lines.push(`export const ${constant} = [${values.map(literal).join(", ")}] as const;`);
      lines.push(`export type ${name} = (typeof ${constant})[number];`);
    } else if (node.type === "object") {
      lines.push(`export interface ${name} {`);
      for (const [key, value] of properties(node)) lines.push(`  ${key}: ${typeOf(value, typescript)};`);
      lines.push("}");
    } else {
      lines.push(`export type ${name} = ${typeOf(node, typescript)};`);
    }
  }
  lines.push("", "/** Maps each definition name to its type. */", "export interface DefTypes {");
  for (const [name] of defs) lines.push(`  ${name}: ${name};`);
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

// One value per line with a trailing comma, which ruff keeps; a single value stays on one line.
function pyLiteralBlock(values: readonly string[]): string {
  if (values.length === 1) return `[${JSON.stringify(values[0])}]`;
  return `[\n${values.map((value) => `    ${JSON.stringify(value)},\n`).join("")}]`;
}

function pyTuple(values: readonly string[]): string {
  if (values.length === 1) return `(${JSON.stringify(values[0])},)`;
  return `(\n${values.map((value) => `    ${JSON.stringify(value)},\n`).join("")})`;
}

function renderPython(schema: SchemaNode): string {
  const defs = definitions(schema);
  const lines = [
    `# Derived from ${SCHEMA_SOURCE};`,
    `# regenerate with ${COMMAND}.`,
    "",
    "from __future__ import annotations",
    "",
    "from typing import Final, Literal, TypedDict",
    "",
    `DEF_NAMES: Final = ${pyTuple(defs.map(([name]) => name))}`,
  ];
  for (const [name, node] of defs) {
    const values = enumValues(node);
    if (values !== null) {
      lines.push("", `type ${name} = Literal${pyLiteralBlock(values)}`);
      lines.push(`${constantName(name)}: Final = ${pyTuple(values)}`);
    } else if (node.type === "object") {
      lines.push("", "", `class ${name}(TypedDict):`);
      for (const [key, value] of properties(node)) lines.push(`    ${key}: ${typeOf(value, python)}`);
      lines.push("");
    } else {
      lines.push("", `type ${name} = ${typeOf(node, python)}`);
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n\n").replace(/\n+$/, "")}\n`;
}

/** Renders every derived file from the schema source text. */
export function renderGenerated(schemaText: string): RenderedFile[] {
  const schema: unknown = JSON.parse(schemaText);
  if (!isNode(schema)) throw new Error("schema must be an object");
  return [
    { path: "packages/schema/src/generated.ts", content: renderTypescript(schema) },
    { path: "python/schema/src/rbw_schema/generated.py", content: renderPython(schema) },
    { path: "python/schema/src/rbw_schema/records.schema.json", content: schemaText },
  ];
}

export function readSchemaSource(): string {
  return readFileSync(join(repositoryRoot, SCHEMA_SOURCE), "utf8");
}
