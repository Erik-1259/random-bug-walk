// The `review` command: for each candidate in a review-inputs file, one metered call to Super and
// then one to Kimi, one at a time, combined with the harvest's ast-grep outcome. It follows the
// writer's `record` command: it opens the ledger, acquires the slot for a fresh root, runs the
// calls and releases the slot. An uncertain call stops the run and leaves the slot held.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Spend } from "@rbw/spend";
import {
  buildEnvelope,
  createModelProvider,
  makeRecording,
  meteredStructuredCall,
  parseRateSheet,
  profileSha256,
  rateSheetSha256,
  serializeRecording,
  WriterInterruptedError,
} from "@rbw/writer";
import type { CallRecord, FetchFunction, ModelProvider, RunContext } from "@rbw/writer";
import { parseReviewInputs } from "./inputs.ts";
import type { CandidateInput, ReviewInputs } from "./inputs.ts";
import { ACTOR_ROLE, API_KEY_VARIABLE, REVIEW_KIND, REVIEW_MODELS } from "./profiles.ts";
import type { ModelName, ReviewKind } from "./profiles.ts";
import { ReviewOutputSchema, reviewPrompt } from "./prompt.ts";
import type { ReviewOutput } from "./prompt.ts";
import { combine, emptyMatrix, OUTCOMES, vote } from "./vote.ts";
import type { Matrix, Outcome, Vote } from "./vote.ts";

/** 8 × (120 s + 1,200 s) = 176 minutes of timeouts at most, inside the review job's 210 minutes. */
export const MAX_CANDIDATES = 8;

export interface ReviewOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  fetch: FetchFunction;
  provenance: "synthetic" | "live";
  /** Opens the spend database named by DATABASE_URL. */
  connect: (databaseUrl: string) => Promise<{ spend: Spend; close: () => Promise<void> }>;
  write: (text: string) => void;
  now: () => Date;
}

/** `h` and the first 16 hex characters of SHA-256(candidate ID, a newline, the commit). */
export function candidateKey(candidateId: string, commit: string): string {
  return `h${createHash("sha256").update(`${candidateId}\n${commit}`).digest("hex").slice(0, 16)}`;
}

// The project fields of the writer's run context (tools/local-runner/candidates/*/context.json).
const PROJECT_FIELDS = {
  project_id: "00000000-0000-4000-8000-000000000001",
  project_policy_sha256: "f4f15e4c10e0d724f839c22695656fbe6d368f7fe90ee102ccc7012c18525663",
  task_revision: "0".repeat(64),
} as const;

/** A new run context: fresh batch, root and execution IDs, with the root as the parent. */
export function freshContext(): RunContext {
  const root = randomUUID();
  return { ...PROJECT_FIELDS, batch_id: randomUUID(), root_execution_id: root, execution_id: randomUUID(), parent_execution_id: root };
}

export interface CallResult {
  vote: Vote;
  output: ReviewOutput | null;
  call_name: string;
  operation_id: string;
  status: CallRecord["status"];
  failure: CallRecord["failure"];
  http_status: number | null;
  reserved_microusd: string;
  settled_microusd: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  input_token_bound: number;
  prompt_within_bound: boolean | null;
  ledger_refusal: string | null;
}

export interface CandidateResult {
  candidate_id: string;
  candidate_key: string;
  repo: string;
  commit: string;
  path: string;
  line: number;
  call: string;
  function: string;
  ast_grep: string;
  /** Null when the run stopped before the candidate was decided. */
  outcome: Outcome | null;
  reason: "too_large" | null;
  votes: Record<ModelName, CallResult | null>;
}

export interface Stopped {
  reason: "uncertain" | "ledger_refusal" | "refused" | "error";
  candidate_id: string | null;
  operation_id: string | null;
  detail: string;
}

export interface ReviewFile {
  format_version: 1;
  context: RunContext;
  profiles: Record<ModelName, { model: string; service: string; runtime_profile_sha256: string }>;
  rate_sheet_sha256: string;
  max_candidates: number;
  stopped: Stopped | null;
  counts: Record<Outcome, number>;
  matrix: Matrix;
  candidates: CandidateResult[];
}

