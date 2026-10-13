// The screen run: up to N metered calls of one model, one at a time, each asking it to locate and fix
// the bug from the shown source and the symptom alone, each answer scored by code. It follows the
// harvest review: it opens the ledger, acquires the slot for a fresh root, runs the calls and
// releases the slot. An uncertain call stops the run and leaves the slot held.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Spend } from "@rbw/spend";
import { createModelProvider, makeRecording, meteredStructuredCall, profileSha256, rateSheetSha256, serializeRecording, WriterInterruptedError } from "@rbw/writer";
import type { CallRecord, FetchFunction, ModelProvider, RunContext } from "@rbw/writer";
import { budgetRefusal, worstCasePerCall } from "./budget.ts";
import type { ScreenSubject } from "./inputs.ts";
import { API_KEY_VARIABLE, ACTOR_ROLE, SCREEN_KIND, SCREEN_PROFILES } from "./profiles.ts";
import type { ScreenKind, ScreenModelName } from "./profiles.ts";
import { ScreenAnswerSchema, screenPrompt } from "./prompt.ts";
import type { ScreenAnswer } from "./prompt.ts";
import { buildRecord, scoringRecord } from "./record.ts";
import type { Attempt, ScreenRecord, StaticProbe, Stopped } from "./record.ts";
import { isHit, scoreAnswer, verdictOf } from "./score.ts";
import { sha256Hex } from "./site.ts";

export interface ScreenOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  fetch: FetchFunction;
  provenance: "synthetic" | "live";
  /** Opens the spend database named by DATABASE_URL. */
  connect: (databaseUrl: string) => Promise<{ spend: Spend; close: () => Promise<void> }>;
  write: (text: string) => void;
  now: () => Date;
}

export interface ScreenRun {
  subject: ScreenSubject;
  model: ScreenModelName;
  attempts: number;
  failAtHits: number;
  budgetMicrousd: number;
  rateSheet: Uint8Array;
  out: string;
  slotKey: string;
  pool: string;
  binding: boolean;
}

/** `s` and the first 16 hex characters of SHA-256(case, a newline, the planted file's SHA-256). */
export function screenKey(caseName: string, plantedSha256: string): string {
  return `s${createHash("sha256").update(`${caseName}\n${plantedSha256}`).digest("hex").slice(0, 16)}`;
}

// The project fields of the writer's run context, as the harvest review uses them.
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

/** A driver error code such as ECONNREFUSED or a SQLSTATE; never a message, which can name the host or user. */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "unknown";
  }
  return "unknown";
}

async function isNewDirectory(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("an amount is above the safe integer range");
  }
  return Number(value);
}

function attemptOf(index: number, call: CallRecord<ScreenKind>, answer: ScreenAnswer | null, subject: ScreenSubject): Attempt {
  const score =
    answer === null ? null : scoreAnswer(answer, subject.input.target_path, subject.site, subject.planted_text, subject.clean_text);
  const outcome = score?.outcome ?? "no_answer";
  return {
    attempt: index,
    operation_id: call.operation_id,
    call_name: call.call_name,
    status: call.status,
    failure: call.failure,
    http_status: call.http_status,
    outcome,
    miss_kind: score?.miss_kind ?? null,
    hit_range: answer !== null && isHit(outcome) ? { file: subject.input.target_path, start_line: answer.start_line, end_line: answer.end_line } : null,
    input_token_bound: call.input_token_bound,
    prompt_tokens: call.usage.prompt_tokens,
    completion_tokens: call.usage.completion_tokens,
    prompt_within_bound: call.prompt_within_bound,
    reserved_microusd: safeNumber(call.reserved_microusd),
    settled_microusd: call.settlement === null ? null : safeNumber(call.settlement.settled_microusd),
  };
}

/** One attempt's private working copy: the model's own answer text, kept out of the record. */
export interface AnswerEntry {
  attempt: number;
  operation_id: string;
  answer: ScreenAnswer | null;
}

export interface ScreenResult {
  code: number;
  record: ScreenRecord | null;
}

/**
 * Runs the screen and writes `screen.json` (the record), `answers.json` (the model's answers, a
 * private working file) and `recordings/` under `run.out`. Returns the exit code and the record, or
 * null when nothing was started.
 */
