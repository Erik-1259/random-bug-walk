// The issue prompt. Its only input is a validated ObservedSymptom; it never sees a pattern card,
// and this module imports nothing from the card modules.
import type { ObservedSymptom } from "./observed-symptom.ts";
import type { PromptMessages } from "./prompt.ts";

const SYSTEM = `You write a bug report the way a user of a web analytics product would file it.
You are given one observation as JSON: what the user did, the public request, the time zone, the recorded visits, the response status, the expected and observed counts for the primary time zone, follow-up examples in other time zones, and excerpts from the user documentation.

Rules:
- Describe only what the user sees. You may name the public endpoint, its parameters and product settings.
- Do not guess at an internal cause and do not suggest a fix. Write "daily pageview counts do not follow the requested reporting timezone", not how the code should change.
- Use only numbers that appear in the observation. Do not compute totals, differences or new dates.
- expected_result must list the expected counts of the primary time zone in bucket order. actual_result must list the observed counts of the primary time zone in bucket order.
- reproduction_steps is a list of short steps a user can follow.
- environment names the time zone, the locale and the response status.
Answer with JSON that matches the schema.`;

export function buildIssuePrompt(symptom: ObservedSymptom): PromptMessages {
  return {
    system: SYSTEM,
    user: `Observation:\n${JSON.stringify(symptom, null, 2)}`,
  };
}