export interface ReviewRun {
  inputs: ReviewInputs;
  rateSheet: Uint8Array;
  out: string;
  slotKey: string;
  pool: string;
  maxCandidates: number;
}

/** A driver error code such as ECONNREFUSED or a SQLSTATE; never a message, which can name the host or user. */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "unknown";
  }
  return "unknown";
}

function callResult(call: CallRecord<ReviewKind>, output: ReviewOutput | null): CallResult {
  return {
    vote: vote(output),
    output,
    call_name: call.call_name,
    operation_id: call.operation_id,
    status: call.status,
    failure: call.failure,
    http_status: call.http_status,
    reserved_microusd: call.reserved_microusd.toString(),
    settled_microusd: call.settlement?.settled_microusd.toString() ?? null,
    prompt_tokens: call.usage.prompt_tokens,
    completion_tokens: call.usage.completion_tokens,
    input_token_bound: call.input_token_bound,
    prompt_within_bound: call.prompt_within_bound,
    ledger_refusal: call.ledger_refusal,
  };
}

function pending(input: CandidateInput, outcome: Outcome | null): CandidateResult {
  return {
    candidate_id: input.candidate_id,
    candidate_key: candidateKey(input.candidate_id, input.commit),
    repo: input.repo,
    commit: input.commit,
    path: input.path,
    line: input.line,
    call: input.call,
    function: input.function,
    ast_grep: input.ast_grep,
    outcome,
    reason: null,
    votes: { super: null, kimi: null },
  };
}

function tally(candidates: readonly CandidateResult[]): { counts: Record<Outcome, number>; matrix: Matrix } {
  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<Outcome, number>;
  const matrix = emptyMatrix();
  for (const entry of candidates) {
    if (entry.outcome !== null) {
      counts[entry.outcome] += 1;
    }
    const { super: superCall, kimi } = entry.votes;
    if (entry.outcome !== null && superCall !== null && kimi !== null) {
      matrix[entry.ast_grep === "confirmed" ? "confirmed" : "dropped"][superCall.vote][kimi.vote] += 1;
    }
  }
  return { counts, matrix };
}

