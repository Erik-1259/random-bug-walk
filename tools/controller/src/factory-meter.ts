// The spend side of every factory copy, apart from how a runner places files and runs the copy, so
// the hosted `sandbox` runner and a metered local runner share one ledger path. As the judge
// controller does for its copies: refuse a copy whose limits exceed its host's copy limits or that
// would not end before the deadline; check for a stop; reserve the copy's envelope on the request
// budget; move it to launching under the factory slot; when the provider has created the sandbox,
// record it as running (a slot child); after the run, confirm the stop and settle the measured
// lifetime. A launch that rejects, or a stop that cannot be confirmed, is uncertain: it is never
// retried, keeps its reservation and the slot held, and no later copy of this meter starts.
//
// A validation run reserves its copies with its own operation at its accepted POST, so in
// `child_of` mode each copy is recorded and confirmed as a child resource of that operation and
// its lifetime is kept for the run's settlement. Copies run one at a time: a second run() waits
// until the first has settled.
import type { Rates } from "@rbw/envelope";
import type { CopyState, HostId } from "@rbw/factory-contract";
import { canonicalDigest } from "@rbw/schema";
import type { Evidence } from "@rbw/spend";
import { FACTORY_KIND, WORKER_ACTOR, copyExecutionId, copyOperation, copySandboxName, copySettlementFor, usd, zeroSettlement } from "./factory-ledger.ts";
import type { FactoryOperation, SandboxUsage } from "./factory-ledger.ts";
import { FACTORY_PROFILE } from "./factory-profile.ts";
import type { FactoryProfile } from "./factory-profile.ts";
import type { BudgetRole, FactoryIdentity, FactoryLedger } from "./factory-ports.ts";

export interface MeterContext {
  ledger: FactoryLedger;
  identity: Pick<FactoryIdentity, "project_id">;
  rates: Rates;
  now: () => Date;
  /** The request root or the validation root. */
  root: string;
  /** That root's UUIDv5 namespace, for the copies' execution IDs. */
  namespace: string;
  /** The request's interpretation_sha256, or the validation's case_id. */
  task_revision: string;
  budget_key: string;
  /** `vercel-sandbox` for hosted copies; `docker` for local proofs. */
  provider: string;
  /** No copy starts unless its timeout, the shutdown allowance and margin_s end by this time. */
  deadline: Date;
  margin_s: number;
  mode: { kind: "own_operation"; role: BudgetRole } | { kind: "child_of"; operation_id: string };
  /** Checked before each copy, before anything is reserved: false stops it. */
  beforeLaunch?: () => Promise<boolean>;
  /** Told after a reservation or a settlement changed the budget (own_operation mode), with a deterministic event key. */
  onBudgetChange?: (eventKey: string, message: string) => Promise<void>;
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

export type RefusalReason = "limits_exceed_profile" | "no_time" | "stopped" | "budget" | "halted" | "uncertain";

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
  /** Child mode: copies created so far; a validation run's reservation is priced for its host's most copies. */
  private childLaunches = 0;

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

