import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ScanUnavailable } from "./gitleaks.ts";
import { ChildTimedOut, ensureHelperRepository, helperGit, readRemoteBranch, type Decision, type OperationContext } from "./operation.ts";
import type { WorktreeEntry } from "./registry.ts";
import { scan } from "./scan.ts";
import { readCommits } from "./sources.ts";

const REMOTE_NAMESPACE = "refs/rbw/remote";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

type PathInfo = { kind: "missing" } | { kind: "present"; directory: boolean; file: boolean; size: number; identity: string };

async function info(path: string): Promise<PathInfo> {
  try {
    const stats = await lstat(path);
    return { kind: "present", directory: stats.isDirectory(), file: stats.isFile(), size: stats.size, identity: `${String(stats.dev)}:${String(stats.ino)}` };
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return { kind: "missing" };
    throw error;
  }
}

/**
 * Checks the working copy around the fetch: `.git` and `.git/objects` are real
 * directories, and there is no commondir file and no non-empty alternates file. A valid
 * result carries the device and inode of both directories, so the check after the fetch
 * can tell that upload-pack saw the same ones.
 */
async function checkWorkingCopy(path: string): Promise<{ kind: "ok"; identity: string } | { kind: "missing" } | { kind: "invalid" }> {
  if ((await info(path)).kind === "missing") return { kind: "missing" };
  const dotGit = await info(join(path, ".git"));
  const objects = await info(join(path, ".git", "objects"));
  if (dotGit.kind !== "present" || !dotGit.directory || objects.kind !== "present" || !objects.directory) return { kind: "invalid" };
  if ((await info(join(path, ".git", "commondir"))).kind !== "missing") return { kind: "invalid" };
  for (const name of ["alternates", "http-alternates"]) {
    const alternates = await info(join(path, ".git", "objects", "info", name));
    if (alternates.kind === "present" && (!alternates.file || alternates.size > 0)) return { kind: "invalid" };
  }
  return { kind: "ok", identity: `${dotGit.identity} ${objects.identity}` };
}

/** True when an author or committer value names exactly the registered identity. */
function hasIdentity(value: Buffer | null, identity: WorktreeEntry["identity"]): boolean {
  if (value === null) return false;
  const match = /^(.*?) <([^<>]*)> \d+ [+-]\d{4}$/.exec(value.toString("latin1"));
  const latin1 = (text: string): string => Buffer.from(text, "utf8").toString("latin1");
  return match !== null && match[1] === latin1(identity.name) && match[2] === latin1(identity.email);
}

/** "match" when every commit the push would publish carries the registered identity as author and committer. */
async function checkIdentities(context: OperationContext, repository: string, exclude: readonly string[]): Promise<"match" | "mismatch" | "unavailable"> {
  try {
    const commits = await readCommits(repository, context.request.sha, exclude, { env: context.env, timeoutMs: context.config.timeouts.git });
    const { identity } = context.entry;
    return commits.every(({ commit }) => hasIdentity(commit.author, identity) && hasIdentity(commit.committer, identity)) ? "match" : "mismatch";
  } catch (error) {
    if (error instanceof ScanUnavailable) return "unavailable";
    throw error;
  }
}

/** 0 when ancestor is an ancestor of descendant, 1 when not, null on error. */
async function isAncestor(context: OperationContext, repository: string, ancestor: string, descendant: string): Promise<0 | 1 | null> {
  const result = await helperGit(context, repository, ["merge-base", "--is-ancestor", ancestor, descendant], context.env);
  return result.code === 0 ? 0 : result.code === 1 ? 1 : null;
}

async function hasCommit(context: OperationContext, repository: string, sha: string): Promise<boolean> {
  return (await helperGit(context, repository, ["cat-file", "-e", `${sha}^{commit}`], context.env)).code === 0;
}

