// The runner's values the controller's judge web entry also needs, apart from the runner's other
// modules so importing them loads only @rbw/schema and the driver's limits: the run and copy tags,
// a copy's outer limit and the UTC time format.
import { sha256Hex } from "@rbw/schema";
import { DEFAULT_PHASE_LIMITS } from "@rbw/umami-driver/limits";

export { utcSeconds } from "./clock.ts";

/** A copy's hard outer limit: the driver's 600 s copy deadline plus 120 s. */
export const COPY_OUTER_LIMIT_MS = DEFAULT_PHASE_LIMITS.total_ms + 120_000;

export function runTag(rootExecutionId: string): string {
  return sha256Hex(Buffer.from(rootExecutionId)).slice(0, 8);
}

/**
 * The tag in a job's copy names: the run tag, then the tag of the job's own execution. Vercel keeps
 * a stopped named sandbox and refuses a create on its name, so every job under one root needs names
 * of its own: two judge_verify jobs' fixed-01 copies would otherwise share one.
 */
export function copyTag(rootExecutionId: string, executionId: string): string {
  return `${runTag(rootExecutionId)}-${runTag(executionId)}`;
}
