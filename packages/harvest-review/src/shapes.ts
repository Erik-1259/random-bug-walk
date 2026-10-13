// The shapes a review can judge. Each names its system prompt, its output schema, the evidence
// fields a yes vote needs, and the field a structurally confirmed harvest match carries
// (`timezone` for DT-1.tz-arg, `guard` for the race class). The review inputs name the shape; a
// file that names none is a DT-1.tz-arg file, as written before shapes could be chosen.
import { DT1_HARVEST_SHAPE, RACE_HARVEST_SHAPE } from "@rbw/harvest";
import type { z } from "zod";
import { RACE_SYSTEM_PROMPT, RaceReviewOutputSchema, ReviewOutputSchema, SYSTEM_PROMPT } from "./prompt.ts";
import type { ReviewAnswer } from "./prompt.ts";

export interface ReviewShape {
  readonly id: string;
  readonly system_prompt: string;
  readonly schema: z.ZodType<ReviewAnswer>;
  /** The output fields that must all be `yes`, with a `fix` verdict, for a yes vote. */
  readonly evidence: readonly string[];
  /** The field of a structurally confirmed harvest match that names what the fix added. */
  readonly confirmed_field: "timezone" | "guard";
}

export const DT1_REVIEW_SHAPE: ReviewShape = {
  id: DT1_HARVEST_SHAPE.id,
  system_prompt: SYSTEM_PROMPT,
  schema: ReviewOutputSchema,
  evidence: ["zone_is_selected", "same_call"],
  confirmed_field: "timezone",
};

export const RACE_REVIEW_SHAPE: ReviewShape = {
  id: RACE_HARVEST_SHAPE.id,
  system_prompt: RACE_SYSTEM_PROMPT,
  schema: RaceReviewOutputSchema,
  evidence: ["guard_rechecks_state", "same_call"],
  confirmed_field: "guard",
};

export const REVIEW_SHAPES: readonly ReviewShape[] = [DT1_REVIEW_SHAPE, RACE_REVIEW_SHAPE];

/** The review shape with this ID, or DT-1.tz-arg's for none. Throws for an unknown ID. */
export function reviewShape(id: string | undefined): ReviewShape {
  const shape = REVIEW_SHAPES.find((entry) => entry.id === (id ?? DT1_REVIEW_SHAPE.id));
  if (shape === undefined) {
    throw new Error(`no review shape ${String(id)}; known shapes: ${REVIEW_SHAPES.map((entry) => entry.id).join(", ")}`);
  }
  return shape;
}
