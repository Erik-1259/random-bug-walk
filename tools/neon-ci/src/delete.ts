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
 * Looks the branch up by its CI name, deletes the ID found and confirms the result. The name is
 * validated by the caller; no caller-supplied ID is ever deleted.
 */
export async function deleteAndConfirm(
  deps: Deps,
  config: Config,
  name: string,
): Promise<DeleteResult> {
  const found = await listBranches(deps, config);
  if ("unreadable" in found) return { outcome: "unknown", name, id: undefined };
  const match = found.branches.find((branch) => branch.name === name);
  if (match === undefined) return { outcome: "absent", name, id: undefined };
  return deleteListedBranch(deps, config, name, match.id);
}

/**
 * Deletes a branch whose ID came from a listing the caller has just read and filtered by CI name,
 * then confirms the result. Never call this with an ID taken from user input.
 */
export async function deleteListedBranch(deps: Deps, config: Config, name: string, id: string): Promise<DeleteResult> {
  const attempt = await send(deps, config, "DELETE", `/projects/${config.projectId}/branches/${id}`, DELETE_BUDGET_MS);
  if (attempt.kind === "response" && attempt.status === 404) return { outcome: "absent", name, id };
  if (isSuccess(attempt)) return { outcome: "deleted", name, id };

  const listed = await listBranches(deps, config);
  if ("unreadable" in listed) return { outcome: "unknown", name, id };
  const stillThere = listed.branches.some((branch) => branch.id === id || branch.name === name);
  return { outcome: stillThere ? "leaked" : "absent", name, id };
}
