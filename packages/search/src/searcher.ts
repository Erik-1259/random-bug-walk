// The six-call plan for one candidate. Every call is reserved against the spend pool before it
// starts and settled from the credits Tavily reports, following `@rbw/spend`'s caller protocol.
import type { Price, Settled, Spend, UsageSettlement } from "@rbw/spend";
import { z } from "zod";
import { SearchError } from "./errors.ts";
import type { SearchClient } from "./client.ts";
import {
  CREDIT_LIMIT_PER_CALL,
  DOCS_NAMES,
  PHRASE_NAMES,
  SOURCE_NAMES,
  checkDocsUrl,
  checkQuery,
  checkSourceDomains,
  docsOptions,
  isCallName,
  phraseIndex,
  phraseOptions,
  settingsSchema,
  sourceOptions,
  sourceQuery,
} from "./plan.ts";
import type { PolicyRefusal, SearchSettings } from "./plan.ts";
import { priceOf } from "./rates.ts";
import type { RateSheet } from "./rates.ts";
import { freezeRecord, recordKey } from "./records.ts";
import type { DocsResult, RecordKind, RecordStore, SearchRecord, SourceResult, UnhashedRecord } from "./records.ts";
import { parseSearchInput } from "./search-input.ts";
import type { SearchInput } from "./search-input.ts";
import {
  buildIdentity,
  buildProfile,
  buildReserveRequest,
  creditEnvelope,
  parseRunContext,
} from "./spend-identity.ts";
import type { RunContext, SpendKind } from "./spend-identity.ts";

export interface SearcherDeps {
  client: SearchClient;
  spend: Spend;
  /** Validated strictly when the searcher is created. */
  context: unknown;
  rates: RateSheet;
  poolKey: string;
  slotKey: string;
  allocationKey?: string | null;
  settings: SearchSettings;
  /** Internal function names, source paths, check or shape IDs and fix commit IDs. A query containing one is refused. */
  excludedIdentifiers: readonly string[];
  /** Where frozen records are written once. Default: nothing is stored. */
  store?: RecordStore;
  clock?: () => Date;
  /** Role label for the spend transitions. Default `workflow`. */
  actorRole?: string;
}

/** A refusal made locally: nothing was reserved, requested or recorded. */
export type LocalRefusalCode = "call_limit_reached" | "invalid_input" | PolicyRefusal;

export interface SpendOutcome {
  reserved_microusd: bigint;
  /** Null when no settlement was recorded (an uncertain or refused call). */
  settled_microusd: bigint | null;
  retained_microusd: bigint | null;
  over_envelope: boolean;
}

export type StopReason = "spend_refused" | "uncertain";

export type CallResult =
  | { status: "refused"; code: LocalRefusalCode; detail: string }
  | { status: "recorded"; record: SearchRecord; spend: SpendOutcome | null; stop: StopReason | null };

export interface Searcher {
  searchSource(name: string, input: unknown): Promise<CallResult>;
  extractDocs(name: string, input: unknown): Promise<CallResult>;
  checkPhrase(name: string, input: unknown): Promise<CallResult>;
}

const usageSchema = z.object({ credits: z.number() });
const searchResponseSchema = z.object({
  results: z.array(
    z.object({
      url: z.string().min(1),
      title: z.string().nullish(),
      content: z.string().nullish(),
      score: z.number().nullish(),
      publishedDate: z.string().nullish(),
    }),
  ),
});
const extractResponseSchema = z.object({
  results: z.array(z.object({ url: z.string().min(1), rawContent: z.string() })),
  failedResults: z.array(z.object({ url: z.string() })),
});

type Failure = "timeout" | "unreachable" | "malformed" | "provider";

/**
 * The SDK folds every failure into an Error and drops the cause, so the kind is read from its message:
 * a timeout message, a wrapped non-HTTP error (a reset connection, or a body the SDK could not map),
 * or an error built from an HTTP error status.
 */
function classifyFailure(error: unknown): Failure {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Request timed out after")) {
    return "timeout";
  }
  if (message.startsWith("An unexpected error occurred while making the request.")) {
    return /\b(TypeError|SyntaxError|RangeError)\b/.test(message) ? "malformed" : "unreachable";
  }
  return "provider";
}

