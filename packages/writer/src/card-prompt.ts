// The pattern-card prompt and its input. The card writer reads public source-fix information only,
// plus the caller's shape confirmation, which also supplies the code-owned card fields.
import { z } from "zod";
import { CardSchema, CODE_OWNED_FIELDS, RUNTIME_LEVERS, deriveRuntimeDependence } from "./card-schema.ts";
import type { Card, ModelCard } from "./card-schema.ts";
import type { PromptMessages } from "./prompt.ts";

export const CardSourceSchema = z
  .object({
    source_links: z.array(z.url()).min(1),
    repository: z.string().min(1),
    date: z.iso.date(),
    license: z.string().min(1),
    diff_excerpt: z.string(),
    issue_text: z.string(),
    confirmation: z
      .object({
        card_id: z.string().min(1),
        shape_id: z.string().min(1),
        rules_matched: z.array(z.string().min(1)),
        matched_lines: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type CardSource = z.infer<typeof CardSourceSchema>;

/** What each runtime lever means, as the prompt states it. */
const LEVER_MEANINGS: Record<(typeof RUNTIME_LEVERS)[number], string> = {
  hidden_runtime_state: "the bug depends on state that exists only while the code runs",
  distance_between_symptom_and_cause: "the symptom shows up far from the code that causes it",
  plausible_wrong_static_fix: "reading the code alone suggests a fix that looks right but is wrong",
  path_ambiguity: "several code paths could produce the symptom, and only running it shows which one does",
  ordering_or_concurrency: "the bug depends on the order or timing of events",
  magnitude_visible_only_at_runtime: "how wrong the result is shows only when the code runs",
  external_side_effect_semantics: "the bug depends on how an outside system behaves when it is called",
};

const LEVER_LINES = RUNTIME_LEVERS.map((lever) => `  - ${lever}: ${LEVER_MEANINGS[lever]}.`).join("\n");

const SYSTEM = `You write a pattern card that describes one fixed bug from public source-fix information.
You are given the source links, repository, date, licence, a short diff excerpt, the source issue text and a shape confirmation.

Rules:
- bug_class is exactly one of the listed values.
- mechanism is one sentence and names no library or framework.
- runtime_dependence.reason says which of the seven levers apply, which are absent and which are unverified.
- runtime_dependence.levers gives each of the seven levers one state: apply, absent or unverified (the input does not show whether it applies). The levers:
${LEVER_LINES}
- Copy id, provenance and shape from the input; they are checked by code.
- Do not invent tests, links or APIs that the input does not show.
Answer with JSON that matches the schema.`;

export function buildCardPrompt(source: CardSource): PromptMessages {
  return {
    system: SYSTEM,
    user: `Source-fix information:\n${JSON.stringify(source, null, 2)}`,
  };
}

export interface CodeOwnedField {
  field: (typeof CODE_OWNED_FIELDS)[number];
  /** True when the model returned a different value, which code replaced. */
  overwritten: boolean;
}

/**
 * Replaces id, provenance and shape with the caller's values, records which ones differed, derives
 * the three lever lists from the model's lever states, and validates the completed card against the
 * full card schema.
 */
export function applyCodeOwnedFields(card: ModelCard, source: CardSource): { card: Card; fields: CodeOwnedField[] } {
  const owned: Pick<Card, "id" | "provenance" | "shape"> = {
    id: source.confirmation.card_id,
    provenance: {
      source_links: source.source_links,
      repository: source.repository,
      date: source.date,
      license: source.license,
    },
    shape: {
      shape_id: source.confirmation.shape_id,
      rules_matched: source.confirmation.rules_matched,
      matched_lines: source.confirmation.matched_lines,
    },
  };
  const fields = CODE_OWNED_FIELDS.map((field) => ({
    field,
    overwritten: JSON.stringify(card[field]) !== JSON.stringify(owned[field]),
  }));
  const runtime_dependence = deriveRuntimeDependence(card.runtime_dependence);
  return { card: CardSchema.parse({ ...card, ...owned, runtime_dependence }), fields };
}
