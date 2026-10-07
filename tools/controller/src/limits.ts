// Spec §9.4's limits for the controller. Each job kind has its own deadline, spend ceiling and
// most app copies (from @rbw/envelope's fixed limits; the kit check reuses admission's), and runs
// under one pool, allocation and slot key. Each copy's deadline follows the child-deadline rule.
import { FIXED_LIMITS } from "@rbw/envelope";
import type { JobKind } from "@rbw/schema";
import { DEFAULT_PHASE_LIMITS } from "@rbw/umami-driver";

export interface JobLimits {
  controller_ms: number;
  ceiling_microusd: number;
  max_copies: number;
}

function limits(kind: "observe" | "admission" | "judge"): JobLimits {
  return {
    controller_ms: FIXED_LIMITS[kind].deadline_seconds * 1000,
    ceiling_microusd: FIXED_LIMITS.ceilings[kind],
    max_copies: FIXED_LIMITS[kind].app_copies,
  };
}

export const JOB_LIMITS: Readonly<Record<JobKind, JobLimits>> = {
  admission: limits("admission"),
  kit_check: { ...limits("admission"), max_copies: 5 },
  observe: limits("observe"),
  judge_verify: limits("judge"),
};

/** Where a job's spend and its serial slot are recorded. */
export interface LedgerTarget {
  pool_key: string;
  allocation_key: string | null;
  slot_key: string;
}

/** Factory runs: the conductor's development pool and slot key. */
export const DEVELOPMENT: LedgerTarget = { pool_key: "development", allocation_key: null, slot_key: "development" };
/** Judge replays: the judge-demo pool's protected judge allocation, under the judge slot key. */
export const JUDGE: LedgerTarget = { pool_key: "judge-demo", allocation_key: "judge", slot_key: "judge" };

/** A copy's own deadline: the driver's whole-copy deadline, 600 s. */
export const COPY_DEADLINE_MS = DEFAULT_PHASE_LIMITS.total_ms;
/** What the parent keeps after a child's deadline. */
export const PARENT_MARGIN_MS = 120_000;

/** The child-deadline rule: the minimum of 600 s and the parent's remaining time minus 120 s; null when that is not positive. */
export function childDeadlineMs(parentRemainingMs: number): number | null {
  const ms = Math.min(COPY_DEADLINE_MS, parentRemainingMs - PARENT_MARGIN_MS);
  return ms > 0 ? ms : null;
}

export type LaunchDecision = { launch: true; child_ms: number } | { launch: false; reason: "parent_deadline" | "child_deadline_short"; child_ms: number | null };

/**
 * Whether a copy may start now. The run-copy path gives every copy the driver's whole 600 s, and
 * 120 s after it to stop and collect, so a copy starts only when its child deadline is that whole
 * 600 s; a shorter positive child deadline also stops new launches.
 */
export function launchDecision(parentRemainingMs: number): LaunchDecision {
  const child = childDeadlineMs(parentRemainingMs);
  if (child === null) return { launch: false, reason: "parent_deadline", child_ms: null };
  if (child < COPY_DEADLINE_MS) return { launch: false, reason: "child_deadline_short", child_ms: child };
  return { launch: true, child_ms: child };
}
