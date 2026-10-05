// Synthetic inputs and recorded responses for the tests. Wire bodies are written out literally here,
// independently of the implementation, so a test fails when the code sends different options.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Recording } from "./replay-server.ts";

export const RECORDINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "recordings", "synthetic");

export function hex(n: number): string {
  return n.toString(16).padStart(64, "0");
}

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export const ROOT = uuid(1);
export const POOL = "synthetic-pool";
export const SLOT = "synthetic-slot";
export const SYNTHETIC_KEY = "synthetic-key-for-tests";

export const CONTEXT = {
  project_id: uuid(100),
  project_policy_sha256: hex(3),
  batch_id: uuid(101),
  task_revision: hex(4),
  root_execution_id: ROOT,
  execution_id: ROOT,
  parent_execution_id: null,
};

export const RATE_ENTRIES = [
  {
    service: "tavily",
    unit: "credit",
    price: { microusd: 8000, per_units: 1 },
    source_url: "https://example.invalid/pricing",
  },
];

export const SEARCH_INPUT = {
  schema_version: 1,
  candidate: "synthetic-candidate-1",
  source: {
    shape_keywords: ["synthetic", "report", "filter"],
    symptom_words: ["empty", "table"],
    include_domains: ["github.com", "stackoverflow.com"],
    start_date: "2020-01-01",
    end_date: "2026-10-01",
  },
  docs: { url: "https://docs.example.invalid/guide/reports", query: "report filter shows empty table" },
  phrases: ["synthetic phrase one", "synthetic phrase two", "synthetic phrase three"],
  docs_policy: { allowed_domains: ["docs.example.invalid"], excluded_domains: ["datelib.example.invalid"] },
};

export const SETTINGS = {
  timeout_seconds: 30,
  max_results: 5,
  excerpt_max_chars: 300,
  passage_max_chars: 2000,
  max_passages: 6,
  project_docs_domains: ["docs.example.invalid"],
};

export const EXCLUDED_IDENTIFIERS = ["synthetic_internal_fn", "synthetic/internal/path.ts"];

/** The exact JSON body the SDK sends for each call of the plan, for SEARCH_INPUT and SETTINGS. */
export function wireBody(name: string): Record<string, unknown> {
  const common = { search_depth: "basic", max_results: 5, auto_parameters: false, include_usage: true };
  switch (name) {
    case "source-1":
    case "source-2":
      return {
        ...common,
        query: name === "source-1" ? "synthetic report filter empty table" : "empty table synthetic report filter",
        include_domains: ["github.com", "stackoverflow.com"],
        include_domains_mode: "restrict",
        start_date: "2020-01-01",
        end_date: "2026-10-01",
      };
    case "docs-1":
      return {
        urls: ["https://docs.example.invalid/guide/reports"],
        extract_depth: "basic",
        timeout: 30,
        include_usage: true,
        query: "report filter shows empty table",
      };
    case "phrase-1":
    case "phrase-2":
    case "phrase-3": {
      const phrase = SEARCH_INPUT.phrases[Number(name.slice(-1)) - 1];
      return { ...common, query: `"${phrase ?? ""}"`, exact_match: true };
    }
    default:
      throw new Error(`unknown call ${name}`);
  }
}

export function endpointOf(name: string): "search" | "extract" {
  return name === "docs-1" ? "extract" : "search";
}

const RECORDED_AT = "2026-10-04T12:00:00.000Z";

function searchBody(query: string, count: number, usage: { credits: number } | null): Record<string, unknown> {
  const results = Array.from({ length: count }, (_, i) => ({
    url: `https://example.invalid/issues/${String(100 + i)}`,
    title: `Synthetic result ${String(i + 1)}`,
    content: `Synthetic excerpt ${String(i + 1)} about ${query.replaceAll('"', "")}.`,
    score: 0.9 - i * 0.1,
    raw_content: null,
    ...(i === 0 ? { published_date: "2024-05-01" } : {}),
  }));
  return {
    query,
    follow_up_questions: null,
    answer: null,
    images: [],
    results,
    response_time: 0.5,
    ...(usage === null ? {} : { usage }),
  };
}

const ERROR_429 = { detail: { error: "Too many requests (synthetic)." } };
const ERROR_500 = { detail: { error: "Internal server error (synthetic)." } };

function extractBody(options: { failed?: boolean; credits: number | null }): Record<string, unknown> {
  const url = "https://docs.example.invalid/guide/reports";
  return {
    results: options.failed
      ? []
      : [
          {
            url,
            raw_content: "Reports can be filtered by date. [...] An empty filter shows every row.",
            images: [],
            favicon: null,
          },
        ],
    failed_results: options.failed ? [{ url, error: "synthetic fetch failure" }] : [],
    response_time: 0.7,
    ...(options.credits === null ? {} : { usage: { credits: options.credits } }),
  };
}

/** Every committed synthetic recording, by file name without extension. */
export function buildRecordings(): Record<string, Recording> {
  const out: Record<string, Recording> = {};
  const add = (name: string, scenario: string, status: number, body: unknown): void => {
    out[`${name}.${scenario}`] = {
      schema_version: 1,
      provenance: "synthetic",
      endpoint: endpointOf(name),
      recorded_at: RECORDED_AT,
      request_body: wireBody(name),
      response: { status, body },
    };
  };
  for (const name of ["source-1", "source-2"]) {
    const query = String(wireBody(name).query);
    add(name, "ok", 200, searchBody(query, 3, { credits: 1 }));
    add(name, "no-usage", 200, searchBody(query, 3, null));
    add(name, "credits-3", 200, searchBody(query, 3, { credits: 3 }));
    add(name, "429", 429, ERROR_429);
    add(name, "500", 500, ERROR_500);
    add(name, "malformed", 200, { results: "not-a-list" });
    add(name, "bad-result", 200, { images: [], results: [{ content: "no url here" }], usage: { credits: 1 } });
  }
  for (const name of ["phrase-1", "phrase-2", "phrase-3"]) {
    const query = String(wireBody(name).query);
    add(name, "zero-results", 200, searchBody(query, 0, { credits: 1 }));
    add(name, "match", 200, searchBody(query, 2, { credits: 1 }));
    add(name, "no-usage", 200, searchBody(query, 0, null));
    add(name, "429", 429, ERROR_429);
    add(name, "500", 500, ERROR_500);
    add(name, "malformed", 200, { results: "not-a-list" });
    add(name, "bad-result", 200, { images: [], results: [{ content: "no url here" }], usage: { credits: 1 } });
  }
  add("docs-1", "ok", 200, extractBody({ credits: 1 }));
  add("docs-1", "failed-url", 200, extractBody({ failed: true, credits: 0 }));
  add("docs-1", "zero-credits", 200, extractBody({ credits: 0 }));
  add("docs-1", "no-usage", 200, extractBody({ credits: null }));
  add("docs-1", "500", 500, ERROR_500);
  return out;
}

export function loadRecording(name: string): Recording {
  return JSON.parse(readFileSync(join(RECORDINGS_DIR, `${name}.json`), "utf8")) as Recording;
}

/** Loads the named synthetic recordings, for example `["source-1.ok", "docs-1.ok"]`. */
export function loadRecordings(names: string[]): Recording[] {
  return names.map(loadRecording);
}

export const ALL_OK = [
  "source-1.ok",
  "source-2.ok",
  "docs-1.ok",
  "phrase-1.zero-results",
  "phrase-2.zero-results",
  "phrase-3.zero-results",
];
