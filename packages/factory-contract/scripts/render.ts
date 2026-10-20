import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, three levels above this file. */
export const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SCHEMA_SOURCE = "packages/factory-contract/schema/bug-request-v1.schema.json";
export const GENERATED_PATH = "packages/factory-contract/src/generated.ts";
const COMMAND = "pnpm --filter @rbw/factory-contract run generate";

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

function literal(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  throw new Error("unsupported literal");
}

/** `SupportStatus` becomes `SUPPORT_STATUS_VALUES`. */
export function constantName(defName: string): string {
  return `${defName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}_VALUES`;
}

/** Literal values of a string enum definition, or null when the definition is not one. */
export function enumValues(node: SchemaNode): string[] | null {
  if (node.type !== "string" || !Array.isArray(node.enum)) return null;
  return node.enum.map((value) => {
    if (typeof value !== "string") throw new Error("enum values must be strings");
    return value;
  });
}

const PRIMITIVES: Record<string, string> = { string: "string", integer: "number", boolean: "boolean", null: "null" };

/** One TSDoc line from a schema description; `*\/` is escaped so the comment cannot end early. */
function doc(node: SchemaNode, indent: string): string[] {
  const description = node.description;
  if (typeof description !== "string") return [];
  return [`${indent}/** ${description.replaceAll("*/", "*\\/")} */`];
}

function definitions(schema: SchemaNode): [string, SchemaNode][] {
  if (!isNode(schema.$defs)) throw new Error("schema needs $defs");
  return Object.entries(schema.$defs).map(([name, node]): [string, SchemaNode] => {
    if (!isNode(node)) throw new Error("definitions must be objects");
    return [name, node];
  });
}

/** Maps a property or alias schema to a type expression. Object schemas must be named definitions. */
function typeOf(node: SchemaNode, names: ReadonlySet<string>): string {
  if (typeof node.$ref === "string") {
    const prefix = "#/$defs/";
    const name = node.$ref.startsWith(prefix) ? node.$ref.slice(prefix.length) : null;
    if (name === null || !names.has(name)) throw new Error(`unsupported $ref ${node.$ref}`);
    return name;
  }
  if ("const" in node) return literal(node.const);
  if (Array.isArray(node.enum)) return node.enum.map(literal).join(" | ");
  const members = node.anyOf ?? node.oneOf;
  if (members !== undefined) return nodes(members).map((item) => typeOf(item, names)).join(" | ");
  if (node.type === "array") {
    if (!isNode(node.items)) throw new Error("arrays need items");
    const item = typeOf(node.items, names);
    return /^[A-Za-z0-9]+$/.test(item) ? `${item}[]` : `(${item})[]`;
  }
  if (node.type === "object") throw new Error("inline objects are not supported; use a named definition");
  const primitive = typeof node.type === "string" ? PRIMITIVES[node.type] : undefined;
  if (primitive === undefined) throw new Error("unsupported schema node");
  return primitive;
}

function properties(name: string, node: SchemaNode): [string, SchemaNode][] {
  if (!isNode(node.properties)) throw new Error(`${name} needs properties`);
  const required = Array.isArray(node.required) ? node.required : [];
  const entries = Object.entries(node.properties).map(([key, value]): [string, SchemaNode] => {
    if (!isNode(value)) throw new Error("property schemas must be objects");
    return [key, value];
  });
  for (const [key] of entries) if (!required.includes(key)) throw new Error(`${name}.${key} must be required`);
  if (required.length !== entries.length) throw new Error(`${name} requires a field it does not define`);
  if (node.additionalProperties !== false) throw new Error(`${name} must forbid unknown fields`);
  return entries;
}

/** Renders src/generated.ts from the schema source text: types, enum value lists, DEF_NAMES and DefTypes. */
export function renderTypescript(schemaText: string): string {
  const schema: unknown = JSON.parse(schemaText);
  if (!isNode(schema)) throw new Error("schema must be an object");
  const defs = definitions(schema);
  const names = new Set(defs.map(([name]) => name));
  const lines = [
    `// Derived from ${SCHEMA_SOURCE}; regenerate with ${COMMAND}.`,
    "// Types and value lists only, with no imports, so client components can import this file.",
    "",
    "export const DEF_NAMES = [",
    ...defs.map(([name]) => `  ${JSON.stringify(name)},`),
    "] as const;",
    "export type DefName = (typeof DEF_NAMES)[number];",
  ];
  for (const [name, node] of defs) {
    lines.push("", ...doc(node, ""));
    const values = enumValues(node);
    if (values !== null) {
      const constant = constantName(name);
      lines.push(`export const ${constant} = [${values.map(literal).join(", ")}] as const;`);
      lines.push(`export type ${name} = (typeof ${constant})[number];`);
    } else if (node.type === "object" && node.properties !== undefined) {
      const entries = properties(name, node);
      if (entries.length === 0) {
        lines.push(`export type ${name} = Record<string, never>;`);
        continue;
      }
      lines.push(`export interface ${name} {`);
      for (const [key, value] of entries) lines.push(...doc(value, "  "), `  ${key}: ${typeOf(value, names)};`);
      lines.push("}");
    } else {
      lines.push(`export type ${name} = ${typeOf(node, names)};`);
    }
  }
  lines.push("", "/** Maps each definition name to its type. */", "export interface DefTypes {");
  for (const [name] of defs) lines.push(`  ${name}: ${name};`);
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function readSchemaSource(): string {
  return readFileSync(join(repositoryRoot, SCHEMA_SOURCE), "utf8");
}
