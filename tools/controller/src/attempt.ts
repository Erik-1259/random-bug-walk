// The candidate attempt (W2-5): one factory root under a project policy. In order, each stage
// gating the next: the kit check and the observation (runJob, sharing the root's IDs), the
// symptom built from the observation, one card call and one issue call (@rbw/writer), the three
// exact-phrase checks of phrases picked from the frozen issue (@rbw/search), and the admission
// (runJob). Then it writes the RootRun that the release tool stages, publishes and builds from.
// Nothing is retried; a retry is a new root in a new directory.
//
// The writer and searcher run here against the controller's own ledger and development slot. The
// issue, its phrases and the search records are written under <work>/candidate/ only, never
// under jobs/ and never to a report line: the release tool publishes the issue later.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InputsError, loadCopyInputs, newRunIds } from "@rbw/local-runner";
import type { RunIds } from "@rbw/local-runner";
import { CanonicalError, RecordError, assertRecord, encodeCanonical, parseRecord, sha256Hex, validateRecord } from "@rbw/schema";
import type { ObservedSymptom, ProjectPolicy, RootRun } from "@rbw/schema";
import { SearchError, createDirectoryRecordStore, createSearcher, priceOf, searchInputSchema, settingsSchema, summarizeNovelty, parseRateSheet as parseSearchRates } from "@rbw/search";
import type { RateSheet, SearchClient, SearchInput, SearchRecord, SearchSettings } from "@rbw/search";
import type { Spend } from "@rbw/spend";
import { CardSourceSchema, WriterInterruptedError, buildEnvelope, createWriter, createWriterProvider, makeRecording, serializeRecording, parseRateSheet as parseWriterRates } from "@rbw/writer";
import type { CardOutcome, FetchFunction, IssueOutcome, IssueOutput, WriterProvider } from "@rbw/writer";
import { runJob } from "./controller.ts";
import type { Backend, ControllerDeps, JobOutcome } from "./controller.ts";
import { DEVELOPMENT } from "./limits.ts";
import { SymptomUnavailable, buildSymptom } from "./symptom.ts";
import type { SymptomProse } from "./symptom.ts";

/** The admission policy a release is graded under; the release check requires it, and ProjectPolicy has no such field. */
export const GRADING_POLICY_ID = "umami-uc3-v1";
export const DECLARED_STAGES = ["kit_check", "observe", "write", "novelty", "admission"] as const;
/** The two keys the attempt reads from the environment, once, and then removes from it. */
export const KEY_VARIABLES = ["TOKEN_FACTORY_WRITER_KEY", "TAVILY_API_KEY"] as const;
/** The development placeholder project that newRunIds names; an attempt never runs under it. */
const PLACEHOLDER_PROJECT_ID = newRunIds(() => "00000000-0000-4000-8000-000000000000").project_id;
const PHRASE_CALLS = ["phrase-1", "phrase-2", "phrase-3"] as const;
const JOB_NAMES = ["kit-check", "observe", "admission"] as const;
const ACTOR = "controller";
const PHRASE_WORDS = 12;
const INPUT_FIELDS = ["candidate", "card_source", "excluded_identifiers", "search_settings", "search", "user_action", "locale", "fixture_description", "doc_excerpts"];
const UNRESOLVED = new Set(["prepared", "launching", "running", "uncertain"]);

export interface AttemptInputs {
  /** A new run directory: absent or empty. */
  work: string;
  /** The ProjectPolicy record. */
  policy: string;
  /** The private candidate input. */
  candidate: string;
  writerRates: string;
  searchRates: string;
  /** The local kit image, a tag or a digest. */
  image: string;
  manifest: string;
  terms: string;
  /** The projection audit policy (what `run --policy` takes). */
  auditPolicy: string | null;
  kitStage: string;
  /** The frozen original suite; when null, the kit check's freeze copy makes it. */
  originalSuite: string | null;
  probesDir?: string;
  alternativeDir?: string;
  backend: Backend;
  sandboxImage: string | null;
}

