// Synthetic inputs and synthetic model responses for the committed recordings. No value here was
// observed from a real system: counts, instants and identifiers are invented for the tests.

/** 64 lowercase hexadecimal characters derived from a small number. */
export function hex(n: number): string {
  return n.toString(16).padStart(64, "0");
}

/** A lowercase UUID string derived from a small number. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export const CONTEXT = {
  project_id: uuid(1),
  project_policy_sha256: hex(11),
  batch_id: uuid(2),
  task_revision: hex(12),
  root_execution_id: uuid(3),
  execution_id: uuid(4),
  parent_execution_id: uuid(3),
};

export const RATE_ENTRIES = [
  {
    service: "token-factory",
    unit: "input_token",
    price: { microusd: 60_000, per_units: 1_000_000 },
    source_url: "https://prices.example.invalid/synthetic",
  },
  {
    service: "token-factory",
    unit: "output_token",
    price: { microusd: 240_000, per_units: 1_000_000 },
    source_url: "https://prices.example.invalid/synthetic",
  },
];

/** Worst case of one call at the synthetic prices: ceil(32768 × 0.06) + ceil(8192 × 0.24) micro-USD. */
export const CALL_WORST_CASE_MICROUSD = 1967 + 1967;

export const CANDIDATE = "synthetic-candidate-1";

/** The fixture's internal names, supplied by the caller as data. All synthetic. */
export const EXCLUDED_IDENTIFIERS = ["getSyntheticRange", "syntheticBucketHelper", "synthetic.check-one"];

export const ISSUE_CASES = [
  "valid",
  "schema-invalid",
  "missing-usage",
  "unsupported-number",
  "excluded-identifier",
  "hint-words",
  "http-500",
] as const;
export type IssueCase = (typeof ISSUE_CASES)[number];

export const CARD_CASES = ["valid", "bug-class-out-of-list"] as const;
export type CardCase = (typeof CARD_CASES)[number];

const buckets = (pairs: [string, number][]): { bucket_label: string; count: number }[] =>
  pairs.map(([bucket_label, count]) => ({ bucket_label, count }));

/**
 * A synthetic observation. Each case gets its own wording so that each case renders a distinct
 * request body, and so a distinct recording.
 */
export function symptom(variant: string): Record<string, unknown> {
  return {
    schema_version: 1,
    user_action: `Opened the daily pageview report for a two-day range with the reporting timezone set to America/Los_Angeles (synthetic case ${variant}).`,
    request: {
      method: "GET",
      path: "/api/websites/synthetic-website/pageviews",
      query: { unit: "day", timezone: "America/Los_Angeles" },
    },
    timezone: "America/Los_Angeles",
    locale: "en-US",
    fixture_description: "Eight synthetic pageviews: six on the evening of 1 January local time and two on 2 January.",
    events: [
      { label: "first pageview", timestamp_seconds: 1767322800, utc_instant: "2026-01-02T03:00:00Z" },
      { label: "last pageview", timestamp_seconds: 1767398400, utc_instant: "2026-01-03T00:00:00Z" },
    ],
    http_status: 200,
    expected: buckets([
      ["2026-01-01", 6],
      ["2026-01-02", 2],
    ]),
    observed: buckets([
      ["2026-01-01", 0],
      ["2026-01-02", 8],
    ]),
    follow_up_examples: [
      { timezone: "Pacific/Auckland", expected: buckets([["2026-01-02", 8]]), observed: buckets([["2026-01-02", 8]]) },
      { timezone: "Asia/Kolkata", expected: buckets([["2026-01-02", 8]]), observed: buckets([["2026-01-02", 8]]) },
    ],
    doc_excerpts: [
      {
        text: "Synthetic excerpt: reports group pageviews by day in the timezone selected for the report.",
        source_url: "https://docs.example.invalid/reports",
      },
    ],
  };
}

const VALID_ISSUE = {
  title: "Daily pageview counts do not follow the requested reporting timezone",
  reproduction_steps: [
    "Record eight pageviews: six on the evening of 2026-01-01 and two on 2026-01-02, America/Los_Angeles time.",
    "Open the daily pageview report for 2026-01-01 to 2026-01-02 with the timezone America/Los_Angeles.",
  ],
  expected_result: "2026-01-01 shows 6 pageviews and 2026-01-02 shows 2 pageviews.",
  actual_result: "2026-01-01 shows 0 pageviews and 2026-01-02 shows 8 pageviews.",
  environment: "Reporting timezone America/Los_Angeles, locale en-US, response status 200.",
};

