// Deterministic checks on a written issue, in order: structure, numeric statements, identifier
// scan, hint words. Checks 1 to 3 can reject; hint words are only reported to the human reviewer.
// Nothing here approves an issue: the best outcome is `ready_for_review`.
import { z } from "zod";
import { CARD_FIELD_IDENTIFIERS } from "./card-schema.ts";
import { IssueOutputSchema, issueFields } from "./issue-schema.ts";
import type { IssueOutput } from "./issue-schema.ts";
import { isRaceSymptom } from "./race-symptom.ts";
import type { WriterSymptom } from "./race-symptom.ts";

export type IssueCheckCode = "invalid_structure" | "numeric_mismatch" | "excluded_identifier";

export interface NumericViolation {
  field: string;
  reason: "unsupported_number" | "missing_expected_vector" | "missing_observed_vector";
  /** The digit run as written, for an unsupported number; null for a missing vector. */
  number: string | null;
}

export type IdentifierKind = "listed" | "source_path" | "commit_id" | "check_id" | "card_field";

export interface IdentifierViolation {
  field: string;
  offset: number;
  kind: IdentifierKind;
  /** The list entry or built-in name that matched (`listed`, `card_field`), or the matched text. */
  term: string;
}

export interface HintWord {
  field: string;
  offset: number;
  word: string;
}

export interface IssueCheckReport {
  status: "ready_for_review" | "rejected";
  codes: IssueCheckCode[];
  structure: { ok: boolean; detail: string | null };
  numeric: { ok: boolean; violations: NumericViolation[] } | null;
  identifiers: { ok: boolean; violations: IdentifierViolation[] } | null;
  hint_words: HintWord[];
}

const DIGIT_RUN = /\d+/g;

function digitRuns(text: string): string[] {
  return text.match(DIGIT_RUN) ?? [];
}

// An ISO date with an optional time and offset, or a time of day on its own.
const DATE_OR_TIME =
  /(?<!\d)(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?!\d)/g;

/** The digit runs a count could be stated in: those that are not part of a date or a time. */
function countRuns(text: string): bigint[] {
  return digitRuns(text.replace(DATE_OR_TIME, " ")).map(BigInt);
}

// A race issue states its counts on one fixed line per result field: `Expected: accepted=<n>,
// refused=<n>` in expected_result and `Observed: accepted=<n>, refused=<n>` in actual_result. The
// line must be a whole line, exactly as written (case-sensitive keys, ASCII digits, no other
// spacing or punctuation). Free-text counts elsewhere are never read. The field states its counts
// only when exactly one line starts with the label, that line is the exact form, and its counts
// equal the observation's.
const RACE_LABEL = { expected: "Expected", observed: "Observed" } as const;

/** True when `text` holds exactly one `<Label>: accepted=<n>, refused=<n>` line with these counts. */
function statesRaceCounts(text: string, key: "expected" | "observed", counts: { accepted: number; refused: number }): boolean {
  const label = RACE_LABEL[key];
  const labelLine = new RegExp(`^\\s*${label}\\s*:`, "i");
  const exactLine = new RegExp(`^${label}: accepted=([0-9]+), refused=([0-9]+)$`);
  const lines = text.split(/\r?\n/).filter((line) => labelLine.test(line));
  const match = lines.length === 1 ? exactLine.exec(lines[0] ?? "") : null;
  return match !== null && BigInt(match[1] ?? "") === BigInt(counts.accepted) && BigInt(match[2] ?? "") === BigInt(counts.refused);
}

/** Every string and number value in the observation (never its keys). */
function symptomValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "number") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(symptomValues);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(symptomValues);
  }
  return [];
}

/** True when `vector` occurs, in order, within `runs` (not necessarily adjacent). */
function containsInOrder(runs: bigint[], vector: bigint[]): boolean {
  let next = 0;
  for (const run of runs) {
    if (next < vector.length && run === vector[next]) {
      next += 1;
    }
  }
  return next === vector.length;
}