export interface AttemptDeps extends ControllerDeps {
  /** The writer's fetch: the platform fetch for a live run. */
  writerFetch: FetchFunction;
  /** Builds the search client from the key. */
  searchClient: (apiKey: string) => SearchClient;
  /** One line per stage: outcomes only, never issue text, phrases or URLs. */
  report: (line: string) => void;
}

export interface PrivateInput extends SymptomProse {
  candidate: string;
  card_source: unknown;
  excluded_identifiers: string[];
  search_settings: SearchSettings;
  search: Omit<SearchInput, "phrases">;
}

/** Everything an attempt needs, validated before anything runs. */
export interface PreparedAttempt {
  inputs: AttemptInputs;
  policy: ProjectPolicy;
  policySha256: string;
  input: PrivateInput;
  writerRates: Uint8Array;
  searchRates: RateSheet;
  keys: { writer: string; search: string };
}

export interface AttemptOutcome {
  /** 0 when the root ends terminal and completed; 1 otherwise. */
  exitCode: number;
  rootRun: RootRun;
  rootRunPath: string;
}

type End = { status: "terminal"; outcome: "completed" | "failed" | "incomplete"; reason: string | null } | { status: "needs_reconciliation"; reason: string };

const failed = (reason: string): End => ({ status: "terminal", outcome: "failed", reason });
const incomplete = (reason: string): End => ({ status: "terminal", outcome: "incomplete", reason });
const reconcile = (reason: string): End => ({ status: "needs_reconciliation", reason });

/** A spend call that threw: its outcome is unknown, so the root needs reconciliation. Only the driver's error code is kept. */
class LedgerFailure extends Error {
  override name = "LedgerFailure";
}

function guarded(spend: Spend): Spend {
  const wrapped: Record<string, unknown> = {};
  for (const [name, call] of Object.entries(spend) as [string, (request: unknown) => Promise<unknown>][]) {
    wrapped[name] = async (request: unknown) => {
      try {
        return await call(request);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(error.code) ? error.code : "unknown";
        throw new LedgerFailure(`a spend ledger call failed (driver error code ${code})`);
      }
    };
  }
  return wrapped as unknown as Spend;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInput(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new InputsError(`the ${what} cannot be read`);
  }
}

/** Validates the private input; errors name fields only, never their values. */
function parsePrivateInput(bytes: Buffer): PrivateInput {
  const bad = (what: string): never => {
    throw new InputsError(`the private candidate input: ${what}`);
  };
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return bad("not JSON");
  }
  if (!isRecord(value) || Object.keys(value).sort().join() !== [...INPUT_FIELDS].sort().join()) return bad(`needs exactly the fields ${INPUT_FIELDS.join(", ")}`);
  const { candidate, excluded_identifiers: excluded, user_action: action, fixture_description: description, locale, doc_excerpts: excerpts } = value;
  if (typeof candidate !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(candidate)) return bad("candidate must be lowercase letters, digits, _ and -, at most 40 characters");
  if (!CardSourceSchema.safeParse(value.card_source).success) return bad("card_source is not a CardSource");
  if (!Array.isArray(excluded) || !excluded.every((item) => typeof item === "string")) return bad("excluded_identifiers must be a list of strings");
  const settings = settingsSchema.safeParse(value.search_settings);
  if (!settings.success) return bad("search_settings is not SearchSettings");
  const search = searchInputSchema.omit({ phrases: true }).safeParse(value.search);
  if (!search.success || search.data.candidate !== candidate) return bad("search must be a SearchInput without phrases, for the same candidate");
  if (typeof action !== "string" || action === "" || typeof description !== "string" || description === "") return bad("user_action and fixture_description must be non-empty strings");
  if (locale !== null && validateRecord("LocaleTag", locale).length > 0) return bad("locale must be a language tag or null");
  if (!Array.isArray(excerpts) || excerpts.some((excerpt) => validateRecord("DocExcerpt", excerpt).length > 0)) return bad("doc_excerpts must be { text, source_url } items with https URLs");
  return {
    candidate,
    card_source: value.card_source,
    excluded_identifiers: excluded,
    search_settings: settings.data,
    search: search.data,
    user_action: action,
    locale: locale as string | null,
    fixture_description: description,
    doc_excerpts: excerpts as SymptomProse["doc_excerpts"],
  };
}

