// The solver's tool-calling loop. Each model turn is one metered call on @rbw/spend, in the
// writer's order: bound and price the exact request, check the slot, reserve, record launching,
// send once, then record the terminal state and settle. Nothing retries. The loop runs each tool
// call itself against the session, and stops on submit, on a cap, on a spend refusal, or on an
// infrastructure error (which the rerun rule handles at the attempt level).
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { callName } from "@rbw/schema";
import type { EnvelopeLine, RefusalCode, ReserveRequest, Spend } from "@rbw/spend";
import { meteredOperationId, ObservedFetch, parseRunContext, payloadHash, profileSha256, reportedUsage } from "@rbw/writer";
import type { Exchange, FetchFunction, ReportedUsage, RunContext } from "@rbw/writer";
import { contaminationHits } from "./contamination.ts";
import type { ContaminationHit } from "./contamination.ts";
import { countSolverPromptBound, settlementLines, solverEnvelope, unsentLines, usageState } from "./envelope.ts";
import { CHAT_COMPLETIONS_URL, SOLVER_KIND } from "./profile.ts";
import type { CapName, SolverProfile } from "./profile.ts";
import { armToolNames, armToolSet, newToolState, runTool } from "./tools.ts";
import type { Arm, SolverSession, ToolName, ToolOutcome } from "./tools.ts";

/** The fixed system prompt, shared by both arms. It names no tool, so it is the same in each. */
export const SOLVER_SYSTEM_PROMPT = [
  "You are fixing a bug in a web application from a user's bug report.",
  "The application's source is in the current directory. Use the tools to investigate, change the source, rebuild and restart the app, and check your fix.",
  "Change only what the fix needs. When you are done, call submit; the files as they are then are graded by tests you cannot see.",
].join("\n");

/** Sent as a user message when a turn ends without a tool call. */
export const NO_TOOL_CALL_REMINDER = "Continue by calling a tool. Call submit when the fix is done.";

/** The first user message: the bug report, unchanged, under a fixed heading. */
export function taskMessage(issue: string): string {
  return `Bug report:\n\n${issue}`;
}

/** One attempt: its arm, its index in the pre-registered order and its rerun number (0 first). */
export interface AttemptSpec {
  arm: Arm;
  index: number;
  rerun: number;
}

const MAX_INDEX = 999;
const MAX_RERUN = 9;

/** The attempt's call-name segment, such as `off-007-r0`. */
export function attemptKey(spec: AttemptSpec): string {
  if (!Number.isSafeInteger(spec.index) || spec.index < 1 || spec.index > MAX_INDEX) {
    throw new Error(`the attempt index must be 1 to ${String(MAX_INDEX)}`);
  }
  if (!Number.isSafeInteger(spec.rerun) || spec.rerun < 0 || spec.rerun > MAX_RERUN) {
    throw new Error(`the rerun number must be 0 to ${String(MAX_RERUN)}`);
  }
  return `${spec.arm}-${String(spec.index).padStart(3, "0")}-r${String(spec.rerun)}`;
}

/** One JSONL line of the transcript. Every model call carries its model, endpoint and dates (R8). */
export type TranscriptEvent =
  | {
      type: "attempt_start";
      attempt_key: string;
      arm: Arm;
      index: number;
      rerun: number;
      model_id: string;
      endpoint: string;
      runtime_profile_sha256: string;
      rate_sheet_sha256: string;
      tools: ToolName[];
      seed: number;
      started_at: string;
    }
  | {
      type: "model_call";
      turn: number;
      operation_id: string;
      model_id: string;
      endpoint: string;
      /** The `model` field of the response body, when it has one. */
      response_model: string | null;
      requested_at: string;
      responded_at: string;
      payload_sha256: string;
      input_token_bound: number;
      status: "completed" | "failed" | "uncertain";
      failure: CallFailure | null;
      http_status: number | null;
      usage: ReportedUsage;
      settled_microusd: number | null;
      /** The assistant's reply: its text and its tool calls as the SDK parsed them. */
      text: string;
      tool_calls: { id: string; name: string; input: unknown; invalid: boolean }[];
    }
  | { type: "tool_call"; turn: number; id: string; name: string; input: unknown; output: string; started_at: string; ended_at: string }
  | { type: "reminder"; turn: number; text: string }
  /** The history policy replaced an earlier tool result with a stub before `turn`'s request. */
  | { type: "history_elided"; turn: number; tool_call_id: string; tool_name: string; bytes: number }
  | { type: "attempt_end"; result: AttemptResult; ended_at: string };

