// A narrow local definition of the issue writer's only input. It will be replaced by the shared
// schema package's `ObservedSymptom`, and field names may change then.
//
// It holds what a user could see and do: the action, the public request, the time zone, the
// recorded visits in user terms, the response status, expected and observed counts, and
// user-documentation passages. Every object is strict, so an extra field (a stack trace, a source
// path, a check ID, a patch, card content) is refused rather than passed on to the model.
import { z } from "zod";

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const TimeZone = z.string().min(1).refine(isTimeZone, "an IANA time zone name");

const Buckets = z.array(z.object({ bucket_label: z.string().min(1), count: z.number().int().nonnegative() }).strict());

export const ObservedSymptomSchema = z
  .object({
    schema_version: z.literal(1),
    user_action: z.string().min(1),
    request: z
      .object({
        method: z.string().regex(/^[A-Z]+$/),
        path: z.string().startsWith("/"),
        query: z.record(z.string(), z.string()),
      })
      .strict(),
    timezone: TimeZone,
    locale: z.string().min(1).nullable(),
    fixture_description: z.string().min(1),
    events: z.array(
      z
        .object({
          label: z.string().min(1),
          timestamp_seconds: z.number().int().nonnegative(),
          utc_instant: z.iso.datetime(),
        })
        .strict(),
    ),
    http_status: z.number().int().min(100).max(599),
    expected: Buckets,
    observed: Buckets,
    follow_up_examples: z.array(z.object({ timezone: TimeZone, expected: Buckets, observed: Buckets }).strict()),
    doc_excerpts: z.array(z.object({ text: z.string().min(1), source_url: z.url() }).strict()),
  })
  .strict()
  .brand<"ObservedSymptom">();

/** A validated observation. The brand means only `parseObservedSymptom` can produce one. */
export type ObservedSymptom = z.infer<typeof ObservedSymptomSchema>;

export type ParsedSymptom = { ok: true; symptom: ObservedSymptom } | { ok: false; detail: string };

export function parseObservedSymptom(value: unknown): ParsedSymptom {
  const parsed = ObservedSymptomSchema.safeParse(value);
  return parsed.success
    ? { ok: true, symptom: parsed.data }
    : { ok: false, detail: `invalid ObservedSymptom: ${z.prettifyError(parsed.error)}` };
}