/**
 * Validates every input and reads both keys before anything runs; any problem is an InputsError.
 * The keys are read once and removed from `env` (process.env in the command), so no child process inherits them.
 */
export function prepareAttempt(inputs: AttemptInputs, env: Record<string, string | undefined>): PreparedAttempt {
  const [writerKey = "", searchKey = ""] = KEY_VARIABLES.map((name) => env[name] ?? "");
  for (const name of KEY_VARIABLES) Reflect.deleteProperty(env, name);
  const missing = KEY_VARIABLES.find((_name, index) => [writerKey, searchKey][index] === "");
  if (missing !== undefined) throw new InputsError(`${missing} is not set`);
  if (existsSync(inputs.work) && (!statSync(inputs.work).isDirectory() || readdirSync(inputs.work).length > 0)) {
    throw new InputsError("--work is not empty: an attempt never resumes, so a retry is a new root in a new directory");
  }

  const policyBytes = readInput(inputs.policy, "policy");
  let policy: ProjectPolicy;
  try {
    policy = parseRecord("ProjectPolicy", policyBytes);
  } catch (error) {
    if (error instanceof RecordError || error instanceof CanonicalError) throw new InputsError("the policy is not a canonical ProjectPolicy record");
    throw error;
  }
  if (policy.project_id === PLACEHOLDER_PROJECT_ID) throw new InputsError("the policy names the development placeholder project");
  const input = parsePrivateInput(readInput(inputs.candidate, "private candidate input"));

  const writerRates = readInput(inputs.writerRates, "writer rate file");
  const writerSheet = parseWriterRates(writerRates);
  if (!writerSheet.ok || !buildEnvelope(writerSheet.entries).ok) throw new InputsError("unknown_price: the writer rate file has no token-factory input and output prices");
  let searchRates: RateSheet;
  try {
    searchRates = parseSearchRates(readInput(inputs.searchRates, "search rate file"));
  } catch (error) {
    if (error instanceof SearchError) throw new InputsError(`the search rate file is invalid (${error.code})`);
    throw error;
  }
  if (priceOf(searchRates, "tavily", "credit") === null) throw new InputsError("unknown_price: the search rate file has no tavily credit price");
  loadCopyInputs({
    manifest: inputs.manifest,
    terms: inputs.terms,
    policy: inputs.auditPolicy,
    ...(inputs.probesDir === undefined ? {} : { probesDir: inputs.probesDir }),
    ...(inputs.alternativeDir === undefined ? {} : { alternativeDir: inputs.alternativeDir }),
  });
  return { inputs, policy, policySha256: sha256Hex(policyBytes), input, writerRates, searchRates, keys: { writer: writerKey, search: searchKey } };
}

function clean(text: string): string {
  return text.replaceAll('"', "").replace(/\s+/g, " ").trim();
}

function firstSentence(text: string): string {
  const cleaned = clean(text);
  return /^.*?[.!?](?=\s|$)/.exec(cleaned)?.[0] ?? cleaned;
}

function words(text: string): string {
  return text.split(" ").slice(0, PHRASE_WORDS).join(" ");
}

/** The three exact phrases, picked by code from the frozen issue: the title and the first sentences of the expected and actual results. */
export function pickPhrases(issue: IssueOutput): [string, string, string] {
  return [words(clean(issue.title)), words(firstSentence(issue.expected_result)), words(firstSentence(issue.actual_result))];
}

function writeOnce(path: string, bytes: string | Uint8Array): void {
  writeFileSync(path, bytes, { flag: "wx" });
}

interface Operation {
  kind: string;
  operation_id: string;
}

interface Attempt {
  prepared: PreparedAttempt;
  deps: AttemptDeps;
  ids: RunIds;
  /** <work>/candidate */
  dir: string;
  provider: WriterProvider;
  search: SearchClient;
}

