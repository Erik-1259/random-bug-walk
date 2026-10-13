// The issue prompt. Its only input is a validated writer symptom (an ObservedSymptom for the
// time-zone family, a RaceSymptom for the race family); it never sees a pattern card, and this
// module imports nothing from the card modules.
import type { ObservedSymptom } from "./observed-symptom.ts";
import type { PromptMessages } from "./prompt.ts";
import { isRaceSymptom } from "./race-symptom.ts";
import type { RaceSymptom, WriterSymptom } from "./race-symptom.ts";

const SYSTEM = `You write a bug report the way a user of a web analytics product would file it.
You are given one observation as JSON: what the user did, the public request, the time zone, the recorded visits, the response status, the expected and observed counts for the primary time zone, follow-up examples in other time zones, and excerpts from the user documentation.

Rules:
- Describe only what the user sees. You may name the public endpoint, its parameters and product settings.
- Do not guess at an internal cause and do not suggest a fix. Write "daily pageview counts do not follow the requested reporting timezone", not how the code should change.
- Use only numbers that appear in the observation. Do not compute totals, differences or new dates.
- expected_result and actual_result each state, in bucket order, one short sentence per local day of the primary time zone that names the day's bucket label as given in the observation and its expected (in expected_result) or observed (in actual_result) count, for example "On 2026-03-07 the chart should show 3 pageviews."
- reproduction_steps is a list of short steps a user can follow.
- environment names the time zone, the locale and the response status.
Answer with JSON that matches the schema.`;

const RACE_SYSTEM = `You write a bug report the way a user of a web analytics product would file it.
You are given one observation as JSON: what the user did, the public request, two requests that used the same one-time sign-in code at the same time with each one's response status, outcome and timing in milliseconds, how many of them should have been accepted and refused and how many were, a sequential example where the same code was used twice one after the other, and excerpts from the user documentation.

Rules:
- Describe only what the user sees. You may name the public endpoint, the response statuses, the error codes and product settings.
- Do not guess at an internal cause and do not suggest a fix. Write "one backup code signs in twice when it is entered in two places at the same time", not how the code should change.
- Never write a backup code, a token or a password.
- Use only numbers that appear in the observation. Do not compute totals, differences or new times.
- expected_result says in a short sentence what should happen to the requests sent at the same time, then ends with exactly one line of its own that reads \`Expected: accepted=<n>, refused=<n>\`, with the observation's expected counts as digits, for example "Of the two requests sent at the same time, one should be accepted and the other refused.\\nExpected: accepted=1, refused=1".
- actual_result says in a short sentence what happened, and may add each request's status and timing, then ends with exactly one line of its own that reads \`Observed: accepted=<n>, refused=<n>\`, with the observation's observed counts as digits, for example "Both requests returned HTTP 200 and each tab was signed in.\\nObserved: accepted=2, refused=0".
- Write those two lines exactly in that form: the same words and capital letters, no spaces around "=", nothing before or after on the line, and no other line that starts with "Expected:" or "Observed:".
- reproduction_steps is a list of short steps a user can follow.
- environment names the locale and the response statuses.
Answer with JSON that matches the schema.`;

function timeZonePrompt(symptom: ObservedSymptom): PromptMessages {
  return {
    system: SYSTEM,
    user: `Observation:\n${JSON.stringify(symptom, null, 2)}`,
  };
}

function racePrompt(symptom: RaceSymptom): PromptMessages {
  return {
    system: RACE_SYSTEM,
    user: `Observation:\n${JSON.stringify(symptom, null, 2)}`,
  };
}

export function buildIssuePrompt(symptom: WriterSymptom): PromptMessages {
  return isRaceSymptom(symptom) ? racePrompt(symptom) : timeZonePrompt(symptom);
}
