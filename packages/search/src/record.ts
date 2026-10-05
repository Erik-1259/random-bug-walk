// The live-set run: acquires the slot, runs the six calls in plan order (each reserved before and
// settled after), writes one recording and one record per call, prints a summary per call and
// releases the slot when nothing blocks it. The owner runs it later through `record-cli.ts`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Spend } from "@rbw/spend";
import { parseRunContext } from "./spend-identity.ts";
import { CALL_NAMES, DOCS_NAMES, PHRASE_NAMES, SOURCE_NAMES } from "./plan.ts";
import { parseSearchInput } from "./search-input.ts";
import type { Searcher } from "./searcher.ts";
import type { WireTap } from "./wire-tap.ts";

export interface RecordOptions {
  searcher: Searcher;
  spend: Spend;
  context: unknown;
  input: unknown;
  slotKey: string;
  /** Directory for the recordings. The searcher's record store should write to the same place. */
  outDir: string;
  tap: WireTap;
  write: (line: string) => void;
  actorRole?: string;
}

export interface CallSummary {
  name: string;
  outcome: string;
  reason: string | null;
  operation_id: string;
  reserved_microusd: bigint | null;
  settled_microusd: bigint | null;
  retained_microusd: bigint | null;
  reported_credits: number | null;
}

export interface RecordResult {
  exitCode: number;
  summaries: CallSummary[];
  released: boolean;
}

/** The only per-request identifier the provider's search and extract responses carry. */
const PROVIDER_REQUEST_ID_KEYS = new Set(["request_id", "requestId"]);

/** Copies JSON with every provider request ID removed, at any depth, so a saved recording never holds one. */
function withoutRequestIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutRequestIds);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !PROVIDER_REQUEST_ID_KEYS.has(key))
        .map(([key, entry]) => [key, withoutRequestIds(entry)]),
    );
  }
  return value;
}

function text(value: bigint | number | null): string {
  return value === null ? "none" : String(value);
}

export async function runRecord(options: RecordOptions): Promise<RecordResult> {
  const context = parseRunContext(options.context);
  const input = parseSearchInput(options.input);
  const { spend, searcher, write } = options;
  const summaries: CallSummary[] = [];
  const fail = (line: string): RecordResult => {
    write(line);
    return { exitCode: 1, summaries, released: false };
  };

  const hold = await spend.acquireSlot({
    slot_key: options.slotKey,
    root_execution_id: context.root_execution_id,
    actor_role: options.actorRole ?? "workflow",
  });
  if (!hold.ok) {
    return fail(`stopped before any call: slot refused (${hold.code})`);
  }

  mkdirSync(options.outDir, { recursive: true });
  for (const name of CALL_NAMES) {
    options.tap.take();
    const result = SOURCE_NAMES.some((n) => n === name)
      ? await searcher.searchSource(name, input)
      : DOCS_NAMES.some((n) => n === name)
        ? await searcher.extractDocs(name, input)
        : PHRASE_NAMES.some((n) => n === name)
          ? await searcher.checkPhrase(name, input)
          : null;
    if (result === null || result.status === "refused") {
      return fail(`${name}: refused before reserving (${result === null ? "unknown_call" : result.code}); slot left held`);
    }
    const exchange = options.tap.take();
    if (exchange?.response != null) {
      writeFileSync(
        join(options.outDir, `${name}.recording.json`),
        `${JSON.stringify(
          {
            schema_version: 1,
            provenance: "live",
            endpoint: exchange.endpoint,
            recorded_at: result.record.completed_at,
            request_body: withoutRequestIds(exchange.request_body),
            response: { status: exchange.response.status, body: withoutRequestIds(exchange.response.body) },
          },
          null,
          2,
        )}\n`,
      );
    }
    const summary: CallSummary = {
      name,
      outcome: result.record.outcome,
      reason: result.record.reason,
      operation_id: result.record.operation_id,
      reserved_microusd: result.spend?.reserved_microusd ?? null,
      settled_microusd: result.spend?.settled_microusd ?? null,
      retained_microusd: result.spend?.retained_microusd ?? null,
      reported_credits: result.record.reported_credits,
    };
    summaries.push(summary);
    write(
      `${name} outcome=${summary.outcome}${summary.reason === null ? "" : ` reason=${summary.reason}`} ` +
        `operation_id=${summary.operation_id} reserved_microusd=${text(summary.reserved_microusd)} ` +
        `settled_microusd=${text(summary.settled_microusd)} retained_microusd=${text(summary.retained_microusd)} ` +
        `reported_credits=${text(summary.reported_credits)}`,
    );
    if (result.stop !== null) {
      return fail(`stopped at ${name}: ${result.stop}; slot left held`);
    }
  }

  const status = await spend.slotStatus({ slot_key: options.slotKey });
  if (!status.ok) {
    return fail(`slot status refused (${status.code}); slot left held`);
  }
  const { child_resources, operation_ids } = status.release_blockers;
  if (child_resources.length > 0 || operation_ids.length > 0) {
    return fail("the slot has release blockers; slot left held");
  }
  const released = await spend.releaseSlot({
    slot_key: options.slotKey,
    root_execution_id: context.root_execution_id,
    actor_role: options.actorRole ?? "workflow",
    evidence: null,
    reason: null,
  });
  if (!released.ok) {
    return fail(`slot release refused (${released.code}); slot left held`);
  }
  return { exitCode: 0, summaries, released: true };
}
