// The request loop (contract sections 8 to 10). Every effect is
// injected: the event store, the ledger, the stop check, the export-verification harness, packaging,
// evidence storage and the clock. One candidate runs at a time; an uncertain operation is never retried.
//
// For each candidate, in assignment order across the selected hosts: the ledger's halt and overrun
// check, `candidate_selected`, the duplicate-defect skip, budget admission (`no_budget_for_candidate`),
// the reservation, export verification through the harness (with the stop and time check before every
// copy and `check_finished` after every copy state), the verdict, assignment, packaging and delivery,
// and the candidate's settlement. The loop appends every request event except `request_accepted`,
// `stop_requested`, the start reservation's `budget_updated`, `worker_started`, the validation events
// and the lost-worker finish.
import { canonicalDigest } from "@rbw/schema";
import { CHECK_SET_VALUES, COPY_STATE_VALUES } from "@rbw/factory-contract";
import type { Case, CatalogEntry, Cell, CellObservation, CheckSet, CopyRecord, CopyState, HostId, RequestOutcome, StopCode } from "@rbw/factory-contract";
import { assignItem, demonstratedCriteria, itemStates, nextCandidate, servesItem, unfilledUnits } from "./assignment.ts";
import type { ItemState, PlannedCandidate } from "./assignment.ts";
import { admitCandidate, budgetRoom, ledgerStop } from "./budget.ts";
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

type CandidateOutcome = { kind: "done" } | { kind: "stop"; stop_code: "cancelled_by_user" | "time_limit" } | { kind: "uncertain" } | { kind: "failed" };

interface Amounts {
  reserved_microusd: number;
  spent_microusd: number;
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
  private reconciliation = false;
  private hookError: { error: unknown } | null = null;
  private readonly notes: string[] = [];
  /** The candidate of the current iteration: whether it ended, holds a reservation, and settled. */
  private current: { candidate: PlannedCandidate; ended: boolean; reserved: boolean; settled: boolean } | null = null;
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

  /** Appends `budget_updated` when the ledger's amounts changed since the last one this run saw. */
  private async budgetChanged(key: string, subject: string): Promise<LedgerStatus> {
    const status = await this.deps.ledger.status();
    const amounts = { reserved_microusd: status.reserved_microusd, spent_microusd: status.spent_microusd };
    const before = this.lastAmounts;
    if (before !== null && before.reserved_microusd === amounts.reserved_microusd && before.spent_microusd === amounts.spent_microusd) return status;
    await this.append(budgetUpdated(key, status, budgetMessage(before ?? amounts, amounts, subject), this.at()));
    this.lastAmounts = amounts;
    return status;
  }

  private async raiseReconciliation(): Promise<void> {
    if (this.reconciliation) return;
    this.reconciliation = true;
    await this.append(attention("needs_reconciliation", this.at()));
  }

