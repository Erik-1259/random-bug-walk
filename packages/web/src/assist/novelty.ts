// The delivery brief's novelty check: up to three distinctive phrases from the delivered incident text,
// each searched on the public web as an exact phrase. It covers the report's wording only; the planted
// change and its fix come from RBW's public catalog.
import { NOVELTY_MAX_PHRASES } from "./limits.ts";

export const NOVELTY_CAVEAT = "The planted change and its fix come from RBW's public catalog, so they are not new. This check covers only the wording of the delivered incident report: whether its distinctive phrases already appear on the public web.";

const COMMON = new Set(
  "the a an and or but of to in on at by for with from as is are was were be been being it its this that these those when then than which who what where while after before into over under both each only same also not no one two can could would should will may might have has had does did do there their they them our your request requests response responses".split(" "),
);

const WINDOW = 6;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;

function score(words: readonly string[]): number {
  return words.reduce((total, word) => total + (COMMON.has(word.toLowerCase()) ? 0 : word.length >= 7 ? 2 : word.length >= 4 ? 1 : 0), 0);
}

/** The most distinctive word window of each sentence, best first, at most NOVELTY_MAX_PHRASES, none repeated. */
export function distinctivePhrases(text: string): string[] {
  const candidates: { phrase: string; score: number; order: number }[] = [];
  text.split(/[.!?;:\n]+/).forEach((sentence, order) => {
    const words = sentence.match(WORD) ?? [];
    if (words.length < 4) return;
    let best: { phrase: string; score: number } | null = null;
    for (let start = 0; start + Math.min(WINDOW, words.length) <= words.length; start += 1) {
      const window = words.slice(start, start + WINDOW);
      const value = score(window);
      if (best === null || value > best.score) best = { phrase: window.join(" "), score: value };
    }
    if (best !== null) candidates.push({ ...best, order });
  });
  const chosen: string[] = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score || a.order - b.order)) {
    if (chosen.length >= NOVELTY_MAX_PHRASES) break;
    if (!chosen.some((phrase) => phrase.toLowerCase() === candidate.phrase.toLowerCase())) chosen.push(candidate.phrase);
  }
  return chosen;
}
