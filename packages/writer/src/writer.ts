// The card and issue writer. Every model call is bounded, counted and priced before it starts,
// reserved against the spend pool, recorded as launching before the request, and settled after it.
// The caller protocol of @rbw/spend is followed exactly; nothing retries.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Output, generateText, jsonSchema, zodSchema } from "ai";
import type { FlexibleSchema, LanguageModel } from "ai";
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
import { ModelCardSchema, ModelRequestCardSchema } from "./card-schema.ts";
import type { Card, ModelCard } from "./card-schema.ts";
import { MAX_CALLS_PER_CANDIDATE, WRITER_MODEL_PROFILE } from "./config.ts";
import { ObservedFetch } from "./http.ts";
import type { Exchange, FetchFunction } from "./http.ts";
import { CANDIDATE_PATTERN, operationIdFor, parseRunContext, payloadHash } from "./identity.ts";
import type { RunContext, WriterKind } from "./identity.ts";
import { checkIssue, structureFailure } from "./issue-checks.ts";
import type { IssueCheckReport } from "./issue-checks.ts";
import { buildIssuePrompt } from "./issue-prompt.ts";
import { IssueOutputSchema } from "./issue-schema.ts";
import type { IssueOutput } from "./issue-schema.ts";
import { parseObservedSymptom } from "./observed-symptom.ts";
import { profileSha256 } from "./profile.ts";
import type { ModelProfile } from "./profile.ts";
import { countPromptBound } from "./prompt-bound.ts";
import type { PromptMessages } from "./prompt.ts";
import { actualMicrousd, buildEnvelope, lineWorstCase, parseRateSheet, rateSheetSha256 } from "./rates.ts";
import { reportedUsage } from "./recording.ts";
import type { ReportedUsage } from "./recording.ts";

/** One model through the OpenAI-compatible provider, built from its profile. */
export interface ModelProvider<K extends string = string> {
  readonly modelId: string;
  readonly model: LanguageModel;
  readonly observed: ObservedFetch;
  readonly profile: ModelProfile<K>;
}

export type WriterProvider = ModelProvider<WriterKind>;

export interface WriterProviderOptions {
  /** Required. Replay in tests and public CI; the platform fetch only in the `record` command. */
  fetch: FetchFunction;
  /** The role's key. Sent only as the bearer header; never recorded. */
  apiKey?: string;
}

/** The writer's fixed model, with thinking off and no tools. */
export function createWriterProvider(options: WriterProviderOptions): WriterProvider {
  return createModelProvider(WRITER_MODEL_PROFILE, options);
}