function checkNumbers(issue: IssueOutput, symptom: WriterSymptom): NumericViolation[] {
  const supported = new Set(symptomValues(symptom).flatMap(digitRuns).map((run) => BigInt(run)));
  const violations: NumericViolation[] = [];
  for (const { field, text } of issueFields(issue)) {
    for (const run of digitRuns(text)) {
      if (!supported.has(BigInt(run))) {
        violations.push({ field, reason: "unsupported_number", number: run });
      }
    }
  }
  // The time-zone family's vectors are its bucket counts in bucket order; the race family's are
  // the accepted and refused counts on the fixed Expected and Observed lines.
  const states = isRaceSymptom(symptom)
    ? (text: string, key: "expected" | "observed") => statesRaceCounts(text, key, symptom[key])
    : (text: string, key: "expected" | "observed") => containsInOrder(countRuns(text), symptom[key].map((b) => BigInt(b.count)));
  if (!states(issue.expected_result, "expected")) {
    violations.push({ field: "expected_result", reason: "missing_expected_vector", number: null });
  }
  if (!states(issue.actual_result, "observed")) {
    violations.push({ field: "actual_result", reason: "missing_observed_vector", number: null });
  }
  return violations;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Matches `term` case-insensitively, with no letter, digit or underscore directly around it. */
function wordPattern(term: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${term}(?![\\p{L}\\p{N}_])`, "giu");
}

// A path or file name ending in a source-file extension: relative, absolute, alias (`@/`, `~/`),
// bracketed route segments, route groups, and paths inside URLs or stack frames (a match may start
// after `//` or `:/`, but not after a single `/` inside a path, which keeps the scan linear).
// Product names written like a file name (Node.js) are not paths and are left alone.
const SOURCE_PATH =
  /(?<![\w.@~[\]()-]|(?<![:/])\/)\/?(?:[\w.@~[\]()-]+\/)*[\w.[\]-]*[\w\]]\.(?:tsx|ts|js|py|sql)(?![\w-])/giu;
const NOT_A_PATH = new Set(["node.js"]);
const COMMIT_ID = wordPattern("[0-9a-f]{40}");
const CHECK_ID = /(?<![\p{L}\p{N}_.-])[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*-[a-z0-9_-]*[a-z0-9_](?![\p{L}\p{N}_-])/giu;

const BUILT_IN: { kind: IdentifierKind; pattern: RegExp; skip?: (text: string) => boolean }[] = [
  { kind: "source_path", pattern: SOURCE_PATH, skip: (text) => NOT_A_PATH.has(text.toLowerCase()) },
  { kind: "commit_id", pattern: COMMIT_ID },
  { kind: "check_id", pattern: CHECK_ID },
];

function checkIdentifiers(issue: IssueOutput, excluded: readonly string[]): IdentifierViolation[] {
  const listed: IdentifierViolation[] = [];
  const builtIn: IdentifierViolation[] = [];
  const terms = excluded.map((term) => term.trim()).filter((term) => term.length > 0);
  for (const { field, text } of issueFields(issue)) {
    for (const term of terms) {
      for (const match of text.matchAll(wordPattern(escape(term)))) {
        listed.push({ field, offset: match.index, kind: "listed", term });
      }
    }
    for (const { kind, pattern, skip } of BUILT_IN) {
      for (const match of text.matchAll(pattern)) {
        if (!skip?.(match[0])) {
          builtIn.push({ field, offset: match.index, kind, term: match[0] });
        }
      }
    }
    for (const name of CARD_FIELD_IDENTIFIERS) {
      for (const match of text.matchAll(wordPattern(escape(name)))) {
        builtIn.push({ field, offset: match.index, kind: "card_field", term: name });
      }
    }
  }
  return [...listed, ...builtIn];
}

/** Words that hint at a cause without naming it, with the forms each one matches (time-zone family). */
const HINT_WORDS: { word: string; pattern: RegExp }[] = [
  { word: "argument", pattern: wordPattern("arguments?") },
  { word: "parameter", pattern: wordPattern("parameters?") },
  { word: "passed", pattern: wordPattern("passed") },
  { word: "pass through", pattern: wordPattern("pass(?:es|ed|ing)?\\s+through") },
  { word: "forward", pattern: wordPattern("forward(?:s|ed|ing)?") },
  { word: "default", pattern: wordPattern("default(?:s|ed)?") },
  { word: "defaults to utc", pattern: wordPattern("defaults?\\s+to\\s+utc") },
  { word: "ignored", pattern: wordPattern("ignored") },
  { word: "dropped", pattern: wordPattern("dropped") },
];

/** The race family's hint words: names for a kind of fix rather than for what the user saw. */
const RACE_HINT_WORDS: { word: string; pattern: RegExp }[] = [
  { word: "race", pattern: wordPattern("rac(?:e|es|ing)") },
  { word: "atomic", pattern: wordPattern("atomic(?:ally|ity)?") },
  { word: "lock", pattern: wordPattern("lock(?:s|ed|ing)?") },
  { word: "transaction", pattern: wordPattern("transactions?") },
  { word: "mutex", pattern: wordPattern("mutex(?:es)?") },
  { word: "compare-and-swap", pattern: wordPattern("compare[-\\s]and[-\\s]swap") },
  { word: "check then write", pattern: wordPattern("check(?:s|ed)?[-\\s]then[-\\s](?:write|update|act)") },
];

function findHintWords(issue: IssueOutput, symptom: WriterSymptom): HintWord[] {
  const words = isRaceSymptom(symptom) ? RACE_HINT_WORDS : HINT_WORDS;
  return issueFields(issue).flatMap(({ field, text }) =>
    words.flatMap(({ word, pattern }) =>
      [...text.matchAll(pattern)].map((match) => ({ field, offset: match.index, word })),
    ).sort((a, b) => a.offset - b.offset),
  );
}

/** The report of an output that failed check 1; no later check runs on it. */
export function structureFailure(detail: string): IssueCheckReport {
  return {
    status: "rejected",
    codes: ["invalid_structure"],
    structure: { ok: false, detail },
    numeric: null,
    identifiers: null,
    hint_words: [],
  };
}

/**
 * Runs the four checks on a model output. `excluded` is the caller's list of internal names for
 * the fixture (function and helper names, source paths, check IDs, shape ID, source-fix commit).
 */
export function checkIssue(output: unknown, symptom: WriterSymptom, excluded: readonly string[]): IssueCheckReport {
  const parsed = IssueOutputSchema.safeParse(output);
  if (!parsed.success) {
    return structureFailure(z.prettifyError(parsed.error));
  }
  const issue = parsed.data;
  const numeric = checkNumbers(issue, symptom);
  const identifiers = checkIdentifiers(issue, excluded);
  const codes: IssueCheckCode[] = [
    ...(numeric.length > 0 ? (["numeric_mismatch"] as const) : []),
    ...(identifiers.length > 0 ? (["excluded_identifier"] as const) : []),
  ];
  return {
    status: codes.length === 0 ? "ready_for_review" : "rejected",
    codes,
    structure: { ok: true, detail: null },
    numeric: { ok: numeric.length === 0, violations: numeric },
    identifiers: { ok: identifiers.length === 0, violations: identifiers },
    hint_words: findHintWords(issue, symptom),
  };
}
