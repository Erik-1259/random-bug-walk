// The card and issue writer. Every model call is bounded, counted and priced before it starts,
// reserved against the spend pool, recorded as launching before the request, and settled after it.
// The caller protocol of @rbw/spend is followed exactly; nothing retries.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Output, generateText } from "ai";
import type { LanguageModel } from "ai";
import { callName } from "@rbw/schema";
import type {
  EnvelopeLine,
  OperationStatus,
  RefusalCode,
  ReserveRequest,
  Settled,
  Spend,
  UsageSettlement,
  UsageSettlementLine,
} from "@rbw/spend";
import { z } from "zod";
import { CardSourceSchema, applyCodeOwnedFields, buildCardPrompt } from "./card-prompt.ts";
import type { CodeOwnedField } from "./card-prompt.ts";
import { CardSchema } from "./card-schema.ts";
import type { Card } from "./card-schema.ts";
import {
  ACTOR_ROLE,
  BASE_URL,
  MAX_CALLS_PER_CANDIDATE,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MAX_RETRIES,
  MODEL_ID,
  PROVIDER,
  REQUEST_TIMEOUT_MS,
} from "./config.ts";
import { ObservedFetch } from "./http.ts";
import type { Exchange, FetchFunction } from "./http.ts";
import {
  CANDIDATE_PATTERN,
  WRITER_KINDS,
  operationId,
  parseRunContext,
  payloadHash,
  runtimeProfileSha256,
} from "./identity.ts";
import type { RunContext, WriterKind } from "./identity.ts";
import { checkIssue, structureFailure } from "./issue-checks.ts";
import type { IssueCheckReport } from "./issue-checks.ts";
import { buildIssuePrompt } from "./issue-prompt.ts";
import { IssueOutputSchema } from "./issue-schema.ts";
import type { IssueOutput } from "./issue-schema.ts";
import { parseObservedSymptom } from "./observed-symptom.ts";
import { countPromptBound } from "./prompt-bound.ts";
import type { PromptMessages } from "./prompt.ts";
import { actualMicrousd, buildEnvelope, lineWorstCase, parseRateSheet, rateSheetSha256 } from "./rates.ts";
import { reportedUsage } from "./recording.ts";
import type { ReportedUsage } from "./recording.ts";

export interface WriterProvider {
  readonly modelId: string;
  readonly model: LanguageModel;
  readonly observed: ObservedFetch;
}

export interface WriterProviderOptions {
  /** Required. Replay in tests and public CI; the platform fetch only in the `record` command. */
  fetch: FetchFunction;
  /** The writer role's key. Sent only as the bearer header; never recorded. */
  apiKey?: string;
}

/** The fixed model through the OpenAI-compatible provider, with thinking off and no tools. */
export function createWriterProvider(options: WriterProviderOptions): WriterProvider {
  if (typeof options.fetch !== "function") {
    throw new Error("createWriterProvider needs an injected fetch; the library never picks one itself");
  }
  const observed = new ObservedFetch(options.fetch);
  const provider = createOpenAICompatible({
    name: PROVIDER,
    baseURL: BASE_URL,
    fetch: observed.fetch,
    // Adds stream_options to streaming requests only. A non-streaming chat completion, which is
    // what the writer sends, carries `usage` in its response without being asked.
    includeUsage: true,
    supportsStructuredOutputs: true,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    transformRequestBody: (body: Record<string, unknown>) => {
      if (body.tools !== undefined) {
        throw new Error("writer requests carry no tools");
      }
      return { ...body, chat_template_kwargs: { enable_thinking: false } };
    },
  });
  return { modelId: MODEL_ID, model: provider.chatModel(MODEL_ID), observed };
}

/** An infrastructure error after a reservation was requested; the operation may need an operator. */
export class WriterInterruptedError extends Error {
  readonly operation_id: string;

  constructor(operationId: string, cause: unknown) {
    super(`the writer stopped on an infrastructure error after reserving operation ${operationId}`, { cause });
    this.name = "WriterInterruptedError";
    this.operation_id = operationId;
  }
}

export interface WriterOptions {
  spend: Spend;
  provider: WriterProvider;
  /** The run context; validated strictly here, unknown fields rejected. */
  context: unknown;
  poolKey: string;
  allocationKey: string | null;
  /** Slot key the context's root execution must already hold. */
  slotKey: string;
  /** Exact bytes of the rate file. */
  rateSheet: Uint8Array;
}

