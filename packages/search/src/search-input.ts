// A narrow local input type for one candidate bug. The symptom words and the docs query will later
// come from the shared schema's `ObservedSymptom`, and the phrases from the frozen issue revision.
// Until that package exists, the caller supplies them here.
import { z } from "zod";
import { SearchError } from "./errors.ts";

const word = z.string().min(1);
const domain = z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, "not a calendar date");

export const searchInputSchema = z.strictObject({
  schema_version: z.literal(1),
  // Becomes part of the spend call name, which allows lowercase letters, digits, ".", "_" and "-".
  candidate: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  source: z
    .strictObject({
      shape_keywords: z.array(word).min(1),
      symptom_words: z.array(word).min(1),
      include_domains: z.array(domain).min(1),
      start_date: date,
      end_date: date,
    })
    .refine((source) => source.start_date <= source.end_date, "start_date is after end_date"),
  docs: z.strictObject({ url: z.string().min(1), query: word }),
  // The phrases are quoted in the query, so a double quote inside one is refused.
  phrases: z
    .array(z.string().trim().min(1).refine((phrase) => !phrase.includes('"'), "must not contain a double quote"))
    .length(3),
  docs_policy: z.strictObject({
    allowed_domains: z.array(domain).min(1),
    excluded_domains: z.array(domain),
  }),
});

export type SearchInput = z.infer<typeof searchInputSchema>;

export function parseSearchInput(value: unknown): SearchInput {
  const parsed = searchInputSchema.safeParse(value);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
    throw new SearchError("invalid_input", paths.join(", "));
  }
  return parsed.data;
}
