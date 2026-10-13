// The UC1 spend guard (pre-registration, "Caps"): no billable operation (a model call, a regrade or
// a rerun) starts unless its worst-case cost fits the remaining UC1 allowance, which is the cap
// minus settled spend minus every open reservation under the UC1 roots. The check and the start
// run under one lock, so sessions running at once cannot carry the run past the cap. A halted pool
// or an uncertain operation under the roots stops the run, as an allowance that does not fit does;
// after a stop nothing billable starts in this process.
import type { Refusal, ReserveRequest, Reservation, Result, Spend, SqlClient } from "@rbw/spend";
import { lineWorstCase } from "@rbw/writer";

/** What the ledger holds under the UC1 roots. */
export interface LedgerView {
  settled_microusd: bigint;
  open_microusd: bigint;
  /** Operations under the roots in the `uncertain` state. */
  uncertain: string[];
  halted: boolean;
}

export interface AllowanceSource {
  view(roots: readonly string[]): Promise<LedgerView>;
}

export type StopReason = "allowance_exceeded" | "ledger_uncertain" | "ledger_halted";

export interface AllowanceStop {
  reason: StopReason;
  detail: string;
}

export type Decision = { ok: true; remaining_microusd: bigint; view: LedgerView } | ({ ok: false } & AllowanceStop);

/** The worst case of a reservation request: each line at its limit, as the ledger computes it. */
export function requestWorstCase(request: Pick<ReserveRequest, "envelope">): bigint {
  return request.envelope.reduce((sum, line) => sum + BigInt(lineWorstCase(line)), 0n);
}

export class Allowance {
  readonly cap_microusd: bigint;
  private readonly source: AllowanceSource;
  private readonly roots: () => readonly string[];
  private readonly pending = new Map<string, bigint>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped: AllowanceStop | null = null;

  constructor(source: AllowanceSource, capMicrousd: bigint, roots: () => readonly string[]) {
    this.source = source;
    this.cap_microusd = capMicrousd;
    this.roots = roots;
  }

  /** The first stop, or null while the run may go on. */
  get stop(): AllowanceStop | null {
    return this.stopped;
  }

