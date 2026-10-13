// The session's in-container shell scripts, run for real with /bin/sh against a temporary tree:
// the write_file placement, the server_logs slice, the tracked-file archive and the end of every
// rbw-app process before a rebuild. Each takes its paths as arguments (or a root prefix), so the
// tests pass temporary ones; the session passes the container's.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extract } from "tar-stream";
import { describe, expect, it } from "vitest";
import { sha256, tempDir } from "../../../local-runner/test/support/synthetic.ts";
import { KILL_APP_SCRIPT } from "../../src/reset.ts";
import { CLEAR_LOGS_SCRIPT, LOG_SLICE_SCRIPT, PLACE_SCRIPT } from "../../src/session.ts";
import { TRACKED_TAR_SCRIPT } from "../../src/tracked.ts";

function sh(script: string, args: readonly string[], env: Record<string, string> = {}): { code: number | null; stdout: Buffer; stderr: string } {
  const result = spawnSync("/bin/sh", ["-c", script, ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr.toString("utf8") };
}

async function tarNames(bytes: Buffer): Promise<string[]> {
  const names: string[] = [];
  const archive = extract();
  archive.on("entry", (header, stream, next) => {
    names.push(header.name);
    stream.on("end", next);
    stream.resume();
  });
  const done = new Promise<void>((resolve, reject) => {
    archive.on("finish", resolve);
    archive.on("error", reject);
  });
  archive.end(bytes);
  await done;
  return names.sort();
}

describe("the write_file placement script", () => {
  function app(): { app: string; staging: string } {
    const root = tempDir("rbw-solver-session-place-");
    const dir = join(root, "app");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/target.ts"), "planted\n", { mode: 0o640 });
    chmodSync(join(dir, "src/target.ts"), 0o640);
    const staging = join(root, "incoming-1");
    writeFileSync(staging, "fixed\n");
    return { app: dir, staging };
  }

  it("writes the staging file over the target in place, keeping its mode, and removes the staging file", () => {
    const { app: dir, staging } = app();
    const result = sh(PLACE_SCRIPT, ["rbw-place", dir, "src/target.ts", staging]);
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe(`${sha256("fixed\n")}  ${dir}/src/target.ts\n`);
    expect(readFileSync(join(dir, "src/target.ts"), "utf8")).toBe("fixed\n");
    expect(statSync(join(dir, "src/target.ts")).mode & 0o7777).toBe(0o640);
    expect(existsSync(staging)).toBe(false);
  });

  it("refuses a symlink or a missing file with exit 3 and removes the staging file", () => {
    const { app: dir, staging } = app();
    symlinkSync("target.ts", join(dir, "src/link.ts"));
    expect(sh(PLACE_SCRIPT, ["rbw-place", dir, "src/link.ts", staging])).toMatchObject({ code: 3, stderr: "not a regular file\n" });
    expect(readlinkSync(join(dir, "src/link.ts"))).toBe("target.ts");
    expect(readFileSync(join(dir, "src/target.ts"), "utf8")).toBe("planted\n");
    expect(existsSync(staging)).toBe(false);
    writeFileSync(staging, "fixed\n");
    expect(sh(PLACE_SCRIPT, ["rbw-place", dir, "src/missing.ts", staging]).code).toBe(3);
    expect(existsSync(join(dir, "src/missing.ts"))).toBe(false);
    expect(existsSync(staging)).toBe(false);
  });
});

describe("the server_logs slice script", () => {
  function slice(log: string | null, offset: number, max: number): { header: string; body: string } {
    const dir = tempDir("rbw-solver-session-log-");
    const file = join(dir, "umami.stderr.log");
    if (log !== null) writeFileSync(file, log);
    const result = sh(LOG_SLICE_SCRIPT, ["rbw-log", file, String(offset), String(max)]);
    expect(result.code).toBe(0);
    const text = result.stdout.toString("utf8");
    const newline = text.indexOf("\n");
    return { header: text.slice(0, newline), body: text.slice(newline + 1) };
  }

  const LOG = "0123456789abcdefghij";

  it("returns the tail with no cursor, or all of a short log", () => {
    expect(slice(LOG, -1, 8)).toEqual({ header: "20 12", body: "cdefghij" });
    expect(slice(LOG, -1, 64)).toEqual({ header: "20 0", body: LOG });
  });

  it("reads forward from a cursor, at most max bytes", () => {
    expect(slice(LOG, 0, 8)).toEqual({ header: "20 0", body: "01234567" });
    expect(slice(LOG, 8, 8)).toEqual({ header: "20 8", body: "89abcdef" });
    expect(slice(LOG, 16, 8)).toEqual({ header: "20 16", body: "ghij" });
  });

  it("returns nothing at a cursor exactly at the size, and the tail for a cursor past it", () => {
    expect(slice(LOG, 20, 8)).toEqual({ header: "20 20", body: "" });
    expect(slice(LOG, 21, 8)).toEqual({ header: "20 12", body: "cdefghij" });
  });

  it("reads a missing log as empty", () => {
    expect(slice(null, -1, 8)).toEqual({ header: "0 0", body: "" });
    expect(slice(null, 5, 8)).toEqual({ header: "0 0", body: "" });
  });
});

describe("the runtime log clearing script", () => {
  it("empties each named log that exists, keeping its mode, and creates none", () => {
    const root = tempDir("rbw-solver-session-clear-");
    const umami = join(root, "umami.stderr.log");
    writeFileSync(umami, "old start\n", { mode: 0o640 });
    const missing = join(root, "postgres.stderr.log");
    const result = sh(CLEAR_LOGS_SCRIPT, ["rbw-clear-logs", umami, missing]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(readFileSync(umami, "utf8")).toBe("");
    expect(statSync(umami).mode & 0o777).toBe(0o640);
    expect(existsSync(missing)).toBe(false);
  });

  it("succeeds when the logs directory does not exist yet", () => {
    const root = tempDir("rbw-solver-session-clear-");
    expect(sh(CLEAR_LOGS_SCRIPT, ["rbw-clear-logs", join(root, "logs", "umami.stderr.log")]).code).toBe(0);
  });
});

describe("the tracked-file archive script", () => {
  it("archives exactly the listed paths that exist, symlinks as links", async () => {
    const root = tempDir("rbw-solver-session-tracked-");
    const dir = join(root, "app");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# app\n");
    writeFileSync(join(dir, "src/a.ts"), "a\n");
    writeFileSync(join(dir, "src/untracked.ts"), "u\n");
    symlinkSync("missing-target", join(dir, "dangling"));
    const list = join(root, "tracked.list");
    const result = sh(TRACKED_TAR_SCRIPT, ["rbw-tracked", dir, list, "README.md", "src/a.ts", "src/deleted.ts", "dangling"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(readFileSync(list, "utf8")).toBe("README.md\nsrc/a.ts\ndangling\n");
    expect(await tarNames(result.stdout)).toEqual(["README.md", "dangling", "src/a.ts"]);
  });
});

describe("the end of every rbw-app process", () => {
  /** A fake /proc under a temporary root, a fake `id`, and `kill`/`sleep` as shell functions that log. */
  function procTree(processes: Record<string, { uid: number; state: string }>): { root: string; bin: string; killed: string } {
    const root = tempDir("rbw-solver-session-kill-");
    for (const [pid, { uid, state }] of Object.entries(processes)) {
      mkdirSync(join(root, "proc", pid), { recursive: true });
      writeFileSync(join(root, "proc", pid, "status"), `Name:\tnode\nState:\t${state} (x)\nPid:\t${pid}\nUid:\t${String(uid)}\t${String(uid)}\t${String(uid)}\t${String(uid)}\n`);
    }
    mkdirSync(join(root, "proc", "self"), { recursive: true });
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "id"), '#!/bin/sh\n[ "$*" = "-u rbw-app" ] && echo 2001\n', { mode: 0o755 });
    return { root, bin, killed: join(root, "killed") };
  }

  const PRELUDE = `kill() { echo "$3" >> "$KILLED"; [ -n "\${KEEP:-}" ] || rm -rf "$ROOT/proc/$3"; }
sleep() { :; }
`;

  function run(tree: { root: string; bin: string; killed: string }, keep = false) {
    return sh(`${PRELUDE}${KILL_APP_SCRIPT}`, ["rbw-kill-app", tree.root], { PATH: `${tree.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, KILLED: tree.killed, ROOT: tree.root, ...(keep ? { KEEP: "1" } : {}) });
  }

  it("kills every live rbw-app process and leaves zombies and other users alone", () => {
    const tree = procTree({ "101": { uid: 2001, state: "S" }, "102": { uid: 2001, state: "R" }, "103": { uid: 2001, state: "Z" }, "104": { uid: 2002, state: "S" }, "105": { uid: 0, state: "S" } });
    const result = run(tree);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.toString()).toBe("killed_rounds=1\n");
    expect(readFileSync(tree.killed, "utf8").split("\n").filter(Boolean).sort()).toEqual(["101", "102"]);
  });

  it("does nothing when no rbw-app process is left", () => {
    const tree = procTree({ "104": { uid: 2002, state: "S" } });
    expect(run(tree)).toMatchObject({ code: 0 });
    expect(existsSync(tree.killed)).toBe(false);
  });

  it("fails when an rbw-app process survives KILL", () => {
    const tree = procTree({ "101": { uid: 2001, state: "S" } });
    const result = run(tree, true);
    expect(result).toMatchObject({ code: 2, stderr: "rbw-kill-app: rbw-app processes survive KILL\n" });
  });
});