/** The profile's model, with the profile's request extras on every request and no tools. */
export function createModelProvider<K extends string>(
  profile: ModelProfile<K>,
  options: WriterProviderOptions,
): ModelProvider<K> {
  if (typeof options.fetch !== "function") {
    throw new Error("a model provider needs an injected fetch; the library never picks one itself");
  }
  const { hashed, request_extras: extras } = profile;
  const observed = new ObservedFetch(options.fetch);
  const provider = createOpenAICompatible({
    name: hashed.provider,
    baseURL: hashed.base_url,
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
      return { ...body, ...extras };
    },
  });
  return { modelId: hashed.model, model: provider.chatModel(hashed.model), observed, profile };
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
export interface CallRecord<K extends string = WriterKind> {
  operation_id: string;
  kind: K;
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

type Rendered<T> = { ok: true; prompt: PromptMessages; schema: FlexibleSchema<T> } | WriterRefusal;

// The model is asked for the full card with one state per runtime lever, but its answer is validated
// only in the fields it owns; code replaces the rest and derives the three lever lists.
const CARD_OUTPUT = jsonSchema<ModelCard>(() => zodSchema(ModelRequestCardSchema).jsonSchema, {
  validate: (value) => {
    const parsed = ModelCardSchema.safeParse(value);
    return parsed.success ? { success: true, value: parsed.data } : { success: false, error: parsed.error };
  },
});

/** A metered call's outcome: a refusal, or the launched call and its output when it completed. */
export type MeteredOutcome<T, K extends string = string> = WriterRefusal | { ok: true; call: CallRecord<K>; output: T | null };

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
// the next ordinal is serialized per profile and candidate across all of them in this process.
const candidateClaims = new Map<string, Promise<unknown>>();

async function withCandidateClaim<R>(claimKey: string, task: () => Promise<R>): Promise<R> {
  const previous = candidateClaims.get(claimKey) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  candidateClaims.set(claimKey, tail);
  try {
    return await run;
  } finally {
    if (candidateClaims.get(claimKey) === tail) {
      candidateClaims.delete(claimKey);
    }
  }
}

/** What one metered call runs against: the ledger, the provider and its profile, and the run. */
interface Meter<K extends string> {
  spend: Spend;
  provider: ModelProvider<K>;
  context: RunContext;
  profileSha: string;
  poolKey: string;
  allocationKey: string | null;
  slotKey: string;
  rateSheet: Uint8Array;
}

function generate<T>(provider: ModelProvider, prompt: PromptMessages, schema: FlexibleSchema<T>) {
  const { hashed } = provider.profile;
  return generateText({
    model: provider.model,
    system: prompt.system,
    prompt: prompt.user,
    output: Output.object({ schema }),
    maxRetries: hashed.max_retries,
    maxOutputTokens: hashed.max_output_tokens,
    abortSignal: AbortSignal.timeout(hashed.request_timeout_ms),
  });
}

async function render<T>(provider: ModelProvider, rendered: Rendered<T>): Promise<Preview> {
  if (!rendered.ok) {
    return rendered;
  }
  const body = await provider.observed.preview(() => generate(provider, rendered.prompt, rendered.schema));
  return { ok: true, request_body: body, input_token_bound: countPromptBound(body, provider.profile) };
}

/**
 * The first ordinal that no kind of the profile has used for this candidate, read from the ledger,
 * and the attempt of `kind` to make at it. An operation that provably never reached the provider
 * (settled at zero, its whole reservation released) does not use its ordinal: the next call there
 * is the next attempt, chained to the unsent one.
 */
async function nextSlot<K extends string>(meter: Meter<K>, kind: K, candidate: string): Promise<Slot | WriterRefusal> {
  const { spend, context, profileSha } = meter;
  for (let ordinal = 1; ordinal <= MAX_CALLS_PER_CANDIDATE; ordinal += 1) {
    let free = true;
    let own: { attempt: number; previous: string | null } = { attempt: 1, previous: null };
    for (const other of meter.provider.profile.kinds) {
      let attempt = 1;
      let previous: string | null = null;
      for (;;) {
        const id = operationIdFor(profileSha, { context, kind: other, candidate, callOrdinal: ordinal, attemptOrdinal: attempt });
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
 * With `fixedOrdinal`, the call reserves exactly that ordinal at attempt 1, without reading the
 * ledger for a free ordinal and without the per-candidate cap.
 */
async function meteredCall<T, K extends string>(
  meter: Meter<K>,
  kind: K,
  candidate: string,
  rendered: Rendered<T>,
  fixedOrdinal?: number,
): Promise<MeteredOutcome<T, K>> {
  const reserving: { id: string | null } = { id: null };
  try {
    return await meteredCallSteps(meter, kind, candidate, rendered, fixedOrdinal, (id) => {
      reserving.id = id;
    });
  } catch (error) {
    if (reserving.id !== null) {
      throw new WriterInterruptedError(reserving.id, error);
    }
    throw error;
  }
}

async function meteredCallSteps<T, K extends string>(
  meter: Meter<K>,
  kind: K,
  candidate: string,
  rendered: Rendered<T>,
  fixedOrdinal: number | undefined,
  onReserving: (operationId: string) => void,
): Promise<MeteredOutcome<T, K>> {
  const { spend, provider, context, profileSha } = meter;
  const { profile } = provider;
  if (!rendered.ok) {
    return rendered;
  }
  const sheet = parseRateSheet(meter.rateSheet);
  if (!sheet.ok) {
    return refusal("unknown_price", sheet.detail);
  }
  const priced = buildEnvelope(sheet.entries, profile);
  if (!priced.ok) {
    return refusal("unknown_price", priced.detail);
  }
  const preview = await render(provider, rendered);
  if (!preview.ok) {
    return preview;
  }
  const body = preview.request_body;
  const bound = preview.input_token_bound;
  const maxInput = profile.hashed.max_input_tokens;
  if (bound > maxInput) {
    return refusal("prompt_too_large", `the counted bound ${String(bound)} exceeds ${String(maxInput)}`);
  }
  const slot = await spend.slotStatus({ slot_key: meter.slotKey });
  if (!slot.ok) {
    return refusal(slot.code, slot.detail ?? null);
  }
  if (slot.holder !== context.root_execution_id) {
    return refusal("slot_not_held", "the run context's root execution does not hold the slot");
  }
  const rateSha = rateSheetSha256(meter.rateSheet);
  const reserveAt = async ({ ordinal, attempt, previous }: Slot) => {
    const id = operationIdFor(profileSha, { context, kind, candidate, callOrdinal: ordinal, attemptOrdinal: attempt });
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
      provider: profile.hashed.provider,
      provider_replay_key: null,
      pool_key: meter.poolKey,
      allocation_key: meter.allocationKey,
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
  };
  // Picking a free ordinal and reserving it is one step per candidate, shared by every kind of the
  // profile. A fixed ordinal needs no pick: the ledger refuses a second reservation of it.
  const claimed =
    fixedOrdinal === undefined
      ? await withCandidateClaim(`${profileSha}:${candidate}`, async () => {
          const slotFound = await nextSlot(meter, kind, candidate);
          return "ok" in slotFound ? slotFound : reserveAt(slotFound);
        })
      : await reserveAt({ ordinal: fixedOrdinal, attempt: 1, previous: null });
  if ("ok" in claimed) {
    return claimed;
  }
  const { ordinal, id, request, reservation } = claimed;
  const actorRole = profile.actor_role;
  const launched = await spend.transition({
    operation_id: id,
    from_state: "prepared",
    to_state: "launching",
    actor_role: actorRole,
    slot_key: meter.slotKey,
  });
  if (!launched.ok) {
    return refusal(launched.code, launched.detail ?? null, id);
  }

  let output: T | null = null;
  const { exchange, error } = await provider.observed.send(body, async () => {
    output = (await generate(provider, rendered.prompt, rendered.schema)).output;
  });
  const { status, failure } = classify(exchange, error);
  const response = exchange.kind === "response" ? exchange : null;
  const usage = response === null ? reportedUsage(0, "") : reportedUsage(response.status, response.body);
  const call: CallRecord<K> = {
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
      actor_role: actorRole,
      uncertainty: "lost_response",
    });
    return { ok: true, call: { ...call, ledger_refusal: uncertain.ok ? null : uncertain.code }, output: null };
  }

  const terminal = await spend.transition({
    operation_id: id,
    from_state: "launching",
    to_state: "terminal",
    actor_role: actorRole,
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

function checkCandidate(candidate: string): WriterRefusal | null {
  return CANDIDATE_PATTERN.test(candidate)
    ? null
    : refusal("invalid_input", "candidate must be lowercase letters, digits, _ and - (at most 46)");
}

export interface MeteredCallOptions<K extends string> {
  spend: Spend;
  provider: ModelProvider<K>;
  /** The run context; validated strictly here, unknown fields rejected. */
  context: unknown;
  poolKey: string;
  allocationKey: string | null;
  /** Slot key the context's root execution must already hold. */
  slotKey: string;
  /** Exact bytes of the rate file; the provider's profile picks its service's entries. */
  rateSheet: Uint8Array;
}

export interface MeteredRequest<T, K extends string> {
  /** One of the provider profile's kinds. */
  kind: K;
  candidate: string;
  prompt: PromptMessages;
  /** The structured output the model must return. */
  schema: FlexibleSchema<T>;
  /** Reserve exactly this call ordinal at attempt 1, instead of the first free one within the cap. */
  callOrdinal?: number;
}

/**
 * One metered structured call under the provider's profile: bounded, priced, reserved, launched,
 * sent once and settled, as the writer's own calls are. Calls on one provider must not overlap:
 * a call that finds the provider busy is settled at zero as never sent.
 */
export async function meteredStructuredCall<T, K extends string>(
  options: MeteredCallOptions<K>,
  request: MeteredRequest<T, K>,
): Promise<MeteredOutcome<T, K>> {
  const meter: Meter<K> = {
    ...options,
    context: parseRunContext(options.context),
    profileSha: profileSha256(options.provider.profile),
  };
  const badCandidate = checkCandidate(request.candidate);
  if (badCandidate !== null) {
    return badCandidate;
  }
  if (!options.provider.profile.kinds.includes(request.kind)) {
    return refusal("invalid_input", `kind ${request.kind} is not one of the profile's kinds`);
  }
  const ordinal = request.callOrdinal;
  if (ordinal !== undefined && !(Number.isSafeInteger(ordinal) && ordinal >= 1)) {
    return refusal("invalid_input", "callOrdinal must be a positive integer");
  }
  return meteredCall(
    meter,
    request.kind,
    request.candidate,
    { ok: true, prompt: request.prompt, schema: request.schema },
    ordinal,
  );
}

export function createWriter(options: WriterOptions): Writer {
  const { provider } = options;
  const meter: Meter<WriterKind> = {
    spend: options.spend,
    provider,
    context: parseRunContext(options.context),
    profileSha: profileSha256(provider.profile),
    poolKey: options.poolKey,
    allocationKey: options.allocationKey,
    slotKey: options.slotKey,
    rateSheet: options.rateSheet,
  };

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

  function renderIssue(symptom: unknown): Rendered<IssueOutput> {
    const parsed = parseObservedSymptom(symptom);
    if (!parsed.ok) {
      return refusal("invalid_input", parsed.detail);
    }
    return { ok: true, prompt: buildIssuePrompt(parsed.symptom), schema: IssueOutputSchema };
  }

  function renderCard(source: unknown): Rendered<ModelCard> {
    const parsed = CardSourceSchema.safeParse(source);
    if (!parsed.success) {
      return refusal("invalid_input", `invalid card source: ${z.prettifyError(parsed.error)}`);
    }
    return { ok: true, prompt: buildCardPrompt(parsed.data), schema: CARD_OUTPUT };
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
      const result = await meteredCall(meter, "writer.issue", request.candidate, {
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
      const result = await meteredCall(meter, "writer.card", request.candidate, {
        ok: true,
        prompt: buildCardPrompt(parsed.data),
        schema: CARD_OUTPUT,
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

    previewIssue: (symptom) => serial(() => render(provider, renderIssue(symptom))),
    previewCard: (source) => serial(() => render(provider, renderCard(source))),
  };
}

