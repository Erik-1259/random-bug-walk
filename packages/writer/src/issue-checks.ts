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

// A race count is read clause by clause. The text is split into clauses at sentence ends,
// semicolons, commas, `and`, `but`, `while` and `whereas`, and at a colon or dash that does not
// lead into a number (so `accepted: 2` and `accepted - 2` stay one clause); a clause that is
// ambiguous as a whole is split again at any colon or dash ("both were accepted in 5 ms: 2
// accepted"). A clause states a count
// only when it holds exactly one outcome word and exactly one count number, in either order and in
// any voice: "2 were accepted", "the server accepted 2 requests", "refused: 0", "0 failed". A
// clause with two outcome words, two count numbers or a negation (`not`, `never`, `n't`) is
// ambiguous and states nothing. A number is never a count when it is a timing (`0 ms`, `5 s`), a
// percentage, part of a path, word, decimal or date, or an ID or code (`request 2`, `#2`,
// `HTTP 200`, `status 400`).
const CLAUSE_BREAK =
  /[.!?](?=\s|$)|[;,](?!\d)|[:\u2013\u2014](?!\s*\d)|\s-\s(?!\s*\d)|\s[/|]\s|(?<![\p{L}])(?:and|but|while|whereas)(?![\p{L}])/giu;
const LABEL_BREAK = /[:=\u2013\u2014]|\s-\s/u;
const ACCEPTED_WORD = String.raw`accept\p{L}*|succe(?:ss|ed)\p{L}*`;
const REFUSED_WORD = String.raw`refus\p{L}*|reject\p{L}*|denied|deny|denies|declin\p{L}*|fail\p{L}*`;
const OUTCOME_WORD = new RegExp(`(?<![\\p{L}])(?:(${ACCEPTED_WORD})|(${REFUSED_WORD}))`, "giu");
const NEGATION = /(?<![\p{L}])(?:not|never)(?![\p{L}])|n't(?![\p{L}])/iu;
const ID_WORD = String.raw`(?<![\p{L}])(?:http|status|code|id|request|attempt|tab|port|line|version|step|number)`;
const COUNT_NUMBER = new RegExp(
  String.raw`(?<![\p{L}\p{N}_./\\#-])(?<!${ID_WORD}\s*)(\d+)(?![\p{L}\p{N}_/]|[.,:]\d)(?!\s*(?:ms|milliseconds?|s|secs?|seconds?|min|minutes?|h|hours?|%)(?![\p{L}]))`,
  "giu",
);

interface RaceCount {
  outcome: "accepted" | "refused";
  count: bigint;
}

/** The race count one clause states, or null when it states none or is ambiguous. */
function clauseCount(clause: string): RaceCount | null {
  const outcomes = [...clause.matchAll(OUTCOME_WORD)];
  const numbers = [...clause.matchAll(COUNT_NUMBER)];
  const [outcome] = outcomes;
  const [number] = numbers;
  if (outcomes.length !== 1 || numbers.length !== 1 || outcome === undefined || number === undefined || NEGATION.test(clause)) {
    return null;
  }
  return { outcome: outcome[1] === undefined ? "refused" : "accepted", count: BigInt(number[1] ?? "") };
}

/** The race counts stated in `text`, in order, each with the outcome it is stated for. */
function raceCounts(text: string): RaceCount[] {
  return text
    .replace(DATE_OR_TIME, " ")
    .split(CLAUSE_BREAK)
    .flatMap((clause) => {
      const stated = clauseCount(clause);
      if (stated !== null) {
        return [stated];
      }
      const parts = clause.split(LABEL_BREAK);
      return parts.length > 1 ? parts.flatMap((part) => clauseCount(part) ?? []) : [];
    });
}

/** True when the accepted count, then the refused count, are each stated with their outcome. */
function statesRaceCounts(text: string, counts: { accepted: number; refused: number }): boolean {
  let next: "accepted" | "refused" | null = "accepted";
  for (const stated of raceCounts(text)) {
    if (next !== null && stated.outcome === next && stated.count === BigInt(counts[next])) {
      next = next === "accepted" ? "refused" : null;
    }
  }
  return next === null;
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
  // the accepted count, then the refused count, each stated with its outcome.
  const states = isRaceSymptom(symptom)
    ? (text: string, key: "expected" | "observed") => statesRaceCounts(text, symptom[key])
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
