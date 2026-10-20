// In-memory event store and request ledger for tests. The event store applies the append rule of the
// factory event table: the same key with the same content replays and different content conflicts,
// where the content is everything but `at` (the table records its own time and compares the rest);
// after `request_finished` only the event types of contract section 8.4 may follow; events are
// numbered from 1 with no gaps. The ledger reserves and settles like the spend ledger's request
// budget: every fake operation settles at exactly its worst case unless a test says otherwise.
import { canonicalDigest } from "@rbw/schema";
import type { Event, StopCode } from "@rbw/factory-contract";
import type { EventSink, LedgerStatus, NewEvent, RequestLedger, ReserveOutcome } from "../ports.ts";

export class EventConflictError extends Error {
  constructor(key: string) {
    super(`event key ${key} was appended before with different content`);
    this.name = "EventConflictError";
  }
}

export class EventNotAllowedError extends Error {
  constructor(type: string) {
    super(`a ${type} event cannot follow request_finished`);
    this.name = "EventNotAllowedError";
  }
}

/** The only event types that may follow `request_finished` (contract section 8.4). */
const AFTER_FINISH: ReadonlySet<string> = new Set(["budget_updated", "attention", "attention_cleared", "validation_started", "validation_finished"]);

export class MemoryEventStore implements EventSink {
  readonly events: Event[] = [];
  readonly keys = new Map<string, string>();
  readonly replays: string[] = [];

  append(event: NewEvent): Promise<void> {
    const { event_key: key, ...content } = event;
    // A replay keeps the first append's time, as the table does.
    const digest = canonicalDigest({ ...content, at: null }).sha256;
    const existing = this.keys.get(key);
    if (existing !== undefined) {
      if (existing !== digest) return Promise.reject(new EventConflictError(key));
      this.replays.push(key);
      return Promise.resolve();
    }
    if (!AFTER_FINISH.has(content.type) && this.events.some((stored) => stored.type === "request_finished")) return Promise.reject(new EventNotAllowedError(content.type));
    this.keys.set(key, digest);
    this.events.push({ ...content, seq: this.events.length + 1 });
    return Promise.resolve();
  }
}

export interface MemoryLedgerOptions {
  budget_microusd: number;
  /** Reserved at creation, as the start route does before the worker runs. */
  worker_worst_case_microusd: number;
  /** The pool's cap; 40,000,000 (the test pool of contract section 15.1) by default. */
  pool_cap_microusd?: number;
  /** Committed by other requests against the same pool. */
  other_committed_microusd?: number;
  /** What a settled candidate spent; its whole reservation by default. */
  candidateCost?: (candidateId: string, reservedMicrousd: number) => number;
  /** What the worker spent; its whole reservation by default. */
  workerCost?: number;
}

export type LedgerCall =
  | { call: "reserveCandidate"; candidate_id: string; worst_case_microusd: number; outcome: ReserveOutcome["kind"] }
  | { call: "settleCandidate"; candidate_id: string; spent_microusd: number }
  | { call: "settleWorker"; stop_code: StopCode; spent_microusd: number };

export class MemoryLedger implements RequestLedger {
  readonly options: MemoryLedgerOptions;
  readonly reservations = new Map<string, number>();
  readonly calls: LedgerCall[] = [];
  spent = 0;
  halted = false;
  poolHalted = false;
  closedWith: StopCode | null = null;

  constructor(options: MemoryLedgerOptions) {
    this.options = options;
    this.reservations.set("worker", options.worker_worst_case_microusd);
  }

  private reserved(): number {
    let total = 0;
    for (const amount of this.reservations.values()) total += amount;
    return total;
  }

  snapshot(): LedgerStatus {
    const committed = this.reserved() + this.spent;
    return {
      budget_microusd: this.options.budget_microusd,
      reserved_microusd: this.reserved(),
      spent_microusd: this.spent,
      halted: this.halted,
      pool_available_microusd: (this.options.pool_cap_microusd ?? 40_000_000) - (this.options.other_committed_microusd ?? 0) - committed,
      pool_halted: this.poolHalted,
    };
  }

  status(): Promise<LedgerStatus> {
    return Promise.resolve(this.snapshot());
  }

  reserveCandidate(input: { candidate_id: string; worst_case_microusd: number }): Promise<ReserveOutcome> {
    const status = this.snapshot();
    let outcome: ReserveOutcome;
    if (this.halted || this.poolHalted || this.closedWith !== null) outcome = { kind: "refused", reason: "halted" };
    else if (status.budget_microusd - status.reserved_microusd - status.spent_microusd < input.worst_case_microusd) outcome = { kind: "refused", reason: "budget" };
    else if (status.pool_available_microusd < input.worst_case_microusd) outcome = { kind: "refused", reason: "pool" };
    else {
      this.reservations.set(`candidate:${input.candidate_id}`, input.worst_case_microusd);
      outcome = { kind: "reserved" };
    }
    this.calls.push({ call: "reserveCandidate", candidate_id: input.candidate_id, worst_case_microusd: input.worst_case_microusd, outcome: outcome.kind });
    return Promise.resolve(outcome);
  }

  settleCandidate(input: { candidate_id: string }): Promise<void> {
    const key = `candidate:${input.candidate_id}`;
    const reserved = this.reservations.get(key);
    if (reserved === undefined) return Promise.reject(new Error(`no reservation for candidate ${input.candidate_id}`));
    const spent = this.options.candidateCost?.(input.candidate_id, reserved) ?? reserved;
    this.reservations.delete(key);
    this.spent += spent;
    this.calls.push({ call: "settleCandidate", candidate_id: input.candidate_id, spent_microusd: spent });
    return Promise.resolve();
  }

  settleWorker(input: { stop_code: StopCode }): Promise<void> {
    const reserved = this.reservations.get("worker");
    if (reserved === undefined) return Promise.reject(new Error("the worker is already settled"));
    const spent = this.options.workerCost ?? reserved;
    this.reservations.delete("worker");
    this.spent += spent;
    this.closedWith = input.stop_code;
    this.calls.push({ call: "settleWorker", stop_code: input.stop_code, spent_microusd: spent });
    return Promise.resolve();
  }
}