export async function executeScreen(options: ScreenOptions, run: ScreenRun): Promise<ScreenResult> {
  const say = (line: string): void => {
    options.write(`${line}\n`);
  };
  const profile = SCREEN_PROFILES[run.model];
  const apiKey = options.env[API_KEY_VARIABLE];
  if (apiKey === undefined || apiKey === "") {
    say(`screen: ${API_KEY_VARIABLE} is not set`);
    return { code: 1, record: null };
  }
  const databaseUrl = options.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    say("screen: DATABASE_URL is not set");
    return { code: 1, record: null };
  }
  if (!(await isNewDirectory(run.out))) {
    say("screen: --out must be a new or empty directory");
    return { code: 1, record: null };
  }
  const worst = worstCasePerCall(run.rateSheet, profile);
  if (!worst.ok) {
    say(`screen: unknown_price: ${worst.detail}`);
    return { code: 1, record: null };
  }
  const overBudget = budgetRefusal(run.attempts, worst.per_call_microusd, run.budgetMicrousd);
  if (overBudget !== null) {
    say(`screen: over budget: ${overBudget}`);
    return { code: 1, record: null };
  }

  let connection: { spend: Spend; close: () => Promise<void> };
  try {
    connection = await options.connect(databaseUrl);
  } catch (error) {
    say(`screen: could not connect to the database named by DATABASE_URL (error code ${errorCode(error)})`);
    return { code: 1, record: null };
  }
  const { spend } = connection;
  const { subject } = run;
  const context = freshContext();
  const key = screenKey(subject.input.case, subject.planted_sha256);
  const prompt = screenPrompt(subject.input.symptom, subject.files);
  const attempts: Attempt[] = [];
  const answers: AnswerEntry[] = [];

  // An operation the run stopped on without an attempt entry (interrupted by an error, or reserved and
  // then refused its launch) has unknown or unsettled amounts, so it is listed as unsettled and stays
  // out of the reserved and settled sums.
  const unsettled = (stopped: Stopped | null): string[] => {
    const ids = attempts.filter((attempt) => attempt.settled_microusd === null).map((attempt) => attempt.operation_id);
    const orphan = stopped?.operation_id ?? null;
    return orphan === null || attempts.some((attempt) => attempt.operation_id === orphan) ? ids : [...ids, orphan];
  };
  const probe = (stopped: Stopped | null): StaticProbe => {
    const settled = attempts.flatMap((attempt) => (attempt.settled_microusd === null ? [] : [attempt.settled_microusd]));
    return {
      status: "run",
      tool: "@rbw/screen",
      model: profile.hashed.model,
      service: profile.service,
      runtime_profile_sha256: profileSha256(profile),
      rate_sheet_sha256: rateSheetSha256(run.rateSheet),
      prompt_sha256: sha256Hex(`${prompt.system}\n\u0000\n${prompt.user}`),
      files_shown: subject.files.map((file) => file.path),
      symptom_sha256: sha256Hex(subject.input.symptom),
      root_execution_id: context.root_execution_id,
      attempts_planned: run.attempts,
      attempts_run: attempts.length,
      answered: attempts.filter((attempt) => attempt.outcome !== "no_answer").length,
      hits: attempts.filter((attempt) => isHit(attempt.outcome)).length,
      fail_at_hits: run.failAtHits,
      scoring: scoringRecord(),
      cost: {
        budget_microusd: run.budgetMicrousd,
        worst_case_microusd_per_call: worst.per_call_microusd,
        reserved_microusd: attempts.reduce((sum, attempt) => sum + attempt.reserved_microusd, 0),
        settled_microusd: settled.reduce((sum, amount) => sum + amount, 0),
        unsettled_operation_ids: unsettled(stopped),
      },
      stopped,
      attempts: [...attempts],
    };
  };
  const finish = async (stopped: Stopped | null): Promise<ScreenRecord> => {
    const probed = probe(stopped);
    // A call whose reported prompt exceeded the counted bound spent outside the reserved envelope, so
    // its answer decides nothing: the run is inconclusive.
    const verdict =
      stopped?.reason === "bound_exceeded"
        ? "inconclusive"
        : verdictOf(
            attempts.map((attempt) => attempt.outcome),
            run.attempts,
            run.failAtHits,
          );
    const record = buildRecord({ subject, probe: probed, verdict, binding: run.binding, judgedOn: options.now() });
    await mkdir(run.out, { recursive: true });
    await writeFile(join(run.out, "screen.json"), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(join(run.out, "answers.json"), `${JSON.stringify({ format_version: 1, case: subject.input.case, answers }, null, 2)}\n`);
    say(
      `screen: ${record.verdict}: ${String(probed.hits)} hits in ${String(probed.attempts_run)} of ${String(run.attempts)} attempts; settled ${String(probed.cost.settled_microusd)} micro-USD`,
    );
    say(`screen: wrote ${join(run.out, "screen.json")}`);
    return record;
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
      say(`screen: the slot stays held: ${released.code}${blockers === "" ? "" : ` (operations ${blockers})`}`);
      return false;
    }
    return true;
  };

  let held = false;
  let current: number | null = null;
  try {
    const hold = await spend.acquireSlot({ slot_key: run.slotKey, root_execution_id: context.root_execution_id, actor_role: ACTOR_ROLE });
    if (!hold.ok) {
      say(`screen: could not acquire the slot: ${hold.code}`);
      return { code: 1, record: null };
    }
    held = true;
    await mkdir(join(run.out, "recordings"), { recursive: true });
    const provider = createModelProvider(profile, { fetch: options.fetch, apiKey });
    const stopped = await attemptAll(options, run, {
      spend,
      context,
      provider,
      key,
      prompt,
      attempts,
      answers,
      say,
      setCurrent: (index) => (current = index),
    });
    const record = await finish(stopped);
    const clean = stopped === null || stopped.reason === "verdict_decided";
    return { code: (await release()) && clean ? 0 : 1, record };
  } catch (error) {
    const cause = error instanceof WriterInterruptedError ? error.cause : error;
    say(`screen: stopped on an unexpected error (${cause instanceof Error ? cause.name : "unknown"}, code ${errorCode(cause)})`);
    const operation = error instanceof WriterInterruptedError ? error.operation_id : null;
    if (operation !== null) {
      say(`screen: operation ${operation} may be unresolved; check it with operationStatus`);
    }
    const record = held
      ? await finish({ reason: "error", attempt: current, operation_id: operation, detail: cause instanceof Error ? cause.name : "unknown" })
      : null;
    // Spend refuses the release while any operation is unresolved, so trying is always safe.
    if (held) {
      await release().catch((releaseError: unknown) => {
        say(`screen: the slot stays held: the release failed (code ${errorCode(releaseError)})`);
      });
    }
    return { code: 1, record };
  } finally {
    await connection.close();
  }
}

