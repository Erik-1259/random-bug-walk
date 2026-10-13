// The candidate attempt's test world: the controller harness's PGlite ledger and the local
// runner's simulated kit on the Docker backend, a ProjectPolicy with a synthetic project, a private
// candidate input, the writer's synthetic rates and a fake writer fetch, and a search client
// answered in process (source searches, the docs extract and the phrase checks). The fake issue's
// numbers come from the symptom the attempt built.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@rbw/search";
import type { SearchClient } from "@rbw/search";
import type { Spend } from "@rbw/spend";
import { buildPolicy, parseCanonical } from "@rbw/schema";
import type { ObservedSymptom, RaceSymptom } from "@rbw/schema";
import type { FetchFunction, IssueOutput } from "@rbw/writer";
import { CARD_OUTPUTS, RATE_ENTRIES, SYNTHETIC_USAGE, cardSource, completion } from "../../../../packages/writer/test/fixtures/cases.ts";
import { FakeDocker } from "../../../local-runner/test/support/fakes.ts";
import { writeAlternativeDir, writeManifest, writeProbeDir, writeTerms } from "../../../local-runner/test/support/synthetic.ts";
import type { AttemptDeps, AttemptInputs } from "../../src/attempt.ts";
import type { World } from "./harness.ts";

export const ATTEMPT_PROJECT_ID = "00000000-0000-4000-8000-0000000000a1";
export const CANDIDATE = "synthetic-candidate-1";
// Assembled at runtime so that no source line holds a key-like literal.
export const WRITER_KEY = ["synthetic", "writer", "key", "value"].join("-");
export const SEARCH_KEY = ["synthetic", "search", "key", "value"].join("-");
export const MATCH_URL = "https://forum.example.invalid/synthetic-thread";
export const SOURCE_URL = "https://tracker.example.invalid/synthetic-owner/synthetic-project/issues/7";
export const DOCS_URL = "https://docs.example.invalid/reports";
export const DOCS_QUERY = "daily counts timezone";
/** The fake extract's passages; the attempt hands them to the issue writer as doc excerpts. */
export const DOC_PASSAGES = ["Synthetic docs passage: reports group pageviews by day in the selected time zone.", "Synthetic docs passage: the time zone is an IANA name such as America/New_York."] as const;
/** A passage that names an excluded identifier; the attempt never hands it to the writer. */
export const EXCLUDED_PASSAGE = "Synthetic docs passage: the syntheticRangeHelper option sets the range.";

export interface PolicyFile {
  file: string;
  bytes: Uint8Array;
  sha256: string;
  projectId: string;
}

/** A public_demo ProjectPolicy for a synthetic project that is not the development placeholder. */
export function attemptPolicy(dir: string, projectId = ATTEMPT_PROJECT_ID): PolicyFile {
  const built = buildPolicy({ projectId, outputRepository: "https://example.invalid/synthetic-owner/synthetic-results", publicArtifactBaseUri: "https://example.invalid/synthetic-store/", policyVersion: 1 });
  const file = join(dir, "policy.json");
  writeFileSync(file, built.bytes);
  return { file, bytes: built.bytes, sha256: built.sha256, projectId };
}

/** The private candidate input, all synthetic. */
export function privateInput(): Record<string, unknown> {
  return {
    candidate: CANDIDATE,
    card_source: cardSource("attempt"),
    excluded_identifiers: ["syntheticRangeHelper", "tzarg.la-day-counts"],
    search_settings: DEFAULT_SETTINGS,
    search: {
      schema_version: 1,
      candidate: CANDIDATE,
      source: { shape_keywords: ["synthetic", "timezone"], symptom_words: ["daily", "counts"], include_domains: ["github.com"], start_date: "2020-01-01", end_date: "2026-10-01" },
      docs: { url: DOCS_URL, query: DOCS_QUERY },
      docs_policy: { allowed_domains: ["docs.example.invalid"], excluded_domains: ["datelib.example.invalid"] },
    },
    user_action: "Opened the daily pageview report for three days with the report time zone set far from UTC.",
    locale: "en-US",
    fixture_description: "Twelve synthetic pageviews spread over three days, several of them close to local midnight.",
    doc_excerpts: [{ text: "Synthetic excerpt: reports group pageviews by day in the time zone selected for the report.", source_url: "https://docs.example.invalid/reports" }],
  };
}