  /** Runs `call` after every earlier exclusive call has settled. */
  exclusive<T>(call: () => Promise<T>): Promise<T> {
    const next = this.queue.then(call, call);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Reads the ledger and decides whether `worstCase` fits. Call it inside exclusive(); a refusal stops
   * the run. `own` names the hold the operation draws on (a rerun's model call), left out of the sum.
   */
  async decide(worstCase: bigint, own?: string): Promise<Decision> {
    if (this.stopped !== null) return { ok: false, ...this.stopped };
    const view = await this.source.view(this.roots());
    const refuse = (reason: StopReason, detail: string): Decision => {
      this.stopped = { reason, detail };
      return { ok: false, reason, detail };
    };
    if (view.halted) return refuse("ledger_halted", "new work is halted in the spend ledger; reconcile before anything else");
    if (view.uncertain.length > 0) return refuse("ledger_uncertain", `operations under the UC1 roots are uncertain: ${view.uncertain.join(", ")}; reconcile before anything else`);
    const pending = [...this.pending].reduce((sum, [label, value]) => (label === own ? sum : sum + value), 0n);
    const remaining = this.cap_microusd - view.settled_microusd - view.open_microusd - pending;
    if (worstCase > remaining) {
      return refuse("allowance_exceeded", `worst case ${worstCase.toString()} micro-USD does not fit the remaining UC1 allowance of ${remaining.toString()} micro-USD (cap ${this.cap_microusd.toString()}, settled ${view.settled_microusd.toString()}, open ${view.open_microusd.toString()}, starting ${pending.toString()})`);
    }
    return { ok: true, remaining_microusd: remaining, view };
  }

  /** Checks without starting anything (for example before an attempt); a refusal stops the run. */
  check(worstCase: bigint): Promise<Decision> {
    return this.exclusive(() => this.decide(worstCase));
  }

  /**
   * Admits an operation whose whole worst case must fit before it starts (a rerun): if it fits, it
   * counts as open under `label` until release(), so operations starting meanwhile see it.
   */
  admit(label: string, worstCase: bigint): Promise<Decision> {
    return this.exclusive(async () => {
      const decided = await this.decide(worstCase);
      if (decided.ok) this.pending.set(label, worstCase);
      return decided;
    });
  }

  /** Ends a hold; releasing one that is gone does nothing. */
  release(label: string): void {
    this.pending.delete(label);
  }

  /** Shrinks a hold by an amount its operation has now reserved in the ledger, where it counts as open. */
  consume(label: string, amount: bigint): void {
    const held = this.pending.get(label);
    if (held !== undefined) this.pending.set(label, held > amount ? held - amount : 0n);
  }

  /**
   * Starts an operation the ledger does not reserve before it begins (a regrade's controller job): if
   * its worst case fits, it counts as open under `label` until `run` settles.
   */
  async withHold<T>(label: string, worstCase: bigint, run: () => Promise<T>): Promise<{ ok: true; value: T } | ({ ok: false } & AllowanceStop)> {
    const decision = await this.admit(label, worstCase);
    if (!decision.ok) return decision;
    try {
      return { ok: true, value: await run() };
    } finally {
      this.pending.delete(label);
    }
  }
}

/**
 * The solver's ledger with every reservation checked against the allowance first, under the lock: a
 * model call whose worst case does not fit is refused before it is reserved, so it never starts.
 * With `hold` (an admitted rerun's), the call draws on that hold, which shrinks by what it reserves.
 */
export function guardSpend(spend: Spend, allowance: Allowance, hold?: string): Spend {
  return {
    ...spend,
    reserve: (request: ReserveRequest): Promise<Result<Reservation>> =>
      allowance.exclusive(async () => {
        const worstCase = requestWorstCase(request);
        const decision = await allowance.decide(worstCase, hold);
        if (!decision.ok) {
          const refusal: Refusal = { ok: false, code: "insufficient_funds", detail: `uc1_${decision.reason}: ${decision.detail}` };
          return refusal;
        }
        const reserved = await spend.reserve(request);
        if (reserved.ok && hold !== undefined) allowance.consume(hold, worstCase);
        return reserved;
      }),
  };
}

const FINAL_STATES = new Set(["terminal", "reconciled"]);

/**
 * The ledger view from the database: the operations under the roots (a read of the operations
 * table), each one's status from the spend API, and the halt status. An operation that is terminal
 * or reconciled with nothing open is cached, since its amounts no longer change.
 */
export function ledgerAllowanceSource(client: SqlClient, spend: Spend, schema = "public"): AllowanceSource {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("the spend schema must be a plain lower-case identifier");
  const settledFinal = new Map<string, bigint>();
  return {
    async view(roots) {
      const halt = await spend.haltStatus();
      if (!halt.ok) throw new Error(`the spend ledger's halt status is unavailable (${halt.code})`);
      const rows = roots.length === 0 ? [] : (await client.query(`SELECT operation_id FROM ${schema}.operations WHERE root_execution_id = ANY($1::text[]) ORDER BY operation_id`, [[...roots]])).rows;
      let settled = 0n;
      let open = 0n;
      const uncertain: string[] = [];
      for (const row of rows) {
        const id = String(row.operation_id);
        const cached = settledFinal.get(id);
        if (cached !== undefined) {
          settled += cached;
          continue;
        }
        const status = await spend.operationStatus({ operation_id: id });
        if (!status.ok) throw new Error(`the spend ledger has no status for operation ${id} (${status.code})`);
        settled += status.settled_microusd;
        open += status.open_microusd;
        if (status.state === "uncertain") uncertain.push(id);
        if (FINAL_STATES.has(status.state) && status.open_microusd === 0n) settledFinal.set(id, status.settled_microusd);
      }
      return { settled_microusd: settled, open_microusd: open, uncertain, halted: halt.halted };
    },
  };
}
