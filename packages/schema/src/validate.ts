import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { CanonicalError, canonicalDigest, encodeCanonical, parseCanonical } from "./canonical.ts";
import type { DefName, DefTypes, ProjectPolicy, RootRun } from "./generated.ts";
import { DEF_NAMES } from "./generated.ts";
import { checkRules } from "./rules.ts";

const schemaBytes = readFileSync(new URL("../schema/records.schema.json", import.meta.url));
const schema = parseCanonical(schemaBytes) as { $id: string };

// Offsets of year, month, day, hour, minute and second in a UtcTime string.
const UTC_TIME_FIELDS = [[0, 4], [5, 7], [8, 10], [11, 13], [14, 16], [17, 19]] as const;

/**
 * Calendar check for UtcTime. The schema pattern alone checks the shape; this reads the fields
 * at their fixed offsets and returns false when one is not a number.
 */
export function isUtcTime(value: string): boolean {
  const fields = UTC_TIME_FIELDS.map(([start, end]) => value.slice(start, end));
  if (fields.some((field) => !/^[0-9]+$/.test(field))) return false;
  const [year, month, day, hour, minute, second] = fields.map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

// unicodeRegExp compiles every pattern with the "u" flag; patterns are anchored, so JavaScript
// and Python's re.fullmatch agree on them.
const ajv = new Ajv2020({ strict: true, allErrors: true, unicodeRegExp: true });
ajv.addFormat("rbw-utc-time", { type: "string", validate: isUtcTime });
ajv.addSchema(schema);

const validators = new Map<DefName, ValidateFunction>();

function validatorFor(type: DefName): ValidateFunction {
  let validator = validators.get(type);
  if (validator === undefined) {
    validator = ajv.getSchema(`${schema.$id}#/$defs/${type}`);
    if (validator === undefined) throw new Error(`no schema definition ${type}`);
    validators.set(type, validator);
  }
  return validator;
}

export function isDefName(value: string): value is DefName {
  return (DEF_NAMES as readonly string[]).includes(value);
}

/** Records a value may be checked against: its policy, its root, or the policy it succeeds. */
export interface RecordContext {
  policy?: ProjectPolicy;
  root?: RootRun;
  previous?: ProjectPolicy;
}

/** Returns error codes; an empty list means the value is valid. */
export function validateRecord(type: DefName, value: unknown, context: RecordContext = {}): string[] {
  try {
    encodeCanonical(value);
  } catch (error) {
    if (error instanceof CanonicalError) return ["canonical"];
    throw error;
  }
  const validator = validatorFor(type);
  if (!validator(value)) {
    return (validator.errors ?? []).map((error) => `schema:${error.instancePath || "/"}:${error.keyword}`);
  }
  return checkRules(type, value, context);
}

export class RecordError extends Error {
  readonly errors: readonly string[];

  constructor(type: string, errors: readonly string[]) {
    super(`invalid ${type}: ${errors.join(", ")}`);
    this.name = "RecordError";
    this.errors = errors;
  }
}

/** Validates and narrows a value; throws RecordError when invalid. */
export function assertRecord<K extends DefName>(type: K, value: unknown, context: RecordContext = {}): DefTypes[K] {
  const errors = validateRecord(type, value, context);
  if (errors.length > 0) throw new RecordError(type, errors);
  return value as DefTypes[K];
}

/** Strictly parses bytes as canonical JSON input and validates the record. */
export function parseRecord<K extends DefName>(type: K, bytes: Uint8Array, context: RecordContext = {}): DefTypes[K] {
  let value: unknown;
  try {
    value = parseCanonical(bytes);
  } catch (error) {
    if (error instanceof CanonicalError) throw new RecordError(type, ["canonical"]);
    throw error;
  }
  return assertRecord(type, value, context);
}

/** SHA-256 of a policy's canonical bytes. */
export function policySha256(policy: ProjectPolicy): string {
  return canonicalDigest(policy).sha256;
}
