// The request loop (contract sections 8 to 10). Every effect is
// injected: the event store, the ledger, the stop check, the export-verification harness, packaging,
// evidence storage and the clock. One candidate runs at a time; an uncertain operation is never retried.
//
// For each candidate, in assignment order across the selected hosts: the stop, fill, deadline, sources
// and candidate-limit checks, then the ledger's halt and overrun check, `candidate_selected`, the
// duplicate-defect skip, budget admission (`no_budget_for_candidate`), the reservation, export
// verification through the harness (with the accounting, stop and time check before every copy and
// `check_finished` after every copy state), the verdict, the accounting and stop check before a
// matched candidate's qualification, assignment, packaging and delivery, and the candidate's
// settlement. The loop appends every request event except `request_accepted`, `stop_requested`, the
// start reservation's `budget_updated`, `worker_started`, the validation events and the lost-worker
// finish.
//
// Accounting stops (contract sections 8.1 and 8.5), one rule set for the loop and its finish:
// - A halted ledger, a halted pool or an overrun stops the work still to do: no further copy of the
//   candidate in flight and no qualification of it (it ends incomplete, `stopped`, and settles), no
//   further candidate, and a reservation refused as halted ends its candidate the same way; the request
//   finishes `operational_error`. A halt or an overrun the reservation's ledger read finds ends the
//   candidate before the harness runs, and one the last copy's read finds ends a candidate whose six
//   cells matched. A candidate's check boundaries are before each copy and, for a candidate that would
//   qualify, the harness's return; each checks, in this order, a halt or an overrun a copy's read found,
//   the user's stop and (before a copy) that the copy's timeout fits before the deadline, so a halt
//   found with a stop or the deadline finishes `operational_error`. The top of the loop applies the same
//   order before a next candidate: a halt or an overrun the run's latest read showed comes ahead of a
//   stop or the deadline found there. The deadline bounds only what starts (a copy, a candidate): a
//   matched candidate whose copies all started in time is delivered.
// - An overrun finishes `operational_error`, ahead of a fill, a stop or a limit. Every ledger read while
//   the request runs (the reservation's, a copy's, a candidate's settlement, the worker's) checks for
//   one, and once seen it stays seen, even when a later read no longer shows it (a ledger that releases
//   a candidate's unused copy reservations when it settles): at the candidate's settlement the loop
//   finishes with that code at once (so the budget closes with it), and the finish turns the decided
//   code into it.
// - A halt seen only once no work is left (after the last needed case or the last candidate settled,
//   or when no entry is left or the candidate limit is reached) stopped nothing and keeps the outcome,
//   as contract revision 2 keeps it for an overrun after the finish. A candidate whose complete verdict
//   is not a match keeps its reason, so a halt its last copy's read found is left to the loop's checks
//   before the next candidate.
// - The worker's settlement closes the budget with the code `request_finished` names, an overrun seen
//   by then included. Between the loop's last ledger read and that settlement only the worker itself
//   runs (preparing hosts, checking, packaging), and its use settles there, so only that settlement's
//   own overrun, or a failed read or budget event after it, can still change the code.
// - An uncertain outcome (a rejected harness, reserve or settle call) finishes `needs_reconciliation`
//   ahead of both; its reservation stays held and is never retried.
import { canonicalDigest } from "@rbw/schema";
import { CHECK_SET_VALUES } from "@rbw/factory-contract";
import type { Case, CatalogEntry, Cell, CellObservation, CheckSet, CopyState, HostId, RequestOutcome, StopCode } from "@rbw/factory-contract";
import { assignItem, demonstratedCriteria, itemStates, nextCandidate, servesItem, unfilledUnits } from "./assignment.ts";
import type { ItemState, PlannedCandidate } from "./assignment.ts";
import { admitCandidate, budgetRoom, ledgerStop, overrun } from "./budget.ts";
import { PACKAGE_FORMATS, QUALIFICATION_ROUTE } from "./capabilities.ts";
import { bugTypeOf } from "./criteria.ts";
import type { CriteriaCatalog } from "./criteria.ts";
import {
  OUTCOME_OF,
  attention,
  behaviorChecksPassed,
  budgetMessage,
  budgetUpdated,
  candidateEnded,
  candidateSelected,
  caseDelivered,
  checkFinished,
  hostPreparing,
  hostReady,
  packageReady,
  requestFinished,
  requestedCriteriaPassed,
  sourceExhausted,
} from "./events.ts";
import { caseId } from "./identity.ts";
import { formatUsd } from "./money.ts";
import type { CasePackages, EventSink, HarnessResult, LedgerStatus, NewEvent, PackageCase, QualifyHarness, RequestLedger, RequestRecordInput, ReserveOutcome } from "./ports.ts";
import { candidateWorstCase } from "./profile.ts";
import type { FactoryProfileInput } from "./profile.ts";
import type { CaseEvidence } from "./projection.ts";
import { HOST_PRESENTATION, candidateInfo, entryServes, sourcesOf } from "./sources.ts";
import type { HostRegistry } from "./sources.ts";
import { EXPECTED, cellVerdict, qualificationRecord } from "./verdict.ts";

