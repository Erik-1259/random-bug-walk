import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_SAFETY_OPTIONS, runProcess } from "./run.ts";

export interface WorktreeEntry {
  /** Absolute host path of a standalone clone. */
  path: string;
  /** Push URL, or a local bare repository for tests. */
  remote: string;
  /** `<owner>/<repo>`, needed for PR operations and the URL exception. */
  repository?: string;
  /** The only branch this worktree may publish. */
  branch: string;
  /** Commit the branch may be created from. */
  approvedBase: string;
  /** The author and committer every published commit must carry exactly. */
  identity: { name: string; email: string };
  /** 64 lowercase hex characters; the clone holds the same value as rbw.worktreeToken. */
  token: string;
}

const ENTRY_KEYS = new Set(["path", "remote", "repository", "branch", "approvedBase", "identity", "token"]);
const TOKEN = /^[0-9a-f]{64}$/;
const IDENTITY_PART = /^[^<>\n\0]+$/;
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the registry; null when it is missing, unreadable or not in the expected shape. */
export async function readRegistry(path: string): Promise<Record<string, unknown> | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.worktrees)) return null;
  if (Object.keys(value).some((key) => key !== "version" && key !== "worktrees")) return null;
  return value.worktrees;
}

/** The `<owner>/<repo>` of a GitHub remote URL, or null for any other remote. */
export function githubRepository(remote: string): string | null {
  const scp = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remote);
  if (scp?.[1] !== undefined) return scp[1];
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const match = /^\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.pathname);
  return match?.[1] ?? null;
}

/** The local path of a path or file: remote, or null for a network remote. */
export function localRemotePath(remote: string): string | null {
  if (remote.startsWith("/")) return remote;
  if (!remote.startsWith("file:")) return null;
  try {
    return fileURLToPath(remote);
  } catch {
    return null;
  }
}

function validIdentity(value: unknown): value is { name: string; email: string } {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  const { name, email } = value;
  return typeof name === "string" && typeof email === "string" && IDENTITY_PART.test(name) && IDENTITY_PART.test(email);
}

/** False when the remote carries user information (other than ssh's `git` user) or a token. */
function remoteIsAllowed(remote: string): boolean {
  if (remote.startsWith("/")) return !remote.includes("\n");
  if (/^git@[^/:]+:[^/]/.test(remote)) return !/[\s?#]/.test(remote);
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return false;
  }
  if (!["https:", "ssh:", "file:"].includes(url.protocol)) return false;
  if (url.password !== "" || url.search !== "" || url.hash !== "") return false;
  if (url.username !== "" && !(url.protocol === "ssh:" && url.username === "git")) return false;
  return true;
}

async function validBranch(branch: string, cwd: string, env: Record<string, string>): Promise<boolean> {
  if (branch === "main" || branch === "HEAD" || branch.startsWith("-")) return false;
  const result = await runProcess("git", [...GIT_SAFETY_OPTIONS, "check-ref-format", `refs/heads/${branch}`], { cwd, env });
  return result.code === 0;
}

/** Validates one registry entry; null when it is invalid. */
export async function validateEntry(value: unknown, cwd: string, env: Record<string, string>): Promise<WorktreeEntry | null> {
  if (!isRecord(value) || !Object.keys(value).every((key) => ENTRY_KEYS.has(key))) return null;
  const { path, remote, repository, branch, approvedBase, identity, token } = value;
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  if (typeof remote !== "string" || !remoteIsAllowed(remote)) return null;
  if (typeof branch !== "string" || !(await validBranch(branch, cwd, env))) return null;
  if (typeof approvedBase !== "string" || !SHA.test(approvedBase)) return null;
  if (!validIdentity(identity)) return null;
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  const entry: WorktreeEntry = { path, remote, branch, approvedBase, identity: { name: identity.name, email: identity.email }, token };
  if (repository !== undefined) {
    if (typeof repository !== "string" || !REPOSITORY.test(repository)) return null;
    // The repository must be the one a recognised GitHub remote names; a local remote is for tests.
    const github = githubRepository(remote);
    if (github === null ? localRemotePath(remote) === null : github.toLowerCase() !== repository.toLowerCase()) return null;
    entry.repository = repository;
  }
  return entry;
}
