// The real publisher in local mode, in process: a bare repository and a store directory stand in
// for the results repository and the public store, and the C2 scanner runs with a gitleaks stand-in.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "@rbw/publisher";
import type { CliResult } from "@rbw/publisher";
import { parseCanonical } from "@rbw/schema";
import type { PublicationRecord } from "@rbw/schema";
import { tempDir, write } from "./world.ts";
import type { World } from "./world.ts";

const SCANNER = join(new URL("../../../publication/src/cli.ts", import.meta.url).pathname);

const gitEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

export function git(gitDir: string, args: string[]): Buffer {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", `--git-dir=${gitDir}`, ...args], { env: gitEnv, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

export interface Destination {
  dir: string;
  remote: string;
  store: string;
  state: string;
  /** The publisher's local-mode destination flags, with the scanner and the gitleaks stand-in. */
  flags: string[];
}

export function destination(w: World): Destination {
  const dir = tempDir("rbw-release-destination-");
  const remote = join(dir, "remote.git");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote], { env: gitEnv });
  const store = join(dir, "store");
  mkdirSync(store);
  return {
    dir,
    remote,
    store,
    state: join(dir, "private", "state"),
    flags: ["--local-remote", remote, "--local-store", store, "--scanner", `${process.execPath} ${SCANNER}`, "--gitleaks", w.gitleaks],
  };
}

export async function publish(w: World, d: Destination, options: { rootRun: string; staging: string; redactions?: string }): Promise<{ result: CliResult; record: PublicationRecord | null }> {
  const result = await runCli([
    "publish",
    "--policy", w.policy.file,
    "--root-run", options.rootRun,
    "--staging", options.staging,
    "--state", d.state,
    "--patterns", w.patterns,
    ...(options.redactions === undefined ? [] : ["--redaction-values", options.redactions]),
    ...d.flags,
  ]);
  const record = result.stdout.startsWith("{") ? (parseCanonical(Buffer.from(result.stdout.trim())) as unknown as PublicationRecord) : null;
  return { result, record };
}

/** The files of the remote branch under a prefix, written below `out` (a fresh clone's view of that directory). */
export function checkout(remote: string, prefix: string, out: string = tempDir("rbw-release-checkout-")): string {
  const listing = git(remote, ["ls-tree", "-r", "-z", "refs/heads/main", "--", prefix]).toString("utf8");
  for (const line of listing.split("\0").filter((item) => item.length > 0)) {
    const [meta = "", path = ""] = line.split("\t");
    write(join(out, path.slice(prefix.length + 1)), git(remote, ["cat-file", "blob", meta.split(" ")[2] ?? ""]));
  }
  return out;
}

export function commitCount(remote: string): number {
  try {
    return Number(git(remote, ["rev-list", "--count", "refs/heads/main"]).toString("utf8").trim());
  } catch {
    return 0;
  }
}
