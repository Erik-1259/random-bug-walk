// Card writing, issue writing and the candidate's three exact-phrase searches, through
// @rbw/writer and @rbw/search in recorded mode. The spend ledger is an in-memory PGlite with
// every @rbw/spend migration applied. The writer answers from its replay fetch; the search
// client's requests are answered by an axios adapter that serves recordings in process, so no
// request leaves the process and no socket is opened. No API key is read: the search client
// needs a non-empty key, so it gets a fixed placeholder that never leaves the process. A request
// with no recording fails the step, never a silent pass.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { canonicalJson as searchCanonicalJson, createSearcher, createTavilyClient, parseRateSheet, settingsSchema, summarizeNovelty } from "@rbw/search";
import type { NoveltySummary, SearchRecord, SearchSettings } from "@rbw/search";
import { sha256Hex } from "@rbw/schema";
import { createSpend, migrate } from "@rbw/spend";
import type { Spend } from "@rbw/spend";
import { createReplayFetch, createWriter, createWriterProvider, loadRecordings } from "@rbw/writer";
import type { Card, CallRecord, IssueCheckReport, IssueOutput, Recording } from "@rbw/writer";
import axios, { AxiosError, AxiosHeaders } from "axios";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import type { Clock } from "./clock.ts";

/** The committed development inputs: the packages' own synthetic recordings and inputs that match them. */
export const RECORDED_SYNTHETIC_DIR = fileURLToPath(new URL("../recorded/synthetic/", import.meta.url));

const POOL = "development";
const SLOT = "local-runner";
/** The search client refuses an empty key; this placeholder only ever reaches the in-process adapter. */
const PLACEHOLDER_SEARCH_KEY = "recorded-mode-placeholder";
const REPLAY_BASE_URL = "https://search-replay.example.invalid";
const PHRASE_CALLS = ["phrase-1", "phrase-2", "phrase-3"] as const;

export type RecordedErrorCode = "recording_missing" | "recordings_invalid" | "writer_refused" | "call_failed" | "search_incomplete" | "ledger_refused";

export class RecordedModeError extends Error {
  override name = "RecordedModeError";
  readonly code: RecordedErrorCode;

  constructor(code: RecordedErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

export interface RecordedContext {
  project_id: string;
  project_policy_sha256: string;
  batch_id: string;
  task_revision: string;
  root_execution_id: string;
  execution_id: string;
  parent_execution_id: string;
}

interface SearchRecording {
  provenance: "synthetic" | "live";
  endpoint: "search" | "extract";
  request_body: Record<string, unknown>;
  response: { status: number; body: unknown };
}

export interface RecordedDir {
  path: string;
  /** SHA-256 of every file, by path relative to the directory. */
  files: Record<string, string>;
  /** The writer's recordings are in writer/, read by the writer's own loader when the step runs. */
  writer: { candidate: string; card: unknown; symptom: unknown; excluded: string[]; rates: Buffer };
  search: { input: { candidate: string } & Record<string, unknown>; settings: SearchSettings; excluded: string[]; rates: Buffer; recordings: SearchRecording[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new RecordedModeError("recordings_invalid", `${what} must be a list of strings`);
  return value;
}

function json(dir: string, file: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && "code" in error)) throw new RecordedModeError("recordings_invalid", `${file} cannot be read as JSON`);
    throw error;
  }
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? listFiles(join(dir, entry.name), base) : [relative(base, join(dir, entry.name)).split("\\").join("/")]))
    .sort();
}

function searchKey(endpoint: string, body: unknown): string {
  return `${endpoint}:${sha256Hex(Buffer.from(searchCanonicalJson(body)))}`;
}

function parseSearchRecording(value: unknown, file: string): SearchRecording {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    (value.provenance !== "synthetic" && value.provenance !== "live") ||
    (value.endpoint !== "search" && value.endpoint !== "extract") ||
    !isRecord(value.request_body) ||
    !isRecord(value.response) ||
    typeof value.response.status !== "number"
  ) {
    throw new RecordedModeError("recordings_invalid", `${file} is not a search recording`);
  }
  return { provenance: value.provenance, endpoint: value.endpoint, request_body: value.request_body, response: { status: value.response.status, body: value.response.body } };
}

/**
 * Reads a recorded-mode directory: writer-input.json, writer-rates.json and writer/*.json;
 * search-input.json, search-rates.json and search/*.json. Two recordings for one request are refused.
 */