export interface AttemptFiles {
  policy: PolicyFile;
  candidate: string;
  writerRates: string;
  searchRates: string;
}

export function attemptFiles(dir: string, input: Record<string, unknown> = privateInput()): AttemptFiles {
  const candidate = join(dir, "candidate-input.json");
  writeFileSync(candidate, JSON.stringify(input));
  const writerRates = join(dir, "writer-rates.json");
  writeFileSync(writerRates, JSON.stringify(RATE_ENTRIES));
  const searchRates = join(dir, "search-rates.json");
  writeFileSync(searchRates, JSON.stringify([{ service: "tavily", unit: "credit", price: { microusd: 8000, per_units: 1 }, source_url: "https://prices.example.invalid/synthetic" }]));
  return { policy: attemptPolicy(dir), candidate, writerRates, searchRates };
}

/** Attempt inputs on the Docker backend with the simulated kit and the runner's synthetic copy inputs. */
export function attemptInputs(w: World, files: AttemptFiles, overrides: Partial<AttemptInputs> = {}): AttemptInputs {
  return {
    work: join(w.dir, "attempt"),
    policy: files.policy.file,
    candidate: files.candidate,
    writerRates: files.writerRates,
    searchRates: files.searchRates,
    image: "rbw-umami-kit:synthetic",
    manifest: writeManifest(w.dir),
    terms: writeTerms(w.dir),
    auditPolicy: null,
    kitStage: w.kit.kitStage,
    originalSuite: null,
    probesDir: writeProbeDir(),
    alternativeDir: writeAlternativeDir(),
    backend: "docker",
    sandboxImage: null,
    ...overrides,
  };
}

/** A user-style issue whose every number comes from the symptom: the primary expected and observed counts, in bucket order. */
export function syntheticIssue(symptom: ObservedSymptom): IssueOutput {
  const counts = (buckets: ObservedSymptom["expected"]) => buckets.map((bucket) => `${String(bucket.count)} pageviews on ${bucket.bucket_label}`).join(", ");
  return {
    title: "Synthetic report: daily pageview totals land on the wrong day when the report uses a time zone far from UTC",
    reproduction_steps: ["Record the synthetic visits.", `Open the daily pageview report with the time zone ${symptom.timezone}.`],
    expected_result: `The report shows ${counts(symptom.expected)}. Each visit is counted on its local day.`,
    actual_result: `The report shows ${counts(symptom.observed)}. Some visits move to a neighboring day.`,
    environment: "Synthetic fixture data; the planted bug is synthetic.",
  };
}

/** The race family's private candidate input, all synthetic: the time-zone input with race prose, search words and excluded check IDs. */
export function racePrivateInput(): Record<string, unknown> {
  const input = privateInput();
  const search = input.search as Record<string, unknown>;
  return {
    ...input,
    excluded_identifiers: ["syntheticVerifyHelper", "rc1.backup-code-concurrent-double-spend", "rc1.backup-code-serial-reuse"],
    search: {
      ...search,
      source: { shape_keywords: ["synthetic", "backup"], symptom_words: ["code", "twice"], include_domains: ["github.com"], start_date: "2020-01-01", end_date: "2026-10-01" },
      docs: { url: DOCS_URL, query: "backup codes single use" },
    },
    user_action: "Signed in from two browser tabs and entered the same unused backup code in both at the same moment.",
    fixture_description: "One synthetic account with two-step sign-in and ten unused backup codes.",
    doc_excerpts: [{ text: "Synthetic excerpt: each backup code can be used once.", source_url: "https://docs.example.invalid/reports" }],
  };
}

