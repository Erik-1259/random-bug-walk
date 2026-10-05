// The pattern-card prompt and its input. The card writer reads public source-fix information only,
// plus the caller's shape confirmation, which also supplies the code-owned card fields.
import { z } from "zod";
import { CODE_OWNED_FIELDS } from "./card-schema.ts";
import type { Card } from "./card-schema.ts";
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

const SYSTEM = `You write a pattern card that describes one fixed bug from public source-fix information.
You are given the source links, repository, date, licence, a short diff excerpt, the source issue text and a shape confirmation.

Rules:
- bug_class is exactly one of the listed values.
- mechanism is one sentence and names no library or framework.
- runtime_dependence.reason says which of the seven levers apply, which are absent and which are unverified, and each lever appears in exactly one of levers_apply, levers_absent and levers_unverified.
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

/** Replaces id, provenance and shape with the caller's values, and records which ones differed. */
export function applyCodeOwnedFields(card: Card, source: CardSource): { card: Card; fields: CodeOwnedField[] } {
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
  return { card: { ...card, ...owned }, fields };
}
