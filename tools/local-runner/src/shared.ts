// The runner's values the controller's judge web entry also needs, apart from the runner's other
// modules so importing them loads only @rbw/schema and the driver's limits: the run tag, a copy's
// outer limit and the UTC time format.
import { sha256Hex } from "@rbw/schema";
import { DEFAULT_PHASE_LIMITS } from "@rbw/umami-driver/limits";

export { utcSeconds } from "./clock.ts";

/** A copy's hard outer limit: the driver's 600 s copy deadline plus 120 s. */
export const COPY_OUTER_LIMIT_MS = DEFAULT_PHASE_LIMITS.total_ms + 120_000;

export function runTag(rootExecutionId: string): string {
  return sha256Hex(Buffer.from(rootExecutionId)).slice(0, 8);
}