/** Whether `dir` is missing or empty, so a run can write there. */
async function isNewDirectory(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

/**
 * Runs the review of already parsed inputs and writes `review.json` and `recordings/` under
 * `run.out`. Returns the exit code and the review, or null when nothing was started.
 */
export async function executeReview(options: ReviewOptions, run: ReviewRun): Promise<{ code: number; review: ReviewFile | null }> {
  const say = (line: string): void => {
    options.write(`${line}\n`);
  };
  const apiKey = options.env[API_KEY_VARIABLE];
  if (apiKey === undefined || apiKey === "") {
    say(`review: ${API_KEY_VARIABLE} is not set`);
    return { code: 1, review: null };
  }
  const databaseUrl = options.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    say("review: DATABASE_URL is not set");
    return { code: 1, review: null };
  }
  if (!(await isNewDirectory(run.out))) {
    say("review: --out must be a new or empty directory");
    return { code: 1, review: null };
  }
  const sheet = parseRateSheet(run.rateSheet);
  for (const model of REVIEW_MODELS) {
    const priced = sheet.ok ? buildEnvelope(sheet.entries, model.profile) : sheet;
    if (!priced.ok) {
      say(`review: unknown_price: ${priced.detail}`);
      return { code: 1, review: null };
    }
  }

  let connection: { spend: Spend; close: () => Promise<void> };
  try {
    connection = await options.connect(databaseUrl);
  } catch (error) {
    say(`review: could not connect to the database named by DATABASE_URL (error code ${errorCode(error)})`);
    return { code: 1, review: null };
  }
  const { spend } = connection;
  const context = freshContext();
  const candidates = run.inputs.candidates.map((input, index) => pending(input, index < run.maxCandidates ? null : "not_reviewed"));
  const review = (stopped: Stopped | null): ReviewFile => ({
    format_version: 1,
    context,
    profiles: {
      super: describe(REVIEW_MODELS[0]?.profile),
      kimi: describe(REVIEW_MODELS[1]?.profile),
    },
    rate_sheet_sha256: rateSheetSha256(run.rateSheet),
    max_candidates: run.maxCandidates,
    stopped,
    ...tally(candidates),
    candidates,
  });
  const finish = async (stopped: Stopped | null): Promise<ReviewFile> => {
    const file = review(stopped);
    await mkdir(run.out, { recursive: true });
    await writeFile(join(run.out, "review.json"), `${JSON.stringify(file, null, 2)}\n`);
    const { counts } = file;
    say(`review: ${String(candidates.length)} candidates; ${OUTCOMES.map((outcome) => `${outcome} ${String(counts[outcome])}`).join(", ")}`);
    say(`review: wrote ${join(run.out, "review.json")}`);
    return file;
  };
  const release = async (): Promise<boolean> => {
    const released = await spend.releaseSlot({
      slot_key: run.slotKey,
      root_execution_id: context.root_execution_id,
      actor_role: ACTOR_ROLE,
      evidence: null,
      reason: null,
    });
    if (!released.ok) {
      const blockers = released.blocking_operation_ids?.join(", ") ?? "";
      say(`review: the slot stays held: ${released.code}${blockers === "" ? "" : ` (operations ${blockers})`}`);
      return false;
    }
    return true;
  };

  let held = false;
  let current: string | null = null;
  try {
    const hold = await spend.acquireSlot({ slot_key: run.slotKey, root_execution_id: context.root_execution_id, actor_role: ACTOR_ROLE });
    if (!hold.ok) {
      say(`review: could not acquire the slot: ${hold.code}`);
      return { code: 1, review: null };
    }
    held = true;
    await mkdir(join(run.out, "recordings"), { recursive: true });
    const providers = REVIEW_MODELS.map((model) => ({ ...model, provider: createModelProvider(model.profile, { fetch: options.fetch, apiKey }) }));
    const stopped = await reviewAll(options, run, { spend, context, providers, candidates, say, setCurrent: (id) => (current = id) });
    const file = await finish(stopped);
    return { code: (await release()) && stopped === null ? 0 : 1, review: file };
  } catch (error) {
    const cause = error instanceof WriterInterruptedError ? error.cause : error;
    say(`review: stopped on an unexpected error (${cause instanceof Error ? cause.name : "unknown"}, code ${errorCode(cause)})`);
    const operation = error instanceof WriterInterruptedError ? error.operation_id : null;
    if (operation !== null) {
      say(`review: operation ${operation} may be unresolved; check it with operationStatus`);
    }
    const file = held
      ? await finish({ reason: "error", candidate_id: current, operation_id: operation, detail: cause instanceof Error ? cause.name : "unknown" })
      : null;
    // Spend refuses the release while any operation is unresolved, so trying is always safe.
    if (held) {
      await release().catch((releaseError: unknown) => {
        say(`review: the slot stays held: the release failed (code ${errorCode(releaseError)})`);
      });
    }
    return { code: 1, review: file };
  } finally {
    await connection.close();
  }
}

function describe(profile: (typeof REVIEW_MODELS)[number]["profile"] | undefined): { model: string; service: string; runtime_profile_sha256: string } {
  if (profile === undefined) {
    throw new Error("the review needs two model profiles");
  }
  return { model: profile.hashed.model, service: profile.service, runtime_profile_sha256: profileSha256(profile) };
}

interface Loop {
  spend: Spend;
  context: RunContext;
  providers: ((typeof REVIEW_MODELS)[number] & { provider: ModelProvider<ReviewKind> })[];
  candidates: CandidateResult[];
  say: (line: string) => void;
  setCurrent: (candidateId: string) => void;
}