/** Saves the call's recording and says whether the root stops. */
function called(a: Attempt, kind: "card" | "issue", outcome: CardOutcome | IssueOutcome, operations: Operation[]): End | null {
  if (!outcome.ok) {
    if (outcome.operation_id !== null) operations.push({ kind: `writer.${kind}`, operation_id: outcome.operation_id });
    return failed(`${kind}_refused_${outcome.code}`);
  }
  const { call } = outcome;
  operations.push({ kind: call.kind, operation_id: call.operation_id });
  if (call.http_status !== null && call.response_body !== null) {
    const recording = makeRecording({ requestBody: call.request_body, status: call.http_status, responseBody: call.response_body, provenance: "live", recordedAt: new Date(a.deps.clock.now()).toISOString() });
    writeOnce(join(a.dir, "recordings", `${kind}-${String(call.call_ordinal)}.recording.json`), serializeRecording(recording));
  }
  if (call.status === "uncertain") return reconcile(`${kind}_uncertain`);
  if (call.ledger_refusal !== null) return reconcile(`${kind}_ledger_refusal`);
  if (call.status !== "completed") return failed(`${kind}_${call.failure ?? "failed"}`);
  return null;
}

/** The card, the issue and the phrase checks; null when novelty is clear. */
async function writeAndSearch(a: Attempt, spend: Spend, context: Record<string, string>, symptom: ObservedSymptom, operations: Operation[]): Promise<End | null> {
  const { input } = a.prepared;
  const say = a.deps.report;
  const writer = createWriter({ spend, provider: a.provider, context, poolKey: DEVELOPMENT.pool_key, allocationKey: DEVELOPMENT.allocation_key, slotKey: DEVELOPMENT.slot_key, rateSheet: a.prepared.writerRates });
  mkdirSync(join(a.dir, "recordings"), { recursive: true });

  const card = await writer.writeCard({ candidate: input.candidate, source: input.card_source });
  const cardEnd = called(a, "card", card, operations);
  if (card.ok && card.card !== null) writeOnce(join(a.dir, "card.json"), encodeCanonical(card.card));
  say(`stage=write call=card outcome=${card.ok ? card.call.status : `refused:${card.code}`}`);
  if (cardEnd !== null) return cardEnd;

  const issue = await writer.writeIssue({ candidate: input.candidate, symptom, excludedIdentifiers: input.excluded_identifiers });
  const issueEnd = called(a, "issue", issue, operations);
  let frozen: { issue: IssueOutput; sha256: string } | null = null;
  if (issue.ok && issue.issue !== null) {
    const bytes = encodeCanonical(issue.issue);
    writeOnce(join(a.dir, "issue.json"), bytes);
    frozen = { issue: issue.issue, sha256: sha256Hex(bytes) };
    if (issue.report !== null) writeOnce(join(a.dir, "issue-check.json"), encodeCanonical({ ...issue.report, issue_sha256: frozen.sha256 }));
  }
  const check = issue.ok ? (issue.report?.status ?? "-") : "-";
  say(`stage=write call=issue outcome=${issue.ok ? issue.call.status : `refused:${issue.code}`} issue_check=${check}`);
  if (issueEnd !== null) return issueEnd;
  if (frozen === null || check !== "ready_for_review") return failed("issue_not_ready");

  const searcher = createSearcher({
    client: a.search,
    spend,
    context,
    rates: a.prepared.searchRates,
    poolKey: DEVELOPMENT.pool_key,
    allocationKey: DEVELOPMENT.allocation_key,
    slotKey: DEVELOPMENT.slot_key,
    settings: input.search_settings,
    excludedIdentifiers: input.excluded_identifiers,
    store: createDirectoryRecordStore(join(a.dir, "search")),
    clock: () => new Date(a.deps.clock.now()),
    actorRole: ACTOR,
  });
  const phrases = pickPhrases(frozen.issue);
  const records: SearchRecord[] = [];
  for (const name of PHRASE_CALLS) {
    const result = await searcher.checkPhrase(name, { ...input.search, phrases });
    if (result.status === "refused") {
      say(`stage=novelty call=${name} refused=${result.code}`);
      continue;
    }
    operations.push({ kind: "search.phrase", operation_id: result.record.operation_id });
    records.push(result.record);
    say(`stage=novelty call=${name} outcome=${result.record.outcome}`);
    if (result.stop === "uncertain") return reconcile(`${name}_uncertain`);
    if (result.stop !== null) break;
  }
  const novelty = summarizeNovelty(records);
  writeOnce(join(a.dir, "novelty.json"), encodeCanonical({ ...novelty, issue_sha256: frozen.sha256 }));
  say(`stage=novelty status=${novelty.status}`);
  if (novelty.status === "blocked") return failed("novelty_blocked");
  if (novelty.status === "incomplete") return incomplete("novelty_incomplete");
  return null;
}

