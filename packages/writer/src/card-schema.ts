import { z } from "zod";

export const BUG_CLASSES = [
  "time_and_date",
  "data_validation",
  "permissions",
  "async_ordering_and_races",
  "caching_and_stale_state",
  "configuration_and_environment",
  "ui_state_and_hydration",
  "api_contract",
] as const;

/** The seven levers that make a bug depend on runtime evidence. */
export const RUNTIME_LEVERS = [
  "hidden_runtime_state",
  "distance_between_symptom_and_cause",
  "plausible_wrong_static_fix",
  "path_ambiguity",
  "ordering_or_concurrency",
  "magnitude_visible_only_at_runtime",
  "external_side_effect_semantics",
] as const;

const Lever = z.enum(RUNTIME_LEVERS);

const ProvenanceSchema = z
  .object({
    source_links: z.array(z.url()).min(1),
    repository: z.string().min(1),
    date: z.iso.date(),
    license: z.string().min(1),
  })
  .strict();

const ShapeSchema = z
  .object({
    shape_id: z.string().min(1),
    rules_matched: z.array(z.string().min(1)),
    matched_lines: z.array(z.string()),
  })
  .strict();

const RuntimeDependenceSchema = z
  .object({
    value: z.enum(["yes", "no", "unknown"]),
    reason: z.string().min(1),
    levers_apply: z.array(Lever),
    levers_absent: z.array(Lever),
    levers_unverified: z.array(Lever),
  })
  .strict()
  .superRefine((value, ctx) => {
    const listed = [...value.levers_apply, ...value.levers_absent, ...value.levers_unverified];
    for (const lever of RUNTIME_LEVERS) {
      const count = listed.filter((l) => l === lever).length;
      if (count !== 1) {
        ctx.addIssue({
          code: "custom",
          message: `lever ${lever} must be listed exactly once across apply, absent and unverified`,
        });
      }
    }
  });

export const CardSchema = z
  .object({
    id: z.string().min(1),
    provenance: ProvenanceSchema,
    bug_class: z.enum(BUG_CLASSES),
    mechanism: z.string().min(1),
    shape: ShapeSchema,
    fault_shape: z.string().min(1),
    trigger: z.string().min(1),
    symptom: z.string().min(1),
    apis: z.array(z.string().min(1)),
    runtime_dependence: RuntimeDependenceSchema,
    fidelity_tier: z.enum(["A", "B", "C"]),
    references: z
      .object({
        diff_excerpt: z.string(),
        failing_tests: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();
export type Card = z.infer<typeof CardSchema>;

/** Fields that code fills from the caller's confirmation input; the model's values are never kept. */
export const CODE_OWNED_FIELDS = ["id", "provenance", "shape"] as const;

/** The state the model gives each runtime lever; each names one of the card's three lever lists. */
export const LEVER_STATES = ["apply", "absent", "unverified"] as const;

const LeverState = z.enum(LEVER_STATES);

// One required key per lever and no others, so structured output enforces "each lever exactly once"
// while generating, which a refinement across three free lists cannot.
const leverShape = Object.fromEntries(RUNTIME_LEVERS.map((lever) => [lever, LeverState])) as Record<
  (typeof RUNTIME_LEVERS)[number],
  typeof LeverState
>;

const ModelRuntimeDependenceSchema = z
  .object({
    value: z.enum(["yes", "no", "unknown"]),
    reason: z.string().min(1),
    levers: z.object(leverShape).strict(),
  })
  .strict();

/**
 * The card as the model is asked for it: the full card, except that runtime_dependence carries one
 * state per lever in place of the three lists, which code derives.
 */
export const ModelRequestCardSchema = CardSchema.extend({ runtime_dependence: ModelRuntimeDependenceSchema });

/**
 * What the model's answer is validated against: the requested card, except that any value passes in
 * a code-owned field, since code replaces it before the card is validated in full.
 */
export const ModelCardSchema = ModelRequestCardSchema.extend({
  id: z.unknown(),
  provenance: z.unknown(),
  shape: z.unknown(),
});
export type ModelCard = z.infer<typeof ModelCardSchema>;

/** The published runtime_dependence: each lever goes in the list its state names, in RUNTIME_LEVERS order. */
export function deriveRuntimeDependence(dependence: ModelCard["runtime_dependence"]): Card["runtime_dependence"] {
  const listed = (state: (typeof LEVER_STATES)[number]) =>
    RUNTIME_LEVERS.filter((lever) => dependence.levers[lever] === state);
  return {
    value: dependence.value,
    reason: dependence.reason,
    levers_apply: listed("apply"),
    levers_absent: listed("absent"),
    levers_unverified: listed("unverified"),
  };
}

/**
 * Card field names that read as identifiers rather than ordinary words. The issue identifier scan
 * rejects these; single-word field names such as `date`, `trigger` or `symptom` are ordinary words
 * a bug report needs, so they are not on this list.
 */
export const CARD_FIELD_IDENTIFIERS = [
  "bug_class",
  "fault_shape",
  "runtime_dependence",
  "fidelity_tier",
  "shape_id",
  "rules_matched",
  "matched_lines",
  "source_links",
  "diff_excerpt",
  "failing_tests",
  "levers_apply",
  "levers_absent",
  "levers_unverified",
] as const;