export interface RunRequestDeps {
  request: RequestRecordInput;
  /** The host adapters in catalog order. */
  registry: HostRegistry;
  catalog: CriteriaCatalog;
  profile: FactoryProfileInput;
  now(): Date;
  events: EventSink;
  ledger: RequestLedger;
  /** Whether a stop is recorded for the request. */
  stopRequested(): Promise<boolean>;
  qualify: QualifyHarness;
  packageCase: PackageCase;
  /** Stores the per-request evidence of a delivered case before its `package_ready` event. */
  writeEvidence(input: { request_id: string; case_id: string; evidence: CaseEvidence; sha256: string }): Promise<void>;
  /** Readies a host before its first candidate (for example, checks its kit image); optional. */
  prepareHost?(host: HostId): Promise<void>;
}

export interface RunResult {
  outcome: RequestOutcome;
  stop_code: StopCode;
  /** Uncertain spend is held: the caller keeps the factory slot until reconciliation. */
  needs_reconciliation: boolean;
  delivered: number;
  /** What went wrong, for the operator's log (never shown to a client): each caught failure, in order. */
  notes: string[];
}

export const DIFFICULTY_NOTE = "No difficulty assessment ran. This case may be easy or hard to diagnose from source.";

const ENDS_CANDIDATE: ReadonlySet<string> = new Set(["candidate_rejected", "candidate_invalid", "candidate_incomplete", "candidate_skipped"]);

/** Why the request stopped a candidate at a copy boundary. */
type StopCause = "cancelled_by_user" | "time_limit" | "operational_error";

type CandidateOutcome = { kind: "done" } | { kind: "stop"; stop_code: StopCause } | { kind: "uncertain" } | { kind: "failed" };

type Amounts = Pick<LedgerStatus, "budget_microusd" | "reserved_microusd" | "spent_microusd">;

/**
 * Whether the stored parts are the pair export verification ran on: the bug case is the archive it
 * ran on, the downloadable validator holds the validator core it ran on plus this qualification
 * record, as read back from the stored validator, and the reported `pair_sha256` is the canonical hash
 * of the stored parts' hashes and the case ID (contract section 10.3), with the package tooling's layout.
 */
function storedAsVerified(packages: CasePackages, verified: HarnessResult["package_sha256"], record_sha256: string, case_id: string): boolean {
  const pair = canonicalDigest({ bug_case_sha256: packages.bug_case.sha256, case_id, validator_sha256: packages.validator.sha256 }).sha256;
  return packages.bug_case.sha256 === verified.bug_case && packages.validator.core_sha256 === verified.validator && packages.validator.evidence_sha256 === record_sha256 && packages.pair_sha256 === pair;
}

function caseCell(cell: CellObservation, set: CheckSet, state: CopyState): Cell {
  const expected = EXPECTED[set][state];
  return { expected, observed: cell.observed, runs_valid: cell.runs_valid, runs_total: cell.runs_total, matches_expectation: cell.observed === expected };
}

class RequestRun {
  private readonly deps: RunRequestDeps;
  private readonly items: ItemState[];
  private readonly deadlineMs: number;
  private lastAmounts: Amounts | null = null;
  private delivered = 0;
  /** A ledger read while the request ran showed an overrun; it stays set (contract section 8.5). */
  private overrunSeen = false;
  /** The run's latest ledger read showed a halt, a halted pool or an overrun. */
  private latestReadStops = false;
  /** An uncertain outcome happened: its spend stays held for an operator, and the request finishes needs_reconciliation. */
  private uncertain = false;
  /** The needs_reconciliation attention event is recorded. */
  private attentionRaised = false;
  private hookError: { error: unknown } | null = null;
  private readonly notes: string[] = [];
  /**
   * The candidate of the current iteration: its `candidate_selected` event, whether that append resolved,
   * and whether the candidate ended, holds a reservation, has that reservation's budget event recorded,
   * and settled.
   */
  private current: { candidate: PlannedCandidate; selection: NewEvent; selected: boolean; ended: boolean; reserved: boolean; reservationRecorded: boolean; settled: boolean } | null = null;
  private finishing = false;