/** Each operation's state and amounts, read back from the ledger; null when it has none. */
async function ledgerEntries(spend: Spend, operations: readonly Operation[]) {
  const entries = [];
  for (const operation of operations) {
    const status = await spend.operationStatus({ operation_id: operation.operation_id });
    entries.push({
      operation_id: operation.operation_id,
      kind: operation.kind,
      state: status.ok ? status.state : null,
      reserved_microusd: status.ok ? Number(status.reserved_microusd) : null,
      settled_microusd: status.ok ? Number(status.settled_microusd) : null,
    });
  }
  return entries;
}

/** The candidate text, in this process, under the root's development slot; null when the admission may run. */
async function candidateText(a: Attempt, taskRevision: string, symptom: ObservedSymptom): Promise<End | null> {
  const { ids } = a;
  const spend = guarded(a.deps.spend);
  const root = ids.root_execution_id;
  const context = {
    project_id: ids.project_id,
    project_policy_sha256: a.prepared.policySha256,
    batch_id: ids.batch_id,
    task_revision: taskRevision,
    root_execution_id: root,
    execution_id: ids.executions["candidate-text"],
    parent_execution_id: root,
  };
  const slot = { slot_key: DEVELOPMENT.slot_key, root_execution_id: root, actor_role: ACTOR };
  const operations: Operation[] = [];
  try {
    const hold = await spend.acquireSlot(slot);
    if (!hold.ok) a.deps.report(`stage=write status=refused reason=${hold.code}`);
    const end = hold.ok ? await writeAndSearch(a, spend, context, symptom, operations) : failed(`slot_${hold.code}`);
    const entries = await ledgerEntries(spend, operations);
    writeOnce(join(a.dir, "ledger.json"), `${JSON.stringify({ operations: entries }, null, 2)}\n`);
    if (!hold.ok || end?.status === "needs_reconciliation") return end;
    if (entries.some((entry) => entry.state !== null && UNRESOLVED.has(entry.state))) return reconcile("operation_unresolved");
    const released = await spend.releaseSlot({ ...slot, evidence: null, reason: null });
    return released.ok ? end : reconcile("slot_release_blocked");
  } catch (error) {
    if (!(error instanceof LedgerFailure || error instanceof WriterInterruptedError)) throw error;
    if (error instanceof WriterInterruptedError) operations.push({ kind: "writer", operation_id: error.operation_id });
    if (!existsSync(join(a.dir, "ledger.json"))) writeOnce(join(a.dir, "ledger.json"), `${JSON.stringify({ operations: operations.map((operation) => ({ ...operation, state: null })), error: error.name }, null, 2)}\n`);
    return reconcile("ledger_unavailable");
  }
}

function decisionVerdict(jobDir: string): string {
  const path = join(jobDir, "decision.json");
  if (!existsSync(path)) return "-";
  const decision = JSON.parse(readFileSync(path, "utf8")) as { outcome_verdict?: unknown };
  return typeof decision.outcome_verdict === "string" ? decision.outcome_verdict : "-";
}

/** Reports a job and says whether the root stops there. */
function jobEnd(a: Attempt, stage: string, outcome: JobOutcome): End | null {
  const { summary } = outcome;
  const verdict = stage === "admission" ? ` outcome_verdict=${decisionVerdict(outcome.jobDir)}` : "";
  a.deps.report(`stage=${stage} status=${summary.status} reason=${summary.reason ?? "-"} settled_microusd=${String(summary.spend.settled_microusd)}${verdict}`);
  const reason = `${stage}_${summary.reason ?? summary.status}`;
  if (summary.status === "complete") return null;
  if (summary.status === "needs_reconciliation") return reconcile(reason);
  return summary.status === "incomplete" ? incomplete(reason) : failed(reason);
}