/** A user-style race issue whose every number comes from the symptom: the accepted and refused counts, expected and observed, and the HTTP statuses. */
export function syntheticRaceIssue(symptom: RaceSymptom): IssueOutput {
  const statuses = symptom.concurrent_attempts.map((attempt) => String(attempt.http_status)).join(" and ");
  return {
    title: "Synthetic report: one backup code signs in twice when it is entered in two tabs at the same moment",
    reproduction_steps: ["Sign in to the synthetic account in two browser tabs until each asks for a code.", "Enter the same unused backup code in both tabs and submit them together."],
    expected_result: `Of the two requests sent together, ${String(symptom.expected.accepted)} is accepted and ${String(symptom.expected.refused)} is refused. A backup code works once.`,
    actual_result: `${String(symptom.observed.accepted)} were accepted and ${String(symptom.observed.refused)} refused, so both tabs were signed in with one code. The responses were ${statuses}.`,
    environment: "Synthetic fixture data; the planted bug is synthetic.",
  };
}

export type IssueMode = "valid" | "rejected" | "lost";

export interface FakeWriter {
  fetch: FetchFunction;
  calls: { kind: "card" | "issue"; authorization: string | null; body: string }[];
}

/** Answers the card and issue requests; the issue is built from <work>/candidate/symptom.json, which the attempt writes before the writer runs. */
export function fakeWriter(work: string, mode: IssueMode = "valid"): FakeWriter {
  const calls: FakeWriter["calls"] = [];
  const fetch: FetchFunction = (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const kind = JSON.stringify((JSON.parse(body) as { response_format?: unknown }).response_format).includes("reproduction_steps") ? "issue" : "card";
    calls.push({ kind, authorization: new Headers(init?.headers).get("authorization"), body });
    if (kind === "card") return Promise.resolve(new Response(completion(JSON.stringify(CARD_OUTPUTS.valid), SYNTHETIC_USAGE), { status: 200 }));
    if (mode === "lost") return Promise.reject(new TypeError("synthetic: the connection was reset after the request was sent"));
    const symptom = parseCanonical(readFileSync(join(work, "candidate", "symptom.json"))) as unknown as ObservedSymptom | RaceSymptom;
    const issue = "symptom_kind" in symptom ? syntheticRaceIssue(symptom) : syntheticIssue(symptom);
    const content = mode === "rejected" ? { ...issue, environment: `${issue.environment} In total 97 pageviews are listed.` } : issue;
    return Promise.resolve(new Response(completion(JSON.stringify(content), SYNTHETIC_USAGE), { status: 200 }));
  };
  return { fetch, calls };
}

export type PhraseAnswer = "none" | "match" | "error" | "lost";
export type SourceAnswer = "results" | "error" | "lost";
export type DocsAnswer = "passages" | "excluded" | "failed_url" | "error" | "lost";

export interface SearchAnswers {
  /** One answer per source search, in call order. */
  sources?: readonly SourceAnswer[];
  docs?: DocsAnswer;
  /** One answer per phrase check, in call order. */
  phrases?: readonly PhraseAnswer[];
}

export interface FakeSearch {
  client: (apiKey: string) => SearchClient;
  keys: string[];
  /** The phrase checks' queries. */
  queries: string[];
  sourceQueries: string[];
  /** Each extract's URLs and query. */
  extracts: { urls: string[]; query: unknown }[];
  /** Every request's kind, in call order. */
  calls: ("search.source" | "search.docs" | "search.phrase")[];
}

const LOST = "An unexpected error occurred while making the request. synthetic: socket hang up";
const SERVER_ERROR = "Request failed with status code 500";

