// A narrow local definition of the race family's issue-writer input, @rbw/schema's `RaceSymptom`
// record, which the controller's candidate attempt builds from the observation.
//
// It holds what a user could see: the action, the public request, two requests that spent the
// same one-time code at the same time with their statuses, outcomes and times, the single
// acceptance expected against the acceptances observed, a sequential reuse for contrast, and
// user-documentation passages. Every object is strict, like ObservedSymptom, so a token, a code,
// a check ID or a source path in an extra field is refused rather than passed on to the model.
import { z } from "zod";
import { ObservedSymptomSchema } from "./observed-symptom.ts";
import type { ObservedSymptom } from "./observed-symptom.ts";

export const RACE_SYMPTOM_KIND = "concurrent_double_acceptance";

const Milliseconds = z.number().int().nonnegative();

const Attempt = z
  .object({
    label: z.string().min(1),
    sent_ms: Milliseconds,
    settled_ms: Milliseconds,
    http_status: z.number().int().min(100).max(599),
    outcome: z.enum(["accepted", "refused"]),
    error_code: z.string().min(1).nullable(),
  })
  .strict()
  .refine((attempt) => attempt.settled_ms >= attempt.sent_ms, "an attempt settles after it is sent")
  .refine(
    (attempt) => (attempt.outcome === "accepted" ? attempt.http_status === 200 && attempt.error_code === null : attempt.error_code !== null),
    "an accepted attempt has HTTP 200 and no error code; a refused one has an error code",
  );

const Counts = z.object({ accepted: z.number().int().nonnegative(), refused: z.number().int().nonnegative() }).strict();

export const RaceSymptomSchema = z
  .object({
    schema_version: z.literal(1),
    symptom_kind: z.literal(RACE_SYMPTOM_KIND),
    user_action: z.string().min(1),
    request: z
      .object({
        method: z.string().regex(/^[A-Z]+$/),
        path: z.string().startsWith("/"),
        query: z.record(z.string(), z.string()),
      })
      .strict(),
    locale: z.string().min(1).nullable(),
    fixture_description: z.string().min(1),
    concurrent_attempts: z.array(Attempt).length(2),
    overlap_ms: z.number().int().positive(),
    expected: Counts,
    observed: Counts,
    sequential_attempts: z.array(Attempt),
    doc_excerpts: z.array(z.object({ text: z.string().min(1), source_url: z.url() }).strict()),
  })
  .strict()
  .refine(
    (symptom) =>
      symptom.observed.accepted === symptom.concurrent_attempts.filter((attempt) => attempt.outcome === "accepted").length &&
      symptom.observed.refused === symptom.concurrent_attempts.filter((attempt) => attempt.outcome === "refused").length,
    "observed counts the outcomes of the concurrent attempts",
  )
  .brand<"RaceSymptom">();

/** A validated race observation. The brand means only `parseWriterSymptom` can produce one. */
export type RaceSymptom = z.infer<typeof RaceSymptomSchema>;

/** Either family's validated writer input. */
export type WriterSymptom = ObservedSymptom | RaceSymptom;

export type ParsedWriterSymptom = { ok: true; symptom: WriterSymptom } | { ok: false; detail: string };

export function isRaceSymptom(symptom: WriterSymptom): symptom is RaceSymptom {
  return "symptom_kind" in symptom;
}

/**
 * Parses the issue writer's input. A value with a `symptom_kind` field must be a RaceSymptom;
 * any other value must be an ObservedSymptom, parsed exactly as before the race family existed.
 */
export function parseWriterSymptom(value: unknown): ParsedWriterSymptom {
  if (typeof value === "object" && value !== null && "symptom_kind" in value) {
    const parsed = RaceSymptomSchema.safeParse(value);
    return parsed.success ? { ok: true, symptom: parsed.data } : { ok: false, detail: `invalid RaceSymptom: ${z.prettifyError(parsed.error)}` };
  }
  const parsed = ObservedSymptomSchema.safeParse(value);
  return parsed.success ? { ok: true, symptom: parsed.data } : { ok: false, detail: `invalid ObservedSymptom: ${z.prettifyError(parsed.error)}` };
}