  constructor(deps: RunRequestDeps) {
    this.deps = deps;
    this.items = itemStates(deps.request.interpretation);
    this.deadlineMs = Date.parse(deps.request.created_at) + deps.request.interpretation.limits.max_wall_clock_s * 1000;
  }

  private note(what: string, error: unknown): void {
    this.notes.push(`${what}: ${error instanceof Error ? `${error.name}: ${error.message}` : "a non-error value was thrown"}`);
  }

  private at(): string {
    return this.deps.now().toISOString();
  }

  private async append(event: NewEvent): Promise<void> {
    await this.deps.events.append(event);
    const current = this.current;
    if (current !== null && event.candidate_id === current.candidate.candidate_id && (ENDS_CANDIDATE.has(event.type) || event.type === "case_delivered")) current.ended = true;
  }

  /** Every ledger read of the run: one that shows an overrun marks the run for good. */
  private async readLedger(): Promise<LedgerStatus> {
    const status = await this.deps.ledger.status();
    if (overrun(status)) this.overrunSeen = true;
    this.latestReadStops = ledgerStop(status) !== null;
    return status;
  }

  /** Reads the ledger and appends `budget_updated` when its amounts changed since the last one this run recorded. */
  private async budgetChanged(key: string, subject: string): Promise<LedgerStatus> {
    const status = await this.readLedger();
    await this.recordBudget(key, subject, status, false);
    return status;
  }

  /**
   * Appends `budget_updated` with these amounts when they changed since the last one this run recorded,
   * or always with `always`: a candidate's reservation is recorded even when a ledger that reserves per
   * copy changed nothing yet, because the status counts a candidate as started from that event.
   */
  private async recordBudget(key: string, subject: string, status: Amounts, always: boolean): Promise<void> {
    const amounts: Amounts = { budget_microusd: status.budget_microusd, reserved_microusd: status.reserved_microusd, spent_microusd: status.spent_microusd };
    const before = this.lastAmounts;
    if (!always && before !== null && before.reserved_microusd === amounts.reserved_microusd && before.spent_microusd === amounts.spent_microusd) return;
    await this.append(budgetUpdated(key, amounts, budgetMessage(before ?? amounts, amounts, subject), this.at()));
    this.lastAmounts = amounts;
  }

  /** The candidate's reservation event, with these amounts; the status counts the candidate as started from it. */
  private async recordReservation(candidate: PlannedCandidate, status: Amounts): Promise<void> {
    await this.recordBudget(`cand:${candidate.candidate_id}:reserved`, `this candidate's worst case on ${HOST_PRESENTATION[candidate.host_id].name}`, status, true);
  }

  /**
   * The amounts for a held reservation's event in the recovery: a fresh ledger read, or the amounts this
   * run last recorded when the ledger cannot be read, so the candidate's end and the finish still follow.
   */
  private async recoveryAmounts(): Promise<Amounts> {
    try {
      return await this.readLedger();
    } catch (error) {
      this.note("reading the ledger to record a held reservation", error);
      // A candidate is selected only after the loop's first read recorded the amounts.
      if (this.lastAmounts === null) throw error;
      return this.lastAmounts;
    }
  }

  /** Marks the run uncertain and records the attention event once; a retry after a failed append appends it again. */
  private async raiseReconciliation(): Promise<void> {
    this.uncertain = true;
    if (this.attentionRaised) return;
    await this.append(attention("needs_reconciliation", this.at()));
    this.attentionRaised = true;
  }

