// Runtime validators for the shape badge route's request and answer (docs/otf/SPEC.md section 8.11).
// They follow schemas.ts: the same Ajv options (strict, every error, Unicode regular expressions, so
// lengths count code points), the same plain-text rule as OtfOpenRule.observable_failure, the same
// model token, and unknown members refused everywhere. schemas.ts keeps those helpers private, so the
// few lines are repeated here instead of editing it; the tests check both files agree.
//
// The answer depends on its request: every index appears exactly once for the request's shapes, and
// a proven badge may only name a proven criterion of the request's host. So validateShapeBadges takes
// the request, and one schema is compiled per host and shape count.
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { OTF_HOST_IDS, OTF_OPEN_FAMILIES, type OtfHostId } from "./contract.ts";
import {
  SHAPE_BADGES_MAX_SHAPES,
  SHAPE_BADGES_MIN_SHAPES,
  SHAPE_BADGES_QUERY_MAX_CHARS,
  SHAPE_BADGES_QUERY_MIN_CHARS,
  SHAPE_BADGES_SUMMARY_MAX_CHARS,
  SHAPE_BADGES_TITLE_MAX_CHARS,
  SHAPE_PROVEN_BY_HOST,
  SHAPE_REASON_MAX_CHARS,
  SHAPE_REASON_MIN_CHARS,
  SHAPE_REFUSAL_KINDS,
  TRANSLATED_FAILURE_MAX_CHARS,
  TRANSLATED_FAILURE_MIN_CHARS,
  provenFamily,
  type OtfShapeBadges,
  type OtfShapeBadgesRequest,
} from "./shape-badges-contract.ts";

type Schema = Record<string, unknown>;

const text = (maxLength: number, minLength = 1): Schema => ({ type: "string", minLength, maxLength });
/** As schemas.ts: no \p{Cc}, \p{Zl}, \p{Zp} or \p{Cf} characters. */
const plainText = (maxLength: number, minLength = 1): Schema => ({ ...text(maxLength, minLength), pattern: "^[^\\p{Cc}\\p{Zl}\\p{Zp}\\p{Cf}]*$" });
const object = (properties: Record<string, Schema>): Schema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const NULL: Schema = { type: "null" };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, NULL] });
/** The model token of schemas.ts (TOKEN()). */
const MODEL: Schema = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$" };

const REQUEST: Schema = object({
  query: text(SHAPE_BADGES_QUERY_MAX_CHARS, SHAPE_BADGES_QUERY_MIN_CHARS),
  host_id: { enum: [...OTF_HOST_IDS] },
  shapes: {
    type: "array",
    minItems: SHAPE_BADGES_MIN_SHAPES,
    maxItems: SHAPE_BADGES_MAX_SHAPES,
    items: object({ title: text(SHAPE_BADGES_TITLE_MAX_CHARS), summary: text(SHAPE_BADGES_SUMMARY_MAX_CHARS) }),
  },
});

/** The answer for a request on `host` with `shapes` shapes: one branch per outcome (and per proven criterion), each index once. */
function badgesSchema(host: OtfHostId, shapes: number): Schema {
  const index: Schema = { type: "integer", minimum: 0, maximum: shapes - 1 };
  const proven = SHAPE_PROVEN_BY_HOST[host].map((criterion) =>
    object({
      index,
      outcome: { const: "proven" },
      proven_criterion_id: { const: criterion },
      family: { const: provenFamily(criterion) },
      translated_failure: NULL,
      refusal_kind: NULL,
      reason: NULL,
    }),
  );
  const open = object({
    index,
    outcome: { const: "open" },
    proven_criterion_id: NULL,
    family: { enum: [...OTF_OPEN_FAMILIES] },
    translated_failure: nullable(plainText(TRANSLATED_FAILURE_MAX_CHARS, TRANSLATED_FAILURE_MIN_CHARS)),
    refusal_kind: NULL,
    reason: NULL,
  });
  const refused = object({
    index,
    outcome: { const: "refused" },
    proven_criterion_id: NULL,
    family: NULL,
    translated_failure: NULL,
    refusal_kind: { enum: [...SHAPE_REFUSAL_KINDS] },
    reason: plainText(SHAPE_REASON_MAX_CHARS, SHAPE_REASON_MIN_CHARS),
  });
  return object({
    badges: {
      type: "array",
      minItems: shapes,
      maxItems: shapes,
      items: { oneOf: [...proven, open, refused] },
      allOf: Array.from({ length: shapes }, (_, i) => ({
        contains: { type: "object", properties: { index: { const: i } }, required: ["index"] },
        minContains: 1,
        maxContains: 1,
      })),
    },
    model: MODEL,
  });
}

const ajv = new Ajv2020({ strict: true, allErrors: true, unicodeRegExp: true });
const requestValidator = ajv.compile(REQUEST);
const badgeValidators = new Map<string, ValidateFunction>();
for (const host of OTF_HOST_IDS) {
  for (let count = SHAPE_BADGES_MIN_SHAPES; count <= SHAPE_BADGES_MAX_SHAPES; count += 1) {
    badgeValidators.set(`${host}/${String(count)}`, ajv.compile(badgesSchema(host, count)));
  }
}

function messages(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`);
}

/** The schema errors of a classify-shapes request body; empty when it matches. */
export function validateShapeBadgesRequest(value: unknown): string[] {
  return requestValidator(value) ? [] : messages(requestValidator.errors);
}

/** The parsed request when it matches, or the errors. */
export function parseShapeBadgesRequest(value: unknown): { ok: true; value: OtfShapeBadgesRequest } | { ok: false; errors: string[] } {
  const errors = validateShapeBadgesRequest(value);
  return errors.length === 0 ? { ok: true, value: value as OtfShapeBadgesRequest } : { ok: false, errors };
}

/** What the answer is checked against: the request's host and its shapes (only their count is read). */
export interface ShapeBadgesContext {
  host_id: OtfHostId;
  shapes: readonly unknown[];
}

/**
 * The schema errors of a classify-shapes answer for this request; empty when it matches. A request
 * outside the host list or the shape count limits answers an error too, so the answer is never
 * trusted without its request.
 */
export function validateShapeBadges(value: unknown, request: ShapeBadgesContext): string[] {
  const validate = badgeValidators.get(`${request.host_id}/${String(request.shapes.length)}`);
  if (validate === undefined) return [`/ no shape badge schema for host ${request.host_id} with ${String(request.shapes.length)} shapes`];
  return validate(value) ? [] : messages(validate.errors);
}

/** The parsed answer when it matches its request, or the errors. */
export function parseShapeBadges(value: unknown, request: ShapeBadgesContext): { ok: true; value: OtfShapeBadges } | { ok: false; errors: string[] } {
  const errors = validateShapeBadges(value, request);
  return errors.length === 0 ? { ok: true, value: value as OtfShapeBadges } : { ok: false, errors };
}
