// Shape badges: the bug designer shows 3 to 5 shapes after a search, and with badges on each shape
// gets a badge saying whether and how it can be built as an on-the-fly custom bug, before the judge
// writes a card. One classifier call answers for every shape; the card-level classify route stays
// the final check. docs/otf/SPEC.md section 8.12 explains the behavior around these types.
//
// This module holds types, constants, the badge copy and small pure helpers (the copy formatter and
// the display order) only, so the browser bundle can import it. The validators live in
// shape-badges-schemas.ts. It adds to contract.ts without editing it.
import { QUERY_MAX_CHARS, SHAPE_SUMMARY_MAX_CHARS, SHAPE_TITLE_MAX_CHARS } from "../assist/limits.ts";
import {
  OTF_CLASSIFY_REFUSAL_KINDS,
  OTF_HOST_IDS,
  criteriaOf,
  isProvenCriterion,
  type OtfClassifyRefusalKind,
  type OtfErrorCode,
  type OtfHostId,
  type OtfOpenFamily,
  type ProvenCriterionId,
} from "./contract.ts";

/** POST /api/factory/otf/classify-shapes: signed-in judges only, one unit of the designer's bug-spec budget per call. */
export const OTF_CLASSIFY_SHAPES_PATH = "/api/factory/otf/classify-shapes";

/** The flag that turns badges on ("1"); badges also need RBW_OTF_OPEN_BEHAVIORS=1. */
export const OTF_SHAPE_BADGES_FLAG = "RBW_OTF_SHAPE_BADGES";

// ---- limits. Every length counts Unicode code points (as Ajv does); a UI counts with [...text].length.

/** The designer query: 1 to QUERY_MAX_CHARS (300), the designer's own query cap. */
export const SHAPE_BADGES_QUERY_MIN_CHARS = 1;
export const SHAPE_BADGES_QUERY_MAX_CHARS = QUERY_MAX_CHARS;
/** A shape's title and summary: the designer's shape caps (200 and 1200). */
export const SHAPE_BADGES_TITLE_MAX_CHARS = SHAPE_TITLE_MAX_CHARS;
export const SHAPE_BADGES_SUMMARY_MAX_CHARS = SHAPE_SUMMARY_MAX_CHARS;
/** Shapes per request. */
export const SHAPE_BADGES_MIN_SHAPES = 1;
export const SHAPE_BADGES_MAX_SHAPES = 5;
/** An open badge's translated_failure: one plain-text sentence. */
export const TRANSLATED_FAILURE_MIN_CHARS = 20;
export const TRANSLATED_FAILURE_MAX_CHARS = 200;
/** A refused badge's reason: one plain-text sentence. */
export const SHAPE_REASON_MIN_CHARS = 1;
export const SHAPE_REASON_MAX_CHARS = 160;

// ---- outcomes, refusal kinds and the proven ids each host may name

export const SHAPE_BADGE_OUTCOMES = ["proven", "open", "refused"] as const;
export type ShapeBadgeOutcome = (typeof SHAPE_BADGE_OUTCOMES)[number];

/** The same kinds as the classify route's refusal. */
export const SHAPE_REFUSAL_KINDS = OTF_CLASSIFY_REFUSAL_KINDS;
export type ShapeRefusalKind = OtfClassifyRefusalKind;

/**
 * The proven criteria a badge may name for a search on each host: task-report, the two concurrency
 * criteria; Umami, time-zone grouping only (CRITERION_HOST decides).
 */
export const SHAPE_PROVEN_BY_HOST: Readonly<Record<OtfHostId, readonly ProvenCriterionId[]>> = Object.freeze(
  Object.fromEntries(OTF_HOST_IDS.map((host) => [host, Object.freeze(criteriaOf(host).filter(isProvenCriterion))])) as Record<OtfHostId, readonly ProvenCriterionId[]>,
);

/** The family a proven criterion belongs to (the part of its id before the dot); a proven badge names it. */
export function provenFamily(id: ProvenCriterionId): OtfOpenFamily {
  return id.slice(0, id.indexOf(".")) as OtfOpenFamily;
}

/** The error codes the route answers with, in the shared OtfErrorBody. Only unavailable is retryable. */
export const OTF_SHAPE_BADGES_ERRORS = ["signed_out", "invalid_request", "unavailable"] as const satisfies readonly OtfErrorCode[];

// ---- bodies

export interface OtfShapeInput {
  /** 1..SHAPE_BADGES_TITLE_MAX_CHARS code points. */
  title: string;
  /** 1..SHAPE_BADGES_SUMMARY_MAX_CHARS code points. */
  summary: string;
}

/** POST OTF_CLASSIFY_SHAPES_PATH. Unknown members are refused. */
export interface OtfShapeBadgesRequest {
  /** The designer query, SHAPE_BADGES_QUERY_MIN_CHARS..SHAPE_BADGES_QUERY_MAX_CHARS code points. */
  query: string;
  /** The app the judge chose in the designer. */
  host_id: OtfHostId;
  /** SHAPE_BADGES_MIN_SHAPES..SHAPE_BADGES_MAX_SHAPES shapes, in the designer's order. */
  shapes: OtfShapeInput[];
}

/**
 * One shape's badge. index points into the request's shapes, and every index appears exactly once.
 * Which members are set follows the outcome (the validator enforces it):
 * - proven: proven_criterion_id is one of SHAPE_PROVEN_BY_HOST[host_id] and family is its family;
 * - open: family is set; translated_failure is one plain-text sentence, or null when the server has none;
 * - refused: refusal_kind and reason are set; everything else is null.
 */
