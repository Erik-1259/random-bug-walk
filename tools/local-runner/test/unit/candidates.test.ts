// The real inputs for the first live writer and search recordings of fixture umami-tz-arg-001.
// Every file is parsed with its own package's parser, every value is compared with the source it
// is copied or computed from, and both request paths are rendered without any network: the
// writer's preview, and the search client's six requests answered in process.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { buildPolicy, callName, operationId as schemaOperationId, providerCallIdentity } from "@rbw/schema";
import {
  CALL_NAMES,
  CREDIT_LIMIT_PER_CALL,
  DEFAULT_SETTINGS,
  createSearcher,
  createTavilyClient,
  parseRateSheet as parseSearchRates,
  parseRunContext as parseSearchContext,
  parseSearchInput,
  priceOf,
  settingsSchema,
} from "@rbw/search";
import type { CallResult } from "@rbw/search";
import { DT1_SOURCE, DT1_TARGET, PLANTED_RULE_ID, FIXED_RULE_ID, SHAPE_ID, SOURCE_RULE_ID } from "@rbw/shapes";
import { createSpend, migrate } from "@rbw/spend";
import { loadFixture, queryString } from "@rbw/umami-fixture";
import {
  CardSourceSchema,
  MAX_INPUT_TOKENS,
  MODEL_ID,
  actualMicrousd,
  buildEnvelope,
  checkIssue,
  createWriter,
  createWriterProvider,
  operationId as writerOperationId,
  parseObservedSymptom,
  parseRateSheet as parseWriterRates,
  parseRunContext as parseWriterContext,
  runtimeProfileSha256,
} from "@rbw/writer";
import type { IssueOutput, ObservedSymptom } from "@rbw/writer";
import axios, { AxiosHeaders } from "axios";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { afterEach, describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../candidates/umami-tz-arg-001/", import.meta.url));
const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const PR_URL = "https://github.com/umami-software/umami/pull/4112";
const COMMIT_URL = `https://github.com/umami-software/umami/commit/${DT1_SOURCE.commit}`;
const DOCS_URL = "https://docs.umami.is/docs/api-reference/get-website-pageviews";

function bytes(file: string): Buffer {
  return readFileSync(join(DIR, file));
}

function json(file: string): unknown {
  return JSON.parse(bytes(file).toString("utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} is not an object`);
  return value;
}

function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${what} is not a list of strings`);
  return value;
}

interface WriterInput {
  candidate: string;
  card: unknown;
  symptom: ObservedSymptom;
  excluded: string[];
}

function writerInput(): WriterInput {
  const root = record(json("writer-input.json"), "writer-input.json");
  expect(Object.keys(root).sort()).toEqual(["candidate", "card", "issue"]);
  const issue = record(root.issue, "issue");
  expect(Object.keys(issue).sort()).toEqual(["excluded_identifiers", "symptom"]);
  if (typeof root.candidate !== "string") throw new Error("candidate is not a string");
  const parsed = parseObservedSymptom(issue.symptom);
  if (!parsed.ok) throw new Error(parsed.detail);
  return { candidate: root.candidate, card: root.card, symptom: parsed.symptom, excluded: strings(issue.excluded_identifiers, "excluded_identifiers") };
}

interface SearchFile {
  input: unknown;
  settings: unknown;
  excluded: string[];
}

function searchFile(): SearchFile {
  const root = record(json("search-input.json"), "search-input.json");
  expect(Object.keys(root).sort()).toEqual(["excluded_identifiers", "input", "settings"]);
  return { input: root.input, settings: root.settings, excluded: strings(root.excluded_identifiers, "excluded_identifiers") };
}

/** The writer's run context, which the search package's parser must accept too. */
function context() {
  return parseWriterContext(json("context.json"));
}

/** Every text value of the symptom that a user wrote or saw, for the phrase and identifier checks. */
function symptomText(symptom: ObservedSymptom): string {
  return [symptom.user_action, symptom.fixture_description, ...symptom.events.map((event) => event.label), ...symptom.doc_excerpts.map((excerpt) => excerpt.text)].join("\n");
}

function counts(buckets: readonly { count: number }[]): number[] {
  return buckets.map((bucket) => bucket.count);
}

function labels(buckets: readonly { bucket_label: string }[]): string[] {
  return buckets.map((bucket) => bucket.bucket_label);
}

const fixture = loadFixture();
const liveProof = record(JSON.parse(readFileSync(join(REPO, "packages", "umami-fixture", "evidence", "live-proof.json"), "utf8")), "live-proof.json");

function check(timezone: string) {
  const found = fixture.checks.find((item) => item.timezone === timezone);
  if (found === undefined) throw new Error(`the fixture has no ${timezone} check`);
  return found;
}

/** The planted copy's recorded outcome for one check, from the live proof. */
function plantedOutcome(checkId: string): unknown {
  const states = record(liveProof.states, "states");
  const planted = record(states.planted, "states.planted");
  if (!Array.isArray(planted.observed)) throw new Error("states.planted.observed is not a list");
  return planted.observed.find((row) => isRecord(row) && row.check_id === checkId);
}

describe("writer-input.json", () => {
  it("names the fixture as the candidate, in the form both packages accept", () => {
    const { candidate } = writerInput();
    expect(candidate).toBe(fixture.fixture_id);
    expect(candidate).toMatch(/^[a-z0-9][a-z0-9_-]{0,39}$/);
  });

  it("holds a card source that the writer's strict card-source schema accepts, copied from the upstream fix", () => {
    const card = CardSourceSchema.parse(writerInput().card);
    expect(card.source_links).toEqual([PR_URL, COMMIT_URL]);
    expect(card.repository).toBe("https://github.com/umami-software/umami");
    expect(card.date).toBe("2026-03-25");
    expect(card.license).toBe("MIT");
    expect(card.diff_excerpt).toContain(`diff --git a/${DT1_SOURCE.path} b/${DT1_SOURCE.path}`);
    expect(card.diff_excerpt).toContain(`index ${DT1_SOURCE.before.gitBlob.slice(0, 7)}..${DT1_SOURCE.after.gitBlob.slice(0, 7)} 100644`);
    expect(card.diff_excerpt).toContain("\n-  } = useDateRange();\n+  } = useDateRange({ timezone });\n");
    expect(card.diff_excerpt).toContain("\n+  const { timezone } = useTimezone();\n");
    expect(card.issue_text).toContain("fix: use settings timezone in revenue chart date range");
    expect(card.issue_text).toContain("Fixes #4107");
  });

  it("takes the confirmation from the shape and the source rule's confirmed lines", () => {
    const { confirmation, diff_excerpt } = CardSourceSchema.parse(writerInput().card);
    expect(confirmation.shape_id).toBe(SHAPE_ID);
    expect(confirmation.rules_matched).toEqual([SOURCE_RULE_ID]);
    expect(confirmation.matched_lines).toEqual(["-  } = useDateRange();", "+  } = useDateRange({ timezone });"]);
    for (const line of confirmation.matched_lines) expect(diff_excerpt.split("\n")).toContain(line);
    expect(confirmation.matched_lines[0]).toContain(`${DT1_SOURCE.callee}()`);
    expect(confirmation.matched_lines[1]).toContain(`${DT1_SOURCE.callee}({ ${DT1_SOURCE.argument} })`);
  });

  it("describes the Los Angeles check's request exactly as the fixture's check sends it", () => {
    const { symptom } = writerInput();
    const la = check("America/Los_Angeles");
    expect(symptom.request).toEqual({ method: "GET", path: fixture.request.path, query: Object.fromEntries(new URLSearchParams(queryString(fixture, la))) });
    expect(new URLSearchParams(symptom.request.query).toString()).toBe(queryString(fixture, la));
    expect(symptom.timezone).toBe(la.timezone);
    expect(symptom.locale).toBeNull();
    expect(symptom.http_status).toBe(200);
  });

  it("lists every recorded visit from the data file, in order", () => {
    const { symptom } = writerInput();
    expect(symptom.events.map((event) => [event.timestamp_seconds, event.utc_instant])).toEqual(fixture.events.map((event) => [event.timestamp_seconds, event.utc_instant]));
  });

  it("takes expected counts from the fixture's derived table and labels from its bucket labels", () => {
    const { symptom } = writerInput();
    expect(labels(symptom.expected)).toEqual(fixture.bucket_labels);
    expect(counts(symptom.expected)).toEqual(check("America/Los_Angeles").expected);
    expect(symptom.follow_up_examples.map((example) => example.timezone)).toEqual(["Pacific/Auckland", "Asia/Kolkata"]);
    for (const example of symptom.follow_up_examples) {
      expect(labels(example.expected)).toEqual(fixture.bucket_labels);
      expect(counts(example.expected)).toEqual(check(example.timezone).expected);
    }
  });

  it("gives the planted counts [2, 8, 2] for each zone whose planted outcome the live proof records as a count mismatch", () => {
    const { symptom } = writerInput();
    const rows = [
      { timezone: symptom.timezone, expected: symptom.expected, observed: symptom.observed },
      ...symptom.follow_up_examples,
    ];
    for (const row of rows) {
      const checkId = check(row.timezone).check_id;
      expect(plantedOutcome(checkId)).toEqual({ check_id: checkId, failure_code: "local_day_counts_mismatch", observed: "assertion_fail" });
      // A count mismatch means the labels were exactly the expected ones and some count differed.
      expect(labels(row.observed)).toEqual(fixture.bucket_labels);
      expect(counts(row.observed)).toEqual([2, 8, 2]);
      expect(counts(row.observed)).not.toEqual(counts(row.expected));
      expect(counts(row.observed)).toEqual(fixture.predicted_planted_counts.counts[checkId]);
    }
  });

  it("lists the identifiers that would give the answer away, and none of them appears in the symptom", () => {
    const { symptom, excluded } = writerInput();
    expect(excluded).toEqual(expect.arrayContaining([
      fixture.fixture_id,
      SHAPE_ID,
      FIXED_RULE_ID,
      PLANTED_RULE_ID,
      SOURCE_RULE_ID,
      ...fixture.checks.map((item) => item.check_id),
      DT1_TARGET.functionName,
      DT1_TARGET.path,
      "getDateSQL",
      "getPageviewStats",
      DT1_SOURCE.commit,
    ]));
    expect(new Set(excluded).size).toBe(excluded.length);
    const text = JSON.stringify(symptom).toLowerCase();
    for (const term of excluded) expect(text, term).not.toContain(term.toLowerCase());
  });
});

describe("the writer's issue checks on the symptom's own numbers", () => {
  function issueFrom(symptom: ObservedSymptom, actual: readonly number[]): IssueOutput {
    return {
      title: `Daily pageview counts land on the wrong day for ${symptom.timezone}`,
      reproduction_steps: [symptom.user_action, `Send GET ${symptom.request.path} with unit=${symptom.request.query.unit ?? ""} and timezone=${symptom.timezone}.`],
      expected_result: `Counts of ${counts(symptom.expected).join(", ")} for the three days.`,
      actual_result: `Counts of ${actual.join(", ")} for the three days.`,
      environment: `HTTP ${String(symptom.http_status)}, time zone ${symptom.timezone}.`,
    };
  }

  it("passes an issue that states the expected and observed counts", () => {
    const { symptom, excluded } = writerInput();
    const report = checkIssue(issueFrom(symptom, counts(symptom.observed)), symptom, excluded);
    expect(report.codes).toEqual([]);
    expect(report.status).toBe("ready_for_review");
  });

  it("rejects an issue whose actual result does not state the observed counts", () => {
    const { symptom, excluded } = writerInput();
    const report = checkIssue(issueFrom(symptom, counts(symptom.expected)), symptom, excluded);
    expect(report.status).toBe("rejected");
    expect(report.codes).toEqual(["numeric_mismatch"]);
  });
});

describe("search-input.json", () => {
  it("parses with the search input schema and the settings schema, and keeps the package's default settings", () => {
    const file = searchFile();
    const input = parseSearchInput(file.input);
    expect(input.candidate).toBe(writerInput().candidate);
    expect(settingsSchema.parse(file.settings)).toEqual(DEFAULT_SETTINGS);
    expect(input.docs).toEqual({ url: DOCS_URL, query: input.docs.query });
    expect(input.docs_policy).toEqual({ allowed_domains: ["docs.umami.is"], excluded_domains: ["date-fns.org"] });
    expect(input.source.include_domains).toEqual(["github.com", "stackoverflow.com"]);
  });

  it("uses the writer's excluded identifiers", () => {
    expect(searchFile().excluded).toEqual(writerInput().excluded);
  });

  it("takes each of the three exact phrases from the symptom's wording", () => {
    const input = parseSearchInput(searchFile().input);
    const text = symptomText(writerInput().symptom);
    for (const phrase of input.phrases) expect(text).toContain(phrase);
  });
});

describe("rates.json and search-rates.json", () => {
  const envelopeSheet = record(JSON.parse(readFileSync(join(REPO, "packages", "envelope", "rate-sheets", "v1.json"), "utf8")), "v1.json");
  // The writer's model and Tavily's API are the subjects the envelope sheet prices them under.
  const subjects: Record<string, string> = { "token-factory": MODEL_ID, tavily: "api" };
  const pinned = (service: string, unit: string): unknown => {
    if (!Array.isArray(envelopeSheet.entries)) throw new Error("v1.json has no entries");
    const entry = record(
      envelopeSheet.entries.find((item) => isRecord(item) && item.service === service && item.subject === subjects[service] && item.unit === unit),
      `${service} ${unit}`,
    );
    return { service: entry.service, unit: entry.unit, price: entry.price, source_url: entry.source_url };
  };

  it("holds the envelope package's pinned Lightning prices in the writer's rate format", () => {
    const sheet = parseWriterRates(bytes("rates.json"));
    if (!sheet.ok) throw new Error(sheet.detail);
    expect(sheet.entries).toEqual([pinned("token-factory", "input_token"), pinned("token-factory", "output_token")]);
    expect(buildEnvelope(sheet.entries).ok).toBe(true);
  });

  it("holds the pinned Tavily credit price in the search package's rate format", () => {
    const sheet = parseSearchRates(bytes("search-rates.json"));
    expect(sheet.entries).toEqual([pinned("tavily", "credit")]);
    expect(priceOf(sheet, "tavily", "credit")).toEqual({ microusd: 8000, per_units: 1 });
  });

  it("reserves 7,868 micro-USD for two writer calls and 96,000 for six Tavily calls", () => {
    const writerSheet = parseWriterRates(bytes("rates.json"));
    if (!writerSheet.ok) throw new Error(writerSheet.detail);
    const envelope = buildEnvelope(writerSheet.entries);
    if (!envelope.ok) throw new Error(envelope.detail);
    const perWriterCall = envelope.envelope.reduce((sum, line) => sum + (line.price === null ? Number.NaN : actualMicrousd(line.limit, line.price)), 0);
    const tavily = priceOf(parseSearchRates(bytes("search-rates.json")), "tavily", "credit");
    if (tavily === null) throw new Error("no Tavily price");
    const perSearchCall = actualMicrousd(CREDIT_LIMIT_PER_CALL, tavily);
    expect([perWriterCall, perSearchCall]).toEqual([3934, 16000]);
    expect(2 * perWriterCall + CALL_NAMES.length * perSearchCall).toBe(103868);
  });
});

describe("context.json and max-calls", () => {
  it("is a run context both packages accept", () => {
    const value = json("context.json");
    expect(parseWriterContext(value)).toEqual(value);
    expect(parseSearchContext(value)).toEqual(value);
  });

  it("carries the policy hash that the schema's buildPolicy computes for the development project", () => {
    const ctx = context();
    expect(ctx.project_policy_sha256).toBe(buildPolicy({ projectId: ctx.project_id, outputRepository: null, publicArtifactBaseUri: null, policyVersion: 1 }).sha256);
  });

  it("gives writer operation IDs equal to the schema's operationId, for the card at ordinal 1 and the issue at ordinal 2", () => {
    // `record --max-calls 2` writes the card first; ordinals are shared across both writer kinds.
    const ctx = context();
    const { candidate } = writerInput();
    const readme = bytes("README.md").toString("utf8");
    for (const [kind, ordinal] of [["writer.card", 1], ["writer.issue", 2]] as const) {
      const expected = schemaOperationId(
        providerCallIdentity({ ...ctx, kind, runtime_profile_sha256: runtimeProfileSha256(), call_name: callName(kind, candidate, ordinal), attempt_ordinal: 1 }),
      ).sha256;
      expect(writerOperationId({ context: ctx, kind, candidate, callOrdinal: ordinal, attemptOrdinal: 1 })).toBe(expected);
      expect(readme).toContain(`\`${expected.slice(0, 8)}…${expected.slice(-7)}\` for \`${kind}:${candidate}:${String(ordinal)}\``);
    }
  });

  it("allows exactly two writer calls", () => {
    expect(bytes("max-calls").toString("utf8")).toBe("2\n");
  });
});