  /**
   * Settles the worker and appends `request_finished`. The stop code the loop decided stands unless
   * the request's accounting says otherwise, in this order:
   * - an uncertain outcome, including a rejected worker settlement (whose reservation then stays
   *   held, never retried), finishes `needs_reconciliation`;
   * - an overrun any ledger read of the run showed, including the read once the worker settled,
   *   finishes `operational_error` (contract section 8.5: an overrun found while the request runs, from
   *   the reservation, a copy, a candidate's settlement or the worker's own), ahead of a fill, a stop or
   *   a limit, even when the last read no longer shows it;
   * - a failed ledger read or budget event after the worker settled finishes `operational_error`,
   *   since the request's accounting could not be confirmed.
   * settleWorker closes the budget with the code known before it settles (see closingCode); only an
   * overrun of the worker's own settlement, or a failed read or budget event after it, can therefore
   * leave the budget closed with another code than `request_finished` names.
   */
  private async finish(decided: StopCode): Promise<RunResult> {
    this.finishing = true;
    let stopCode = this.closingCode(decided);
    try {
      await this.deps.ledger.settleWorker({ stop_code: stopCode });
    } catch (error) {
      this.note("settling the worker", error);
      await this.raiseReconciliation();
    }
    try {
      await this.budgetChanged("run:worker-settled", "the worker");
    } catch (error) {
      this.note("recording the budget after the worker settled", error);
      stopCode = "operational_error";
    }
    if (this.overrunSeen) stopCode = "operational_error";
    if (this.uncertain) stopCode = "needs_reconciliation";
    await this.append(requestFinished(stopCode, this.at()));
    return { outcome: OUTCOME_OF[stopCode], stop_code: stopCode, needs_reconciliation: this.uncertain, delivered: this.delivered, notes: [...this.notes] };
  }

  /**
   * The code the worker's settlement closes the budget with: the decided code, unless an outcome was
   * uncertain or a ledger read of the run showed an overrun (for example the loop's first read, ahead of
   * a stop found at the top of the loop).
   */
  private closingCode(decided: StopCode): StopCode {
    if (this.uncertain) return "needs_reconciliation";
    return this.overrunSeen ? "operational_error" : decided;
  }

  private async finishUncertain(): Promise<RunResult> {
    await this.raiseReconciliation();
    return this.finish("needs_reconciliation");
  }

  /** The entries this run may try: selected hosts in catalog order, available until the deadline, eligible for an item. */
  private plan(): PlannedCandidate[] {
    const { deps } = this;
    const hosts = deps.request.interpretation.input.hosts;
    const window = { from: this.at(), until: new Date(this.deadlineMs).toISOString() };
    const planned: PlannedCandidate[] = [];
    for (const adapter of deps.registry) {
      if (!hosts.includes(adapter.host_id)) continue;
      const baseline = adapter.baseline();
      for (const source of sourcesOf(adapter, deps.catalog, window)) {
        for (const entry of source.available) {
          if (!this.items.some((item) => entryServes(entry, item))) continue;
          planned.push({ ...candidateInfo(baseline, entry), baseline_id: baseline.baseline_id, entry, adapter, worst_case_microusd: candidateWorstCase(adapter, entry, deps.profile) });
        }
      }
    }
    return planned;
  }

  /**
   * Runs the loop. An unexpected failure (a port read, a hook, an adapter, an append) ends the candidate
   * in flight as incomplete and finishes the request: `needs_reconciliation` once an outcome was
   * uncertain or while that candidate's reservation is held, otherwise `operational_error`. A failure
   * while finishing, or a store that refuses the recovery's events, propagates: the lost-worker finish
   * then applies.
   */
  async run(): Promise<RunResult> {
    try {
      return await this.loop();
    } catch (error) {
      if (this.finishing) throw error;
      this.note("the request loop", error);
      const current = this.current;
      if (current !== null && !current.ended) {
        // A selection whose append failed may or may not have committed. Appending the same event again
        // replays it or records it, so the end never names a candidate the event log lacks.
        if (!current.selected) await this.append(current.selection);
        // Likewise a reservation whose budget event failed, so the status counts the held candidate as started.
        if (current.reserved && !current.reservationRecorded) await this.recordReservation(current.candidate, await this.recoveryAmounts());
        await this.append(candidateEnded(current.candidate, "incomplete_run", this.at(), "Incomplete: the worker hit an internal error during this candidate. It is not reproduction and was not retried."));
      }
      if (this.uncertain || (current !== null && current.reserved && !current.settled)) return this.finishUncertain();
      return this.finish("operational_error");
    }
  }

