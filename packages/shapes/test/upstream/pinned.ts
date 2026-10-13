// The pinned upstream commits and helpers that read their blobs from a local git directory.
import { spawnSync } from "node:child_process";

export const REPOSITORY_URL = "https://github.com/umami-software/umami.git";
export const HOST_COMMIT = "ec0ff50388c264ed8ce46f00967e92f7e71476ae";
export const FIX_COMMIT = "e6f3f3b4b40a490d5cb050471baa0999366dab2a";
export const FIX_PARENT = "0a838649b773122cc68cbd0c3df78d4251b981c5";
/** The first parent of FIX_PARENT; that pairing changes only pnpm-lock.yaml. */
export const FIX_PARENT_FIRST_PARENT = "2260520ae58b7b79327f0f50e4d465931b07f41c";
export const ROUTE_PATH = "src/app/api/websites/[websiteId]/pageviews/route.ts";
/** Upstream 3e165a8c, the RC-1 source fix, and its only parent. */
export const RC1_FIX_COMMIT = "3e165a8c6fea303250e626dc952a396e40887c71";
export const RC1_FIX_PARENT = "b4bb9cc727cd0ec05dc233e3e1f506f2e3633e34";

export const FETCHES = [
  { commit: HOST_COMMIT, depth: 1 },
  { commit: FIX_COMMIT, depth: 2 },
  { commit: FIX_PARENT, depth: 2 },
  { commit: RC1_FIX_COMMIT, depth: 2 },
] as const;

const REQUIRED = [HOST_COMMIT, FIX_COMMIT, FIX_PARENT, FIX_PARENT_FIRST_PARENT, RC1_FIX_COMMIT, RC1_FIX_PARENT];

function git(gitDir: string, args: string[]): { status: number | null; stdout: Buffer } {
  const result = spawnSync("git", ["--git-dir", gitDir, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout };
}

export function missingObjects(gitDir: string): string[] {
  return REQUIRED.filter((commit) => git(gitDir, ["cat-file", "-e", `${commit}^{commit}`]).status !== 0);
}

export function readBlob(gitDir: string, commit: string, path: string): Buffer {
  const result = git(gitDir, ["cat-file", "blob", `${commit}:${path}`]);
  if (result.status !== 0) {
    throw new Error(`cannot read ${commit}:${path}`);
  }
  return result.stdout;
}

export function fileMode(gitDir: string, commit: string, path: string): string {
  const result = git(gitDir, ["ls-tree", commit, "--", path]);
  const mode = result.stdout.toString("utf8").split(" ")[0];
  if (result.status !== 0 || mode === undefined || mode === "") {
    throw new Error(`cannot read the mode of ${commit}:${path}`);
  }
  return mode;
}

export function umamiGitDir(): string {
  const dir = process.env.RBW_UMAMI_GIT_DIR;
  if (dir === undefined || dir === "") {
    throw new Error("RBW_UMAMI_GIT_DIR is not set; run these tests through `pnpm run test:upstream`");
  }
  return dir;
}