/** Publishes the requested commit to the registered branch; see README "Push". */
export async function publishPush(context: OperationContext): Promise<Decision> {
  const { request, entry, config } = context;
  const { sha } = request;
  const branchRef = `refs/heads/${entry.branch}`;

  // A resumed push may already have reached the remote; that settles it whatever the working copy holds now.
  const attempted = await context.state.hasAttempt(request.requestId);
  const repository = await ensureHelperRepository(context);
  if (repository === null) return { outcome: attempted ? "pending" : "unavailable", category: "helper-repository" };
  if (attempted) {
    const current = await readRemoteBranch(context, repository);
    if (current === undefined) return { outcome: "pending", category: "resume-check-failed" };
    if (current === sha) return { outcome: "published", category: "found-after-restart" };
  }

  const workingCopy = await checkWorkingCopy(entry.path);
  if (workingCopy.kind === "missing") return { outcome: "unavailable", category: "worktree-missing" };
  if (workingCopy.kind === "invalid") return { outcome: "blocked", category: "invalid-worktree" };
  const candidateRef = `refs/rbw/candidates/${sha}`;

  // Upload-pack runs in the working copy with lazy fetching off and the allowlisted environment.
  const fetched = await helperGit(
    context,
    repository,
    [
      "-c", "protocol.version=2",
      "-c", "fetch.fsckObjects=true",
      "-c", "transfer.fsckObjects=true",
      "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance",
      "--", join(entry.path, ".git"), `${sha}:${candidateRef}`,
    ],
    context.env,
  );
  // Upload-pack used whatever the path held while it ran; it must still be the checked working copy.
  const after = await checkWorkingCopy(entry.path);
  if (after.kind !== "ok" || after.identity !== workingCopy.identity) {
    await helperGit(context, repository, ["update-ref", "-d", candidateRef], context.env);
    return { outcome: "blocked", category: "invalid-worktree" };
  }
  if (fetched.code !== 0 || !(await hasCommit(context, repository, sha))) return { outcome: "stale", category: "candidate-unavailable" };
  // The request names "the candidate commit"; any other object type would be pushed unscanned.
  const type = await helperGit(context, repository, ["cat-file", "-t", sha], context.env);
  if (type.code !== 0 || type.stdout.toString("latin1").trim() !== "commit") {
    await helperGit(context, repository, ["update-ref", "-d", candidateRef], context.env);
    return { outcome: "blocked", category: "invalid-request" };
  }

  const heads = await helperGit(
    context,
    repository,
    [
      "-c", "fetch.fsckObjects=true",
      "fetch", "--quiet", "--prune", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance",
      "--", entry.remote, `+refs/heads/*:${REMOTE_NAMESPACE}/*`,
    ],
    context.remoteEnv,
  );
  if (heads.code !== 0) return { outcome: "unavailable", category: "remote-read" };
  const listing = await helperGit(context, repository, ["for-each-ref", "--format=%(objectname) %(refname)", `${REMOTE_NAMESPACE}/`], context.env);
  if (listing.code !== 0) return { outcome: "unavailable", category: "remote-read" };
  const remoteHeads = new Map<string, string>();
  for (const line of listing.stdout.toString("utf8").split("\n")) {
    const [objectName, refName] = line.split(" ");
    if (objectName !== undefined && refName !== undefined) remoteHeads.set(refName.slice(REMOTE_NAMESPACE.length + 1), objectName);
  }
  const tip = remoteHeads.get(entry.branch) ?? null;
  if (tip === sha) return { outcome: "published", category: "already-published" };

  const baseKnown = await hasCommit(context, repository, entry.approvedBase);
  const ancestry = tip !== null
    ? await isAncestor(context, repository, tip, sha)
    : baseKnown ? await isAncestor(context, repository, entry.approvedBase, sha) : 1;
  if (ancestry === null) return { outcome: "unavailable", category: "ancestry-check" };
  if (ancestry === 1) return { outcome: "blocked", category: "not-fast-forward" };

  const exclude = [...new Set(remoteHeads.values())];
  const identities = await checkIdentities(context, repository, exclude);
  if (identities === "unavailable") return { outcome: "unavailable", category: "identity-check" };
  if (identities === "mismatch") return { outcome: "blocked", category: "identity-mismatch" };

  // PUB-02: everything the push would make public is scanned before anything is pushed.
  const result = await scan({
    patternFile: config.patternFile,
    gitleaksCommand: config.gitleaksCommand,
    gitTimeoutMs: config.timeouts.git,
    gitleaksTimeoutMs: config.timeouts.gitleaks,
    ...(entry.repository === undefined ? {} : { repository: entry.repository }),
    git: {
      repository,
      head: sha,
      exclude,
      ...(baseKnown ? { licenseRevision: entry.approvedBase } : {}),
    },
  });
  if (result.outcome === "unavailable") return { outcome: "unavailable", category: "scan-unavailable" };
  if (result.outcome === "blocked") return { outcome: "blocked", category: "content", locations: result.locations };

  // PUB-02 publish path: push exactly the scanned commit as a compare-and-swap on the branch.
  await context.state.markAttempt(request.requestId);
  let pushed: { code: number | null } | "timed-out";
  try {
    pushed = await helperGit(
      context,
      repository,
      [
        "-c", "push.followTags=false",
        "-c", "push.recurseSubmodules=no",
        "-c", "push.gpgSign=false",
        "push", "--quiet", "--porcelain", "--no-verify", "--no-follow-tags", "--recurse-submodules=no",
        `--force-with-lease=${branchRef}:${tip ?? ""}`,
        "--", entry.remote, `${sha}:${branchRef}`,
      ],
      context.remoteEnv,
    );
  } catch (error) {
    if (!(error instanceof ChildTimedOut)) throw error;
    pushed = "timed-out";
  }
  if (pushed !== "timed-out" && pushed.code === 0) return { outcome: "published", category: "pushed" };

  const remoteAfter = await readRemoteBranch(context, repository);
  if (remoteAfter === undefined) return { outcome: "pending", category: "push-read-back-failed" };
  if (remoteAfter === sha) return { outcome: "published", category: "pushed-with-error" };
  // A killed push may still land on the remote, so only a resumed check may settle it.
  if (pushed === "timed-out") return { outcome: "pending", category: "push-timed-out" };
  if (remoteAfter === tip) return { outcome: "unavailable", category: "push-failed" };
  return { outcome: "stale", category: "remote-moved" };
}
