// The spend side of every factory copy, apart from how a runner places files and runs the copy.
// The hosted `sandbox` runner uses it; a local runner (the harness's docker runner) needs the same
// glue at integration. As the judge controller does for its copies: refuse a copy whose limits
// exceed its host's copy limits or that would not end before the deadline; check for a stop; move
// the copy's operation to launching under the factory slot; when the provider has created the
// sandbox, record it as running (a slot child); after the run, confirm the stop and settle the
// measured lifetime. A launch that rejects, a stop that cannot be confirmed, or a ledger call that
// fails is uncertain: it is never retried, keeps its reservation and the slot held, and no later
// copy of this meter starts.
//
// A request candidate's copies are reserved at its selection (contract section 8.5: its worst case
// is reserved from selection until it settles): reserveCandidate reserves one operation per copy
// of the candidate's protocol on the request budget, run() launches them one at a time, and
// settleCandidate, when the candidate ends, cancels each one that never launched through launching
// and terminal to a settlement at zero. A copy that has no reserved operation does not start.
//
// A validation run reserves its copies with its own operation at its accepted POST, so in
// `child_of` mode each copy is recorded and confirmed as a child resource of that operation and
// its lifetime is kept for the run's settlement. Copies run one at a time: a second run() waits
// until the first has settled. The meter appends no events: the factory core's loop appends the
// request's budget_updated after each copy.
import type { Rates } from "@rbw/envelope";
import type { CopyState, HostId, Protocol } from "@rbw/factory-contract";
import { canonicalDigest } from "@rbw/schema";
import type { Evidence } from "@rbw/spend";
import { FACTORY_KIND, WORKER_ACTOR, copyExecution, copyOperation, copySandboxName, copySettlementFor, makeUncertain, zeroSettlement } from "./factory-ledger.ts";
import type { FactoryOperation, SandboxUsage } from "./factory-ledger.ts";
import { FACTORY_PROFILE } from "./factory-profile.ts";
import type { FactoryProfile } from "./factory-profile.ts";
import type { BudgetRole, FactoryIdentity, FactoryLedger } from "./factory-ports.ts";

export interface MeterContext {
  ledger: FactoryLedger;
  identity: Pick<FactoryIdentity, "project_id" | "copyExecutionId">;
  rates: Rates;
  now: () => Date;
  /** The request root or the validation root. */
  root: string;
  /** Which of the two the root is, for the copies' execution IDs. */
  kind: "request" | "validation";
  /** The request's interpretation_sha256, or the validation's case_id. */
  task_revision: string;
  budget_key: string;
  /** `vercel-sandbox` for hosted copies; `docker` for local proofs. */
  provider: string;
  /** No copy starts unless its timeout, the shutdown allowance and margin_s end by this time. */
  deadline: Date;
  margin_s: number;
  /** child_of: `max_copies` is the run's reservation's copy count, from its package's protocol. */
  mode: { kind: "own_operation"; role: BudgetRole } | { kind: "child_of"; operation_id: string; max_copies: number };
  /** Checked before each copy, before it launches: false stops it. */
  beforeLaunch?: () => Promise<boolean>;
  /** True once the request was finished elsewhere: settleCandidate then cancels nothing and leaves the reservations for reconciliation. */
  fenced?: () => Promise<boolean>;
  log: (line: string) => void;
  profile?: FactoryProfile;
}

/** What the meter needs of a copy plan: the subject (candidate_id or case_id), host, state and limits. */
export interface MeteredCopyPlan {
  subject: string;
  host: HostId;
  state: CopyState;
  limits: { timeout_s: number; vcpus: number; memory_mb: number };
}

export interface LaunchHooks {
  /** The runner calls this right after the provider created the copy's resource. */
  created(resourceId: string): Promise<void>;
}

/** What a runner reports after a definite outcome. A runner rejects only for an uncertain provider outcome. */
export interface LaunchReport<R> {
  result: R;
  created: boolean;
  /** From the create call to the confirmed stop. */
  lifetime_ms: number;
  stop_confirmed: boolean;
  status: "completed" | "failed";
  /** The vCPUs the copy's sandbox was created with (2 GB of memory each); absent, its host's whole copy size is settled. */
  vcpus?: number;
}

/** limits_exceed_profile also covers a request copy that has no reserved operation (beyond its candidate's protocol). */
export type RefusalReason = "limits_exceed_profile" | "no_time" | "stopped" | "halted" | "uncertain";