export type CallFailure = "http_status" | "invalid_output" | "request_not_sent" | "lost_response";

export type AttemptOutcome = "submitted" | "cap_reached" | "spend_refused" | "infrastructure_error";
export type { CapName };

export interface AttemptResult {
  attempt_key: string;
  arm: Arm;
  index: number;
  rerun: number;
  outcome: AttemptOutcome;
  cap: CapName | null;
  /** Why an infrastructure error stopped the attempt, and the operation when one was involved. */
  infrastructure: { reason: string; operation_id: string | null } | null;
  refusal: { code: string; detail: string | null; operation_id: string | null } | null;
  summary: string | null;
  /** Model calls launched. */
  turns: number;
  /** Reported input tokens, with the counted bound standing in for a call that reported none. */
  input_tokens: number;
  /** Reported output tokens, with the output limit standing in for a call that reported none. */
  output_tokens: number;
  /** False when any launched call did not report its usage. */
  usage_complete: boolean;
  settled_microusd: number;
  tool_calls: Record<ToolName, number>;
  invalid_tool_calls: number;
  rebuilds: number;
  /** Tool results the history policy replaced with a stub. */
  elided_tool_results: number;
  bash_commands: string[];
  contamination: ContaminationHit[];
  wall_ms: number;
}

export interface AttemptOptions {
  spend: Spend;
  /** Required. A scripted or replay fetch in tests; the platform fetch only in a live run. */
  fetch: FetchFunction;
  /** The solver role's key, sent only as the bearer header and never recorded. */
  apiKey?: string;
  profile: SolverProfile;
  /** The attempt's run context; validated strictly, unknown fields rejected. */
  context: unknown;
  poolKey: string;
  allocationKey: string | null;
  /** The slot the context's root execution must already hold. */
  slotKey: string;
  /** Exact bytes of the solver rate file. */
  rateSheet: Uint8Array;
  spec: AttemptSpec;
  /** The bug report, the same text in every attempt of both arms. */
  issue: string;
  session: SolverSession;
  /** Receives each transcript event in order; awaited. */
  transcript: (event: TranscriptEvent) => void | Promise<void>;
  /** The clock; injected in tests. */
  now?: () => Date;
  /** When the attempt started, if before this call (its session's open and initial build): the wall cap and wall_ms count from it. */
  startedAt?: Date;
}

/** The transcript event as one JSONL line. */
export function transcriptLine(event: TranscriptEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Request fields the loop sets itself; a profile's request extras may not set them. */
const OWNED_REQUEST_FIELDS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "response_format",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "n",
  "temperature",
  "seed",
]);

interface Provider {
  model: LanguageModel;
  observed: ObservedFetch;
}

function createProvider(profile: SolverProfile, fetch: FetchFunction, apiKey: string | undefined): Provider {
  if (typeof fetch !== "function") {
    throw new Error("the solver needs an injected fetch; it never picks one itself");
  }
  const extras = profile.request_extras;
  const owned = Object.keys(extras).filter((key) => OWNED_REQUEST_FIELDS.has(key));
  if (owned.length > 0) {
    throw new Error(`request extras may not set loop-owned request fields: ${owned.join(", ")}`);
  }
  const observed = new ObservedFetch(fetch);
  const provider = createOpenAICompatible({
    name: profile.hashed.provider,
    baseURL: profile.hashed.base_url,
    fetch: observed.fetch,
    includeUsage: true,
    ...(apiKey === undefined ? {} : { apiKey }),
    transformRequestBody: (body: Record<string, unknown>) => {
      const collisions = Object.keys(extras).filter((key) => key in body);
      if (collisions.length > 0) {
        throw new Error(`request extras may not override request fields: ${collisions.join(", ")}`);
      }
      return { ...body, ...extras };
    },
  });
  return { model: provider.chatModel(profile.hashed.model), observed };
}

function classify(exchange: Exchange, error: unknown): { status: "completed" | "failed" | "uncertain"; failure: CallFailure | null } {
  switch (exchange.kind) {
    case "lost":
      return { status: "uncertain", failure: "lost_response" };
    case "none":
    case "not_sent":
      return { status: "failed", failure: "request_not_sent" };
    case "response":
      if (exchange.status < 200 || exchange.status > 299) {
        return { status: "failed", failure: "http_status" };
      }
      return error === null ? { status: "completed", failure: null } : { status: "failed", failure: "invalid_output" };
  }
}