interface Loop {
  spend: Spend;
  context: RunContext;
  provider: ModelProvider<ScreenKind>;
  key: string;
  prompt: ReturnType<typeof screenPrompt>;
  attempts: Attempt[];
  answers: AnswerEntry[];
  say: (line: string) => void;
  setCurrent: (index: number) => void;
}

/** Runs the attempts one at a time. Returns why the run stopped early, or null when all ran. */
async function attemptAll(options: ScreenOptions, run: ScreenRun, loop: Loop): Promise<Stopped | null> {
  const { spend, context, provider, key, prompt, attempts, answers, say } = loop;
  for (let index = 1; index <= run.attempts; index += 1) {
    loop.setCurrent(index);
    const result = await meteredStructuredCall(
      { spend, provider, context, poolKey: run.pool, allocationKey: null, slotKey: run.slotKey, rateSheet: run.rateSheet },
      { kind: SCREEN_KIND, candidate: key, prompt, schema: ScreenAnswerSchema, callOrdinal: index },
    );
    if (!result.ok) {
      say(`screen: refused: ${result.code} at attempt ${String(index)}`);
      return {
        reason: result.code === "prompt_too_large" ? "prompt_too_large" : "refused",
        attempt: index,
        operation_id: result.operation_id,
        detail: result.code,
      };
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
        provider.profile,
      );
      await writeFile(join(run.out, "recordings", `${key}-${String(index)}.recording.json`), serializeRecording(recording));
    }
    attempts.push(attemptOf(index, call, output, run.subject));
    answers.push({ attempt: index, operation_id: call.operation_id, answer: output });
    if (call.status === "uncertain") {
      say(`screen: uncertain: lost_response for operation ${call.operation_id}; it needs a manual reconciliation`);
      return { reason: "uncertain", attempt: index, operation_id: call.operation_id, detail: "lost_response" };
    }
    if (call.ledger_refusal !== null) {
      say(`screen: the ledger refused a write after launch (${call.ledger_refusal}) for operation ${call.operation_id}`);
      return { reason: "ledger_refusal", attempt: index, operation_id: call.operation_id, detail: call.ledger_refusal };
    }
    if (call.prompt_within_bound === false) {
      say(
        `screen: bound exceeded: reported prompt tokens ${String(call.usage.prompt_tokens)} exceed the counted bound ${String(call.input_token_bound)} for operation ${call.operation_id}`,
      );
      return { reason: "bound_exceeded", attempt: index, operation_id: call.operation_id, detail: "prompt_tokens_over_bound" };
    }
    const hits = attempts.filter((attempt) => isHit(attempt.outcome)).length;
    if (hits >= run.failAtHits && index < run.attempts) {
      return { reason: "verdict_decided", attempt: index, operation_id: null, detail: `${String(hits)} hits reached the failing count` };
    }
  }
  return null;
}