  private async loop(): Promise<RunResult> {
    const { deps } = this;
    const start = await this.readLedger();
    this.lastAmounts = { budget_microusd: start.budget_microusd, reserved_microusd: start.reserved_microusd, spent_microusd: start.spent_microusd };
    let planned: PlannedCandidate[];
    try {
      planned = this.plan();
      const hosts = new Map<HostId, string>();
      for (const candidate of planned) if (!hosts.has(candidate.host_id)) hosts.set(candidate.host_id, candidate.baseline_id);
      for (const [host, baselineId] of hosts) await this.append(hostPreparing(host, baselineId, this.at()));
      for (const host of hosts.keys()) await deps.prepareHost?.(host);
      for (const [host, baselineId] of hosts) await this.append(hostReady(host, baselineId, this.at()));
    } catch (error) {
      this.note("planning candidates or preparing hosts", error);
      return this.finish("operational_error");
    }

    const tried = new Set<string>();
    /** Defects of candidates that started, with the entry that started them. */
    const defects = new Map<string, string>();
    const budgetSkipped = new Set<string>();
    let started = 0;
    /**
     * A stop or the deadline found at the top of the loop, where a halt or an overrun the run's latest
     * ledger read showed comes first when it would stop the same next candidate. A halt that no next
     * candidate would meet (every item filled, no entry left, the candidate limit reached) stops no work
     * and keeps their code.
     */
    const loopStop = (code: "cancelled_by_user" | "time_limit"): StopCode => {
      if (!this.latestReadStops) return code;
      const next = nextCandidate(this.items, planned, tried);
      if (next === null || (!defects.has(next.defect_id) && started >= deps.request.interpretation.limits.max_candidates)) return code;
      return "operational_error";
    };
    for (;;) {
      this.current = null;
      // A stop recorded before the finish makes the outcome cancelled, even once every item is filled
      // (contract section 9).
      if (await deps.stopRequested()) return this.finish(loopStop("cancelled_by_user"));
      if (this.items.every((item) => unfilledUnits(item) === 0)) return this.finish("fulfilled");
      if (deps.now().getTime() >= this.deadlineMs) return this.finish(loopStop("time_limit"));
      const next = nextCandidate(this.items, planned, tried);
      if (next === null) return this.exhausted(planned, tried, budgetSkipped);
      const duplicateOf = defects.get(next.defect_id);
      if (duplicateOf === undefined && started >= deps.request.interpretation.limits.max_candidates) return this.finish("candidate_limit");
      // A halt or an overrun stops the work still to do, so it is read once a next candidate exists.
      const status = await this.readLedger();
      if (ledgerStop(status) !== null) return this.finish("operational_error");
      tried.add(next.candidate_id);
      const selection = candidateSelected(next, this.at());
      this.current = { candidate: next, selection, selected: false, ended: false, reserved: false, reservationRecorded: false, settled: false };
      await this.append(selection);
      this.current.selected = true;
      if (duplicateOf !== undefined) {
        await this.append(candidateEnded(next, "duplicate_defect", this.at(), `Skipped: this entry plants the same defect as ${duplicateOf}, which this request already tried.`));
        continue;
      }
      const host = HOST_PRESENTATION[next.host_id].name;
      const skip = async (): Promise<void> => {
        budgetSkipped.add(next.candidate_id);
        await this.append(
          candidateEnded(next, "no_budget_for_candidate", this.at(), `Skipped: the remaining budget of ${formatUsd(budgetRoom(status))} or the factory pool cannot cover this candidate's worst case of ${formatUsd(next.worst_case_microusd)} on ${host}.`),
        );
      };
      if (admitCandidate(status, next.worst_case_microusd).kind === "skip") {
        await skip();
        continue;
      }
      let reserved: ReserveOutcome;
      try {
        reserved = await deps.ledger.reserveCandidate({ candidate_id: next.candidate_id, host_id: next.host_id, worst_case_microusd: next.worst_case_microusd });
      } catch (error) {
        this.note(`reserving candidate ${next.candidate_id}`, error);
        await this.append(candidateEnded(next, "incomplete_run", this.at(), "Incomplete: reserving this candidate's worst case had an uncertain outcome, so it was not run or retried."));
        return this.finishUncertain();
      }
      if (reserved.kind === "refused" && reserved.reason === "halted") {
        // Not a budget or pool shortfall (contract section 8.3): the halt stops the request with this candidate selected.
        await this.append(candidateEnded(next, "stopped", this.at(), "Incomplete: the spend ledger is halted, so this candidate's worst case could not be reserved and it was not run."));
        return this.finish("operational_error");
      }
      if (reserved.kind === "refused") {
        await skip();
        continue;
      }
      this.current.reserved = true;
      defects.set(next.defect_id, next.entry_id);
      started += 1;
      const reservedStatus = await this.readLedger();
      await this.recordReservation(next, reservedStatus);
      this.current.reservationRecorded = true;
      let outcome: CandidateOutcome;
      if (ledgerStop(reservedStatus) !== null) {
        // The reservation's read, like a copy's, found a halt or an overrun: the candidate runs no copy
        // and is not verified; it ends stopped and settles (contract section 8.5).
        await this.append(candidateEnded(next, "stopped", this.at()));
        outcome = { kind: "stop", stop_code: "operational_error" };
      } else {
        outcome = await this.runCandidate(next);
      }
      if (outcome.kind === "uncertain") {
        await this.append(candidateEnded(next, "incomplete_run", this.at(), "Incomplete: a sandbox run's outcome is uncertain, so this candidate was stopped and is not retried."));
        return this.finishUncertain();
      }
      try {
        await deps.ledger.settleCandidate({ candidate_id: next.candidate_id });
      } catch (error) {
        this.note(`settling candidate ${next.candidate_id}`, error);
        return this.finishUncertain();
      }
      this.current.settled = true;
      // An overrun seen at any read so far (a copy's, this settlement's) finishes the request
      // operational_error now, ahead of a fill, a stop or the deadline, so the worker's settlement closes
      // the budget with that code; finish() checks again once the worker settled.
      await this.budgetChanged(`cand:${next.candidate_id}:settled`, "the finished candidate");
      if (this.overrunSeen) return this.finish("operational_error");
      if (outcome.kind === "stop") return this.finish(outcome.stop_code);
      if (outcome.kind === "failed") return this.finish("operational_error");
    }
  }