export type OtfShapeBadge =
  | {
      index: number;
      outcome: "proven";
      proven_criterion_id: ProvenCriterionId;
      family: OtfOpenFamily;
      translated_failure: null;
      refusal_kind: null;
      reason: null;
    }
  | {
      index: number;
      outcome: "open";
      proven_criterion_id: null;
      family: OtfOpenFamily;
      /**
       * TRANSLATED_FAILURE_MIN_CHARS..TRANSLATED_FAILURE_MAX_CHARS code points of plain text: the
       * user-visible failure as it would appear in the task-report service (an Umami search's
       * failure translated into task-report terms), or null.
       */
      translated_failure: string | null;
      refusal_kind: null;
      reason: null;
    }
  | {
      index: number;
      outcome: "refused";
      proven_criterion_id: null;
      family: null;
      translated_failure: null;
      refusal_kind: ShapeRefusalKind;
      /** SHAPE_REASON_MIN_CHARS..SHAPE_REASON_MAX_CHARS code points of plain text. */
      reason: string;
    };

/** The route's 200 answer. Unknown members are refused. */
export interface OtfShapeBadges {
  badges: OtfShapeBadge[];
  /** The classifier model. */
  model: string;
}

// ---- badge copy (exact strings)

/**
 * The badge copy. {label} is the behavior's label from availability, {translated_failure} the open
 * badge's sentence (inside typographic quotes) and {reason} the refusal's reason. A proven headline
 * is followed by the existing typical-time line for that behavior, which the UI renders itself.
 */
export const SHAPE_BADGE_COPY = Object.freeze({
  loading: "Checking what can be built…",
  proven_umami: "Builds in Umami as a proven behavior: {label}",
  proven_task_report: "Builds as a proven behavior: {label}",
  open_task_report: "Builds in the task-report service",
  open_umami: "Builds in the task-report service, not Umami",
  open_detail: "Builds in the task-report service as: “{translated_failure}”. Not measured yet.",
  open_umami_fallback_detail:
    "The same kind of failure is recreated in our task-report service, because Umami builds cover time-zone grouping only. Not measured yet.",
  refused: "Can't be built here: {reason}",
  disagreement: "This card did not come out as its shape suggested. Other shapes from this search that can be built:",
});

export interface ShapeBadgeTemplateValues {
  label?: string;
  translated_failure?: string;
  reason?: string;
}

/**
 * Fills the {label}, {translated_failure} and {reason} placeholders of a SHAPE_BADGE_COPY template.
 * Values are inserted literally (no $-pattern expansion). A placeholder without a value throws, so a
 * badge never shows a raw brace.
 */
export function fillShapeBadgeTemplate(template: string, values: ShapeBadgeTemplateValues): string {
  return template.replace(/\{(label|translated_failure|reason)\}/gu, (_match, key: keyof ShapeBadgeTemplateValues) => {
    const value = values[key];
    if (value === undefined) throw new Error(`shape badge template needs ${key}`);
    return value;
  });
}

export interface ShapeBadgeText {
  headline: string;
  /** The open badge's detail line; null for proven and refused badges, and for an open task-report badge without translated_failure. */
  detail: string | null;
}

/**
 * The copy of one badge for a search on host_id. labels maps each proven criterion to its label from
 * availability; a proven badge whose label is missing answers null, and the UI then shows no badge
 * for that shape (as when the badge call fails).
 */
export function shapeBadgeText(badge: OtfShapeBadge, host_id: OtfHostId, labels: Readonly<Partial<Record<ProvenCriterionId, string>>>): ShapeBadgeText | null {
  switch (badge.outcome) {
    case "proven": {
      const label = labels[badge.proven_criterion_id];
      if (label === undefined) return null;
      const template = host_id === "umami" ? SHAPE_BADGE_COPY.proven_umami : SHAPE_BADGE_COPY.proven_task_report;
      return { headline: fillShapeBadgeTemplate(template, { label }), detail: null };
    }
    case "open": {
      const headline = host_id === "umami" ? SHAPE_BADGE_COPY.open_umami : SHAPE_BADGE_COPY.open_task_report;
      const translated = badge.translated_failure;
      if (translated !== null) return { headline, detail: fillShapeBadgeTemplate(SHAPE_BADGE_COPY.open_detail, { translated_failure: translated }) };
      return { headline, detail: host_id === "umami" ? SHAPE_BADGE_COPY.open_umami_fallback_detail : null };
    }
    case "refused":
      return { headline: fillShapeBadgeTemplate(SHAPE_BADGE_COPY.refused, { reason: badge.reason }), detail: null };
  }
}

// ---- display order

/** True for a badge whose shape can be built (proven or open). */
export function isBuildableBadge(badge: OtfShapeBadge | null | undefined): boolean {
  return badge?.outcome === "proven" || badge?.outcome === "open";
}

export interface OrderedShape<T> {
  shape: T;
  /** The shape's index in the designer's order (and in the request). */
  index: number;
  badge: OtfShapeBadge | null;
}

const RANK: Readonly<Record<ShapeBadgeOutcome | "none", number>> = { proven: 0, open: 1, none: 2, refused: 3 };

/**
 * The shapes in display order: proven, then open, then shapes without a badge, then refused, keeping
 * the designer's order within each group (a stable sort). With badges null (the call failed or the
 * flag is off) the designer's order is kept unchanged. Shapes stay selectable in every state.
 */
export function orderShapesByBadge<T>(shapes: readonly T[], badges: readonly OtfShapeBadge[] | null): OrderedShape<T>[] {
  const byIndex = new Map<number, OtfShapeBadge>((badges ?? []).map((badge) => [badge.index, badge]));
  return shapes
    .map((shape, index) => ({ shape, index, badge: byIndex.get(index) ?? null }))
    .sort((a, b) => RANK[a.badge?.outcome ?? "none"] - RANK[b.badge?.outcome ?? "none"] || a.index - b.index);
}