interface Captured {
  endpoint: string;
  body: Record<string, unknown>;
}

const interceptors: number[] = [];

afterEach(() => {
  for (const id of interceptors.splice(0)) axios.interceptors.request.eject(id);
});

/** Answers the search client's requests in process with a minimal successful body, and keeps each request body. */
function captureSearchRequests(): Captured[] {
  const captured: Captured[] = [];
  const adapter = (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const endpoint = (config.url ?? "").split("/").filter(Boolean).pop() ?? "";
    const parsed: unknown = typeof config.data === "string" ? JSON.parse(config.data) : {};
    const body = { ...record(parsed, "request body") };
    delete body.api_key;
    captured.push({ endpoint, body });
    const urls = Array.isArray(body.urls) ? strings(body.urls, "urls") : [];
    const data =
      endpoint === "extract"
        ? { results: urls.map((url) => ({ url, raw_content: "synthetic passage" })), failed_results: [], response_time: 0, usage: { credits: 1 } }
        : { query: body.query, results: [], response_time: 0, usage: { credits: 1 } };
    return Promise.resolve({ data: JSON.stringify(data), status: 200, statusText: "OK", headers: new AxiosHeaders({ "content-type": "application/json" }), config, request: {} });
  };
  interceptors.push(
    axios.interceptors.request.use((config) => {
      config.adapter = adapter;
      return config;
    }),
  );
  return captured;
}

