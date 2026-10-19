// Server and tests only: reads the schema file at load time and compiles it with Ajv.
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { isUtcTime } from "@rbw/schema";
import type { DefName, DefTypes } from "./generated.ts";
import { DEF_NAMES } from "./generated.ts";

const schemaText = readFileSync(new URL("../schema/bug-request-v1.schema.json", import.meta.url), "utf8");
const schema = JSON.parse(schemaText) as { $id: string };

// unicodeRegExp compiles every pattern with the "u" flag. The discriminator keyword makes Ajv check
// an Event against the one variant its type names, so errors point at that variant only.
const ajv = new Ajv2020({ strict: true, allErrors: true, unicodeRegExp: true, discriminator: true });
ajv.addFormat("rbw-utc-time", { type: "string", validate: isUtcTime });
ajv.addSchema(schema);

const validators = new Map<DefName, ValidateFunction>();

function validatorFor(name: DefName): ValidateFunction {
  let validator = validators.get(name);
  if (validator === undefined) {
    validator = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
    if (validator === undefined) throw new Error(`no schema definition ${name}`);
    validators.set(name, validator);
  }
  return validator;
}

export function isDefName(value: string): value is DefName {
  return (DEF_NAMES as readonly string[]).includes(value);
}

/** `schema:<instance path>:<keyword>`, with the field name for unknown and missing fields. */
function errorCode(error: ErrorObject): string {
  const base = `schema:${error.instancePath || "/"}:${error.keyword}`;
  const params = error.params as { additionalProperty?: unknown; missingProperty?: unknown };
  const field = error.keyword === "additionalProperties" ? params.additionalProperty
    : error.keyword === "required" ? params.missingProperty
    : undefined;
  return typeof field === "string" ? `${base}:${field}` : base;
}

/** Returns error codes; an empty list means the value is a valid instance of the definition. */
export function validateContract(name: DefName, value: unknown): string[] {
  const validator = validatorFor(name);
  if (validator(value)) return [];
  return (validator.errors ?? []).map(errorCode);
}

export class ContractError extends Error {
  readonly errors: readonly string[];

  constructor(name: string, errors: readonly string[]) {
    super(`invalid ${name}: ${errors.join(", ")}`);
    this.name = "ContractError";
    this.errors = errors;
  }
}

/** Validates and narrows a value; throws ContractError when it is invalid. */
export function assertContract<K extends DefName>(name: K, value: unknown): DefTypes[K] {
  const errors = validateContract(name, value);
  if (errors.length > 0) throw new ContractError(name, errors);
  return value as DefTypes[K];
}

/** Parses JSON text and validates it; throws ContractError (code `json`) when the text is not JSON. */
export function parseContract<K extends DefName>(name: K, text: string): DefTypes[K] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ContractError(name, ["json"]);
    throw error;
  }
  return assertContract(name, value);
}
