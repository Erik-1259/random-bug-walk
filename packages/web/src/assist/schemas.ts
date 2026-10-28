// JSON schemas of the bug designer: the request bodies its routes take, and the answers its model calls
// must give. Ajv checks both with every size limit; the model is sent its schema without the size
// keywords (wireSchema), since not every structured-output backend supports them, so a too-long answer
// is caught here instead.
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { BUG_TYPE_ID_VALUES, HOST_ID_VALUES } from "@rbw/factory-contract";
import type { BugTypeId, HostId } from "@rbw/factory-contract";
import {
  QUERY_MAX_CHARS,
  SHAPE_MAX_SOURCES,
  SHAPE_SUMMARY_MAX_CHARS,
  SHAPE_TITLE_MAX_CHARS,
  SOURCE_TITLE_MAX_CHARS,
  SOURCE_URL_MAX_CHARS,
} from "./limits.ts";

type Schema = Record<string, unknown>;

const text = (maxLength: number, minLength = 1): Schema => ({ type: "string", minLength, maxLength });
const object = (properties: Record<string, Schema>, extra = false): Schema => ({ type: "object", additionalProperties: extra, required: Object.keys(properties), properties });

/** "none" when no proven catalog pair fits; the route turns it into fit null. */
const FIT_HOSTS = [...HOST_ID_VALUES, "none"] as const;
const FIT_TYPES = [...BUG_TYPE_ID_VALUES, "none"] as const;

const MODEL_SCHEMAS = {
  bug_shapes: object({
    in_scope: { type: "boolean" },
    shapes: {
      type: "array",
      maxItems: 5,
      items: object({
        title: text(160),
        summary: text(900),
        source_numbers: { type: "array", maxItems: SHAPE_MAX_SOURCES, items: { type: "integer", minimum: 1, maximum: 50 } },
        fit_host_id: { type: "string", enum: FIT_HOSTS },
        fit_bug_type_id: { type: "string", enum: FIT_TYPES },
        fit_phrase: text(200, 0),
        fit_reason: text(400, 0),
      }),
    },
  }),
  bug_spec: object({
    in_scope: { type: "boolean" },
    title: text(160),
    where: text(800),
    change: text(1500),
    why_tests_miss: text(1200),
    checks_to_add: { type: "array", minItems: 1, maxItems: 6, items: text(400) },
    fix: text(1200),
  }),
  delivery_brief: object({
    what_it_is: text(1200),
    how_to_run: text(1500),
    how_to_validate: text(1500),
  }),
} as const;

export type ModelSchemaName = keyof typeof MODEL_SCHEMAS;

export interface ModelOutputs {
  bug_shapes: {
    in_scope: boolean;
    shapes: {
      title: string;
      summary: string;
      source_numbers: number[];
      fit_host_id: HostId | "none";
      fit_bug_type_id: BugTypeId | "none";
      fit_phrase: string;
      fit_reason: string;
    }[];
  };
  bug_spec: { in_scope: boolean; title: string; where: string; change: string; why_tests_miss: string; checks_to_add: string[]; fix: string };
  delivery_brief: { what_it_is: string; how_to_run: string; how_to_validate: string };
}

const source = object({ title: text(SOURCE_TITLE_MAX_CHARS), url: { type: "string", minLength: 1, maxLength: SOURCE_URL_MAX_CHARS, pattern: "^https?://" } }, true);

const BODY_SCHEMAS = {
  "bug-shapes": object({ query: text(QUERY_MAX_CHARS, 0) }),
  "bug-spec": object({
    // The page may send the whole shape it was shown; only these fields are read.
    shape: object({ title: text(SHAPE_TITLE_MAX_CHARS), summary: text(SHAPE_SUMMARY_MAX_CHARS), sources: { type: "array", maxItems: SHAPE_MAX_SOURCES, items: source } }, true),
    host_id: { type: "string", enum: HOST_ID_VALUES },
  }),
  "delivery-brief": object({
    request_id: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
    case_id: { type: "string", pattern: "^[0-9a-f]{64}$" },
  }),
} as const;

export type BodySchemaName = keyof typeof BODY_SCHEMAS;

export interface Bodies {
  "bug-shapes": { query: string };
  "bug-spec": { shape: { title: string; summary: string; sources: { title: string; url: string }[] }; host_id: HostId };
  "delivery-brief": { request_id: string; case_id: string };
}

const ajv = new Ajv2020({ strict: true, allErrors: true, unicodeRegExp: true });
const modelValidators = new Map<string, ValidateFunction>(Object.entries(MODEL_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]));
const bodyValidators = new Map<string, ValidateFunction>(Object.entries(BODY_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]));

function messages(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`);
}

function run(validators: Map<string, ValidateFunction>, name: string, value: unknown): string[] {
  const validate = validators.get(name);
  if (validate === undefined) throw new Error(`no schema ${name}`);
  return validate(value) ? [] : messages(validate.errors);
}

export function validateModelOutput(name: ModelSchemaName, value: unknown): string[] {
  return run(modelValidators, name, value);
}

export function validateBody(name: BodySchemaName, value: unknown): string[] {
  return run(bodyValidators, name, value);
}

const SIZE_KEYWORDS = new Set(["minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum"]);

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SIZE_KEYWORDS.has(key)).map(([key, item]) => [key, strip(item)]));
}

/** The schema sent with a model call: the checked one without its size keywords. */
export function wireSchema(name: ModelSchemaName): unknown {
  return strip(MODEL_SCHEMAS[name]);
}
