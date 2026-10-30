// The pre-registered plan of the UC1 paired comparison (docs/uc1-preregistration.md): the attempt
// order in ABBA blocks, one fixed seed per attempt index, the spending caps per model, the rerun
// and concurrency limits, and the pilot's case and label.
import type { Arm, SolverModelName } from "@rbw/solver";

/** One ABBA block: off, on, on, off. Attempt indexes follow it, repeated. */
export const ABBA_BLOCK: readonly Arm[] = ["off", "on", "on", "off"];

/** k = 20 per arm per bug, 40 in total. */
export const MAIN_ATTEMPTS = 40;
/** The harness pilot: 2 off and 2 on attempts (one ABBA block). */
export const PILOT_ATTEMPTS = 4;
/** The Kimi fallback's pilot, if the Super pilot shows tool calling broken: 2 attempts. */
export const KIMI_PILOT_ATTEMPTS = 2;

export type RunMode = "pilot" | "run";

export interface PlannedAttempt {
  /** The attempt index, 1-based, in the pre-registered order. */
  index: number;
  arm: Arm;
  /** The attempt's fixed seed. The solver sends the attempt index as the seed, so it is the index. */
  seed: number;
}

/** The attempts of a mode in index order: ABBA blocks, each index its own seed. */
export function attemptPlan(mode: RunMode, model: SolverModelName = "super"): PlannedAttempt[] {
  const count = mode === "run" ? MAIN_ATTEMPTS : model === "kimi" ? KIMI_PILOT_ATTEMPTS : PILOT_ATTEMPTS;
  return Array.from({ length: count }, (_, i) => {
    const arm = ABBA_BLOCK[i % ABBA_BLOCK.length];
    if (arm === undefined) throw new Error("the ABBA block is empty");
    return { index: i + 1, arm, seed: i + 1 };
  });
}

/**
 * The total UC1 spending cap (decision 5): $40 on Super, $75 if the Kimi fallback is adopted. The
 * caps were set for Nemotron 3 Super and Kimi-K2.7-Code and are unchanged for their successors.
 */
export const SPEND_CAPS_MICROUSD: Readonly<Record<SolverModelName, bigint>> = Object.freeze({ super: 40_000_000n, kimi: 75_000_000n });

/** One change made outside the pre-registration's amendment window, with its date and reason. */
export interface PreregistrationDeviation {
  /** The date of the change, YYYY-MM-DD. */
  date: string;
  change: string;
  reason: string;
}

/**
 * The deviations from the pre-registration, which every report prints next to the result
 * ("Status and changes": a change outside the amendment window is reported with its date and reason).
 */
export const PREREGISTRATION_DEVIATIONS: readonly PreregistrationDeviation[] = Object.freeze([
  Object.freeze({
    date: "2026-10-30",
    change:
      "The solver models changed before the harness pilot: Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) became Nemotron 3.5 Super VL (`nvidia/Nemotron-3.5-Super-VL`), and the Kimi-K2.7-Code fallback (`moonshotai/Kimi-K2.7-Code`) became Kimi-K3 (`moonshotai/Kimi-K3`), with the same settings and spending caps.",
    reason: "The provider retires Nemotron 3 Super and Kimi-K2.7-Code in November 2026.",
  }),
]);

/** Up to 3 sessions run at once on local Docker. */
export const MAX_CONCURRENCY = 3;
/** An attempt that hits an infrastructure error is rerun from scratch at the same index, up to 2 times. */
export const MAX_INFRASTRUCTURE_RERUNS = 2;
/** A grade that stops for infrastructure reasons is retried as a grade only, up to this many times per grade. */
export const MAX_GRADE_RETRIES = 2;

/** The released time-zone case, used only for the harness pilot (its screen record fails it). */
export const PILOT_CASE_ID = "umami-tz-arg-001";
/** How the pilot is published, word for word from the pre-registration. */
export const PILOT_LABEL = "harness pilot; bug fails the static-headroom screen; not a UC1 result";

/** The paired_comparison root's stages. */
export const DECLARED_STAGES = ["solver_sessions", "grade_1", "grade_2"] as const;

/** The two seeded grade round trips of the pilot, with no model: the route each must take. */
export const SEEDED_ROUND_TRIPS = [
  { label: "seed-alternative-fix", state: "alternative_fix", route: "alternative_fix" },
  { label: "seed-clean", state: "clean", route: "clean_equal" },
] as const;
export type SeededLabel = (typeof SEEDED_ROUND_TRIPS)[number]["label"];

/** The development pool and slot the attempts and both grades are charged to (never the judge's). */
export const DEVELOPMENT_POOL = "development";
export const DEVELOPMENT_SLOT = "development";
