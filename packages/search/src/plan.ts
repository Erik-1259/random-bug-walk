// The fixed call plan: six named calls, their request options, and the local checks that run
// before anything is reserved (domain policy and query hygiene).
import { z } from "zod";
import type { SearchInput } from "./search-input.ts";

export const SOURCE_NAMES = ["source-1", "source-2"] as const;
export const DOCS_NAMES = ["docs-1"] as const;
export const PHRASE_NAMES = ["phrase-1", "phrase-2", "phrase-3"] as const;
/** The closed list of call names, in plan order. */
export const CALL_NAMES = [...SOURCE_NAMES, ...DOCS_NAMES, ...PHRASE_NAMES] as const;
export type CallName = (typeof CALL_NAMES)[number];

/** Worst-case credits reserved per call: a search at advanced depth costs 2. */
export const CREDIT_LIMIT_PER_CALL = 2;
/** Hosts a source search may be restricted to, besides the configured project-docs domains. */
export const BASE_SOURCE_DOMAINS = ["github.com", "stackoverflow.com"] as const;

export const settingsSchema = z.strictObject({
  /** Per-call timeout in seconds. */
  timeout_seconds: z.number().positive(),
  max_results: z.number().int().min(1).max(20),
  /** Source and phrase results keep at most this many characters of Tavily's content excerpt. */
  excerpt_max_chars: z.number().int().positive(),
  /** An extract keeps at most `max_passages` passages of at most `passage_max_chars` characters. */
  passage_max_chars: z.number().int().positive(),
  max_passages: z.number().int().positive(),
  project_docs_domains: z.array(z.string().min(1)),
});

export type SearchSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: SearchSettings = {
  timeout_seconds: 30,
  max_results: 5,
  excerpt_max_chars: 300,
  passage_max_chars: 2000,
  max_passages: 6,
  project_docs_domains: [],
};

/** The parts of the profile that do not come from settings. Changing any of them changes the digest. */
export const PLAN_PROFILE = {
  version: 1,
  calls: CALL_NAMES,
  credit_limit_per_call: CREDIT_LIMIT_PER_CALL,
  base_source_domains: BASE_SOURCE_DOMAINS,
  search: { searchDepth: "basic", autoParameters: false, includeUsage: true },
  source: { includeDomainsMode: "restrict" },
  extract: { extractDepth: "basic", includeUsage: true },
  phrase: { exactMatch: true },
};

export function isCallName(name: string, names: readonly string[]): boolean {
  return names.includes(name);
}

export function phraseIndex(name: string): number {
  return Number(name.slice("phrase-".length)) - 1;
}

export function sourceQuery(name: string, input: SearchInput): string {
  const { shape_keywords, symptom_words } = input.source;
  const words = name === "source-1" ? [...shape_keywords, ...symptom_words] : [...symptom_words, ...shape_keywords];
  return words.join(" ");
}

export function sourceOptions(input: SearchInput, settings: SearchSettings): Record<string, unknown> {
  return {
    searchDepth: "basic",
    maxResults: settings.max_results,
    includeDomains: input.source.include_domains,
    includeDomainsMode: "restrict",
    startDate: input.source.start_date,
    endDate: input.source.end_date,
    autoParameters: false,
    includeUsage: true,
    timeout: settings.timeout_seconds,
  };
}

export function phraseOptions(settings: SearchSettings): Record<string, unknown> {
  return {
    searchDepth: "basic",
    maxResults: settings.max_results,
    autoParameters: false,
    includeUsage: true,
    exactMatch: true,
    timeout: settings.timeout_seconds,
  };
}

export function docsOptions(input: SearchInput, settings: SearchSettings): Record<string, unknown> {
  return {
    extractDepth: "basic",
    includeUsage: true,
    query: input.docs.query,
    timeout: settings.timeout_seconds,
  };
}

function hostMatches(host: string, domain: string): boolean {
  const d = domain.toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

export type PolicyRefusal =
  | "docs_domain_excluded"
  | "docs_domain_not_allowed"
  | "source_domain_not_allowed"
  | "excluded_identifier";

/** Checks the docs URL against the allowed and excluded domain lists. Excluded wins. */
export function checkDocsUrl(input: SearchInput): PolicyRefusal | null {
  let host: string;
  try {
    const url = new URL(input.docs.url);
    if (url.protocol !== "https:") {
      return "docs_domain_not_allowed";
    }
    host = url.hostname.toLowerCase();
  } catch {
    return "docs_domain_not_allowed";
  }
  if (input.docs_policy.excluded_domains.some((d) => hostMatches(host, d))) {
    return "docs_domain_excluded";
  }
  return input.docs_policy.allowed_domains.some((d) => hostMatches(host, d)) ? null : "docs_domain_not_allowed";
}

/** Source searches may be restricted only to GitHub, Stack Overflow and the project-docs domains. */
export function checkSourceDomains(input: SearchInput, settings: SearchSettings): PolicyRefusal | null {
  const allowed = [...BASE_SOURCE_DOMAINS, ...settings.project_docs_domains];
  const excluded = input.docs_policy.excluded_domains;
  for (const domain of input.source.include_domains) {
    const host = domain.toLowerCase();
    if (excluded.some((d) => hostMatches(host, d)) || !allowed.some((d) => hostMatches(host, d))) {
      return "source_domain_not_allowed";
    }
  }
  return null;
}

/** A query may not contain any term of the caller's excluded-identifier list (case-insensitive). */
export function checkQuery(query: string, excludedIdentifiers: readonly string[]): PolicyRefusal | null {
  const lower = query.toLowerCase();
  return excludedIdentifiers.some((term) => lower.includes(term.toLowerCase())) ? "excluded_identifier" : null;
}