function responseModel(exchange: Exchange): string | null {
  if (exchange.kind !== "response") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(exchange.body);
    if (typeof parsed === "object" && parsed !== null && "model" in parsed && typeof parsed.model === "string") {
      return parsed.model;
    }
  } catch {
    return null;
  }
  return null;
}

interface Turn {
  turn: number;
  operation_id: string;
  status: "completed" | "failed" | "uncertain";
  failure: CallFailure | null;
  usage: ReportedUsage;
  bound: number;
  payload_sha256: string;
  http_status: number | null;
  response_model: string | null;
  settled_microusd: number | null;
  result: Generated | null;
  /** A ledger write after launch was refused; the operation needs an operator. */
  ledger_refusal: RefusalCode | null;
}

type TurnOutcome =
  | { kind: "refused"; code: string; detail: string | null; operation_id: string | null }
  /** A ledger call threw from the reservation on; the operation may need an operator. */
  | { kind: "ledger_exception"; reason: string; operation_id: string }
  | { kind: "too_large"; bound: number }
  | { kind: "launched"; turn: Turn };

interface Loop {
  options: AttemptOptions;
  context: RunContext;
  provider: Provider;
  profileSha: string;
  envelope: EnvelopeLine[];
  rateSha: string;
  key: string;
  tools: ToolSet;
  now: () => Date;
}

function generate(loop: Loop, messages: ModelMessage[]) {
  const { profile, spec } = loop.options;
  return generateText({
    model: loop.provider.model,
    system: SOLVER_SYSTEM_PROMPT,
    messages,
    tools: loop.tools,
    toolChoice: "auto",
    temperature: profile.temperature,
    seed: spec.index,
    maxOutputTokens: profile.hashed.max_output_tokens,
    maxRetries: profile.hashed.max_retries,
    abortSignal: AbortSignal.timeout(profile.hashed.request_timeout_ms),
  });
}

type Generated = Awaited<ReturnType<typeof generate>>;

/**
 * One metered model turn. Throws only on an infrastructure error before the reservation is
 * requested; from the reservation on, a thrown ledger call ends as `ledger_exception` with the
 * operation's id.
 */
async function meteredTurn(loop: Loop, turn: number, messages: ModelMessage[], inputCounted: number): Promise<TurnOutcome | { kind: "attempt_input_cap"; bound: number }> {
  const { options, context, provider, profileSha } = loop;
  const { spend, profile } = options;
  const body = await provider.observed.preview(() => generate(loop, messages));
  const bound = countSolverPromptBound(body, profile);
  if (bound > profile.hashed.max_input_tokens) {
    return { kind: "too_large", bound };
  }
  if (inputCounted + bound > profile.hashed.attempt_caps.max_input_tokens) {
    return { kind: "attempt_input_cap", bound };
  }
  const slot = await spend.slotStatus({ slot_key: options.slotKey });
  if (!slot.ok) {
    return { kind: "refused", code: slot.code, detail: slot.detail ?? null, operation_id: null };
  }
  if (slot.holder !== context.root_execution_id) {
    return { kind: "refused", code: "slot_not_held", detail: "the run context's root execution does not hold the slot", operation_id: null };
  }
  const id = meteredOperationId(profile, { context, kind: SOLVER_KIND, candidate: loop.key, callOrdinal: turn, attemptOrdinal: 1 });
  const request: ReserveRequest = {
    operation_id: id,
    payload_hash: payloadHash(body),
    attempt_ordinal: 1,
    previous_operation_id: null,
    project_id: context.project_id,
    project_policy_sha256: context.project_policy_sha256,
    batch_id: context.batch_id,
    task_revision: context.task_revision,
    root_execution_id: context.root_execution_id,
    execution_id: context.execution_id,
    parent_execution_id: context.parent_execution_id,
    kind: SOLVER_KIND,
    call_name: callName(SOLVER_KIND, loop.key, turn),
    provider: profile.hashed.provider,
    provider_replay_key: null,
    pool_key: options.poolKey,
    allocation_key: options.allocationKey,
    runtime_profile_sha256: profileSha,
    rate_sheet_sha256: loop.rateSha,
    envelope: loop.envelope,
  };
  try {
    return await reservedTurn(loop, turn, messages, body, bound, request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "ledger_exception", reason: `ledger_exception: ${reason}`, operation_id: id };
  }
}