export type WriterRefusalCode =
  | RefusalCode
  | "invalid_input"
  | "prompt_too_large"
  | "call_limit_reached"
  | "operation_replayed";

/** Nothing was sent. `operation_id` is set when a reservation exists (a refused launch). */
export interface WriterRefusal {
  ok: false;
  code: WriterRefusalCode;
  detail: string | null;
  operation_id: string | null;
}

export type CallFailure = "http_status" | "invalid_output" | "request_not_sent" | "lost_response";

/** One launched call, as the ledger and the provider saw it. */
export interface CallRecord {
  operation_id: string;
  kind: WriterKind;
  candidate: string;
  call_ordinal: number;
  call_name: string;
  payload_hash: string;
  /** The counted upper bound on input tokens, persisted with the call. */
  input_token_bound: number;
  request_body: string;
  status: "completed" | "failed" | "uncertain";
  failure: CallFailure | null;
  http_status: number | null;
  response_body: string | null;
  usage: ReportedUsage;
  /** Whether reported prompt tokens ≤ the counted bound; null when not reported. */
  prompt_within_bound: boolean | null;
  reserved_microusd: bigint;
  settlement: Settled | null;
  /** A spend refusal on a write after launch; the operation then needs an operator. */
  ledger_refusal: RefusalCode | null;
}

export type CardOutcome =
  | WriterRefusal
  | { ok: true; call: CallRecord; card: Card | null; code_owned_fields: CodeOwnedField[] | null };

export type IssueOutcome =
  | WriterRefusal
  | { ok: true; call: CallRecord; issue: IssueOutput | null; report: IssueCheckReport | null };

export type Preview = { ok: true; request_body: string; input_token_bound: number } | WriterRefusal;

export interface IssueRequest {
  candidate: string;
  /** Must parse as an ObservedSymptom; anything else is refused before reserving. */
  symptom: unknown;
  /** The fixture's internal names, supplied as data. */
  excludedIdentifiers: readonly string[];
}

export interface CardRequest {
  candidate: string;
  source: unknown;
}

export interface Writer {
  writeCard(request: CardRequest): Promise<CardOutcome>;
  writeIssue(request: IssueRequest): Promise<IssueOutcome>;
  /** Renders a card request and counts its bound; reserves and sends nothing. */
  previewCard(source: unknown): Promise<Preview>;
  /** Renders an issue request and counts its bound; reserves and sends nothing. */
  previewIssue(symptom: unknown): Promise<Preview>;
}

function refusal(code: WriterRefusalCode, detail: string | null, operationIdValue: string | null = null): WriterRefusal {
  return { ok: false, code, detail, operation_id: operationIdValue };
}

type Rendered<T> = { ok: true; prompt: PromptMessages; schema: z.ZodType<T> } | WriterRefusal;

type Metered<T> = WriterRefusal | { ok: true; call: CallRecord; output: T | null };

function withinBound(usage: ReportedUsage, bound: number): boolean | null {
  return usage.prompt_tokens === null ? null : usage.prompt_tokens <= bound;
}

function settlementLines(envelope: EnvelopeLine[], usage: ReportedUsage): UsageSettlementLine[] {
  return envelope.map((line) => {
    const quantity = line.unit === "input_token" ? usage.prompt_tokens : usage.completion_tokens;
    if (quantity === null || line.price === null) {
      return {
        service: line.service,
        unit: line.unit,
        actual_quantity: null,
        actual_microusd: null,
        retained_microusd: lineWorstCase(line),
      };
    }
    return {
      service: line.service,
      unit: line.unit,
      actual_quantity: quantity,
      actual_microusd: actualMicrousd(quantity, line.price),
      retained_microusd: 0,
    };
  });
}

/** Every line at zero: the request provably never reached the provider, so nothing was spent. */
function unsentLines(envelope: EnvelopeLine[]): UsageSettlementLine[] {
  return envelope.map((line) => ({
    service: line.service,
    unit: line.unit,
    actual_quantity: 0,
    actual_microusd: 0,
    retained_microusd: 0,
  }));
}

interface Slot {
  ordinal: number;
  attempt: number;
  previous: string | null;
}