  private async finish(stopCode: StopCode): Promise<RunResult> {
    this.finishing = true;
    try {
      await this.deps.ledger.settleWorker({ stop_code: stopCode });
    } catch (error) {
      this.note("settling the worker", error);
      // The worker's spend is now unknown: it stays held for an operator, and the outcome stands.
      await this.raiseReconciliation();
    }
    await this.budgetChanged("run:worker-settled", "the worker");
    await this.append(requestFinished(stopCode, this.at()));
    return { outcome: OUTCOME_OF[stopCode], stop_code: stopCode, needs_reconciliation: this.reconciliation, delivered: this.delivered, notes: [...this.notes] };
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
   * Runs the loop. An unexpected failure (a port read, a hook, an adapter) ends the candidate in flight
   * as incomplete and finishes the request: `needs_reconciliation` while that candidate's reservation is
   * held, otherwise `operational_error`. A failure while finishing, or a store that refuses the recovery's
   * events, propagates: the lost-worker finish then applies.
   */
  async run(): Promise<RunResult> {
    try {
      return await this.loop();
    } catch (error) {
      if (this.finishing) throw error;
      this.note("the request loop", error);
      const current = this.current;
      if (current !== null && !current.ended) {
        await this.append(candidateEnded(current.candidate, "incomplete_run", this.at(), "Incomplete: the worker hit an internal error during this candidate. It is not reproduction and was not retried."));
      }
      if (current !== null && current.reserved && !current.settled) return this.finishUncertain();
      return this.finish("operational_error");
    }
  }

  private async loop(): Promise<RunResult> {
    const { deps } = this;
    const start = await deps.ledger.status();
    this.lastAmounts = { reserved_microusd: start.reserved_microusd, spent_microusd: start.spent_microusd };
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
    for (;;) {
      this.current = null;
      if (this.items.every((item) => unfilledUnits(item) === 0)) return this.finish("fulfilled");
      if (await deps.stopRequested()) return this.finish("cancelled_by_user");
      if (deps.now().getTime() >= this.deadlineMs) return this.finish("time_limit");
      const status = await deps.ledger.status();
      if (ledgerStop(status) !== null) return this.finish("operational_error");
      const next = nextCandidate(this.items, planned, tried);
      if (next === null) return this.exhausted(planned, tried, budgetSkipped);
      const duplicateOf = defects.get(next.defect_id);
      if (duplicateOf === undefined && started >= deps.request.interpretation.limits.max_candidates) return this.finish("candidate_limit");
      tried.add(next.candidate_id);
      this.current = { candidate: next, ended: false, reserved: false, settled: false };
      await this.append(candidateSelected(next, this.at()));
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
        await this.append(candidateEnded(next, "no_budget_for_candidate", this.at(), "Skipped: the spend ledger is halted, so this candidate's worst case could not be reserved."));
        return this.finish("operational_error");
      }
      if (reserved.kind === "refused") {
        await skip();
        continue;
      }
      this.current.reserved = true;
      defects.set(next.defect_id, next.entry_id);
      started += 1;
      await this.budgetChanged(`cand:${next.candidate_id}:reserved`, `this candidate's worst case on ${host}`);
      const outcome = await this.runCandidate(next);
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
      await this.budgetChanged(`cand:${next.candidate_id}:settled`, "the finished candidate");
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
    const byState: Record<CopyState, CopyRecord[]> = { clean: [], buggy: [], fixed: [] };
    const emitted = new Set<CopyState>();
    const stop: { cause: "cancelled_by_user" | "time_limit" | null } = { cause: null };
    let copies = 0;
    const emitCells = async (state: CopyState, cells: Record<CheckSet, CellObservation>): Promise<void> => {
      emitted.add(state);
      for (const set of CHECK_SET_VALUES) await this.append(checkFinished(candidate, set, state, cells[set], this.at()));
    };
    const beforeCopy = async (plan: { limits: { timeout_s: number } }): Promise<"continue" | "stop"> => {
      if (this.hookError !== null) return "stop";
      try {
        if (await deps.stopRequested()) {
          stop.cause = "cancelled_by_user";
          return "stop";
        }
        if (deps.now().getTime() + plan.limits.timeout_s * 1000 > this.deadlineMs) {
          stop.cause = "time_limit";
          return "stop";
        }
        return "continue";
      } catch (error) {
        this.hookError = { error };
        return "stop";
      }
    };
    const onCopy = async (record: CopyRecord): Promise<void> => {
      if (this.hookError !== null) return;
      try {
        copies += 1;
        const records = byState[record.state];
        records.push(record);
        if (records.length === protocol.per_state[record.state].copies && !emitted.has(record.state)) {
          let cells: Record<CheckSet, CellObservation> | null = null;
          try {
            cells = adapter.interpret(records, protocol);
          } catch (error) {
            // The harness's own matrix supplies these cells after it returns.
            this.note(`reading the ${record.state} cells of candidate ${candidate.candidate_id}`, error);
          }
          if (cells !== null) await emitCells(record.state, cells);
        }
        await this.budgetChanged(`cand:${candidate.candidate_id}:copy-${String(copies)}:budget`, "a finished copy");
      } catch (error) {
        this.hookError = { error };
      }
    };

    let result: HarnessResult;
    try {
      result = await deps.qualify({ entry, adapter, beforeCopy, onCopy });
    } catch (error) {
      // Every harness rejection is an uncertain provider outcome (a runner rejection passed through).
      this.note(`export verification of candidate ${candidate.candidate_id}`, error);
      return { kind: "uncertain" };
    }
    if (this.hookError !== null) {
      // A read between copies failed, so the harness stopped; every copy it ran has a definite outcome,
      // so the candidate ends incomplete and settles, and the request finishes operational_error.
      this.note(`a check between copies of candidate ${candidate.candidate_id}`, this.hookError.error);
      await this.append(candidateEnded(candidate, "incomplete_run", this.at(), "Incomplete: an internal check between copies failed, so this candidate was stopped. It is not reproduction and was not retried."));
      return { kind: "failed" };
    }
    const { matrix } = result;
    if (matrix !== null) {
      for (const state of COPY_STATE_VALUES) {
        if (!emitted.has(state) && result.records.some((record) => record.state === state)) {
          await emitCells(state, { original_suite: matrix.original_suite[state], verification: matrix.verification[state] });
        }
      }
    }

    const caseIdValue = caseId({ defect_id: candidate.defect_id, entry, criteria_catalog_version: deps.catalog.criteria_catalog_version });
    const demonstrated = demonstratedCriteria(deps.catalog, entry.bug_type_id, matrix?.verification.buggy.failure_codes ?? []);
    const demonstratedIds = demonstrated.map((criterion) => criterion.criterion_id);
    const criteria = bugTypeOf(deps.catalog, entry.bug_type_id).criteria.map((criterion) => ({ criterion_id: criterion.criterion_id, matched: demonstratedIds.includes(criterion.criterion_id) }));
    const verdict = cellVerdict({ matrix, records: result.records, stopped: result.stopped, integrity: result.integrity });
    if (verdict.kind === "ended") {
      const cause = stop.cause;
      const reason = verdict.reason === "stopped" && cause === null ? "incomplete_run" : verdict.reason;
      await this.append(candidateEnded(candidate, reason, this.at()));
      return verdict.reason === "stopped" && cause !== null ? { kind: "stop", stop_code: cause } : { kind: "done" };
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
    if (packages.bug_case.sha256 !== result.package_sha256.bug_case) {
      // The stored bug case must be the exact archive that export verification ran on.
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