/** The turn from the reservation on: reserve, launch, send once, then the terminal state and settlement. */
async function reservedTurn(loop: Loop, turn: number, messages: ModelMessage[], body: string, bound: number, request: ReserveRequest): Promise<TurnOutcome> {
  const { options, provider, profileSha } = loop;
  const { spend, profile } = options;
  const id = request.operation_id;
  const reserved = await spend.reserve(request);
  if (!reserved.ok) {
    return { kind: "refused", code: reserved.code, detail: reserved.detail ?? null, operation_id: null };
  }
  if (reserved.replay) {
    return { kind: "refused", code: "operation_replayed", detail: "another process reserved this turn first", operation_id: id };
  }
  const launched = await spend.transition({
    operation_id: id,
    from_state: "prepared",
    to_state: "launching",
    actor_role: profile.actor_role,
    slot_key: options.slotKey,
  });
  if (!launched.ok) {
    return { kind: "refused", code: launched.code, detail: launched.detail ?? null, operation_id: id };
  }
  let result: Generated | null = null;
  const { exchange, error } = await provider.observed.send(body, async () => {
    result = await generate(loop, messages);
  });
  const { status, failure } = classify(exchange, error);
  const usage = exchange.kind === "response" ? reportedUsage(exchange.status, exchange.body) : reportedUsage(0, "");
  const base: Turn = {
    turn,
    operation_id: id,
    status,
    failure,
    usage,
    bound,
    payload_sha256: request.payload_hash,
    http_status: exchange.kind === "response" ? exchange.status : null,
    response_model: responseModel(exchange),
    settled_microusd: null,
    result: null,
    ledger_refusal: null,
  };
  if (status === "uncertain") {
    const uncertain = await spend.transition({
      operation_id: id,
      from_state: "launching",
      to_state: "uncertain",
      actor_role: profile.actor_role,
      uncertainty: "lost_response",
    });
    return { kind: "launched", turn: { ...base, ledger_refusal: uncertain.ok ? null : uncertain.code } };
  }
  const terminal = await spend.transition({
    operation_id: id,
    from_state: "launching",
    to_state: "terminal",
    actor_role: profile.actor_role,
    terminal_status: status === "completed" ? "completed" : "failed",
  });
  if (!terminal.ok) {
    return { kind: "launched", turn: { ...base, ledger_refusal: terminal.code } };
  }
  const neverSent = exchange.kind === "none" || exchange.kind === "not_sent";
  const lines = neverSent ? unsentLines(loop.envelope) : settlementLines(loop.envelope, usage);
  const settled = await spend.settle({
    schema_version: 1,
    operation_id: id,
    runtime_profile_sha256: profileSha,
    rate_sheet_sha256: loop.rateSha,
    reserved_microusd: Number(reserved.reserved_microusd),
    service_lines: lines,
    usage_state: usageState(lines),
    terminal_evidence_key: null,
    terminal_evidence_sha256: null,
  });
  const settledMicrousd = lines.reduce((sum, line) => sum + (line.actual_microusd ?? line.retained_microusd), 0);
  return {
    kind: "launched",
    turn: {
      ...base,
      settled_microusd: settled.ok ? settledMicrousd : null,
      ledger_refusal: settled.ok ? null : settled.code,
      result: status === "completed" ? result : null,
    },
  };
}

/** Whether the SDK already answered this tool call (it does so for an unknown tool or invalid input). */
function answeredBySdk(messages: readonly ModelMessage[], toolCallId: string): boolean {
  return messages.some(
    (message) =>
      message.role === "tool" &&
      message.content.some((part) => part.type === "tool-result" && part.toolCallId === toolCallId),
  );
}

/** The start of the stub that replaces a tool result the history policy elided. */
export const HISTORY_ELISION_NOTE = "[an earlier tool result was elided to keep the request within the per-call limit; call the tool again to see it";

const encoder = new TextEncoder();

function elisionStub(bytes: number): string {
  return `${HISTORY_ELISION_NOTE} (${String(bytes)} bytes)]`;
}

/**
 * The history policy, the same in both arms: elide the oldest tool result that is not in the
 * newest tool message, is not already a stub and is longer than its stub, by replacing its output
 * with the stub. Returns what was elided, or null when nothing may be.
 */
