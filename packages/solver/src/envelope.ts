// The solver's own envelope: the writer's rate-file format and buildEnvelope(entries, profile)
// pattern, priced from rate-sheets/solver-v1.json under a solver profile. It does not use
// @rbw/envelope, whose reservations carry the judge path's fixed runtime profile.
import { readFileSync } from "node:fs";
import type { EnvelopeLine, UsageSettlement, UsageSettlementLine } from "@rbw/spend";
import { actualMicrousd, buildEnvelope, lineWorstCase, parseRateSheet, rateSheetSha256 } from "@rbw/writer";
import type { ReportedUsage } from "@rbw/writer";
import type { SolverProfile } from "./profile.ts";

/** The committed solver rate file. */
export const SOLVER_RATE_SHEET_URL = new URL("../rate-sheets/solver-v1.json", import.meta.url);

export function readSolverRateSheet(): Uint8Array {
  return readFileSync(SOLVER_RATE_SHEET_URL);
}

export interface PricedEnvelope {
  /** The two token lines of every turn, each limited to the profile's per-call limit. */
  envelope: EnvelopeLine[];
  rate_sheet_sha256: string;
  /** The reservation of one turn: each line's price at its limit, rounded up. */
  turn_worst_case_microusd: number;
  /** One attempt at its turn cap, each turn at its worst case; one turn is open at a time. */
  attempt_worst_case_microusd: number;
}

export type PricedEnvelopeResult = ({ ok: true } & PricedEnvelope) | { ok: false; detail: string };

/** Prices one solver turn under `profile` from the rate file's exact bytes. */
export function solverEnvelope(rateSheet: Uint8Array, profile: SolverProfile): PricedEnvelopeResult {
  const sheet = parseRateSheet(rateSheet);
  if (!sheet.ok) {
    return sheet;
  }
  const priced = buildEnvelope(sheet.entries, profile);
  if (!priced.ok) {
    return priced;
  }
  const turn = priced.envelope.reduce((sum, line) => sum + lineWorstCase(line), 0);
  return {
    ok: true,
    envelope: priced.envelope,
    rate_sheet_sha256: rateSheetSha256(rateSheet),
    turn_worst_case_microusd: turn,
    attempt_worst_case_microusd: turn * profile.hashed.attempt_caps.max_turns,
  };
}

/** Reported usage priced line by line; a line without a reported quantity retains its worst case. */
export function settlementLines(envelope: readonly EnvelopeLine[], usage: ReportedUsage): UsageSettlementLine[] {
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

/** Every line at zero: the request provably never reached the provider. */
export function unsentLines(envelope: readonly EnvelopeLine[]): UsageSettlementLine[] {
  return envelope.map((line) => ({
    service: line.service,
    unit: line.unit,
    actual_quantity: 0,
    actual_microusd: 0,
    retained_microusd: 0,
  }));
}

export function usageState(lines: readonly UsageSettlementLine[]): UsageSettlement["usage_state"] {
  const unknown = lines.filter((line) => line.actual_microusd === null).length;
  return unknown === 0 ? "known" : unknown === lines.length ? "unknown" : "partly_unknown";
}

const encoder = new TextEncoder();

/**
 * The counted upper bound on one request's input tokens: the UTF-8 byte length of the exact body,
 * plus the profile's framing per message and once per request. Throws on a body with no messages.
 */
export function countSolverPromptBound(body: string, profile: SolverProfile): number {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || !("messages" in parsed) || !Array.isArray(parsed.messages)) {
    throw new Error("the request body has no messages");
  }
  const framing = profile.hashed.prompt_bound;
  return (
    encoder.encode(body).length +
    framing.per_request_framing_tokens +
    framing.per_message_framing_tokens * parsed.messages.length
  );
}