/** A candidate's reservation at its selection: its whole worst case, or refused by the request budget, the factory pool or a halt. */
export type CandidateReservation = { kind: "reserved"; reserved_microusd: number } | { kind: "refused"; reason: "budget" | "pool" | "halted"; detail: string };

/** A candidate's end: what its copies settled at, and how many unused copies were cancelled at zero. */
export interface CandidateSettlement {
  settled_microusd: number;
  cancelled: number;
}

const STATES: readonly CopyState[] = ["clean", "buggy", "fixed"];

interface ReservedCopy {
  op: FactoryOperation;
  launched: boolean;
  settled_microusd: number | null;
}

interface Candidate {
  host: HostId;
  /** By `<state>-<n>`. */
  copies: Map<string, ReservedCopy>;
  ended: boolean;
}

export type MeteredOutcome<R> =
  | { kind: "ran"; result: R; operation_id: string | null; execution_id: string; settled_microusd: number | null; over_envelope: boolean }
  | { kind: "refused"; reason: RefusalReason; detail: string }
  | { kind: "uncertain"; operation_id: string | null; execution_id: string; detail: string };

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "non-error";
}

export class CopyMeter {
  /** Child mode: each created copy's lifetime, for the validation run's settlement. */
  readonly usage: SandboxUsage[] = [];
  private readonly ctx: MeterContext;
  private readonly profile: FactoryProfile;
  private readonly counters = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private running = false;
  private uncertainSeen = false;
  /** Set when a settlement exceeded its envelope, which halts the spend ledger: no further copy starts. */
  private halted = false;
  /** Child mode: copies created so far; a validation run's reservation is priced for its package's copies. */
  private childLaunches = 0;
  private refused: { reason: RefusalReason; detail: string } | null = null;
  /** Request mode: each selected candidate's reserved copies. */
  private readonly candidates = new Map<string, Candidate>();

  constructor(ctx: MeterContext) {
    this.ctx = ctx;
    this.profile = ctx.profile ?? FACTORY_PROFILE;
  }

  /** True once any copy's outcome was uncertain: the caller stops with needs_reconciliation. */
  get uncertain(): boolean {
    return this.uncertainSeen;
  }

  /** True while a copy is between its reservation and its settlement. */
  get active(): boolean {
    return this.running;
  }

  /**
   * The most recent copy this meter did not start, and why, or null. A runner reports a refused
   * copy as a copy result (setup_failed or timed_out), so a loop that must tell a stop, the deadline
   * or a halt from a failed copy reads it here.
   */
  get lastRefusal(): { reason: RefusalReason; detail: string } | null {
    return this.refused;
  }

  /** Runs one copy through `launch`, after every copy started earlier has settled. */
  run<R>(plan: MeteredCopyPlan, launch: (sandboxName: string, hooks: LaunchHooks) => Promise<LaunchReport<R>>): Promise<MeteredOutcome<R>> {
    return this.serial(() => this.runOne(plan, launch));
  }

  /**
   * At a candidate's selection: reserves one operation per copy of its protocol on the request
   * budget, each at its host's copy envelope, so the candidate's whole worst case is reserved until
   * it ends. A refusal (the budget, the pool or a halt) cancels what this call reserved, at zero, and
   * reserves nothing. Rejects, and is then uncertain, when a ledger call fails, when an operation of
   * the candidate already existed (it is never reserved or launched twice) or when
   * `worst_case_microusd`, as the caller priced the candidate, differs from its copies' total.
   */
  reserveCandidate(input: { candidate_id: string; host_id: HostId; protocol: Pick<Protocol, "per_state">; worst_case_microusd?: number }): Promise<CandidateReservation> {
    return this.serial(() => this.reserveOne(input));
  }

