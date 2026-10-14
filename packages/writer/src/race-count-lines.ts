// The race family's count lines are written by code, not by the model. The counts are facts the
// RaceSymptom already holds, so after the model's issue is parsed and before the issue checks run,
// every line in expected_result or actual_result that starts with either count label is dropped and
// exactly one canonical line is appended: `Expected: accepted=<n>, refused=<n>` and
// `Observed: accepted=<n>, refused=<n>`. A model count line that contradicts the observation leaves
// the issue as written, so the checks reject it. The checks stay as strict as before; they read only that line.
import type { IssueOutput } from "./issue-schema.ts";
import type { RaceSymptom } from "./race-symptom.ts";

const LABEL = { expected: "Expected", observed: "Observed" } as const;

/** `text` without any line the issue check would read as a `label` line, ending with the canonical one. */
function withCountLine(text: string, key: "expected" | "observed", counts: { accepted: number; refused: number }): string {
  const label = LABEL[key];
  // The issue check's label match (any case, optional space before the label and the colon), for both
  // labels: a count line placed in the other field is dropped too.
  const labelLine = /^\s*(?:expected|observed)\s*:/i;
  const prose = text
    .split(/\r?\n/)
    .filter((line) => !labelLine.test(line))
    .join("\n")
    .trimEnd();
  const line = `${label}: accepted=${String(counts.accepted)}, refused=${String(counts.refused)}`;
  return prose === "" ? line : `${prose}\n${line}`;
}

/** A well-formed count line's label and counts, or null for any other line. */
const COUNT_LINE = /^\s*(expected|observed)\s*:\s*accepted\s*=\s*(\d+)\s*,\s*refused\s*=\s*(\d+)\s*$/i;

/** True when the model wrote a well-formed count line, in either field, whose counts differ from the observation. */
function contradicts(issue: IssueOutput, symptom: RaceSymptom): boolean {
  for (const line of `${issue.expected_result}\n${issue.actual_result}`.split(/\r?\n/)) {
    const match = COUNT_LINE.exec(line);
    if (match === null) continue;
    const counts = match[1]?.toLowerCase() === "expected" ? symptom.expected : symptom.observed;
    if (Number(match[2]) !== counts.accepted || Number(match[3]) !== counts.refused) return true;
  }
  return false;
}

/**
 * The issue with each result field ending in the one count line built from the observation. When the
 * model's own count line contradicts the observation, its prose may repeat the wrong counts, so the
 * issue is returned as the model wrote it and the checks reject it.
 */
export function withRaceCountLines(issue: IssueOutput, symptom: RaceSymptom): IssueOutput {
  if (contradicts(issue, symptom)) return issue;
  return {
    ...issue,
    expected_result: withCountLine(issue.expected_result, "expected", symptom.expected),
    actual_result: withCountLine(issue.actual_result, "observed", symptom.observed),
  };
}