/** Reviews the candidates within the cap, one call at a time. Returns why the run stopped, or null. */
async function reviewAll(options: ReviewOptions, run: ReviewRun, loop: Loop): Promise<Stopped | null> {
  const { spend, context, providers, candidates, say } = loop;
  for (const [index, input] of run.inputs.candidates.slice(0, run.maxCandidates).entries()) {
    const entry = candidates[index];
    if (entry === undefined) {
      throw new Error("a candidate has no result entry");
    }
    loop.setCurrent(input.candidate_id);
    const prompt = reviewPrompt(input);
    for (const model of providers) {
      const result = await meteredStructuredCall(
        { spend, provider: model.provider, context, poolKey: run.pool, allocationKey: null, slotKey: run.slotKey, rateSheet: run.rateSheet },
        { kind: REVIEW_KIND, candidate: entry.candidate_key, prompt, schema: ReviewOutputSchema, callOrdinal: model.ordinal },
      );
      if (!result.ok) {
        if (result.code === "prompt_too_large") {
          entry.reason = "too_large";
          break;
        }
        say(`review: refused: ${result.code} for ${entry.candidate_key} ${model.name}`);
        return { reason: "refused", candidate_id: input.candidate_id, operation_id: result.operation_id, detail: result.code };
      }
      const { call, output } = result;
      if (call.http_status !== null && call.response_body !== null) {
        const recording = makeRecording(
          {
            requestBody: call.request_body,
            status: call.http_status,
            responseBody: call.response_body,
            provenance: options.provenance,
            recordedAt: options.now().toISOString(),
          },
          model.profile,
        );
        await writeFile(join(run.out, "recordings", `${entry.candidate_key}-${String(model.ordinal)}.recording.json`), serializeRecording(recording));
      }
      entry.votes[model.name] = callResult(call, output);
      if (call.status === "uncertain") {
        say(`review: uncertain: lost_response for operation ${call.operation_id}; it needs a manual reconciliation`);
        return { reason: "uncertain", candidate_id: input.candidate_id, operation_id: call.operation_id, detail: "lost_response" };
      }
      if (call.ledger_refusal !== null) {
        say(`review: the ledger refused a write after launch (${call.ledger_refusal}) for operation ${call.operation_id}`);
        return { reason: "ledger_refusal", candidate_id: input.candidate_id, operation_id: call.operation_id, detail: call.ledger_refusal };
      }
    }
    const { super: superCall, kimi } = entry.votes;
    entry.outcome =
      entry.reason === "too_large" ? "needs_review" : combine(input.ast_grep === "confirmed", superCall?.vote ?? "unsure", kimi?.vote ?? "unsure");
  }
  return null;
}

const USAGE =
  "usage: review --inputs <review-inputs.json> --rate-sheet <rates.json> --out <new dir> --slot-key <key> --pool <pool-key> [--max-candidates <1-8>]";

/** Parses --max-candidates: default 8, at most 8. Null when invalid. */
export function maxCandidates(value: string | undefined): number | null {
  if (value === undefined) {
    return MAX_CANDIDATES;
  }
  if (!/^[0-9]+$/.test(value)) {
    return null;
  }
  const n = Number(value);
  return n >= 1 && n <= MAX_CANDIDATES ? n : null;
}

export async function runReview(options: ReviewOptions): Promise<number> {
  const say = (line: string): void => {
    options.write(`${line}\n`);
  };
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      args: options.argv,
      strict: true,
      allowPositionals: false,
      options: {
        inputs: { type: "string" },
        "rate-sheet": { type: "string" },
        out: { type: "string" },
        "slot-key": { type: "string" },
        pool: { type: "string" },
        "max-candidates": { type: "string" },
      },
    }).values;
  } catch {
    say(`review: ${USAGE}`);
    return 2;
  }
  const { inputs: inputsPath, out, pool } = values;
  const ratePath = values["rate-sheet"];
  const slotKey = values["slot-key"];
  if (!inputsPath || !ratePath || !out || !slotKey || !pool) {
    say(`review: ${USAGE}`);
    return 2;
  }
  const cap = maxCandidates(values["max-candidates"]);
  if (cap === null) {
    say(`review: --max-candidates must be from 1 to ${String(MAX_CANDIDATES)}`);
    return 2;
  }
  let inputs: ReviewInputs;
  let rateSheet: Uint8Array;
  try {
    inputs = parseReviewInputs(JSON.parse(await readFile(inputsPath, "utf8")));
    rateSheet = await readFile(ratePath);
  } catch (error) {
    say(`review: could not read the inputs or the rate file: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
  return (await executeReview(options, { inputs, rateSheet, out, slotKey, pool, maxCandidates: cap })).code;
}