  /**
   * When a candidate ends: cancels each of its reserved copies that never launched through
   * launching and terminal to a settlement at zero, so nothing of it stays reserved. Rejects, and is
   * then uncertain, when a cancellation is refused or fails (that reservation stays held for
   * reconciliation), and, cancelling nothing, once the request was finished elsewhere. A repeat
   * after a refused or failed cancellation cancels the copies that still never launched and skips
   * the one that failed; once the candidate ended, repeating it changes nothing.
   */
  settleCandidate(input: { candidate_id: string }): Promise<CandidateSettlement> {
    return this.serial(() => this.settleOne(input.candidate_id));
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const next = this.queue.then(step);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private refusal(plan: MeteredCopyPlan): { reason: RefusalReason; detail: string } | null {
    if (this.uncertainSeen) return { reason: "uncertain", detail: "an earlier outcome is uncertain; no further copy starts" };
    if (this.halted) return { reason: "halted", detail: "an earlier copy settled over its envelope, which halts new work" };
    const limits = this.profile.copy[plan.host];
    if (plan.limits.timeout_s > limits.timeout_s || plan.limits.vcpus > limits.vcpus || plan.limits.memory_mb > limits.memory_mb) {
      return { reason: "limits_exceed_profile", detail: `the plan's limits exceed ${plan.host}'s copy limits (${String(limits.vcpus)} vCPU, ${String(limits.memory_mb)} MB, ${String(limits.timeout_s)} s)` };
    }
    if (this.ctx.mode.kind === "child_of" && this.childLaunches >= this.ctx.mode.max_copies) {
      return { reason: "limits_exceed_profile", detail: `this validation run's package declares ${String(this.ctx.mode.max_copies)} copies, so it starts no more` };
    }
    const ends = this.ctx.now().getTime() + (plan.limits.timeout_s + this.profile.shutdown_seconds + this.ctx.margin_s) * 1000;
    if (ends > this.ctx.deadline.getTime()) return { reason: "no_time", detail: "the copy would not end before the deadline" };
    return null;
  }

  /**
   * The lifetime a copy settles: as measured, but never past its sandbox's provider timeout (its
   * timeout plus the shutdown allowance), which the provider enforces; the client's measurement
   * also counts the create call and the status checks after the stop.
   */
  private settledLifetime(plan: MeteredCopyPlan, measuredMs: number): number {
    return Math.min(Math.max(0, measuredMs), (plan.limits.timeout_s + this.profile.shutdown_seconds) * 1000);
  }

  private nextN(plan: MeteredCopyPlan): number {
    const key = `${plan.subject}:${plan.state}`;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n;
  }

  private refuse<R>(refusal: { reason: RefusalReason; detail: string }): MeteredOutcome<R> {
    this.refused = refusal;
    return { kind: "refused", ...refusal };
  }

  private async runOne<R>(plan: MeteredCopyPlan, launch: (sandboxName: string, hooks: LaunchHooks) => Promise<LaunchReport<R>>): Promise<MeteredOutcome<R>> {
    const refused = this.refusal(plan);
    if (refused !== null) return this.refuse(refused);
    if (this.ctx.beforeLaunch !== undefined && !(await this.ctx.beforeLaunch())) return this.refuse({ reason: "stopped", detail: "a stop was recorded or the run was finished elsewhere" });
    const { mode } = this.ctx;
    if (mode.kind === "child_of") return this.whileActive(() => this.childOf(plan, this.nextN(plan), mode.operation_id, launch));
    const own = this.reservedCopy(plan);
    if (own === null) return this.refuse({ reason: "limits_exceed_profile", detail: `no operation is reserved for this ${plan.state} copy of ${plan.subject} (its candidate's protocol has no more)` });
    return this.whileActive(() => {
      this.nextN(plan);
      return this.ownOperation(plan, own, launch);
    });
  }

  /** Runs one copy's steps with the meter active. */
  private async whileActive<T>(steps: () => Promise<T>): Promise<T> {
    this.running = true;
    try {
      return await steps();
    } finally {
      this.running = false;
    }
  }

  /** The candidate's reserved copy this run would launch (the next of its state), or null. */
  private reservedCopy(plan: MeteredCopyPlan): ReservedCopy | null {
    const candidate = this.candidates.get(plan.subject);
    if (candidate === undefined || candidate.ended || candidate.host !== plan.host) return null;
    const n = (this.counters.get(`${plan.subject}:${plan.state}`) ?? 0) + 1;
    const copy = candidate.copies.get(`${plan.state}-${String(n)}`);
    return copy === undefined || copy.launched ? null : copy;
  }

  private async reserveOne(input: { candidate_id: string; host_id: HostId; protocol: Pick<Protocol, "per_state">; worst_case_microusd?: number }): Promise<CandidateReservation> {
    const { mode } = this.ctx;
    if (mode.kind !== "own_operation") throw new Error("a validation run's copies are reserved with the run's own operation");
    if (this.uncertainSeen) throw new Error("an earlier outcome is uncertain; nothing more is reserved");
    const id = input.candidate_id;
    if (this.candidates.has(id)) throw new Error(`candidate ${id} was reserved already; it is never reserved twice`);
    const planned: { key: string; op: FactoryOperation }[] = [];
    for (const state of STATES) {
      const copies = input.protocol.per_state[state].copies;
      if (!Number.isSafeInteger(copies) || copies < 1) throw new Error(`the candidate's protocol must declare a positive whole number of ${state} copies`);
      for (let n = 1; n <= copies; n += 1) {
        const op = copyOperation(
          { identity: this.ctx.identity, rates: this.ctx.rates, profile: this.profile },
          { kind: this.ctx.kind, root: this.ctx.root, task_revision: this.ctx.task_revision, subject: id, state, n, host: input.host_id, provider: this.ctx.provider },
        );
        planned.push({ key: `${state}-${String(n)}`, op });
      }
    }
    const total = planned.reduce((sum, copy) => sum + copy.op.envelope.reserved_microusd, 0n);
    if (input.worst_case_microusd !== undefined && BigInt(input.worst_case_microusd) !== total) {
      throw new Error(`the candidate's worst case of ${String(input.worst_case_microusd)} µUSD differs from its copies' ${String(total)} µUSD`);
    }
    const candidate: Candidate = { host: input.host_id, copies: new Map(), ended: false };
    this.candidates.set(id, candidate);
    try {
      for (const copy of planned) {
        const reserved = await this.ctx.ledger.budgets.reserve(this.ctx.budget_key, mode.role, copy.op.request);
        if (!reserved.ok) {
          for (const done of candidate.copies.values()) await this.cancel(done.op);
          candidate.ended = true;
          const reason = reserved.code === "pool_halted" ? "halted" : reserved.code === "insufficient_funds" ? "pool" : "budget";
          return { kind: "refused", reason, detail: `the reservation of ${copy.op.call_name} was refused (${reserved.code})` };
        }
        if (reserved.replay) throw new Error(`the operation of ${copy.op.call_name} already existed, so it is not reserved or launched again`);
        candidate.copies.set(copy.key, { op: copy.op, launched: false, settled_microusd: null });
      }
    } catch (error) {
      this.uncertainSeen = true;
      this.ctx.log(`candidate ${id} uncertain: its reservation failed (${message(error)})`);
      throw error;
    }
    return { kind: "reserved", reserved_microusd: Number(total) };
  }

  private async settleOne(id: string): Promise<CandidateSettlement> {
    const candidate = this.candidates.get(id);
    if (candidate === undefined) throw new Error(`candidate ${id} has no reservation`);
    const settled = (): number => [...candidate.copies.values()].reduce((sum, copy) => sum + (copy.settled_microusd ?? 0), 0);
    if (candidate.ended) return { settled_microusd: settled(), cancelled: 0 };
    if (this.ctx.fenced !== undefined && (await this.ctx.fenced())) throw new Error("the request was finished elsewhere; the candidate's reservations are left for reconciliation");
    let cancelled = 0;
    try {
      for (const copy of candidate.copies.values()) {
        if (copy.launched) continue;
        copy.launched = true;
        await this.cancel(copy.op);
        copy.settled_microusd = 0;
        cancelled += 1;
      }
    } catch (error) {
      this.uncertainSeen = true;
      this.ctx.log(`candidate ${id} uncertain: an unused copy could not be cancelled (${message(error)})`);
      throw error;
    }
    candidate.ended = true;
    return { settled_microusd: settled(), cancelled };
  }

  /** An unused reserved copy, ended without a launch: launching, terminal cancelled, settled at zero. */
  private async cancel(op: FactoryOperation): Promise<void> {
    const { spend } = this.ctx.ledger;
    const id = op.operation_id;
    const launching = await spend.transition({ operation_id: id, from_state: "prepared", to_state: "launching", actor_role: WORKER_ACTOR, slot_key: this.profile.slot_key });
    if (!launching.ok) throw new Error(`the cancellation of ${op.call_name} was refused (${launching.code})`);
    const ended = await spend.transition({ operation_id: id, from_state: "launching", to_state: "terminal", actor_role: WORKER_ACTOR, terminal_status: "cancelled" });
    if (!ended.ok) throw new Error(`the end of ${op.call_name} was refused (${ended.code})`);
    const settled = await spend.settle(zeroSettlement(op.envelope, id));
    if (!settled.ok) throw new Error(`the zero settlement of ${op.call_name} was refused (${settled.code})`);
  }

  private uncertainOutcome<R>(operationId: string | null, executionId: string, detail: string): MeteredOutcome<R> {
    this.uncertainSeen = true;
    this.ctx.log(`copy ${executionId} uncertain: ${detail}`);
    return { kind: "uncertain", operation_id: operationId, execution_id: executionId, detail };
  }

  /**
   * A ledger call threw, so whether it took effect is unknown: the copy is uncertain, and its
   * operation goes to uncertain where it is launching or running (best effort; a failure is logged).
   */
  private async ledgerFailed<R>(operationId: string | null, executionId: string, error: unknown): Promise<MeteredOutcome<R>> {
    if (operationId !== null) {
      try {
        await makeUncertain(this.ctx.ledger.spend, operationId, WORKER_ACTOR);
      } catch (moveError) {
        this.ctx.log(`copy ${executionId}: its operation could not be moved to uncertain (${message(moveError)})`);
      }
    }
    return this.uncertainOutcome(operationId, executionId, `a ledger call failed (${message(error)}); the copy needs reconciliation`);
  }

  private stopEvidence(executionId: string, resource: string, lifetimeMs: number, status: string): Evidence {
    return { key: `factory/${this.ctx.root}/stops/${executionId}.json`, sha256: canonicalDigest({ execution_id: executionId, resource_id: resource, lifetime_ms: lifetimeMs, status }).sha256 };
  }

  private async ownOperation<R>(plan: MeteredCopyPlan, copy: ReservedCopy, launch: (sandboxName: string, hooks: LaunchHooks) => Promise<LaunchReport<R>>): Promise<MeteredOutcome<R>> {
    copy.launched = true;
    try {
      const outcome = await this.ownSteps(plan, copy.op, launch);
      if (outcome.kind === "ran") copy.settled_microusd = outcome.settled_microusd;
      return outcome;
    } catch (error) {
      return this.ledgerFailed(copy.op.operation_id, copy.op.execution_id, error);
    }
  }

  /** The copy's reserved operation, from prepared: launching, the launch, running, then the confirmed stop and the settlement. */
  private async ownSteps<R>(plan: MeteredCopyPlan, op: FactoryOperation, launch: (sandboxName: string, hooks: LaunchHooks) => Promise<LaunchReport<R>>): Promise<MeteredOutcome<R>> {
    const { ledger } = this.ctx;
    const id = op.operation_id;
    const launching = await ledger.spend.transition({ operation_id: id, from_state: "prepared", to_state: "launching", actor_role: WORKER_ACTOR, slot_key: this.profile.slot_key });
    if (!launching.ok) return this.uncertainOutcome(id, op.execution_id, `the launch was refused (${launching.code}); the reservation needs reconciliation`);
    const seen: { resource: string | null } = { resource: null };
    const toUncertain = async (from: "launching" | "running", detail: string): Promise<MeteredOutcome<R>> => {
      const moved = await ledger.spend.transition({ operation_id: id, from_state: from, to_state: "uncertain", actor_role: WORKER_ACTOR, uncertainty: from === "launching" ? "lost_response" : "unknown_status" });
      return this.uncertainOutcome(id, op.execution_id, moved.ok ? detail : `${detail}; the uncertain transition was refused (${moved.code})`);
    };
    let report: LaunchReport<R>;
    try {
      report = await launch(op.sandbox_name, {
        created: async (resource) => {
          const running = await ledger.spend.transition({ operation_id: id, from_state: "launching", to_state: "running", actor_role: WORKER_ACTOR, provider_resource_id: resource });
          if (!running.ok) throw new Error(`the running transition was refused (${running.code})`);
          seen.resource = resource;
        },
      });
    } catch (error) {
      return toUncertain(seen.resource === null ? "launching" : "running", message(error));
    }

    if (seen.resource === null) {
      if (report.created) return toUncertain("launching", "the runner reported a resource it never recorded");
      const ended = await ledger.spend.transition({ operation_id: id, from_state: "launching", to_state: "terminal", actor_role: WORKER_ACTOR, terminal_status: "cancelled" });
      if (!ended.ok) return this.uncertainOutcome(id, op.execution_id, `the end was refused (${ended.code})`);
      const settled = await ledger.spend.settle(zeroSettlement(op.envelope, id));
      if (!settled.ok) return this.uncertainOutcome(id, op.execution_id, `the settlement was refused (${settled.code})`);
      return { kind: "ran", result: report.result, operation_id: id, execution_id: op.execution_id, settled_microusd: 0, over_envelope: false };
    }
    const resource = seen.resource;
    if (!report.stop_confirmed) return toUncertain("running", "the copy's stop could not be confirmed");
    const evidence = this.stopEvidence(op.execution_id, resource, report.lifetime_ms, report.status);
    const child = await ledger.spend.confirmChild({ slot_key: this.profile.slot_key, root_execution_id: this.ctx.root, provider: this.ctx.provider, resource_id: resource, terminal_status: report.status, evidence, actor_role: WORKER_ACTOR });
    if (!child.ok) return this.uncertainOutcome(id, op.execution_id, `the stop confirmation was refused (${child.code})`);
    const ended = await ledger.spend.transition({ operation_id: id, from_state: "running", to_state: "terminal", actor_role: WORKER_ACTOR, terminal_status: report.status });
    if (!ended.ok) return this.uncertainOutcome(id, op.execution_id, `the end was refused (${ended.code})`);
    const usage = { launched: true, lifetime_ms: this.settledLifetime(plan, report.lifetime_ms), ...(report.vcpus === undefined ? {} : { vcpus: report.vcpus }) };
    const settled = await ledger.spend.settle(copySettlementFor(op.envelope, id, plan.host, usage, evidence, this.profile));
    if (!settled.ok) return this.uncertainOutcome(id, op.execution_id, `the settlement was refused (${settled.code})`);
    if (settled.over_envelope) this.halted = true;
    return { kind: "ran", result: report.result, operation_id: id, execution_id: op.execution_id, settled_microusd: Number(settled.settled_microusd), over_envelope: settled.over_envelope };
  }

  private async childOf<R>(plan: MeteredCopyPlan, n: number, parent: string, launch: (sandboxName: string, hooks: LaunchHooks) => Promise<LaunchReport<R>>): Promise<MeteredOutcome<R>> {
    const execution = copyExecution(this.ctx.identity, { kind: this.ctx.kind, root: this.ctx.root, subject: plan.subject, state: plan.state, n });
    try {
      return await this.childSteps(plan, execution, parent, launch);
    } catch (error) {
      // The run's own operation is moved to uncertain by the validation worker, which reads `uncertain`.
      return this.ledgerFailed(null, execution, error);
    }
  }

  private async childSteps<R>(plan: MeteredCopyPlan, execution: string, parent: string, launch: (sandboxName: string, hooks: LaunchHooks) => Promise<LaunchReport<R>>): Promise<MeteredOutcome<R>> {
    const { spend } = this.ctx.ledger;
    const seen: { resource: string | null } = { resource: null };
    let report: LaunchReport<R>;
    try {
      report = await launch(copySandboxName(execution), {
        created: async (resource) => {
          this.childLaunches += 1;
          const child = await spend.recordChild({ slot_key: this.profile.slot_key, root_execution_id: this.ctx.root, provider: this.ctx.provider, resource_id: resource, operation_id: parent, execution_id: execution, kind: FACTORY_KIND.copy, actor_role: WORKER_ACTOR });
          if (!child.ok) throw new Error(`the copy's resource could not be recorded (${child.code})`);
          seen.resource = resource;
        },
      });
    } catch (error) {
      return this.uncertainOutcome(null, execution, message(error));
    }
    if (seen.resource === null) {
      if (report.created) return this.uncertainOutcome(null, execution, "the runner reported a resource it never recorded");
      return { kind: "ran", result: report.result, operation_id: null, execution_id: execution, settled_microusd: null, over_envelope: false };
    }
    const resource = seen.resource;
    if (!report.stop_confirmed) return this.uncertainOutcome(null, execution, "the copy's stop could not be confirmed");
    const evidence = this.stopEvidence(execution, resource, report.lifetime_ms, report.status);
    const confirmed = await spend.confirmChild({ slot_key: this.profile.slot_key, root_execution_id: this.ctx.root, provider: this.ctx.provider, resource_id: resource, terminal_status: report.status, evidence, actor_role: WORKER_ACTOR });
    if (!confirmed.ok) return this.uncertainOutcome(null, execution, `the stop confirmation was refused (${confirmed.code})`);
    this.usage.push({ launched: true, lifetime_ms: this.settledLifetime(plan, report.lifetime_ms), ...(report.vcpus === undefined ? {} : { vcpus: report.vcpus }) });
    return { kind: "ran", result: report.result, operation_id: null, execution_id: execution, settled_microusd: null, over_envelope: false };
  }
}
