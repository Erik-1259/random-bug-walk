import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitOutput, runGit, withEmptyDirectory } from "./git.ts";
import { InputError, compareUtf8 } from "./input.ts";
import { epochSeconds, type NeutralCommit, type Policy } from "./policy.ts";
import { walkCopy } from "./walk.ts";

export const BRANCH = "refs/heads/main";

/** Index settings for writing and for re-reading the index, so neither depends on the copy's config. */
export const INDEX_SETTINGS = ["-c", "index.version=2", "-c", "core.splitIndex=false", "-c", "index.skipHash=false"];

/** A path quoted for fast-import: inside double quotes, with `"`, `\` and control bytes escaped. */
function quotePath(path: string): Buffer {
  const bytes = Buffer.from(path, "utf8");
  let quoted = '"';
  for (const byte of bytes) {
    if (byte === 0x22 || byte === 0x5c) quoted += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x20 || byte === 0x7f) quoted += `\\${byte.toString(8).padStart(3, "0")}`;
    else quoted += String.fromCharCode(byte);
  }
  return Buffer.from(`${quoted}"`, "latin1");
}

export function identityLine(commit: NeutralCommit): string {
  return `${commit.name} <${commit.email}> ${String(epochSeconds(commit.date))} +0000`;
}

/**
 * ADM-01: gives the copy a neutral single-commit history. `git init` runs with an empty
 * template, every git call ignores global and system configuration, hooks point at an empty
 * directory and reflogs are off, so nothing from the build machine reaches the commit.
 * `git fast-import` writes the regular files' exact bytes as loose objects (no attribute or line-ending
 * filters) in one parentless commit; symlinks, special files and names that are not UTF-8
 * are left out and the audit refuses them. Returns the commit SHA.
 */
export function commitNeutral(copy: string, policy: Policy): string {
  let stat;
  try {
    stat = lstatSync(copy);
  } catch {
    throw new InputError("copy_unreadable");
  }
  if (!stat.isDirectory()) throw new InputError("copy_unreadable");
  const gitDir = join(copy, ".git");
  try {
    lstatSync(gitDir);
    throw new InputError("git_exists");
  } catch (error) {
    if (error instanceof InputError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new InputError("copy_unreadable");
  }
  const files = walkCopy(copy)
    .filter((entry) => entry.kind === "file" && !entry.undecodable)
    .sort((a, b) => compareUtf8(a.path, b.path));

  const chunks: Buffer[] = [];
  const commands: Buffer[] = [];
  files.forEach((file, index) => {
    let bytes: Buffer;
    let executable: boolean;
    try {
      bytes = readFileSync(file.absolute);
      executable = (lstatSync(file.absolute).mode & 0o100) !== 0;
    } catch {
      throw new InputError("copy_unreadable");
    }
    chunks.push(Buffer.from(`blob\nmark :${String(index + 1)}\ndata ${String(bytes.length)}\n`), bytes, Buffer.from("\n"));
    commands.push(Buffer.from(`M ${executable ? "100755" : "100644"} :${String(index + 1)} `), quotePath(file.path), Buffer.from("\n"));
  });
  const commit = policy.neutral_commit;
  const message = Buffer.from(`${commit.message}\n`, "utf8");
  const identity = identityLine(commit);
  chunks.push(
    Buffer.from(`commit ${BRANCH}\nauthor ${identity}\ncommitter ${identity}\ndata ${String(message.length)}\n`, "utf8"),
    message,
    ...commands,
    Buffer.from("\ndone\n"),
  );

  const init = withEmptyDirectory((template) => runGit(["init", "--quiet", `--template=${template}`, "--initial-branch=main", copy]));
  if (init.status !== 0) throw new InputError("git_failed");
  // A failure after `git init` removes the new .git, so the copy is left as it was and a retry is possible.
  try {
    const options = { gitDir };
    if (runGit(["config", "core.logAllRefUpdates", "false"], options).status !== 0) throw new InputError("git_failed");
    const imported = runGit(["-c", "core.logAllRefUpdates=false", "-c", "fastimport.unpackLimit=2147483647", "fast-import", "--quiet", "--done", "--date-format=raw"], {
      ...options,
      input: Buffer.concat(chunks),
    });
    if (imported.status !== 0) throw new InputError("git_failed");
    if (runGit([...INDEX_SETTINGS, "read-tree", BRANCH], options).status !== 0) throw new InputError("git_failed");
    const sha = gitOutput(["rev-parse", "--verify", BRANCH], options);
    if (sha === null) throw new InputError("git_failed");
    return sha.toString("utf8").trim();
  } catch (error) {
    rmSync(gitDir, { recursive: true, force: true });
    throw error;
  }
}