  /** No untried entry serves an item still short: report the exhausted sources and stop. */
  private async exhausted(planned: readonly PlannedCandidate[], tried: ReadonlySet<string>, budgetSkipped: ReadonlySet<string>): Promise<RunResult> {
    let budget = false;
    const sources: PlannedCandidate[] = [];
    for (const item of this.items) {
      if (unfilledUnits(item) === 0) continue;
      const eligible = planned.filter((candidate) => servesItem(candidate, item));
      if (eligible.some((candidate) => budgetSkipped.has(candidate.candidate_id))) budget = true;
      for (const candidate of eligible) {
        if (sources.some((source) => source.source_id === candidate.source_id && source.bug_type_id === candidate.bug_type_id)) continue;
        const ofSource = eligible.filter((other) => other.source_id === candidate.source_id && other.bug_type_id === candidate.bug_type_id);
        if (ofSource.every((other) => tried.has(other.candidate_id) && !budgetSkipped.has(other.candidate_id))) sources.push(candidate);
      }
    }
    for (const source of sources) await this.append(sourceExhausted(source.host_id, source.bug_type_id, source.source_id, this.at()));
    return this.finish(budget ? "budget_exhausted" : "sources_exhausted");
  }

  private async runCandidate(candidate: PlannedCandidate): Promise<CandidateOutcome> {
    const { deps } = this;
    const { entry, adapter } = candidate;
    const protocol = adapter.protocol(entry);
    const stop: { cause: StopCause | null } = { cause: null };
    let copies = 0;
    /**
     * A copy's ledger read found a halt or an overrun: no further copy runs and the candidate does not
     * qualify (contract section 8.5).
     */
    let accountingStop = false;
    /**
     * One check boundary, in the request's precedence: the accounting stop, then the recorded stop, then,
     * before a copy, the deadline (`timeout_s`: the copy starts only when its timeout fits before it). A
     * read that fails propagates.
     */
    const boundary = async (timeout_s: number | null): Promise<StopCause | null> => {
      if (accountingStop) return "operational_error";
      if (await deps.stopRequested()) return "cancelled_by_user";
      if (timeout_s !== null && deps.now().getTime() + timeout_s * 1000 > this.deadlineMs) return "time_limit";
      return null;
    };
    const beforeCopy = async (plan: { limits: { timeout_s: number } }): Promise<"continue" | "stop"> => {
      if (this.hookError !== null) return "stop";
      try {
        const cause = await boundary(plan.limits.timeout_s);
        if (cause === null) return "continue";
        stop.cause = cause;
        return "stop";
      } catch (error) {
        this.hookError = { error };
        return "stop";
      }
    };
    // Per copy: the ledger read (settlement happens per copy inside the runner, or at the candidate's end).
    // A halt or an overrun it finds ends the candidate at the next check boundary (before the next copy,
    // or the harness's return after the last), as a stop does; an overrun also stays seen, so the
    // candidate's settlement finishes operational_error whatever stopped it.
    const onCopy = async (): Promise<void> => {
      if (this.hookError !== null) return;
      try {
        copies += 1;
        const status = await this.budgetChanged(`cand:${candidate.candidate_id}:copy-${String(copies)}:budget`, "a finished copy");
        if (ledgerStop(status) !== null) accountingStop = true;
      } catch (error) {
        this.hookError = { error };
      }
    };
    // Per state: the two cells exactly as the harness checked them, so each check_finished event reads
    // what the verdict reads.
    const onCells = async (state: CopyState, cells: Record<CheckSet, CellObservation>): Promise<void> => {
      if (this.hookError !== null) return;
      try {
        for (const set of CHECK_SET_VALUES) await this.append(checkFinished(candidate, set, state, cells[set], this.at()));
      } catch (error) {
        this.hookError = { error };
      }
    };

    let result: HarnessResult;
    try {
      result = await deps.qualify({ entry, adapter, beforeCopy, onCopy, onCells });
    } catch (error) {
      // Every harness rejection is an uncertain provider outcome (a runner rejection passed through).
      this.note(`export verification of candidate ${candidate.candidate_id}`, error);
      return { kind: "uncertain" };
    }
    const verdict = cellVerdict({ matrix: result.matrix, records: result.records, stopped: result.stopped, integrity: result.integrity });
    // The harness's return is the candidate's last check boundary: a halt or an overrun its last copy's
    // read found, or a stop recorded while that copy ran, ends a candidate that would go on to
    // qualification (contract sections 8.5 and 9), in the order of the check before a copy. The deadline
    // bounds only what starts, and every copy of this candidate started in time.
    if (verdict.kind === "matched" && stop.cause === null && this.hookError === null) {
      try {
        stop.cause = await boundary(null);
      } catch (error) {
        this.hookError = { error };
      }
    }
    if (this.hookError !== null) {
      // A read between copies failed, so the harness stopped, or the stop check once the copies ran failed;
      // every copy that ran has a definite outcome, so the candidate ends incomplete and settles, and the
      // request finishes operational_error.
      this.note(`a check between or after the copies of candidate ${candidate.candidate_id}`, this.hookError.error);
      await this.append(candidateEnded(candidate, "incomplete_run", this.at(), "Incomplete: an internal check between or after this candidate's copies failed, so it was stopped. It is not reproduction and was not retried."));
      return { kind: "failed" };
    }
    const { matrix } = result;
    const caseIdValue = caseId({ defect_id: candidate.defect_id, entry, criteria_catalog_version: deps.catalog.criteria_catalog_version });
    const demonstrated = demonstratedCriteria(deps.catalog, entry.bug_type_id, matrix?.verification.buggy.failure_codes ?? []);
    const demonstratedIds = demonstrated.map((criterion) => criterion.criterion_id);
    const criteria = bugTypeOf(deps.catalog, entry.bug_type_id).criteria.map((criterion) => ({ criterion_id: criterion.criterion_id, matched: demonstratedIds.includes(criterion.criterion_id) }));
    if (verdict.kind === "ended") {
      const cause = stop.cause;
      const reason = verdict.reason === "stopped" && cause === null ? "incomplete_run" : verdict.reason;
      await this.append(candidateEnded(candidate, reason, this.at()));
      return verdict.reason === "stopped" && cause !== null ? { kind: "stop", stop_code: cause } : { kind: "done" };
    }
    const stoppedBy = stop.cause;
    if (stoppedBy !== null) {
      await this.append(candidateEnded(candidate, "stopped", this.at()));
      return { kind: "stop", stop_code: stoppedBy };
    }
    await this.append(behaviorChecksPassed(candidate, this.at()));
    const item = assignItem(this.items, entry.bug_type_id, demonstratedIds);
    if (item === null) {
      await this.append(candidateEnded(candidate, "wrong_failure", this.at()));
      return { kind: "done" };
    }
    await this.append(requestedCriteriaPassed(candidate, item.item_key, demonstratedIds, this.at()));
    const record = qualificationRecord({ harness: result, case_id: caseIdValue, defect_id: candidate.defect_id, entry_id: entry.entry_id, item_key: item.item_key, criteria, verdict: "accepted", reason_code: null });
    const recordDigest = canonicalDigest(record);
    let packages: CasePackages;
    try {
      packages = await deps.packageCase({ request_id: deps.request.request_id, case_id: caseIdValue, entry, record_json: recordDigest.bytes });
    } catch (error) {
      this.note(`packaging case ${caseIdValue}`, error);
      await this.append(candidateEnded(candidate, "incomplete_run", this.at(), "Incomplete: the case's package parts could not be stored. It is not delivered."));
      return { kind: "failed" };
    }
    if (!storedAsVerified(packages, result.package_sha256, recordDigest.sha256, caseIdValue)) {
      // A stored part that is not what export verification ran on failed the integrity check of the
      // exported parts (contract section 8.3): the candidate is rejected, never delivered.
      await this.append(candidateEnded(candidate, "export_mismatch", this.at()));
      return { kind: "done" };
    }
    const packageAt = this.at();
    const qualifiedAt = this.at();
    const delivered = this.caseOf({ candidate, entry, case_id: caseIdValue, item_key: item.item_key, matrix: result.matrix, demonstrated, protocol_id: protocol.protocol_id, protocol_version: protocol.version, record_sha256: recordDigest.sha256, qualified_at: qualifiedAt, packages });
    const evidence: CaseEvidence = { schema_version: 1, case: delivered, record };
    try {
      await deps.writeEvidence({ request_id: deps.request.request_id, case_id: caseIdValue, evidence, sha256: canonicalDigest(evidence).sha256 });
    } catch (error) {
      this.note(`storing the evidence of case ${caseIdValue}`, error);
      await this.append(candidateEnded(candidate, "incomplete_run", this.at(), "Incomplete: the case's evidence could not be stored. It is not delivered."));
      return { kind: "failed" };
    }
    await this.append(packageReady(candidate, item.item_key, caseIdValue, { bug_case_sha256: packages.bug_case.sha256, validator_sha256: packages.validator.sha256 }, packageAt));
    await this.append(caseDelivered(candidate, item.item_key, caseIdValue, qualifiedAt));
    item.delivered += 1;
    this.delivered += 1;
    return { kind: "done" };
  }