/** `usage.credits` as an exact count, or null when it is absent or not a non-negative integer. */
function reportedCredits(raw: unknown): number | null {
  const parsed = z.object({ usage: usageSchema }).safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const { credits } = parsed.data.usage;
  return Number.isInteger(credits) && credits >= 0 ? credits : null;
}

function cap(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

function costMicrousd(credits: number, price: Price): number {
  const numerator = BigInt(credits) * BigInt(price.microusd);
  const per = BigInt(price.per_units);
  return Number((numerator + per - 1n) / per);
}

interface Parsed {
  results: (SourceResult | DocsResult)[];
  /** Set when the response is well-formed but the call failed (an extract with a failed URL). */
  failed: boolean;
}

interface PlannedCall {
  name: string;
  kind: RecordKind;
  spendKind: SpendKind;
  endpoint: "search" | "extract";
  query: string;
  urls?: string[];
  options: Record<string, unknown>;
  invoke: (client: SearchClient) => Promise<unknown>;
  parse: (raw: unknown) => Parsed | null;
}

export function createSearcher(deps: SearcherDeps): Searcher {
  const context: RunContext = parseRunContext(deps.context);
  const settings = settingsSchema.parse(deps.settings);
  const profile = buildProfile(settings);
  const clock = deps.clock ?? (() => new Date());
  const actorRole = deps.actorRole ?? "workflow";
  const { spend } = deps;
  const used = new Set<string>();

  const toResults = (raw: unknown): SourceResult[] | null => {
    const parsed = searchResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    return parsed.data.results.map((r) => ({
      url: r.url,
      title: r.title ?? "",
      published_date: r.publishedDate ?? null,
      score: r.score ?? null,
      excerpt: cap(r.content ?? "", settings.excerpt_max_chars),
    }));
  };

  const parseSearch = (raw: unknown): Parsed | null => {
    const results = toResults(raw);
    return results === null ? null : { results, failed: false };
  };

  const parseExtract = (raw: unknown): Parsed | null => {
    const parsed = extractResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    const results: DocsResult[] = parsed.data.results.map((r) => ({
      url: r.url,
      passages: r.rawContent
        .split("[...]")
        .map((p) => p.trim())
        .filter((p) => p !== "")
        .slice(0, settings.max_passages)
        .map((p) => cap(p, settings.passage_max_chars)),
    }));
    const failed = parsed.data.failedResults.length > 0;
    return failed || results.length > 0 ? { results, failed } : null;
  };

  const refuse = (code: LocalRefusalCode, detail: string): CallResult => ({ status: "refused", code, detail });

  /** Checks shared by every call, before anything is reserved. Returns a refusal or null. */
  const beginLocal = (
    names: readonly string[],
    name: string,
    candidate: string,
    queries: string[],
  ): CallResult | null => {
    if (!isCallName(name, names)) {
      return refuse("call_limit_reached", "the call name is not in the plan for this function");
    }
    const query = queries.find((q) => checkQuery(q, deps.excludedIdentifiers) !== null);
    if (query !== undefined) {
      return refuse("excluded_identifier", "a query contains an excluded identifier");
    }
    if (used.has(recordKey(candidate, name)) || deps.store?.get(recordKey(candidate, name)) !== undefined) {
      return refuse("call_limit_reached", "the call name was already used");
    }
    return null;
  };

  const parseInput = (input: unknown): SearchInput | CallResult => {
    try {
      return parseSearchInput(input);
    } catch (error) {
      if (error instanceof SearchError) {
        return refuse("invalid_input", error.message);
      }
      throw error;
    }
  };

  async function execute(candidate: string, call: PlannedCall): Promise<CallResult> {
    const key = recordKey(candidate, call.name);
    const identity = buildIdentity({
      context,
      profile,
      candidate,
      name: call.name,
      kind: call.spendKind,
      options: { endpoint: call.endpoint, query: call.query, urls: call.urls, options: call.options },
    });
    let requestedAt = clock();

    const incomplete = (reason: string, credits: number | null, extra?: Partial<UnhashedRecord>): SearchRecord =>
      freezeRecord({
        schema_version: 1,
        candidate,
        call_name: call.name,
        kind: call.kind,
        request: {
          endpoint: call.endpoint,
          query: call.query,
          ...(call.urls === undefined ? {} : { urls: call.urls }),
          options: call.options,
        },
        requested_at: requestedAt.toISOString(),
        completed_at: clock().toISOString(),
        outcome: "incomplete",
        reason,
        results: [],
        reported_credits: credits,
        operation_id: identity.operation_id,
        statement: null,
        ...extra,
      });

    const finish = (
      record: SearchRecord,
      spendOutcome: SpendOutcome | null,
      stop: StopReason | null,
      store: boolean,
    ): CallResult => {
      if (store) {
        deps.store?.put(key, record);
      }
      return { status: "recorded", record, spend: spendOutcome, stop };
    };

    const refusedBeforeReserve = (code: string): CallResult =>
      finish(incomplete(`spend_refused:${code}`, null), null, "spend_refused", false);

    const slot = await spend.slotStatus({ slot_key: deps.slotKey });
    if (!slot.ok) {
      return refusedBeforeReserve(slot.code);
    }
    if (slot.holder !== context.root_execution_id) {
      return refusedBeforeReserve("slot_not_held");
    }
    const price = priceOf(deps.rates, "tavily", "credit");
    if (price === null) {
      return refusedBeforeReserve("unknown_price");
    }

    used.add(key);
    const reservation = await spend.reserve(
      buildReserveRequest({
        context,
        identity,
        poolKey: deps.poolKey,
        allocationKey: deps.allocationKey ?? null,
        rateSheetSha256: deps.rates.sha256,
        envelope: [creditEnvelope(CREDIT_LIMIT_PER_CALL, price)],
      }),
    );
    if (!reservation.ok) {
      return finish(incomplete(`spend_refused:${reservation.code}`, null), null, "spend_refused", true);
    }
    const reserved = reservation.reserved_microusd;
    const outcomeOf = (settled: Settled | null): SpendOutcome => ({
      reserved_microusd: reserved,
      settled_microusd: settled === null ? null : settled.settled_microusd,
      retained_microusd: settled === null ? null : settled.retained_microusd,
      over_envelope: settled?.over_envelope ?? false,
    });
    if (reservation.replay) {
      // The operation already exists, so the call was reserved by an earlier run: never run it again.
      return finish(incomplete("spend_refused:operation_replay", null), outcomeOf(null), "spend_refused", false);
    }

    const launching = await spend.transition({
      operation_id: identity.operation_id,
      from_state: "prepared",
      to_state: "launching",
      actor_role: actorRole,
      slot_key: deps.slotKey,
    });
    if (!launching.ok) {
      return finish(incomplete(`spend_refused:${launching.code}`, null), outcomeOf(null), "spend_refused", true);
    }

    requestedAt = clock();
    let raw: unknown;
    let failure: Failure | null = null;
    try {
      raw = await call.invoke(deps.client);
    } catch (error) {
      failure = classifyFailure(error);
    }

    if (failure === "timeout" || failure === "unreachable") {
      // The request may have been received and billed: record a lost response and never retry.
      const uncertain = await spend.transition({
        operation_id: identity.operation_id,
        from_state: "launching",
        to_state: "uncertain",
        actor_role: actorRole,
        uncertainty: "lost_response",
      });
      const reason = failure === "timeout" ? "timeout" : "provider_uncertain";
      if (!uncertain.ok) {
        return finish(incomplete(`spend_refused:${uncertain.code}`, null), outcomeOf(null), "spend_refused", true);
      }
      return finish(incomplete(reason, null), outcomeOf(null), "uncertain", true);
    }

    const terminal = await spend.transition({
      operation_id: identity.operation_id,
      from_state: "launching",
      to_state: "terminal",
      actor_role: actorRole,
      terminal_status: failure === "provider" ? "failed" : "completed",
    });
    if (!terminal.ok) {
      return finish(incomplete(`spend_refused:${terminal.code}`, null), outcomeOf(null), "spend_refused", true);
    }

    const credits = failure === null || failure === "malformed" ? reportedCredits(raw) : null;
    const parsed = failure === null ? call.parse(raw) : null;
    // A reported 0 on an extract can be a count that has not accrued yet, so it settles as unknown.
    const known = credits !== null && !(call.kind === "docs" && credits === 0);
    const settlement: UsageSettlement = {
      schema_version: 1,
      operation_id: identity.operation_id,
      runtime_profile_sha256: identity.runtime_profile_sha256,
      rate_sheet_sha256: deps.rates.sha256,
      reserved_microusd: Number(reserved),
      service_lines: [
        {
          service: "tavily",
          unit: "credit",
          actual_quantity: known ? credits : null,
          actual_microusd: known ? costMicrousd(credits, price) : null,
          retained_microusd: known ? 0 : Number(reserved),
        },
      ],
      usage_state: known ? "known" : "unknown",
      terminal_evidence_key: null,
      terminal_evidence_sha256: null,
    };
    const settled = await spend.settle(settlement);
    if (!settled.ok) {
      return finish(incomplete(`spend_refused:${settled.code}`, credits), outcomeOf(null), "spend_refused", true);
    }
    const spendOutcome = outcomeOf(settled);

    if (failure === "provider") {
      return finish(incomplete("provider_error", null), spendOutcome, null, true);
    }
    if (parsed === null) {
      return finish(incomplete("malformed_response", credits), spendOutcome, null, true);
    }
    if (parsed.failed) {
      return finish(incomplete("provider_error", credits), spendOutcome, null, true);
    }
    const completedAt = clock().toISOString();
    const base: Omit<UnhashedRecord, "outcome" | "statement"> = {
      schema_version: 1,
      candidate,
      call_name: call.name,
      kind: call.kind,
      request: {
        endpoint: call.endpoint,
        query: call.query,
        ...(call.urls === undefined ? {} : { urls: call.urls }),
        options: call.options,
      },
      requested_at: requestedAt.toISOString(),
      completed_at: completedAt,
      reason: null,
      results: parsed.results,
      reported_credits: credits,
      operation_id: identity.operation_id,
    };
    let record: SearchRecord;
    if (call.kind !== "phrase") {
      record = freezeRecord({ ...base, outcome: "complete", statement: null });
    } else if (parsed.results.length > 0) {
      record = freezeRecord({ ...base, outcome: "public_match", statement: null });
    } else {
      record = freezeRecord({
        ...base,
        outcome: "no_public_match",
        statement: `No public match was found as of ${completedAt}; this holds as of that time only.`,
      });
    }
    return finish(record, spendOutcome, null, true);
  }

  return {
    async searchSource(name, rawInput) {
      const input = parseInput(rawInput);
      if ("status" in input) {
        return input;
      }
      const query = sourceQuery(name, input);
      const refusal =
        beginLocal(SOURCE_NAMES, name, input.candidate, [query]) ??
        policy(checkSourceDomains(input, settings));
      if (refusal !== null) {
        return refusal;
      }
      const options = sourceOptions(input, settings);
      return execute(input.candidate, {
        name,
        kind: "source",
        spendKind: "search.source",
        endpoint: "search",
        query,
        options,
        invoke: (client) => client.search(query, options),
        parse: parseSearch,
      });
    },

    async extractDocs(name, rawInput) {
      const input = parseInput(rawInput);
      if ("status" in input) {
        return input;
      }
      const refusal =
        beginLocal(DOCS_NAMES, name, input.candidate, [input.docs.query]) ?? policy(checkDocsUrl(input));
      if (refusal !== null) {
        return refusal;
      }
      const options = docsOptions(input, settings);
      const urls = [input.docs.url];
      return execute(input.candidate, {
        name,
        kind: "docs",
        spendKind: "search.docs",
        endpoint: "extract",
        query: input.docs.query,
        urls,
        options,
        invoke: (client) => client.extract(urls, options),
        parse: parseExtract,
      });
    },

    async checkPhrase(name, rawInput) {
      const input = parseInput(rawInput);
      if ("status" in input) {
        return input;
      }
      const phrase = input.phrases[phraseIndex(name)];
      const query = `"${phrase ?? ""}"`;
      const refusal = beginLocal(PHRASE_NAMES, name, input.candidate, [query]);
      if (refusal !== null) {
        return refusal;
      }
      const options = phraseOptions(settings);
      return execute(input.candidate, {
        name,
        kind: "phrase",
        spendKind: "search.phrase",
        endpoint: "search",
        query,
        options,
        invoke: (client) => client.search(query, options),
        parse: parseSearch,
      });
    },
  };
}

function policy(refusal: PolicyRefusal | null): CallResult | null {
  return refusal === null ? null : { status: "refused", code: refusal, detail: "refused by the domain policy" };
}
