import { isSuccess, listBranches, send } from "./api.ts";
import type { Deps } from "./api.ts";
import type { Config } from "./config.ts";

export type Outcome = "deleted" | "absent" | "leaked" | "unknown";

export interface DeleteResult {
  outcome: Outcome;
  name: string;
  id: string | undefined;
}

export const DELETE_BUDGET_MS = 120_000;

export function exitCodeFor(outcome: Outcome): 0 | 1 | 2 {
  if (outcome === "deleted" || outcome === "absent") return 0;
  return outcome === "leaked" ? 1 : 2;
}

/** The ID is a provider identifier, so the output line only says whether one was involved. */
export function formatResult(result: DeleteResult): string {
  return `outcome=${result.outcome} name=${result.name} id=${result.id === undefined ? "-" : "masked"}`;
}

/**
 * Deletes a branch by ID, or by looking up `name` when no ID is known, and confirms the result.
 * Inputs are validated by the caller.
 */
export async function deleteAndConfirm(
  deps: Deps,
  config: Config,
  name: string,
  knownId: string | undefined,
): Promise<DeleteResult> {
  let id = knownId;
  if (id === undefined) {
    const listed = await listBranches(deps, config);
    if ("unreadable" in listed) return { outcome: "unknown", name, id };
    const match = listed.branches.find((branch) => branch.name === name);
    if (match === undefined) return { outcome: "absent", name, id };
    id = match.id;
  }

  const attempt = await send(deps, config, "DELETE", `/projects/${config.projectId}/branches/${id}`, DELETE_BUDGET_MS);
  if (attempt.kind === "response" && attempt.status === 404) return { outcome: "absent", name, id };
  if (isSuccess(attempt)) return { outcome: "deleted", name, id };

  const listed = await listBranches(deps, config);
  if ("unreadable" in listed) return { outcome: "unknown", name, id };
  const stillThere = listed.branches.some((branch) => branch.id === id || branch.name === name);
  return { outcome: stillThere ? "leaked" : "absent", name, id };
}
