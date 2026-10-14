// The race family's count lines are written by code, not by the model. The counts are facts the
// RaceSymptom already holds, so after the model's issue is parsed and before the issue checks run,
// every line in expected_result or actual_result that starts with the field's label is dropped and
// exactly one canonical line is appended: `Expected: accepted=<n>, refused=<n>` and
// `Observed: accepted=<n>, refused=<n>`. The checks stay as strict as before; they read only that line.
import type { IssueOutput } from "./issue-schema.ts";
import type { RaceSymptom } from "./race-symptom.ts";

const LABEL = { expected: "Expected", observed: "Observed" } as const;

/** `text` without any line the issue check would read as a `label` line, ending with the canonical one. */
function withCountLine(text: string, key: "expected" | "observed", counts: { accepted: number; refused: number }): string {
  const label = LABEL[key];
  // The same label match as the issue check: any case, optional space before the label and the colon.
  const labelLine = new RegExp(`^\\s*${label}\\s*:`, "i");
  const prose = text
    .split(/\r?\n/)
    .filter((line) => !labelLine.test(line))
    .join("\n")
    .trimEnd();
  const line = `${label}: accepted=${String(counts.accepted)}, refused=${String(counts.refused)}`;
  return prose === "" ? line : `${prose}\n${line}`;
}

/** The issue with each result field ending in the one count line built from the observation. */
export function withRaceCountLines(issue: IssueOutput, symptom: RaceSymptom): IssueOutput {
  return {
    ...issue,
    expected_result: withCountLine(issue.expected_result, "expected", symptom.expected),
    actual_result: withCountLine(issue.actual_result, "observed", symptom.observed),
  };
}