async function developmentLedger(rootExecutionId: string) {
  const db = await PGlite.create();
  await migrate(db, { schema: "public" });
  const spend = createSpend({ client: db, schema: "public" });
  const slot = await spend.createSlotKey({ slot_key: "development", actor_role: "owner", reason: "candidate input preview" });
  if (!slot.ok) throw new Error(slot.code);
  const hold = await spend.acquireSlot({ slot_key: "development", root_execution_id: rootExecutionId, actor_role: "workflow" });
  if (!hold.ok) throw new Error(hold.code);
  return { db, spend };
}

describe("request preview, with no network", () => {
  it("renders the card and issue requests within the writer's input-token bound", async () => {
    const ctx = context();
    const { db, spend } = await developmentLedger(ctx.root_execution_id);
    try {
      const writer = createWriter({
        spend,
        provider: createWriterProvider({ fetch: () => Promise.reject(new Error("a preview sends nothing")) }),
        context: ctx,
        poolKey: "development",
        allocationKey: null,
        slotKey: "development",
        rateSheet: bytes("rates.json"),
      });
      const input = writerInput();
      const card = await writer.previewCard(input.card);
      const issue = await writer.previewIssue(input.symptom);
      if (!card.ok || !issue.ok) throw new Error("a preview was refused");
      expect(card.input_token_bound).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
      expect(issue.input_token_bound).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
      expect(card.request_body).toContain("useDateRange({ timezone })");
      expect(issue.request_body).toContain("America/Los_Angeles");
      expect(issue.request_body).not.toContain("useDateRange");
    } finally {
      await db.close();
    }
  });

  it("runs the six planned searches past every local query check, reserving 16,000 micro-USD each", async () => {
    const ctx = context();
    const file = searchFile();
    const input = parseSearchInput(file.input);
    const { db, spend } = await developmentLedger(ctx.root_execution_id);
    const captured = captureSearchRequests();
    try {
      const searcher = createSearcher({
        client: createTavilyClient({ apiKey: "preview-placeholder", apiBaseURL: "https://search-preview.example.invalid" }),
        spend,
        context: ctx,
        rates: parseSearchRates(bytes("search-rates.json")),
        poolKey: "development",
        slotKey: "development",
        settings: settingsSchema.parse(file.settings),
        excludedIdentifiers: file.excluded,
      });
      const results: CallResult[] = [
        await searcher.searchSource("source-1", file.input),
        await searcher.searchSource("source-2", file.input),
        await searcher.extractDocs("docs-1", file.input),
        await searcher.checkPhrase("phrase-1", file.input),
        await searcher.checkPhrase("phrase-2", file.input),
        await searcher.checkPhrase("phrase-3", file.input),
      ];
      for (const result of results) {
        if (result.status === "refused") throw new Error(`refused locally: ${result.code}`);
        expect(result.spend?.reserved_microusd).toBe(16000n);
      }
      const words = (first: string[], second: string[]): string => [...first, ...second].join(" ");
      expect(captured.map((request) => [request.endpoint, request.body.query ?? null])).toEqual([
        ["search", words(input.source.shape_keywords, input.source.symptom_words)],
        ["search", words(input.source.symptom_words, input.source.shape_keywords)],
        ["extract", input.docs.query],
        ...input.phrases.map((phrase) => ["search", `"${phrase}"`]),
      ]);
      expect(captured[2]?.body.urls).toEqual([DOCS_URL]);
      for (const request of captured) {
        const text = JSON.stringify(request.body).toLowerCase();
        for (const term of file.excluded) expect(text, term).not.toContain(term.toLowerCase());
      }
    } finally {
      await db.close();
    }
  });
});