/** Settled at zero with the whole reservation released: the call's request was never sent. */
function neverReachedProvider(status: OperationStatus): boolean {
  return (
    status.state === "reconciled" &&
    status.settled_microusd === 0n &&
    status.open_microusd === 0n &&
    status.reserved_microusd > 0n &&
    status.released_microusd === status.reserved_microusd
  );
}

function usageState(lines: UsageSettlementLine[]): UsageSettlement["usage_state"] {
  const unknown = lines.filter((line) => line.actual_microusd === null).length;
  return unknown === 0 ? "known" : unknown === lines.length ? "unknown" : "partly_unknown";
}

function classify(exchange: Exchange, error: unknown): { status: CallRecord["status"]; failure: CallFailure | null } {
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

// Writers for one candidate may overlap and need not share a writer object or a provider. Claiming
// the next ordinal is serialized per candidate across all of them in this process.
const candidateClaims = new Map<string, Promise<unknown>>();

async function withCandidateClaim<R>(candidate: string, task: () => Promise<R>): Promise<R> {
  const previous = candidateClaims.get(candidate) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  candidateClaims.set(candidate, tail);
  try {
    return await run;
  } finally {
    if (candidateClaims.get(candidate) === tail) {
      candidateClaims.delete(candidate);
    }
  }
}

export function createWriter(options: WriterOptions): Writer {
  const context: RunContext = parseRunContext(options.context);
  const { spend, provider } = options;
  const profileSha = runtimeProfileSha256();

  // Calls of one writer run one at a time, so two calls never pick the same free ordinal and never
  // share the provider's single in-flight request.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<R>(task: () => Promise<R>): Promise<R> {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function generate<T>(prompt: PromptMessages, schema: z.ZodType<T>) {
    return generateText({
      model: provider.model,
      system: prompt.system,
      prompt: prompt.user,
      output: Output.object({ schema }),
      maxRetries: MAX_RETRIES,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async function render<T>(rendered: Rendered<T>): Promise<Preview> {
    if (!rendered.ok) {
      return rendered;
    }
    const body = await provider.observed.preview(() => generate(rendered.prompt, rendered.schema));
    return { ok: true, request_body: body, input_token_bound: countPromptBound(body) };
  }

  /**
   * The first ordinal that neither kind has used for this candidate, read from the ledger, and the
   * attempt of `kind` to make at it. An operation that provably never reached the provider (settled
   * at zero, its whole reservation released) does not use its ordinal: the next call there is the
   * next attempt, chained to the unsent one.
   */
  async function nextSlot(kind: WriterKind, candidate: string): Promise<Slot | WriterRefusal> {
    for (let ordinal = 1; ordinal <= MAX_CALLS_PER_CANDIDATE; ordinal += 1) {
      let free = true;
      let own: { attempt: number; previous: string | null } = { attempt: 1, previous: null };
      for (const other of WRITER_KINDS) {
        let attempt = 1;
        let previous: string | null = null;
        for (;;) {
          const id = operationId({ context, kind: other, candidate, callOrdinal: ordinal, attemptOrdinal: attempt });
          const status = await spend.operationStatus({ operation_id: id });
          if (!status.ok) {
            if (status.code !== "unknown_operation") {
              return refusal(status.code, status.detail ?? null);
            }
            break;
          }
          if (!neverReachedProvider(status)) {
            free = false;
            break;
          }
          previous = id;
          attempt += 1;
        }
        if (!free) {
          break;
        }
        if (other === kind) {
          own = { attempt, previous };
        }
      }
      if (free) {
        return { ordinal, attempt: own.attempt, previous: own.previous };
      }
    }
    return refusal("call_limit_reached", `candidate ${candidate} has used all ${String(MAX_CALLS_PER_CANDIDATE)} calls`);
  }

  /**
   * One metered call. An infrastructure error once the reservation has been requested is rethrown
   * as a WriterInterruptedError naming the operation, so the caller can find it in the ledger.
   */
  async function meteredCall<T>(kind: WriterKind, candidate: string, rendered: Rendered<T>): Promise<Metered<T>> {
    const reserving: { id: string | null } = { id: null };
    try {
      return await meteredCallSteps(kind, candidate, rendered, (id) => {
        reserving.id = id;
      });
    } catch (error) {
      if (reserving.id !== null) {
        throw new WriterInterruptedError(reserving.id, error);
      }
      throw error;
    }
  }

  async function meteredCallSteps<T>(
    kind: WriterKind,
    candidate: string,
    rendered: Rendered<T>,
    onReserving: (operationId: string) => void,
  ): Promise<Metered<T>> {
    if (!rendered.ok) {
      return rendered;
    }
    const sheet = parseRateSheet(options.rateSheet);
    if (!sheet.ok) {
      return refusal("unknown_price", sheet.detail);
    }
    const priced = buildEnvelope(sheet.entries);
    if (!priced.ok) {
      return refusal("unknown_price", priced.detail);
    }
    const preview = await render(rendered);
    if (!preview.ok) {
      return preview;
    }
    const body = preview.request_body;
    const bound = preview.input_token_bound;
    if (bound > MAX_INPUT_TOKENS) {
      return refusal("prompt_too_large", `the counted bound ${String(bound)} exceeds ${String(MAX_INPUT_TOKENS)}`);
    }
    const slot = await spend.slotStatus({ slot_key: options.slotKey });
    if (!slot.ok) {
      return refusal(slot.code, slot.detail ?? null);
    }
    if (slot.holder !== context.root_execution_id) {
      return refusal("slot_not_held", "the run context's root execution does not hold the slot");
    }
    const rateSha = rateSheetSha256(options.rateSheet);
    // Picking a free ordinal and reserving it is one step per candidate, shared by both kinds.
    const claimed = await withCandidateClaim(candidate, async () => {
      const slotFound = await nextSlot(kind, candidate);
      if ("ok" in slotFound) {
        return slotFound;
      }
      const { ordinal, attempt, previous } = slotFound;
      const id = operationId({ context, kind, candidate, callOrdinal: ordinal, attemptOrdinal: attempt });
      const request: ReserveRequest = {
        operation_id: id,
        payload_hash: payloadHash(body),
        attempt_ordinal: attempt,
        previous_operation_id: previous,
        project_id: context.project_id,
        project_policy_sha256: context.project_policy_sha256,
        batch_id: context.batch_id,
        task_revision: context.task_revision,
        root_execution_id: context.root_execution_id,
        execution_id: context.execution_id,
        parent_execution_id: context.parent_execution_id,
        kind,
        call_name: callName(kind, candidate, ordinal),
        provider: PROVIDER,
        provider_replay_key: null,
        pool_key: options.poolKey,
        allocation_key: options.allocationKey,
        runtime_profile_sha256: profileSha,
        rate_sheet_sha256: rateSha,
        envelope: priced.envelope,
      };
      onReserving(id);
      const reserved = await spend.reserve(request);
      if (!reserved.ok) {
        return refusal(reserved.code, reserved.detail ?? null);
      }
      if (reserved.replay) {
        return refusal("operation_replayed", "another process reserved this call first", id);
      }
      return { ordinal, id, request, reservation: reserved };
    });
    if ("ok" in claimed) {
      return claimed;
    }
    const { ordinal, id, request, reservation } = claimed;
    const launched = await spend.transition({
      operation_id: id,
      from_state: "prepared",
      to_state: "launching",
      actor_role: ACTOR_ROLE,
      slot_key: options.slotKey,
    });
    if (!launched.ok) {
      return refusal(launched.code, launched.detail ?? null, id);
    }

    let output: T | null = null;
    const { exchange, error } = await provider.observed.send(body, async () => {
      output = (await generate(rendered.prompt, rendered.schema)).output;
    });
    const { status, failure } = classify(exchange, error);
    const response = exchange.kind === "response" ? exchange : null;
    const usage = response === null ? reportedUsage(0, "") : reportedUsage(response.status, response.body);
    const call: CallRecord = {
      operation_id: id,
      kind,
      candidate,
      call_ordinal: ordinal,
      call_name: request.call_name,
      payload_hash: request.payload_hash,
      input_token_bound: bound,
      request_body: body,
      status,
      failure,
      http_status: response?.status ?? null,
      response_body: response?.body ?? null,
      usage,
      prompt_within_bound: withinBound(usage, bound),
      reserved_microusd: reservation.reserved_microusd,
      settlement: null,
      ledger_refusal: null,
    };

    if (status === "uncertain") {
      const uncertain = await spend.transition({
        operation_id: id,
        from_state: "launching",
        to_state: "uncertain",
        actor_role: ACTOR_ROLE,
        uncertainty: "lost_response",
      });
      return { ok: true, call: { ...call, ledger_refusal: uncertain.ok ? null : uncertain.code }, output: null };
    }

    const terminal = await spend.transition({
      operation_id: id,
      from_state: "launching",
      to_state: "terminal",
      actor_role: ACTOR_ROLE,
      terminal_status: status === "completed" ? "completed" : "failed",
    });
    if (!terminal.ok) {
      return { ok: true, call: { ...call, ledger_refusal: terminal.code }, output: null };
    }
    const neverSent = exchange.kind === "none" || exchange.kind === "not_sent";
    const lines = neverSent ? unsentLines(priced.envelope) : settlementLines(priced.envelope, usage);
    const settled = await spend.settle({
      schema_version: 1,
      operation_id: id,
      runtime_profile_sha256: profileSha,
      rate_sheet_sha256: rateSha,
      reserved_microusd: Number(reservation.reserved_microusd),
      service_lines: lines,
      usage_state: usageState(lines),
      terminal_evidence_key: null,
      terminal_evidence_sha256: null,
    });
    return {
      ok: true,
      call: { ...call, settlement: settled.ok ? settled : null, ledger_refusal: settled.ok ? null : settled.code },
      output: status === "completed" ? output : null,
    };
  }

  function renderIssue(symptom: unknown): Rendered<IssueOutput> {
    const parsed = parseObservedSymptom(symptom);
    if (!parsed.ok) {
      return refusal("invalid_input", parsed.detail);
    }
    return { ok: true, prompt: buildIssuePrompt(parsed.symptom), schema: IssueOutputSchema };
  }

  function renderCard(source: unknown): Rendered<Card> {
    const parsed = CardSourceSchema.safeParse(source);
    if (!parsed.success) {
      return refusal("invalid_input", `invalid card source: ${z.prettifyError(parsed.error)}`);
    }
    return { ok: true, prompt: buildCardPrompt(parsed.data), schema: CardSchema };
  }

  function checkCandidate(candidate: string): WriterRefusal | null {
    return CANDIDATE_PATTERN.test(candidate)
      ? null
      : refusal("invalid_input", "candidate must be lowercase letters, digits, _ and - (at most 46)");
  }

  return {
    writeIssue: (request) =>
      serial<IssueOutcome>(async () => {
      const badCandidate = checkCandidate(request.candidate);
      if (badCandidate !== null) {
        return badCandidate;
      }
      const excluded = z.array(z.string()).safeParse(request.excludedIdentifiers);
      if (!excluded.success) {
        return refusal("invalid_input", "excludedIdentifiers must be a list of strings");
      }
      const parsed = parseObservedSymptom(request.symptom);
      if (!parsed.ok) {
        return refusal("invalid_input", parsed.detail);
      }
      const result = await meteredCall("writer.issue", request.candidate, {
        ok: true,
        prompt: buildIssuePrompt(parsed.symptom),
        schema: IssueOutputSchema,
      });
      if (!result.ok) {
        return result;
      }
      const { call, output } = result;
      let report: IssueCheckReport | null = null;
      if (output !== null) {
        report = checkIssue(output, parsed.symptom, excluded.data);
      } else if (call.failure === "invalid_output") {
        report = structureFailure("the response did not match the issue schema");
      }
      return { ok: true, call, issue: report?.structure.ok === true ? output : null, report };
    }),

    writeCard: (request) =>
      serial<CardOutcome>(async () => {
      const badCandidate = checkCandidate(request.candidate);
      if (badCandidate !== null) {
        return badCandidate;
      }
      const parsed = CardSourceSchema.safeParse(request.source);
      if (!parsed.success) {
        return refusal("invalid_input", `invalid card source: ${z.prettifyError(parsed.error)}`);
      }
      const result = await meteredCall("writer.card", request.candidate, {
        ok: true,
        prompt: buildCardPrompt(parsed.data),
        schema: CardSchema,
      });
      if (!result.ok) {
        return result;
      }
      if (result.output === null) {
        return { ok: true, call: result.call, card: null, code_owned_fields: null };
      }
      const owned = applyCodeOwnedFields(result.output, parsed.data);
      return { ok: true, call: result.call, card: owned.card, code_owned_fields: owned.fields };
    }),

    previewIssue: (symptom) => serial(() => render(renderIssue(symptom))),
    previewCard: (source) => serial(() => render(renderCard(source))),
  };
}
