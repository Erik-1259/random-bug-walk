/**
 * PUB-02 integration proof: runs the helper and the wrapper as separate processes against
 * a temporary inbox, registry, working copy and local bare remote, with the gitleaks
 * command taken the same way as the scanner CLI. Prints one PASS or FAIL line per check.
 *
 *   pnpm --filter @rbw/publication run proof [--gitleaks <command>]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveGitleaksCommand } from "../src/config.ts";
import { runProcess, type ProcessResult } from "../src/run.ts";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = join(packageDir, "src", "helper.ts");
const cliPath = join(packageDir, "src", "cli.ts");
const wrapperPath = join(packageDir, "bin", "rbw-publish");
const hookPath = join(packageDir, "hooks", "pre-push");

const OWNER = "synthetic-owner";
const REPOSITORY = `${OWNER}/synthetic-repo`;
const IDENTITY = { name: "synthetic-proof", email: "synthetic-proof@example.invalid" };

const results: boolean[] = [];
function check(name: string, ok: boolean): void {
  results.push(ok);
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}\n`);
}

const setupEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_AUTHOR_NAME: "synthetic-proof",
  GIT_AUTHOR_EMAIL: "synthetic-proof@example.invalid",
  GIT_COMMITTER_NAME: "synthetic-proof",
  GIT_COMMITTER_EMAIL: "synthetic-proof@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await runProcess("git", args, { cwd, env: setupEnv, input: input === undefined ? undefined : Buffer.from(input) });
  if (result.code !== 0) throw new Error(`setup git ${args[0] ?? ""} failed`);
  return result.stdout.toString("utf8").trim();
}

async function put(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function commitFiles(repo: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) await put(join(repo, path), content);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "--no-verify", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** Commits blobs straight into the index, so names that collide on this file system still differ in git. */
async function commitIndexEntries(repo: string, entries: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(entries)) {
    const blob = await git(repo, ["hash-object", "-w", "--stdin"], content);
    await git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
  }
  await git(repo, ["commit", "-q", "--no-verify", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function remoteHead(cwd: string, remote: string, branch: string): Promise<string | null> {
  const out = await git(cwd, ["ls-remote", remote, `refs/heads/${branch}`]);
  return out === "" ? null : (out.split("\t")[0] ?? null);
}

async function remoteHas(remote: string, sha: string): Promise<boolean> {
  return (await runProcess("git", ["--git-dir", remote, "cat-file", "-e", `${sha}^{commit}`], { cwd: remote, env: setupEnv })).code === 0;
}

function wrapper(cwd: string, args: string[]): Promise<ProcessResult> {
  return runProcess(wrapperPath, args, { cwd, env: setupEnv, timeoutMs: 300_000 });
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function visible(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => !name.startsWith("."));
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.on("exit", (code) => {
    resolve(code);
  }));
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

async function main(): Promise<number> {
  // pnpm 10 forwards a literal "--" before the script arguments.
  const argv = process.argv.slice(2);
  const { values } = parseArgs({ args: argv[0] === "--" ? argv.slice(1) : argv, options: { gitleaks: { type: "string" } }, strict: true });
  const gitleaks = resolveGitleaksCommand(values.gitleaks, process.env);
  const root = await realpath(await mkdtemp(join(tmpdir(), "rbw-proof-")));
  try {
    return await prove(root, gitleaks);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function prove(root: string, gitleaks: string): Promise<number> {
  const term = `synthetic-proof-canary-${randomBytes(6).toString("hex")}`;
  const host = join(root, "host");
  const patterns = join(host, "patterns.txt");
  await put(patterns, `# synthetic proof list\n${term}\n`);
  const inbox = join(root, "inbox");
  await mkdir(inbox);
  const state = join(host, "state");
  const registryPath = join(host, "registry.json");
  const remote = join(root, "remote.git");
  await mkdir(remote);
  await git(remote, ["init", "-q", "--bare", "-b", "main"]);

  const clone = join(root, "clone");
  await mkdir(clone);
  await git(clone, ["init", "-q", "-b", "main"]);
  await put(join(clone, "tools", "publication", "hooks", "pre-push"), await readFile(hookPath));
  await chmod(join(clone, "tools", "publication", "hooks", "pre-push"), 0o755);
  const base = await commitFiles(
    clone,
    { "README.md": "Synthetic proof project.\n", LICENSE: "MIT License\n\nCopyright (c) 2026 Synthetic Proof Holder\n" },
    "chore: synthetic base",
  );
  await git(clone, ["config", "--file", join(clone, ".git", "config"), "rbw.worktreeId", "proof-worktree"]);
  const cloneToken = randomBytes(32).toString("hex");
  await git(clone, ["config", "--file", join(clone, ".git", "config"), "rbw.worktreeToken", cloneToken]);
  await git(clone, ["push", "-q", "--no-verify", remote, `${base}:refs/heads/main`]);

  const branch = "synthetic/proof";
  const worktrees: Record<string, unknown> = {
    "proof-worktree": { path: clone, remote, repository: REPOSITORY, branch, approvedBase: base, identity: IDENTITY, token: cloneToken },
  };
  const writeRegistry = (): Promise<void> => put(registryPath, JSON.stringify({ version: 1, worktrees }, null, 2));
  await writeRegistry();

  const helperArgs = (patternFile = patterns): string[] => [
    "--inbox", inbox, "--registry", registryPath, "--state", state, "--patterns", patternFile,
    "--gitleaks", gitleaks, "--gh", join(host, "no-gh"),
  ];
  const helperOnce = (patternFile?: string, env: Record<string, string> = {}): Promise<ProcessResult> =>
    runProcess(process.execPath, [helperPath, "once", ...helperArgs(patternFile)], { cwd: host, env: { ...setupEnv, ...env }, timeoutMs: 300_000 });
  const requestsDir = join(inbox, "publication", "requests");
  const responsesDir = join(inbox, "publication", "responses");
  const hasRequest = async (): Promise<boolean> => (await visible(requestsDir)).length > 0;
  await helperOnce();

  /** Runs the wrapper for one push and lets a helper `once` answer it. */
  const pushThroughHelper = async (args: string[] = [], patternFile?: string): Promise<ProcessResult> => {
    const pending = wrapper(clone, ["push", ...args, "--inbox", inbox, "--claim-timeout", "120", "--result-timeout", "300"]);
    await waitFor(hasRequest);
    await helperOnce(patternFile);
    return pending;
  };

  // Case 1: a clean push publishes exactly the candidate to the allowed branch.
  const c1 = await commitFiles(clone, { "src/app.ts": "export const value = 1;\n" }, "feat: synthetic clean change");
  const case1 = await pushThroughHelper();
  check(
    "case 1: clean push publishes exactly the candidate and the remote ref equals the SHA",
    case1.code === 0 && case1.stdout.toString("utf8") === `published\n${c1}\n` && (await remoteHead(root, remote, branch)) === c1,
  );

  // Case 2: a forbidden synthetic term is blocked; only the location is shown.
  const c2 = await commitFiles(clone, { "docs/notes.md": `Notes\nmentions ${term} here\n` }, "docs: synthetic notes");
  const case2 = await pushThroughHelper();
  const responses2 = await Promise.all((await visible(responsesDir)).map((name) => readFile(join(responsesDir, name), "utf8")));
  const helperLog = await readFile(join(state, "helper.log"), "utf8");
  check(
    "case 2: a forbidden term is blocked with only its location and the remote is unchanged",
    case2.code === 1 &&
      case2.stdout.toString("utf8") === "blocked\ndocs/notes.md:2\n" &&
      !contains(case2.stdout.toString("utf8") + case2.stderr.toString("utf8"), term) &&
      !responses2.some((text) => contains(text, term)) &&
      !contains(helperLog, term) &&
      (await remoteHead(root, remote, branch)) === c1 &&
      !(await remoteHas(remote, c2)),
  );
  await git(clone, ["reset", "-q", "--hard", c1]);

  // Case 3: a missing pattern file gives unavailable; an unclaimed request is withdrawn.
  const c3 = await commitFiles(clone, { "src/more.ts": "export const more = 2;\n" }, "feat: synthetic second change");
  const missing = await pushThroughHelper([], join(host, "missing-patterns.txt"));
  const before = (await visible(responsesDir)).length;
  const withdrawn = await wrapper(clone, ["push", "--inbox", inbox, "--claim-timeout", "2", "--result-timeout", "10"]);
  const leftover = await visible(requestsDir);
  await helperOnce();
  const after = (await visible(responsesDir)).length;
  check(
    "case 3: missing pattern file gives unavailable; a timed-out request is withdrawn and never published",
    missing.code === 2 &&
      missing.stdout.toString("utf8").startsWith("unavailable\n") &&
      withdrawn.code === 2 &&
      withdrawn.stdout.toString("utf8").startsWith("unavailable\n") &&
      leftover.length === 0 &&
      after === before &&
      (await remoteHead(root, remote, branch)) === c1,
  );

  // Case 4: HEAD moves to a forbidden commit after the request; only the requested SHA is published.
  const pending4 = wrapper(clone, ["push", "--inbox", inbox, "--claim-timeout", "120", "--result-timeout", "300"]);
  await waitFor(hasRequest);
  const c4 = await commitFiles(clone, { "docs/later.md": `${term}\n` }, "docs: synthetic later change");
  const serve = spawn(process.execPath, [helperPath, "serve", ...helperArgs(), "--poll-interval-ms", "200"], {
    cwd: host,
    env: setupEnv,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const serveExit = exited(serve);
  const case4 = await pending4;
  serve.kill("SIGTERM");
  const serveCode = await serveExit;
  check(
    "case 4: the requested commit is published, not the later HEAD with a forbidden term",
    case4.code === 0 &&
      case4.stdout.toString("utf8") === `published\n${c3}\n` &&
      (await remoteHead(root, remote, branch)) === c3 &&
      !(await remoteHas(remote, c4)) &&
      serveCode === 0,
  );
  await git(clone, ["reset", "-q", "--hard", c3]);

  // Additional: a wrong worktree token and a commit with another identity are refused.
  await git(clone, ["config", "--file", join(clone, ".git", "config"), "rbw.worktreeToken", randomBytes(32).toString("hex")]);
  const c6 = await commitFiles(clone, { "src/token.ts": "export const t = 1;\n" }, "feat: synthetic token change");
  const wrongToken = await pushThroughHelper();
  await git(clone, ["config", "--file", join(clone, ".git", "config"), "rbw.worktreeToken", cloneToken]);
  const tokenLog = await readFile(join(state, "helper.log"), "utf8");
  check(
    "token: a request with another worktree token is blocked without locations and the token is never logged",
    wrongToken.code === 1 && wrongToken.stdout.toString("utf8").split("\n")[1]?.includes("refused") === true &&
      !(await remoteHas(remote, c6)) && tokenLog.includes("category=invalid-token") && !tokenLog.includes(cloneToken) &&
      !(wrongToken.stdout.toString("utf8") + wrongToken.stderr.toString("utf8")).includes(cloneToken),
  );
  await git(clone, ["reset", "-q", "--hard", c3]);
  await put(join(clone, "src", "other.ts"), "export const other = 1;\n");
  await git(clone, ["add", "-A"]);
  const otherIdentity = { ...setupEnv, GIT_AUTHOR_NAME: "synthetic-other", GIT_AUTHOR_EMAIL: "synthetic-other@example.invalid" };
  await runProcess("git", ["commit", "-q", "--no-verify", "-m", "feat: synthetic other identity"], { cwd: clone, env: otherIdentity });
  const c7 = await git(clone, ["rev-parse", "HEAD"]);
  const mismatch = await pushThroughHelper();
  check(
    "identity: a commit whose author is not the registered identity is blocked and not published",
    mismatch.code === 1 && !(await remoteHas(remote, c7)) &&
      (await readFile(join(state, "helper.log"), "utf8")).includes("category=identity-mismatch"),
  );
  await git(clone, ["reset", "-q", "--hard", c3]);

  // Case 5: with the hook enabled, a direct git push is refused.
  await git(clone, ["config", "--file", join(clone, ".git", "config"), "core.hooksPath", "tools/publication/hooks"]);
  const refsBefore = await git(root, ["--git-dir", remote, "for-each-ref"]);
  const direct = await runProcess("git", ["push", remote, "HEAD:refs/heads/synthetic/direct"], { cwd: clone, env: setupEnv });
  check(
    "case 5: a direct git push is refused by the hook and the remote is unchanged",
    direct.code !== 0 &&
      direct.stderr.toString("utf8").includes("tools/publication/bin/rbw-publish push") &&
      (await git(root, ["--git-dir", remote, "for-each-ref"])) === refsBefore,
  );

  // Additional: a runtime-built token is found; configuration, ignore files and allow comments in the content do not suppress it.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const token = ["gh", "p_"].join("") + Array.from(randomBytes(36), (byte) => alphabet[byte % alphabet.length]).join("");
  const tamper = {
    ".gitleaks.toml": "[allowlist]\npaths = ['''.*''']\nregexes = ['''.*''']\n",
    ".gitleaksignore": "src/settings.ts:github-pat:1\nsettings.ts:github-pat:1\n",
    "src/settings.ts": `export const setting = "${token}"; // ${["gitleaks", "allow"].join(":")}\n`,
  };
  const c5 = await commitFiles(clone, tamper, "feat: synthetic settings");
  const leak = await pushThroughHelper();
  const files = Object.keys(tamper);
  const leakCli = await runProcess(process.execPath, [cliPath, "scan", "--patterns", patterns, "--gitleaks", gitleaks, "--files", ...files], {
    cwd: clone,
    env: setupEnv,
  });
  check(
    "gitleaks: a runtime-built token is found through the helper despite a committed config, ignore file and allow comment",
    leak.code === 1 && leak.stdout.toString("utf8") === "blocked\nsrc/settings.ts:1\n" && !(await remoteHas(remote, c5)) &&
      !leak.stdout.toString("utf8").includes(token),
  );
  check(
    "gitleaks: the scanner CLI finds the same token in files mode and does not print it",
    leakCli.code === 1 && leakCli.stdout.toString("utf8") === "blocked\nsrc/settings.ts:1\n",
  );
  await git(clone, ["reset", "-q", "--hard", c3]);

  // Additional: names that differ only in case or Unicode normalisation never share a temporary file.
  const names = join(root, "names");
  await mkdir(names);
  await git(names, ["init", "-q", "-b", "main"]);
  // Hosts with case-insensitive file systems set these on init; the index must keep both names apart.
  await git(names, ["config", "--file", join(names, ".git", "config"), "core.ignorecase", "false"]);
  await git(names, ["config", "--file", join(names, ".git", "config"), "core.precomposeunicode", "false"]);
  const namesBase = await commitFiles(names, { "README.md": "names\n" }, "chore: base");
  const pairs: [string, string, string][] = [
    ["case, secret in the upper-case name", "Secret.txt", "secret.txt"],
    ["case, secret in the lower-case name", "secret.txt", "Secret.txt"],
    ["normalisation, secret in the composed name", "caf\u00e9.txt", "cafe\u0301.txt"],
    ["normalisation, secret in the decomposed name", "cafe\u0301.txt", "caf\u00e9.txt"],
  ];
  for (const [label, secretName, cleanName] of pairs) {
    await git(names, ["reset", "-q", "--hard", namesBase]);
    await commitIndexEntries(names, { [secretName]: `key = "${token}"\n`, [cleanName]: "nothing here\n" }, "feat: pair");
    const result = await runProcess(
      process.execPath,
      [cliPath, "scan", "--patterns", patterns, "--gitleaks", gitleaks, "--range", `${namesBase}..HEAD`],
      { cwd: names, env: setupEnv },
    );
    check(`gitleaks: names differing by ${label} give blocked`, result.code === 1 && result.stdout.toString("utf8") === `blocked\n${secretName}:1\n`);
  }

  // Additional: hostile and partial-clone working copies run nothing, with GIT_NO_LAZY_FETCH=0 given to the helper.
  const markers = join(root, "markers");
  await mkdir(markers);
  const markScript = join(root, "mark.sh");
  await put(markScript, `#!/bin/sh\ntouch "${markers}/$(basename "$0")-$$"\nexit 1\n`);
  await chmod(markScript, 0o755);
  const makeCopy = async (name: string, files: Record<string, string>): Promise<{ path: string; base: string; head: string }> => {
    const path = join(root, name);
    await mkdir(path);
    await git(path, ["init", "-q", "-b", "main"]);
    const copyBase = await commitFiles(path, { "README.md": `${name}\n` }, "chore: base");
    const head = await commitFiles(path, files, "feat: change");
    return { path, base: copyBase, head };
  };
  const setConfig = (repo: string, key: string, value: string): Promise<string> =>
    git(repo, ["config", "--file", join(repo, ".git", "config"), key, value]);
  const tokens = new Map<string, string>();
  const writeRequest = async (worktreeId: string, sha: string): Promise<string> => {
    const requestId = `proof-${randomBytes(6).toString("hex")}`;
    const token = tokens.get(worktreeId);
    await put(join(requestsDir, `${requestId}.json`), JSON.stringify({ version: 1, requestId, worktreeId, token, operation: "push", sha }));
    return requestId;
  };
  const response = async (requestId: string): Promise<Record<string, unknown> | null> => {
    const path = join(responsesDir, `${requestId}.json`);
    return (await visible(responsesDir)).includes(`${requestId}.json`) ? (JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>) : null;
  };

  const hostile = await makeCopy("hostile", { "src/a.ts": "export const a = 1;\n" });
  const hooks = join(root, "hostile-hooks");
  for (const hook of ["pre-commit", "post-commit", "pre-push", "pre-receive", "update", "post-update", "post-checkout", "reference-transaction", "push-to-checkout", "post-index-change", "fsmonitor-watchman", "pre-auto-gc"]) {
    for (const dir of [hooks, join(hostile.path, ".git", "hooks")]) {
      await put(join(dir, hook), `#!/bin/sh\nexec "${markScript}"\n`);
      await chmod(join(dir, hook), 0o755);
    }
  }
  for (const [key, value] of [
    ["core.fsmonitor", markScript], ["core.hooksPath", hooks], ["credential.helper", `!${markScript}`],
    ["core.sshCommand", markScript], ["core.askPass", markScript], ["uploadpack.packObjectsHook", markScript],
    ["alias.fetch", `!${markScript}`], ["alias.upload-pack", `!${markScript}`], ["remote.origin.url", "ssh://example.invalid/synthetic.git"],
    ["remote.origin.uploadpack", markScript],
  ] as const) await setConfig(hostile.path, key, value);

  const partial = await makeCopy("partial", { "data/lost.txt": "synthetic content only in the lost blob\n" });
  const lostBlob = await git(partial.path, ["rev-parse", `${partial.head}:data/lost.txt`]);
  for (const [key, value] of [
    ["core.repositoryformatversion", "1"], ["extensions.partialClone", "origin"], ["remote.origin.url", "ssh://example.invalid/synthetic.git"],
    ["remote.origin.promisor", "true"], ["remote.origin.partialclonefilter", "blob:none"], ["core.sshCommand", markScript],
  ] as const) await setConfig(partial.path, key, value);
  await rm(join(partial.path, ".git", "objects", lostBlob.slice(0, 2), lostBlob.slice(2)));

  for (const [id, copy, copyBranch] of [["proof-hostile", hostile, "synthetic/hostile"], ["proof-partial", partial, "synthetic/partial"]] as const) {
    tokens.set(id, randomBytes(32).toString("hex"));
    worktrees[id] = { path: copy.path, remote, repository: REPOSITORY, branch: copyBranch, approvedBase: copy.base, identity: IDENTITY, token: tokens.get(id) };
  }
  await writeRegistry();
  const hostileId = await writeRequest("proof-hostile", hostile.head);
  const partialId = await writeRequest("proof-partial", partial.head);
  await helperOnce(undefined, { GIT_NO_LAZY_FETCH: "0" });
  const markerFiles = await readdir(markers);
  check(
    "hostile working copy: published with no command from its config or hooks run",
    (await response(hostileId))?.outcome === "published" && (await remoteHead(root, remote, "synthetic/hostile")) === hostile.head && markerFiles.length === 0,
  );
  check(
    "partial clone: a missing promised blob gives stale and its promisor command never runs",
    (await response(partialId))?.outcome === "stale" && (await remoteHead(root, remote, "synthetic/partial")) === null && markerFiles.length === 0,
  );

  const failed = results.filter((ok) => !ok).length;
  process.stdout.write(`proof: ${String(results.length - failed)} passed, ${String(failed)} failed\n`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main();

