// The proven catalog pairs a bug shape may point at: the (host, bug type) pairs the factory's
// capabilities list as supported, each with the criteria phrases the factory interpreter recognizes for
// that bug type. A fit the model names is kept only when its pair is one of these and its phrase is one of
// the pair's phrases, word for word as the interpreter matches them.
import type { Capabilities, HostId } from "@rbw/factory-contract";
import { phraseWords } from "@rbw/factory";
import type { CatalogPair } from "./prompts.ts";

export function catalogPairs(capabilities: Capabilities): CatalogPair[] {
  return capabilities.combinations
    .filter((combination) => combination.status === "supported")
    .flatMap((combination) => {
      const type = capabilities.bug_types.find((item) => item.bug_type_id === combination.bug_type_id);
      if (type === undefined) return [];
      return [{ host_id: combination.host_id, bug_type_id: type.bug_type_id, bug_type_label: type.label, phrases: type.criteria.flatMap((criterion) => criterion.example_phrases) }];
    });
}

export interface Fit {
  host_id: HostId;
  bug_type_id: string;
  phrase: string;
}

/** The fit with the catalog's own phrase text, or null when the pair or the phrase is not recognized. */
export function checkedFit(pairs: readonly CatalogPair[], hostId: string, bugTypeId: string, phrase: string): Fit | null {
  const pair = pairs.find((item) => item.host_id === hostId && item.bug_type_id === bugTypeId);
  if (pair === undefined) return null;
  const words = phraseWords(phrase).join(" ");
  if (words === "") return null;
  const found = pair.phrases.find((item) => phraseWords(item).join(" ") === words);
  return found === undefined ? null : { host_id: pair.host_id, bug_type_id: pair.bug_type_id, phrase: found };
}