  /** The client-safe case: presentation text, identities, the six cells' outcomes and the stored parts. */
  private caseOf(input: {
    candidate: PlannedCandidate;
    entry: CatalogEntry;
    case_id: string;
    item_key: string;
    matrix: HarnessResult["matrix"];
    demonstrated: { criterion_id: string; version: string; label: string }[];
    protocol_id: string;
    protocol_version: string;
    record_sha256: string;
    qualified_at: string;
    packages: CasePackages;
  }): Case {
    const { entry, matrix, packages } = input;
    if (matrix === null) throw new Error("an accepted candidate has a matrix");
    const baseline = input.candidate.adapter.baseline();
    const requestId = this.deps.request.request_id;
    const part = (kind: "bug_case" | "validator") => ({
      kind,
      format: PACKAGE_FORMATS[kind],
      filename: packages[kind].filename,
      media_type: "application/gzip" as const,
      size_bytes: packages[kind].size_bytes,
      sha256: packages[kind].sha256,
      ready: true,
      download_path: `/api/factory/requests/${requestId}/cases/${input.case_id}/packages/${kind === "bug_case" ? "bug-case" : "validator"}`,
    });
    const cells = (set: CheckSet) => ({ clean: caseCell(matrix[set].clean, set, "clean"), buggy: caseCell(matrix[set].buggy, set, "buggy"), fixed: caseCell(matrix[set].fixed, set, "fixed") });
    return {
      case_id: input.case_id,
      defect_id: input.candidate.defect_id,
      title: entry.presentation.title,
      host_id: entry.host_id,
      host_label: HOST_PRESENTATION[entry.host_id].label,
      baseline_id: baseline.baseline_id,
      bug_type_id: entry.bug_type_id,
      item_key: input.item_key,
      criteria_met: input.demonstrated.map((criterion) => ({ criterion_id: criterion.criterion_id, version: criterion.version, label: criterion.label })),
      summary: { observed_failure: entry.presentation.observed_failure, how_checked: entry.presentation.how_checked },
      matrix: {
        original_suite: { suite_id: baseline.original_suite.suite_id, suite_sha256: baseline.original_suite.sha256, test_count: baseline.original_suite.test_count, ...cells("original_suite") },
        verification: { check_set_id: entry.verification.check_set_id, ...cells("verification") },
      },
      repetition: { protocol_id: input.protocol_id, version: input.protocol_version, summary: entry.presentation.repetition_summary },
      difficulty: { status: "not_assessed", note: DIFFICULTY_NOTE },
      qualification: { route_id: QUALIFICATION_ROUTE.route_id, version: QUALIFICATION_ROUTE.version, verdict: "accepted", record_sha256: input.record_sha256, qualified_at: input.qualified_at },
      packages: { package_version: packages.package_version, pair_sha256: packages.pair_sha256, bug_case: part("bug_case"), validator: part("validator") },
      validation: null,
      provenance: { origin: "live_request", request_id: requestId, source_id: entry.source_id, entry_id: entry.entry_id },
    };
  }
}

/** Runs a request's worker loop to its finish and appends every event the loop owns. */
export function runRequest(deps: RunRequestDeps): Promise<RunResult> {
  return new RequestRun(deps).run();
}
