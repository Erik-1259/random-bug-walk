/** Single definition of the per-run CI branch name and the pattern that selects CI branches. */

export const CI_BRANCH_PATTERN = /^ci-pr-[1-9][0-9]*-[1-9][0-9]*-[1-9][0-9]*$/;

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

export function isCiBranchName(name: string): boolean {
  return CI_BRANCH_PATTERN.test(name);
}

/** Parts stay digit strings so run IDs beyond 2^53 are never rounded. */
export function branchName(pr: string, runId: string, runAttempt: string): string {
  const parts = { pr, runId, runAttempt };
  for (const [label, value] of Object.entries(parts)) {
    if (!POSITIVE_INTEGER.test(value)) {
      throw new Error(`invalid ${label}: expected a base-10 integer of at least 1 without leading zeros`);
    }
  }
  return `ci-pr-${pr}-${runId}-${runAttempt}`;
}