/** A search client answered in process: the source searches, the docs extract and the phrase checks, each from its own answers. */
export function fakeSearch(answers: SearchAnswers = {}): FakeSearch {
  const keys: string[] = [];
  const queries: string[] = [];
  const sourceQueries: string[] = [];
  const extracts: FakeSearch["extracts"] = [];
  const calls: FakeSearch["calls"] = [];
  const phrase = (query: string): Promise<unknown> => {
    const answer = answers.phrases?.[queries.length] ?? "none";
    queries.push(query);
    calls.push("search.phrase");
    if (answer === "lost") return Promise.reject(new Error(LOST));
    if (answer === "error") return Promise.reject(new Error(SERVER_ERROR));
    const results = answer === "match" ? [{ url: MATCH_URL, title: "Synthetic thread", content: "Synthetic excerpt.", score: 0.5, publishedDate: null }] : [];
    return Promise.resolve({ query, results, usage: { credits: 1 } });
  };
  const source = (query: string): Promise<unknown> => {
    const answer = answers.sources?.[sourceQueries.length] ?? "results";
    sourceQueries.push(query);
    calls.push("search.source");
    if (answer === "lost") return Promise.reject(new Error(LOST));
    if (answer === "error") return Promise.reject(new Error(SERVER_ERROR));
    return Promise.resolve({ query, results: [{ url: SOURCE_URL, title: "Synthetic report", content: "Synthetic report excerpt.", score: 0.7, publishedDate: "2025-04-01" }], usage: { credits: 1 } });
  };
  const search = (query: string, options?: { exactMatch?: boolean }): Promise<unknown> => (options?.exactMatch === true ? phrase(query) : source(query));
  const extract = (urls: string[], options?: { query?: unknown }): Promise<unknown> => {
    extracts.push({ urls, query: options?.query });
    calls.push("search.docs");
    const answer = answers.docs ?? "passages";
    if (answer === "lost") return Promise.reject(new Error(LOST));
    if (answer === "error") return Promise.reject(new Error(SERVER_ERROR));
    if (answer === "failed_url") return Promise.resolve({ results: [], failedResults: [{ url: DOCS_URL, error: "synthetic" }], usage: { credits: 1 } });
    const passages = answer === "excluded" ? [DOC_PASSAGES[0], EXCLUDED_PASSAGE] : DOC_PASSAGES;
    return Promise.resolve({ results: [{ url: DOCS_URL, rawContent: passages.join(" [...] ") }], failedResults: [], usage: { credits: 1 } });
  };
  return {
    keys,
    queries,
    sourceQueries,
    extracts,
    calls,
    client: (apiKey) => {
      keys.push(apiKey);
      return { search, extract } as unknown as SearchClient;
    },
  };
}

/** The spend API with every reserve whose call name starts with the prefix refused as pool_halted. */
function refusingSpend(spend: Spend, prefix: string): Spend {
  return {
    ...spend,
    reserve: (request) => (request.call_name.startsWith(prefix) ? Promise.resolve({ ok: false as const, code: "pool_halted" as const }) : spend.reserve(request)),
  };
}

export interface AttemptOptions extends SearchAnswers {
  issue?: IssueMode;
  /** Refuses every reserve whose call name starts with this prefix, as pool_halted. */
  refuseReserve?: string;
}

export interface AttemptWorld {
  deps: AttemptDeps;
  writer: FakeWriter;
  search: FakeSearch;
  env: Record<string, string | undefined>;
  /** Each Docker call's view of the environment. */
  dockerEnvs: Record<string, string | undefined>[];
  lines: string[];
}

/** The attempt's dependencies around the harness's: the environment with both keys, the fakes, and a Docker that notes the environment at each call. */
export function attemptDeps(w: World, work: string, options: AttemptOptions = {}): AttemptWorld {
  const env: Record<string, string | undefined> = { TOKEN_FACTORY_WRITER_KEY: WRITER_KEY, TAVILY_API_KEY: SEARCH_KEY, PATH: "/usr/bin:/bin" };
  const dockerEnvs: Record<string, string | undefined>[] = [];
  const inner = w.deps.docker;
  const docker = new FakeDocker((args, runOptions) => {
    dockerEnvs.push({ ...env });
    return inner.run(args, runOptions);
  });
  const writer = fakeWriter(work, options.issue);
  const search = fakeSearch(options);
  const lines: string[] = [];
  const deps: AttemptDeps = {
    ...w.deps,
    ...(options.refuseReserve === undefined ? {} : { spend: refusingSpend(w.deps.spend, options.refuseReserve) }),
    docker,
    writerFetch: writer.fetch,
    searchClient: search.client,
    report: (line) => {
      lines.push(line);
    },
  };
  return { deps, writer, search, env, dockerEnvs, lines };
}