  /** Runs one copy through `launch`, after every copy started earlier has settled. */
  run<R>(plan: MeteredCopyPlan, launch: (sandboxName: string, hooks: LaunchHooks) => Promise<LaunchReport<R>>): Promise<MeteredOutcome<R>> {
    const next = this.queue.then(() => this.runOne(plan, launch));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private refusal(plan: MeteredCopyPlan): { reason: RefusalReason; detail: string } | null {
    if (this.uncertainSeen) return { reason: "uncertain", detail: "an earlier copy's outcome is uncertain; no further copy starts" };
    if (this.halted) return { reason: "halted", detail: "an earlier copy settled over its envelope, which halts new work" };
    const limits = this.profile.copy[plan.host];
    if (plan.limits.timeout_s > limits.timeout_s || plan.limits.vcpus > limits.vcpus || plan.limits.memory_mb > limits.memory_mb) {
      return { reason: "limits_exceed_profile", detail: `the plan's limits exceed ${plan.host}'s copy limits (${String(limits.vcpus)} vCPU, ${String(limits.memory_mb)} MB, ${String(limits.timeout_s)} s)` };
    }
    if (this.ctx.mode.kind === "child_of" && this.childLaunches >= this.profile.validation.max_copies[plan.host]) {
      return { reason: "limits_exceed_profile", detail: `a validation run of a ${plan.host} case starts at most ${String(this.profile.validation.max_copies[plan.host])} copies` };
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

  private async runOne<R>(plan: MeteredCopyPlan, launch: (sandboxName: string, hooks: LaunchHooks) => Promise<LaunchReport<R>>): Promise<MeteredOutcome<R>> {
    const refused = this.refusal(plan);
    if (refused !== null) return { kind: "refused", ...refused };
    if (this.ctx.beforeLaunch !== undefined && !(await this.ctx.beforeLaunch())) return { kind: "refused", reason: "stopped", detail: "a stop was recorded or the run was finished elsewhere" };
    this.running = true;
    try {
      const n = this.nextN(plan);
      return this.ctx.mode.kind === "own_operation" ? await this.ownOperation(plan, n, this.ctx.mode.role, launch) : await this.childOf(plan, n, this.ctx.mode.operation_id, launch);
    } finally {
      this.running = false;
    }
  }

  private uncertainOutcome<R>(operationId: string | null, executionId: string, detail: string): MeteredOutcome<R> {
    this.uncertainSeen = true;
    this.ctx.log(`copy ${executionId} uncertain: ${detail}`);
    return { kind: "uncertain", operation_id: operationId, execution_id: executionId, detail };
  }

  private stopEvidence(executionId: string, resource: string, lifetimeMs: number, status: string): Evidence {
    return { key: `factory/${this.ctx.root}/stops/${executionId}.json`, sha256: canonicalDigest({ execution_id: executionId, resource_id: resource, lifetime_ms: lifetimeMs, status }).sha256 };
  }

  private async ownOperation<R>(plan: MeteredCopyPlan, n: number, role: BudgetRole, launch: (sandboxName: string, hooks: LaunchHooks) => Promise<LaunchReport<R>>): Promise<MeteredOutcome<R>> {
    const { ledger } = this.ctx;
    const op: FactoryOperation = copyOperation(
      { identity: this.ctx.identity, rates: this.ctx.rates, profile: this.profile },
      { namespace: this.ctx.namespace, root: this.ctx.root, task_revision: this.ctx.task_revision, subject: plan.subject, state: plan.state, n, host: plan.host, provider: this.ctx.provider },
    );
    const id = op.operation_id;
    const reserved = await ledger.budgets.reserve(this.ctx.budget_key, role, op.request);
    if (!reserved.ok) {
      if (reserved.code === "pool_halted") return { kind: "refused", reason: "halted", detail: "the spend ledger is halted" };
      return { kind: "refused", reason: "budget", detail: `the copy's reservation was refused (${reserved.code})` };
    }
    if (reserved.replay) return this.uncertainOutcome(id, op.execution_id, "the copy's operation already existed, so it was not launched again");
    await this.ctx.onBudgetChange?.(`copy:${id}:reserved`, `Reserved ${usd(reserved.reserved_microusd)} for one ${plan.host} copy.`);
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
      await this.ctx.onBudgetChange?.(`copy:${id}:settled`, `A ${plan.host} copy that never started settled at $0.00.`);
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
    await this.ctx.onBudgetChange?.(`copy:${id}:settled`, `A ${plan.host} copy settled at ${usd(settled.settled_microusd)}.`);
    return { kind: "ran", result: report.result, operation_id: id, execution_id: op.execution_id, settled_microusd: Number(settled.settled_microusd), over_envelope: settled.over_envelope };
  }

  private async childOf<R>(plan: MeteredCopyPlan, n: number, parent: string, launch: (sandboxName: string, hooks: LaunchHooks) => Promise<LaunchReport<R>>): Promise<MeteredOutcome<R>> {
    const { spend } = this.ctx.ledger;
    const execution = copyExecutionId({ namespace: this.ctx.namespace, root: this.ctx.root, subject: plan.subject, state: plan.state, n });
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