export function elideOldestToolResult(messages: ModelMessage[]): { tool_call_id: string; tool_name: string; bytes: number } | null {
  const newest = messages.findLastIndex((message) => message.role === "tool");
  for (let i = 0; i < newest; i += 1) {
    const message = messages[i];
    if (message?.role !== "tool") {
      continue;
    }
    for (const [j, part] of message.content.entries()) {
      if (part.type !== "tool-result") {
        continue;
      }
      if (part.output.type === "text" && part.output.value.startsWith(HISTORY_ELISION_NOTE)) {
        continue;
      }
      const bytes = encoder.encode(part.output.type === "text" || part.output.type === "error-text" ? part.output.value : JSON.stringify(part.output)).length;
      const stub = elisionStub(bytes);
      if (bytes <= encoder.encode(stub).length) {
        continue;
      }
      const content = [...message.content];
      content[j] = { ...part, output: { type: "text", value: stub } };
      messages[i] = { ...message, content };
      return { tool_call_id: part.toolCallId, tool_name: part.toolName, bytes };
    }
  }
  return null;
}

/**
 * Runs one attempt to its end and returns its result. Every transcript event is written before the
 * function returns, the last one being `attempt_end`.
 */
export async function runAttempt(options: AttemptOptions): Promise<AttemptResult> {
  const now = options.now ?? (() => new Date());
  const { profile, spec, session } = options;
  const context = parseRunContext(options.context);
  const key = attemptKey(spec);
  const priced = solverEnvelope(options.rateSheet, profile);
  if (!priced.ok) {
    throw new Error(`the solver rate file cannot price ${profile.service}: ${priced.detail}`);
  }
  const loop: Loop = {
    options,
    context,
    provider: createProvider(profile, options.fetch, options.apiKey),
    profileSha: profileSha256(profile),
    envelope: priced.envelope,
    rateSha: priced.rate_sheet_sha256,
    key,
    tools: armToolSet(spec.arm),
    now,
  };
  const caps = profile.hashed.attempt_caps;
  const startedAt = options.startedAt ?? now();
  const state = newToolState();
  const result: AttemptResult = {
    attempt_key: key,
    arm: spec.arm,
    index: spec.index,
    rerun: spec.rerun,
    outcome: "cap_reached",
    cap: null,
    infrastructure: null,
    refusal: null,
    summary: null,
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    usage_complete: true,
    settled_microusd: 0,
    tool_calls: state.calls,
    invalid_tool_calls: 0,
    rebuilds: 0,
    elided_tool_results: 0,
    bash_commands: state.bash_commands,
    contamination: [],
    wall_ms: 0,
  };
  await options.transcript({
    type: "attempt_start",
    attempt_key: key,
    arm: spec.arm,
    index: spec.index,
    rerun: spec.rerun,
    model_id: profile.hashed.model,
    endpoint: CHAT_COMPLETIONS_URL,
    runtime_profile_sha256: loop.profileSha,
    rate_sheet_sha256: loop.rateSha,
    tools: armToolNames(spec.arm),
    seed: spec.index,
    started_at: startedAt.toISOString(),
  });

  const finish = async (): Promise<AttemptResult> => {
    const ended = now();
    result.rebuilds = state.rebuilds;
    result.contamination = contaminationHits(state.bash_commands, state.file_paths);
    result.wall_ms = ended.getTime() - startedAt.getTime();
    await options.transcript({ type: "attempt_end", result, ended_at: ended.toISOString() });
    return result;
  };
  const stopOnCap = (cap: CapName) => {
    result.outcome = "cap_reached";
    result.cap = cap;
    return finish();
  };
  const infrastructure = (reason: string, operationId: string | null) => {
    result.outcome = "infrastructure_error";
    result.infrastructure = { reason, operation_id: operationId };
    return finish();
  };

  const messages: ModelMessage[] = [{ role: "user", content: taskMessage(options.issue) }];
  for (;;) {
    if (result.turns >= caps.max_turns) {
      return stopOnCap("turns");
    }
    if (now().getTime() - startedAt.getTime() >= caps.max_wall_ms) {
      return stopOnCap("wall");
    }
    const turnNumber = result.turns + 1;
    const requestedAt = now();
    const outcome = await meteredTurn(loop, turnNumber, messages, result.input_tokens);
    if (outcome.kind === "too_large") {
      // The history policy: elide the oldest tool result and render the request again. The turn
      // is not launched, so the caps are checked again before the retry.
      const elided = elideOldestToolResult(messages);
      if (elided === null) {
        return stopOnCap("context_window");
      }
      result.elided_tool_results += 1;
      await options.transcript({ type: "history_elided", turn: turnNumber, ...elided });
      continue;
    }
    if (outcome.kind === "attempt_input_cap") {
      return stopOnCap("input_tokens");
    }
    if (outcome.kind === "ledger_exception") {
      return infrastructure(outcome.reason, outcome.operation_id);
    }
    if (outcome.kind === "refused") {
      result.outcome = "spend_refused";
      result.refusal = { code: outcome.code, detail: outcome.detail, operation_id: outcome.operation_id };
      return finish();
    }
    const { turn } = outcome;
    result.turns = turnNumber;
    result.input_tokens += turn.usage.prompt_tokens ?? turn.bound;
    result.output_tokens += turn.usage.completion_tokens ?? profile.hashed.max_output_tokens;
    if (turn.usage.prompt_tokens === null || turn.usage.completion_tokens === null) {
      result.usage_complete = false;
    }
    result.settled_microusd += turn.settled_microusd ?? 0;
    const generated = turn.result;
    await options.transcript({
      type: "model_call",
      turn: turnNumber,
      operation_id: turn.operation_id,
      model_id: profile.hashed.model,
      endpoint: CHAT_COMPLETIONS_URL,
      response_model: turn.response_model,
      requested_at: requestedAt.toISOString(),
      responded_at: now().toISOString(),
      payload_sha256: turn.payload_sha256,
      input_token_bound: turn.bound,
      status: turn.status,
      failure: turn.failure,
      http_status: turn.http_status,
      usage: turn.usage,
      settled_microusd: turn.settled_microusd,
      text: generated?.text ?? "",
      tool_calls: (generated?.toolCalls ?? []).map((call) => ({
        id: call.toolCallId,
        name: call.toolName,
        input: call.input as unknown,
        invalid: call.invalid === true,
      })),
    });
    if (turn.ledger_refusal !== null) {
      return infrastructure(`ledger_${turn.ledger_refusal}`, turn.operation_id);
    }
    if (turn.status !== "completed" || generated === null) {
      return infrastructure(turn.failure ?? "no_result", turn.operation_id);
    }
    const responseMessages = generated.finalStep.response.messages;
    messages.push(...responseMessages);
    const calls = generated.toolCalls;
    if (calls.length === 0) {
      messages.push({ role: "user", content: NO_TOOL_CALL_REMINDER });
      await options.transcript({ type: "reminder", turn: turnNumber, text: NO_TOOL_CALL_REMINDER });
      continue;
    }
    const results: { toolCallId: string; toolName: string; output: string }[] = [];
    let submitted = false;
    for (const call of calls) {
      if (call.invalid === true || answeredBySdk(responseMessages, call.toolCallId)) {
        result.invalid_tool_calls += 1;
        continue;
      }
      // The wall cap holds between tool calls too: once it has passed, no further call runs (a submit
      // after the cap is not a submission), so the overshoot is at most one model response and one tool call.
      if (now().getTime() - startedAt.getTime() >= caps.max_wall_ms) {
        return stopOnCap("wall");
      }
      const toolStarted = now();
      let ran: ToolOutcome;
      try {
        ran = await runTool(spec.arm, call.toolName, call.input, session, state, caps);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return infrastructure(`session_error: ${call.toolName}: ${reason}`, null);
      }
      await options.transcript({
        type: "tool_call",
        turn: turnNumber,
        id: call.toolCallId,
        name: call.toolName,
        input: call.input,
        output: ran.output,
        started_at: toolStarted.toISOString(),
        ended_at: now().toISOString(),
      });
      results.push({ toolCallId: call.toolCallId, toolName: call.toolName, output: ran.output });
      if (ran.submitted) {
        submitted = true;
        result.summary = ran.summary;
        break;
      }
    }
    if (results.length > 0) {
      messages.push({
        role: "tool",
        content: results.map((r) => ({
          type: "tool-result" as const,
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          output: { type: "text" as const, value: r.output },
        })),
      });
    }
    if (submitted) {
      result.outcome = "submitted";
      return finish();
    }
  }
}
