// Entry point for `test:upstream`: runs the checks against the pinned Umami blobs. It reads them
// from the git directory in RBW_UMAMI_GIT_DIR, or fetches the pinned commits into a temporary
// directory, and skips with a clear message when neither is possible.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FETCHES, REPOSITORY_URL, missingObjects } from "./pinned.ts";

function fetchPinned(): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), "rbw-umami-"));
  const init = spawnSync("git", ["init", "--quiet", "--bare", dir], { stdio: "inherit" });
  if (init.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
  for (const { commit, depth } of FETCHES) {
    process.stdout.write(`test:upstream: fetching ${commit} (depth ${String(depth)}) from ${REPOSITORY_URL}\n`);
    const fetched = spawnSync("git", ["--git-dir", dir, "fetch", "--quiet", `--depth=${String(depth)}`, REPOSITORY_URL, commit], {
      stdio: "inherit",
    });
    if (fetched.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      return undefined;
    }
  }
  return dir;
}

const given = process.env.RBW_UMAMI_GIT_DIR;
let gitDir: string | undefined;
let temporary = false;
if (given !== undefined && given !== "") {
  const missing = missingObjects(given);
  if (missing.length > 0) {
    process.stdout.write(`test:upstream skipped: RBW_UMAMI_GIT_DIR lacks the pinned objects ${missing.join(", ")}\n`);
    process.exit(0);
  }
  gitDir = given;
} else {
  gitDir = fetchPinned();
  temporary = gitDir !== undefined;
}
if (gitDir === undefined) {
  process.stdout.write("test:upstream skipped: RBW_UMAMI_GIT_DIR is not set and the pinned commits could not be fetched\n");
  process.exit(0);
}

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const result = spawnSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.upstream.config.ts"], {
  cwd: packageDir,
  stdio: "inherit",
  env: { ...process.env, RBW_UMAMI_GIT_DIR: gitDir },
});
if (temporary) {
  rmSync(gitDir, { recursive: true, force: true });
}
process.exit(result.status ?? 1);