export function loadRecordedDir(dir: string): RecordedDir {
  const files = Object.fromEntries(listFiles(dir).map((file) => [file, sha256Hex(readFileSync(join(dir, file)))]));
  const writerInput = json(dir, "writer-input.json");
  if (!isRecord(writerInput) || typeof writerInput.candidate !== "string" || !isRecord(writerInput.issue)) {
    throw new RecordedModeError("recordings_invalid", "writer-input.json needs candidate, card and issue");
  }
  const searchInput = json(dir, "search-input.json");
  if (!isRecord(searchInput) || !isRecord(searchInput.input) || typeof searchInput.input.candidate !== "string") {
    throw new RecordedModeError("recordings_invalid", "search-input.json needs input, settings and excluded_identifiers");
  }
  const settings = settingsSchema.safeParse(searchInput.settings);
  if (!settings.success) throw new RecordedModeError("recordings_invalid", "search-input.json has invalid settings");
  const searchRecordings = readdirSync(join(dir, "search"))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => parseSearchRecording(json(join(dir, "search"), file), `search/${file}`));
  const keys = searchRecordings.map((recording) => searchKey(recording.endpoint, recording.request_body));
  if (new Set(keys).size !== keys.length) throw new RecordedModeError("recordings_invalid", "two search recordings match the same request");
  return {
    path: dir,
    files,
    writer: {
      candidate: writerInput.candidate,
      card: writerInput.card,
      symptom: writerInput.issue.symptom,
      excluded: strings(writerInput.issue.excluded_identifiers, "issue.excluded_identifiers"),
      rates: readFileSync(join(dir, "writer-rates.json")),
    },
    search: {
      input: { ...searchInput.input, candidate: searchInput.input.candidate },
      settings: settings.data,
      excluded: strings(searchInput.excluded_identifiers, "excluded_identifiers"),
      rates: readFileSync(join(dir, "search-rates.json")),
      recordings: searchRecordings,
    },
  };
}

/** Loads the writer's recordings with its own loader, and refuses two for one request. */
async function writerRecordings(dir: RecordedDir): Promise<Recording[]> {
  const recordings = await loadRecordings(join(dir.path, "writer"));
  const keys = recordings.map((recording) => recording.request_sha256);
  if (new Set(keys).size !== keys.length) throw new RecordedModeError("recordings_invalid", "two writer recordings match the same request");
  return recordings;
}

interface SearchReplay {
  unmatched: string[];
  remove(): void;
}

/** Answers the search client's axios requests from recordings, in process, matched by endpoint and canonical body. */
function installSearchReplay(recordings: readonly SearchRecording[]): SearchReplay {
  const table = new Map(recordings.map((recording) => [searchKey(recording.endpoint, recording.request_body), recording]));
  const unmatched: string[] = [];
  const adapter = (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const endpoint = (config.url ?? "").split("?")[0]?.split("/").filter(Boolean).pop() ?? "";
    const parsed: unknown = typeof config.data === "string" ? JSON.parse(config.data) : (config.data ?? {});
    const body: Record<string, unknown> = isRecord(parsed) ? { ...parsed } : {};
    delete body.api_key;
    const recording = table.get(searchKey(endpoint, body));
    if (recording === undefined) {
      unmatched.push(`${endpoint} ${typeof body.query === "string" ? body.query : ""}`.trim());
      return Promise.reject(new AxiosError("no recording matches this request; nothing was sent", AxiosError.ERR_NETWORK, config));
    }
    const response: AxiosResponse = {
      data: JSON.stringify(recording.response.body),
      status: recording.response.status,
      statusText: String(recording.response.status),
      headers: new AxiosHeaders({ "content-type": "application/json" }),
      config,
      request: {},
    };
    const valid = config.validateStatus ?? ((status: number) => status >= 200 && status < 300);
    if (valid(response.status)) return Promise.resolve(response);
    const code = response.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST;
    return Promise.reject(new AxiosError(`Request failed with status code ${String(response.status)}`, code, config, {}, response));
  };
  const id = axios.interceptors.request.use((config) => {
    config.adapter = adapter;
    return config;
  });
  return {
    unmatched,
    remove() {
      axios.interceptors.request.eject(id);
    },
  };
}

export interface WriterCallSummary {
  status: CallRecord["status"];
  failure: CallRecord["failure"];
  operation_id: string;
  call_name: string;
  payload_hash: string;
  input_token_bound: number;
  prompt_within_bound: boolean | null;
  reserved_microusd: string;
  settled_microusd: string | null;
}

export interface RecordedEvidence {
  provenance: string[];
  recordings_dir: string;
  card: WriterCallSummary & { card: Card | null };
  issue: WriterCallSummary & { issue: IssueOutput | null; report: IssueCheckReport | null };
  search: { records: SearchRecord[]; novelty: NoveltySummary };
  ledger: { pool: string; slot_released: boolean; operations: { operation_id: string; state: string; reserved_microusd: string; settled_microusd: string }[] };
}

function callSummary(call: CallRecord): WriterCallSummary {
  return {
    status: call.status,
    failure: call.failure,
    operation_id: call.operation_id,
    call_name: call.call_name,
    payload_hash: call.payload_hash,
    input_token_bound: call.input_token_bound,
    prompt_within_bound: call.prompt_within_bound,
    reserved_microusd: call.reserved_microusd.toString(),
    settled_microusd: call.settlement?.settled_microusd.toString() ?? null,
  };
}