export const ISSUE_OUTPUTS: Record<IssueCase, unknown> = {
  valid: VALID_ISSUE,
  "schema-invalid": { title: VALID_ISSUE.title, expected_result: VALID_ISSUE.expected_result },
  "missing-usage": VALID_ISSUE,
  "unsupported-number": { ...VALID_ISSUE, actual_result: `${VALID_ISSUE.actual_result} In total 97 pageviews are listed.` },
  "excluded-identifier": { ...VALID_ISSUE, environment: `${VALID_ISSUE.environment} The page calls getSyntheticRange.` },
  "hint-words": {
    ...VALID_ISSUE,
    environment: `${VALID_ISSUE.environment} The timezone parameter looks ignored, and the counts look like they use the default.`,
  },
  "http-500": null,
};

/** Card input: public source-fix information plus the caller's shape confirmation. */
export function cardSource(variant: string): Record<string, unknown> {
  return {
    source_links: ["https://code.example.invalid/synthetic-project/pull/1"],
    repository: "https://code.example.invalid/synthetic-project",
    date: "2026-01-15",
    license: "MIT",
    diff_excerpt: `- const range = synthetic(start, end);\n+ const range = synthetic(start, end, zone); // synthetic case ${variant}`,
    issue_text: "Synthetic source issue: daily totals shift by a day for some timezones.",
    confirmation: {
      card_id: "synthetic-card-1",
      shape_id: "synthetic-shape-1",
      rules_matched: ["synthetic-rule-a", "synthetic-rule-b"],
      matched_lines: ["+ const range = synthetic(start, end, zone);"],
    },
  };
}

/** The card as the model is asked for it: one state per runtime lever instead of the three lists. */
const VALID_CARD = {
  id: "synthetic-model-chosen-id",
  provenance: {
    source_links: ["https://model.example.invalid/wrong-link"],
    repository: "https://model.example.invalid/wrong-repository",
    date: "1999-12-31",
    license: "synthetic-model-licence",
  },
  bug_class: "time_and_date",
  mechanism: "Synthetic-card mechanism: a date range is computed without the caller-selected timezone.",
  shape: { shape_id: "synthetic-model-shape", rules_matched: ["synthetic-model-rule"], matched_lines: ["synthetic-model-line"] },
  fault_shape: "Synthetic-card fault shape: a dropped zone argument on a range helper.",
  trigger: "Synthetic-card trigger: a report requested in a timezone far from UTC.",
  symptom: "Synthetic-card symptom: daily buckets shift by one day.",
  apis: ["synthetic-card-api-range"],
  runtime_dependence: {
    value: "yes",
    reason: "Synthetic-card reason: the shift is visible only with recorded events near midnight.",
    levers: {
      hidden_runtime_state: "apply",
      distance_between_symptom_and_cause: "unverified",
      plausible_wrong_static_fix: "unverified",
      path_ambiguity: "unverified",
      ordering_or_concurrency: "absent",
      magnitude_visible_only_at_runtime: "apply",
      external_side_effect_semantics: "absent",
    },
  },
  fidelity_tier: "B",
  references: {
    diff_excerpt: "Synthetic-card diff excerpt reference",
    failing_tests: ["synthetic-card-failing-test"],
  },
};

export const CARD_OUTPUTS: Record<CardCase, unknown> = {
  valid: VALID_CARD,
  "bug-class-out-of-list": { ...VALID_CARD, bug_class: "memory_leaks" },
};

/** A synthetic OpenAI-compatible chat completion carrying `content`. */
export function completion(content: string, usage: { prompt_tokens: number; completion_tokens: number } | null): string {
  return JSON.stringify({
    id: "synthetic-completion",
    object: "chat.completion",
    created: 1767225600,
    model: "nvidia/Nemotron-3_5-Lightning",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage === null
      ? {}
      : { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }),
  });
}

/** Synthetic reported usage: small numbers, well inside every bound. */
export const SYNTHETIC_USAGE = { prompt_tokens: 1200, completion_tokens: 300 };
