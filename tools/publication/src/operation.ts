import type { HelperConfig } from "./config.ts";
import type { Outcome, PublicationRequest } from "./protocol.ts";
import type { WorktreeEntry } from "./registry.ts";
import { GIT_SAFETY_OPTIONS, runProcess, splitCommand, type ProcessResult } from "./run.ts";
import type { StateStore } from "./state.ts";

export interface OperationContext {
  config: HelperConfig;
  state: StateStore;
  request: PublicationRequest;
  entry: WorktreeEntry;
  /** Allowlisted environment for git commands that never talk to the registered remote. */
  env: Record<string, string>;
  /** The same plus the configured extra variables, for the remote and gh. */
  remoteEnv: Record<string, string>;
}

/** An outcome with its host-log category, or `pending` when nothing may be recorded yet. */
export type Decision =
  | { outcome: Outcome; category: string; locations?: string[]; pullRequest?: number }
  | { outcome: "pending"; category: string };

/** Thrown when a git or gh child ran out of time; the helper answers unavailable or keeps the request pending. */
export class ChildTimedOut extends Error {}

/** Runs git against a helper-owned repository, never from or inside a working copy. */
export async function helperGit(
  context: Pick<OperationContext, "state" | "config">,
  repository: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<ProcessResult> {
  const result = await runProcess("git", [...GIT_SAFETY_OPTIONS, "--git-dir", repository, ...args], {
    cwd: context.state.dir,
    env,
    timeoutMs: context.config.timeouts.git,
  });
  if (result.timedOut) throw new ChildTimedOut("git");
  return result;
}

/** Runs the configured gh command from a helper-owned directory. */
export async function runGh(context: OperationContext, args: readonly string[]): Promise<ProcessResult> {
  const [program = "gh", ...prefix] = splitCommand(context.config.ghCommand);
  const result = await runProcess(program, [...prefix, ...args], {
    cwd: context.state.ghDirectory,
    env: context.remoteEnv,
    timeoutMs: context.config.timeouts.gh,
  });
  if (result.timedOut) throw new ChildTimedOut("gh");
  return result;
}

/** Reads one branch head from a remote; undefined when the read fails or times out, null when the branch is absent. */
export async function readRemoteBranch(context: OperationContext, repository: string): Promise<string | null | undefined> {
  const ref = `refs/heads/${context.entry.branch}`;
  let result: ProcessResult;
  try {
    result = await helperGit(context, repository, ["ls-remote", "--", context.entry.remote, ref], context.remoteEnv);
  } catch (error) {
    if (error instanceof ChildTimedOut) return undefined;
    throw error;
  }
  if (result.code !== 0) return undefined;
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const [sha, name] = line.split("\t");
    if (name === ref && sha !== undefined && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
}

/** Creates the helper-owned bare repository for a worktree id when it is missing. */
export async function ensureHelperRepository(context: OperationContext): Promise<string | null> {
  const repository = context.state.repository(context.request.worktreeId);
  const probe = await helperGit(context, repository, ["rev-parse", "--is-bare-repository"], context.env);
  if (probe.code === 0 && probe.stdout.toString("utf8").trim() === "true") return repository;
  const init = await runProcess("git", [...GIT_SAFETY_OPTIONS, "init", "--quiet", "--bare", "--template=", repository], {
    cwd: context.state.dir,
    env: context.env,
    timeoutMs: context.config.timeouts.git,
  });
  return init.code === 0 ? repository : null;
}