function checkCall(call: CallRecord, kind: string): void {
  if (call.failure === "request_not_sent") throw new RecordedModeError("recording_missing", `no recording matches the ${kind} request`);
  if (call.status !== "completed") throw new RecordedModeError("call_failed", `the ${kind} call ended ${call.status} (${call.failure ?? "no failure code"})`);
}

async function openLedger(clock: Clock): Promise<{ db: PGlite; spend: Spend }> {
  const db = await PGlite.create();
  await migrate(db, { schema: "public" });
  const spend = createSpend({ client: db, schema: "public", clock: () => new Date(clock.now()) });
  const slot = await spend.createSlotKey({ slot_key: SLOT, actor_role: "owner", reason: "local runner development ledger" });
  if (!slot.ok) throw new RecordedModeError("ledger_refused", `the slot key was refused (${slot.code})`);
  return { db, spend };
}

export async function runRecorded(dir: RecordedDir, context: RecordedContext, deps: { clock: Clock }): Promise<RecordedEvidence> {
  const recordings = await writerRecordings(dir);
  const provenance = [...new Set([...recordings.map((recording) => recording.provenance), ...dir.search.recordings.map((recording) => recording.provenance)])].sort();
  const { db, spend } = await openLedger(deps.clock);
  try {
    const hold = await spend.acquireSlot({ slot_key: SLOT, root_execution_id: context.root_execution_id, actor_role: "workflow" });
    if (!hold.ok) throw new RecordedModeError("ledger_refused", `the slot was refused (${hold.code})`);
    const writer = createWriter({
      spend,
      provider: createWriterProvider({ fetch: createReplayFetch(recordings) }),
      context,
      poolKey: POOL,
      allocationKey: null,
      slotKey: SLOT,
      rateSheet: dir.writer.rates,
    });
    const card = await writer.writeCard({ candidate: dir.writer.candidate, source: dir.writer.card });
    if (!card.ok) throw new RecordedModeError("writer_refused", `the card call was refused (${card.code})`);
    checkCall(card.call, "writer.card");
    const issue = await writer.writeIssue({ candidate: dir.writer.candidate, symptom: dir.writer.symptom, excludedIdentifiers: dir.writer.excluded });
    if (!issue.ok) throw new RecordedModeError("writer_refused", `the issue call was refused (${issue.code})`);
    checkCall(issue.call, "writer.issue");

    const replay = installSearchReplay(dir.search.recordings);
    const records: SearchRecord[] = [];
    try {
      const searcher = createSearcher({
        client: createTavilyClient({ apiKey: PLACEHOLDER_SEARCH_KEY, apiBaseURL: REPLAY_BASE_URL }),
        spend,
        context,
        rates: parseRateSheet(dir.search.rates),
        poolKey: POOL,
        slotKey: SLOT,
        settings: dir.search.settings,
        excludedIdentifiers: dir.search.excluded,
        clock: () => new Date(deps.clock.now()),
      });
      for (const name of PHRASE_CALLS) {
        const before = replay.unmatched.length;
        const result = await searcher.checkPhrase(name, dir.search.input);
        if (replay.unmatched.length > before) throw new RecordedModeError("recording_missing", `no recording matches the search.phrase ${name} request`);
        if (result.status === "refused") throw new RecordedModeError("search_incomplete", `${name} was refused (${result.code})`);
        if (result.record.outcome === "incomplete") throw new RecordedModeError("search_incomplete", `${name} is incomplete (${result.record.reason ?? "no reason"})`);
        records.push(result.record);
      }
    } finally {
      replay.remove();
    }

    const operations = [];
    for (const operationId of [card.call.operation_id, issue.call.operation_id, ...records.map((record) => record.operation_id)]) {
      const status = await spend.operationStatus({ operation_id: operationId });
      if (!status.ok) throw new RecordedModeError("ledger_refused", `operation ${operationId} has no status (${status.code})`);
      operations.push({ operation_id: operationId, state: status.state, reserved_microusd: status.reserved_microusd.toString(), settled_microusd: status.settled_microusd.toString() });
    }
    const released = await spend.releaseSlot({ slot_key: SLOT, root_execution_id: context.root_execution_id, actor_role: "workflow", evidence: null, reason: null });
    return {
      provenance,
      recordings_dir: dir.path,
      card: { ...callSummary(card.call), card: card.card },
      issue: { ...callSummary(issue.call), issue: issue.issue, report: issue.report },
      search: { records, novelty: summarizeNovelty(records) },
      ledger: { pool: POOL, slot_released: released.ok, operations },
    };
  } finally {
    await db.close();
  }
}
