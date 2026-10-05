import type { Limits } from "./config.ts";
import type { StateDir } from "./state.ts";

export class LimitExceeded extends Error {
  constructor(kind: keyof Limits) {
    super(`limit exceeded: ${kind}`);
    this.name = "LimitExceeded";
  }
}

const ZERO: Limits = { pushAttempts: 0, metadataRequests: 0, newPublicBytes: 0, transferBytes: 0, storeOperations: 0 };

/**
 * Per-root limits, persisted in the state directory and checked before each operation. The
 * limits stored on first use can only be lowered by later configuration, never raised or reset.
 */
export class Budget {
  private readonly state: StateDir;
  private readonly root: string;
  private readonly stored: Limits;
  private readonly limits: Limits;
  private readonly used: Limits;
  /** Tags of amounts that count once per root, such as the repository payload of a candidate. */
  private readonly counted: string[];

  constructor(state: StateDir, root: string, configured: Limits) {
    this.state = state;
    this.root = root;
    const stored = state.loadLimits(root);
    const base = stored?.limits ?? configured;
    this.stored = base;
    this.limits = {
      pushAttempts: Math.min(base.pushAttempts, configured.pushAttempts),
      metadataRequests: Math.min(base.metadataRequests, configured.metadataRequests),
      newPublicBytes: Math.min(base.newPublicBytes, configured.newPublicBytes),
      transferBytes: Math.min(base.transferBytes, configured.transferBytes),
      storeOperations: Math.min(base.storeOperations, configured.storeOperations),
    };
    this.used = { ...ZERO, ...stored?.used };
    this.counted = [...(stored?.counted ?? [])];
    if (stored === null) this.persist();
  }

  private persist(): void {
    this.state.saveLimits(this.root, { limits: this.stored, used: this.used, counted: this.counted });
  }

  /** Throws LimitExceeded when spending the amount would exceed the limit; records nothing. */
  check(kind: keyof Limits, amount: number): void {
    if (this.used[kind] + amount > this.limits[kind]) throw new LimitExceeded(kind);
  }

  /** Checks several amounts at once, before a run of operations that needs all of them. */
  checkAll(amounts: Partial<Limits>): void {
    for (const [kind, amount] of Object.entries(amounts) as [keyof Limits, number][]) this.check(kind, amount);
  }

  /** Records usage, or throws LimitExceeded without recording anything. */
  spend(kind: keyof Limits, amount: number): void {
    this.check(kind, amount);
    this.used[kind] += amount;
    this.persist();
  }

  /** Records usage up to what is left, then throws LimitExceeded if the amount did not fit. For bytes already received. */
  charge(kind: keyof Limits, amount: number): void {
    const room = this.remaining(kind);
    this.used[kind] += Math.min(amount, room);
    this.persist();
    if (amount > room) throw new LimitExceeded(kind);
  }

  /** What is left of a limit. */
  remaining(kind: keyof Limits): number {
    return Math.max(0, this.limits[kind] - this.used[kind]);
  }

  /** True when an amount with this tag has already been counted for the root. */
  hasCounted(tag: string): boolean {
    return this.counted.includes(tag);
  }

  /** Spends an amount once per root: a second call with the same tag records nothing. */
  spendOnce(kind: keyof Limits, amount: number, tag: string): void {
    if (this.hasCounted(tag)) return;
    this.check(kind, amount);
    this.used[kind] += amount;
    this.counted.push(tag);
    this.persist();
  }
}