async function stages(a: Attempt, projectPolicy: { sha256: string; policy_id: string }): Promise<End> {
  const { inputs } = a.prepared;
  const job = (kind: "kit_check" | "observe" | "admission", name: (typeof JOB_NAMES)[number], originalSuite: string | null) =>
    runJob(
      {
        kind,
        work: inputs.work,
        name,
        image: inputs.image,
        manifest: inputs.manifest,
        terms: inputs.terms,
        policy: inputs.auditPolicy,
        kitStage: inputs.kitStage,
        originalSuite,
        ...(inputs.probesDir === undefined ? {} : { probesDir: inputs.probesDir }),
        ...(inputs.alternativeDir === undefined ? {} : { alternativeDir: inputs.alternativeDir }),
        backend: inputs.backend,
        sandboxImage: inputs.sandboxImage,
        trials: null,
        ledger: DEVELOPMENT,
        ids: a.ids,
        projectPolicy,
      },
      a.deps,
    );

  const kit = await job("kit_check", "kit-check", inputs.originalSuite);
  const kitEnd = jobEnd(a, "kit_check", kit);
  if (kitEnd !== null) return kitEnd;
  const suite = inputs.originalSuite ?? join(kit.jobDir, "freeze", "collected", "original-suite.json");
  const observe = await job("observe", "observe", suite);
  const observeEnd = jobEnd(a, "observe", observe);
  if (observeEnd !== null) return observeEnd;

  let symptom: ObservedSymptom;
  try {
    symptom = buildSymptom(observe.jobDir, a.prepared.input);
  } catch (error) {
    if (!(error instanceof SymptomUnavailable)) throw error;
    a.deps.report(`stage=write status=failed reason=${error.code}`);
    return failed(error.code);
  }
  mkdirSync(a.dir, { recursive: true });
  writeOnce(join(a.dir, "symptom.json"), encodeCanonical(symptom));
  const text = await candidateText(a, observe.summary.job.task_revision ?? "", symptom);
  if (text !== null) return text;

  const admission = await job("admission", "admission", suite);
  return jobEnd(a, "admission", admission) ?? { status: "terminal", outcome: "completed", reason: null };
}

/** Runs one attempt as a new root and writes <work>/root-run.json, whatever stage it stopped at. */
export async function runAttempt(prepared: PreparedAttempt, deps: AttemptDeps): Promise<AttemptOutcome> {
  const { inputs, policy } = prepared;
  const ids: RunIds = { ...newRunIds(deps.uuid), project_id: policy.project_id };
  mkdirSync(inputs.work, { recursive: true });
  const a: Attempt = {
    prepared,
    deps,
    ids,
    dir: join(inputs.work, "candidate"),
    provider: createWriterProvider({ fetch: deps.writerFetch, apiKey: prepared.keys.writer }),
    search: deps.searchClient(prepared.keys.search),
  };
  const end = await stages(a, { sha256: prepared.policySha256, policy_id: GRADING_POLICY_ID });

  const rootRun = assertRecord("RootRun", {
    schema_version: 1,
    project_id: policy.project_id,
    root_execution_id: ids.root_execution_id,
    project_policy_sha256: prepared.policySha256,
    kind: "factory",
    declared_stages: [...DECLARED_STAGES],
    child_execution_ids: JOB_NAMES.filter((name) => existsSync(join(inputs.work, "jobs", name))).map((name) => ids.executions[name]),
    status: end.status,
    outcome: end.status === "terminal" ? end.outcome : null,
  });
  const rootRunPath = join(inputs.work, "root-run.json");
  writeOnce(rootRunPath, encodeCanonical(rootRun));
  deps.report(`root=${ids.root_execution_id} status=${rootRun.status} outcome=${rootRun.outcome ?? "-"} reason=${end.reason ?? "-"} root_run=${rootRunPath}`);
  return { exitCode: rootRun.status === "terminal" && rootRun.outcome === "completed" ? 0 : 1, rootRun, rootRunPath };
}
