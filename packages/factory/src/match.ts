// Interpreter criteria-match version 1, contract section 6.1: phrases are matched exactly as word
// sequences. A word is a maximal run of letters and digits, compared case-insensitively; anything else
// only separates words. Every word of a description must be covered by an occurrence of a criterion's
// example phrase or of a declared filler phrase; each maximal run of uncovered words is reported.
import type { Criterion } from "@rbw/factory-contract";

interface Word {
  key: string;
  start: number;
  end: number;
}

const WORD = /[\p{L}\p{N}]+/gu;

function wordsOf(text: string): Word[] {
  return [...text.matchAll(WORD)].map((match) => ({ key: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length }));
}

/** The phrase's words in comparison form; empty for a phrase with no letter or digit. */
export function phraseWords(phrase: string): string[] {
  return wordsOf(phrase).map((word) => word.key);
}

/** Start indexes at which the phrase's words occur in the description's words. */
function occurrences(words: readonly Word[], phrase: readonly string[]): number[] {
  if (phrase.length === 0) return [];
  const found: number[] = [];
  for (let start = 0; start + phrase.length <= words.length; start += 1) {
    if (phrase.every((key, offset) => words[start + offset]?.key === key)) found.push(start);
  }
  return found;
}

export interface MatchedCriterion {
  criterion: Criterion;
  /** The description's text of the criterion's first occurrence (earliest, then longest). */
  matched_text: string;
}

export interface DescriptionMatch {
  /** Matched criteria in catalog order. Empty when the description is treated as no description. */
  criteria: MatchedCriterion[];
  /** Each maximal run of uncovered words, as the description's text from its first word to its last. */
  unmatched_text: string[];
  /** True when the description has no word outside filler phrases, so it counts as no description. */
  treated_as_none: boolean;
}

export function matchDescription(description: string, criteria: readonly Criterion[], fillerPhrases: readonly string[]): DescriptionMatch {
  const words = wordsOf(description);
  const covered = new Array<boolean>(words.length).fill(false);
  const cover = (start: number, length: number): void => {
    for (let index = start; index < start + length; index += 1) covered[index] = true;
  };
  for (const filler of fillerPhrases) {
    const phrase = phraseWords(filler);
    for (const start of occurrences(words, phrase)) cover(start, phrase.length);
  }
  const matched: MatchedCriterion[] = [];
  for (const criterion of criteria) {
    let best: { start: number; length: number } | null = null;
    for (const example of criterion.example_phrases) {
      const phrase = phraseWords(example);
      for (const start of occurrences(words, phrase)) {
        cover(start, phrase.length);
        if (best === null || start < best.start || (start === best.start && phrase.length > best.length)) best = { start, length: phrase.length };
      }
    }
    if (best !== null) {
      const first = words[best.start];
      const last = words[best.start + best.length - 1];
      if (first !== undefined && last !== undefined) matched.push({ criterion, matched_text: description.slice(first.start, last.end) });
    }
  }
  const unmatched: string[] = [];
  let runStart: number | null = null;
  for (let index = 0; index <= words.length; index += 1) {
    const uncovered = index < words.length && covered[index] !== true;
    if (uncovered && runStart === null) runStart = index;
    if (!uncovered && runStart !== null) {
      const first = words[runStart];
      const last = words[index - 1];
      if (first !== undefined && last !== undefined) unmatched.push(description.slice(first.start, last.end));
      runStart = null;
    }
  }
  const treatedAsNone = matched.length === 0 && unmatched.length === 0;
  return { criteria: treatedAsNone ? [] : matched, unmatched_text: unmatched, treated_as_none: treatedAsNone };
}
