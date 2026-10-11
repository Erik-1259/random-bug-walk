// The candidate attempt's test world: the controller harness's PGlite ledger and the local
// runner's simulated kit on the Docker backend, a ProjectPolicy with a synthetic project, a private
// candidate input, the writer's synthetic rates and a fake writer fetch, and a search client
// answered in process. The fake issue's numbers come from the symptom the attempt built.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@rbw/search";
import type { SearchClient } from "@rbw/search";
import { buildPolicy, parseCanonical } from "@rbw/schema";
import type { ObservedSymptom } from "@rbw/schema";
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
      docs: { url: "https://docs.example.invalid/reports", query: "daily counts timezone" },
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

export type IssueMode = "valid" | "rejected" | "lost";

export interface FakeWriter {
  fetch: FetchFunction;
  calls: { kind: "card" | "issue"; authorization: string | null }[];
}

/** Answers the card and issue requests; the issue is built from <work>/candidate/symptom.json, which the attempt writes before the writer runs. */
export function fakeWriter(work: string, mode: IssueMode = "valid"): FakeWriter {
  const calls: FakeWriter["calls"] = [];
  const fetch: FetchFunction = (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const kind = JSON.stringify((JSON.parse(body) as { response_format?: unknown }).response_format).includes("reproduction_steps") ? "issue" : "card";
    calls.push({ kind, authorization: new Headers(init?.headers).get("authorization") });
    if (kind === "card") return Promise.resolve(new Response(completion(JSON.stringify(CARD_OUTPUTS.valid), SYNTHETIC_USAGE), { status: 200 }));
    if (mode === "lost") return Promise.reject(new TypeError("synthetic: the connection was reset after the request was sent"));
    const symptom = parseCanonical(readFileSync(join(work, "candidate", "symptom.json"))) as unknown as ObservedSymptom;
    const issue = syntheticIssue(symptom);
    const content = mode === "rejected" ? { ...issue, environment: `${issue.environment} In total 97 pageviews are listed.` } : issue;
    return Promise.resolve(new Response(completion(JSON.stringify(content), SYNTHETIC_USAGE), { status: 200 }));
  };
  return { fetch, calls };
}

export type PhraseAnswer = "none" | "match" | "error" | "lost";

export interface FakeSearch {
  client: (apiKey: string) => SearchClient;
  keys: string[];
  queries: string[];
}

/** A search client answered in process: one answer per phrase check, in call order. */
export function fakeSearch(answers: readonly PhraseAnswer[] = ["none", "none", "none"]): FakeSearch {
  const keys: string[] = [];
  const queries: string[] = [];
  const search = (query: string): Promise<unknown> => {
    const answer = answers[queries.length] ?? "none";
    queries.push(query);
    if (answer === "lost") return Promise.reject(new Error("An unexpected error occurred while making the request. synthetic: socket hang up"));
    if (answer === "error") return Promise.reject(new Error("Request failed with status code 500"));
    const results = answer === "match" ? [{ url: MATCH_URL, title: "Synthetic thread", content: "Synthetic excerpt.", score: 0.5, publishedDate: null }] : [];
    return Promise.resolve({ query, results, usage: { credits: 1 } });
  };
  const extract = (): Promise<unknown> => Promise.reject(new Error("synthetic: the attempt makes no extract call"));
  return {
    keys,
    queries,
    client: (apiKey) => {
      keys.push(apiKey);
      return { search, extract } as unknown as SearchClient;
    },
  };
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
export function attemptDeps(w: World, work: string, options: { issue?: IssueMode; phrases?: readonly PhraseAnswer[] } = {}): AttemptWorld {
  const env: Record<string, string | undefined> = { TOKEN_FACTORY_WRITER_KEY: WRITER_KEY, TAVILY_API_KEY: SEARCH_KEY, PATH: "/usr/bin:/bin" };
  const dockerEnvs: Record<string, string | undefined>[] = [];
  const inner = w.deps.docker;
  const docker = new FakeDocker((args, runOptions) => {
    dockerEnvs.push({ ...env });
    return inner.run(args, runOptions);
  });
  const writer = fakeWriter(work, options.issue);
  const search = fakeSearch(options.phrases);
  const lines: string[] = [];
  const deps: AttemptDeps = {
    ...w.deps,
    docker,
    writerFetch: writer.fetch,
    searchClient: search.client,
    report: (line) => {
      lines.push(line);
    },
  };
  return { deps, writer, search, env, dockerEnvs, lines };
}
