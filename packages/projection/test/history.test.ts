import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  EXCLUSIONS,
  Fixture,
  MUTATED_PATH,
  NEUTRAL,
  ORIGINAL_QUERY,
  RESULT_QUERY,
  STRICT,
  cli,
  expectNoTerm,
  fixtureGitEnv,
  locations,
  reasons,
  spawnCli,
  tempRoot,
} from "./support.ts";

function neutralEnv(): NodeJS.ProcessEnv {
  return fixtureGitEnv({
    GIT_AUTHOR_NAME: NEUTRAL.name,
    GIT_AUTHOR_EMAIL: NEUTRAL.email,
    GIT_AUTHOR_DATE: NEUTRAL.date,
    GIT_COMMITTER_NAME: NEUTRAL.name,
    GIT_COMMITTER_EMAIL: NEUTRAL.email,
    GIT_COMMITTER_DATE: NEUTRAL.date,
  });
}

/** A HOME whose git configuration names a build-machine identity, a template with a hook and a hooks path. */
function buildMachineHome(): { home: string; marker: string } {
  const home = tempRoot();
  const template = join(home, "template");
  const hooks = join(home, "hooks");
  const marker = join(home, "hook-ran");
  mkdirSync(join(template, "hooks"), { recursive: true });
  mkdirSync(hooks);
  writeFileSync(join(template, "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const name of ["pre-commit", "post-commit", "reference-transaction", "post-checkout", "post-index-change"]) {
    writeFileSync(join(hooks, name), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  }
  writeFileSync(
    join(home, ".gitconfig"),
    `[user]\n\tname = Synthetic Builder\n\temail = builder@example.invalid\n[init]\n\ttemplateDir = ${template}\n\tdefaultBranch = trunk\n[core]\n\thooksPath = ${hooks}\n\tlogAllRefUpdates = always\n`,
  );
  return { home, marker };
}

/** The 1-based line of .git/config that holds the strict term. */
function configLine(fixture: Fixture): number {
  return readFileSync(join(fixture.copy, ".git", "config"), "utf8").split("\n").findIndex((line) => line.includes(STRICT)) + 1;
}

/** Replaces the copy with a clone of the upstream repository, then applies the projection on top. */
function cloneInto(fixture: Fixture, args: string[]): void {
  execFileSync("git", ["clone", "-q", ...args, `file://${fixture.repo}`, fixture.copy], { env: fixtureGitEnv() });
  unlinkSync(join(fixture.copy, "src", "app.test.ts"));
  unlinkSync(join(fixture.copy, "answers", "notes.txt"));
  unlinkSync(join(fixture.copy, "answers", "deep", "more.txt"));
  writeFileSync(join(fixture.copy, MUTATED_PATH), RESULT_QUERY);
}

describe("commit-neutral", () => {
  it("ADM-01 writes exactly one parentless commit with the neutral identity, date and message", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    expect(fixture.copyGit(["rev-list", "--all", "--count"])).toBe("1");
    const raw = fixture.copyGit(["cat-file", "commit", "HEAD"]);
    const tree = fixture.copyGit(["rev-parse", "HEAD^{tree}"]);
    expect(raw).toBe(
      `tree ${tree}\nauthor workspace <workspace@example.invalid> 946684800 +0000\ncommitter workspace <workspace@example.invalid> 946684800 +0000\n\nInitial commit`,
    );
    expect(fixture.copyGit(["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");
    expect(fixture.copyGit(["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
  });

  it("ADM-01 commits the copy as audited, mutation included, with modes and no other object", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const listing = fixture.copyGit(["ls-tree", "-r", "--full-tree", "HEAD"]);
    expect(listing).toContain(`100755 blob ${fixture.copyGit(["hash-object", "bin/run.sh"])}\tbin/run.sh`);
    expect(fixture.copyGit(["cat-file", "blob", `HEAD:${MUTATED_PATH}`])).toBe(RESULT_QUERY.trimEnd());
    expect(listing).not.toContain("src/app.test.ts");
    const all = fixture.copyGit(["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]).split("\n");
    const reachable = fixture.copyGit(["rev-list", "--objects", "--no-object-names", "HEAD"]).split("\n");
    expect(all.sort()).toEqual(reachable.sort());
    const originalBlob = execFileSync("git", ["hash-object", "--stdin"], { input: ORIGINAL_QUERY, encoding: "utf8" }).trim();
    expect(all).not.toContain(originalBlob);
  });

  it("ADM-01 writes no hooks, no reflogs and no template files", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const gitDir = join(fixture.copy, ".git");
    expect(existsSync(join(gitDir, "hooks")) ? readdirSync(join(gitDir, "hooks")) : []).toEqual([]);
    expect(existsSync(join(gitDir, "logs"))).toBe(false);
    expect(existsSync(join(gitDir, "description"))).toBe(false);
    expect(existsSync(join(gitDir, "info", "exclude"))).toBe(false);
  });

  it("ADM-01 ignores the build machine's git identity, configuration, template, hooks and GIT_ variables", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    const { home, marker } = buildMachineHome();
    const result = spawnCli(["commit-neutral", "--dir", fixture.copy, "--policy", fixture.policyPath], {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_AUTHOR_NAME: "Synthetic Builder",
      GIT_AUTHOR_EMAIL: "builder@example.invalid",
      GIT_COMMITTER_NAME: "Synthetic Builder",
      GIT_TEMPLATE_DIR: join(home, "template"),
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    const raw = fixture.copyGit(["cat-file", "commit", "HEAD"]);
    expect(raw).not.toContain("Synthetic Builder");
    expect(raw).not.toContain("builder@example.invalid");
    expect(fixture.copyGit(["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    const audit = await fixture.audit();
    expect(audit.report.findings).toEqual([]);
  });

  it("ADM-01 uses the policy's neutral identity and the defaults when the policy omits it", async () => {
    const custom = new Fixture();
    await custom.prepare();
    const identity = { name: "builder", email: "builder@example.invalid", date: "2001-01-01T12:00:00Z", message: "Snapshot" };
    custom.writePolicy({ dependency_links: [], exclusions: EXCLUSIONS, neutral_commit: identity });
    expect((await custom.commitNeutral()).code).toBe(0);
    expect(custom.copyGit(["log", "-1", "--format=%an|%ae|%at|%ad|%s", "--date=raw"])).toBe("builder|builder@example.invalid|978350400|978350400 +0000|Snapshot");
    expect((await custom.audit()).code).toBe(0);

    const defaults = new Fixture();
    await defaults.prepare();
    defaults.writePolicy({ exclusions: EXCLUSIONS });
    expect((await defaults.commitNeutral()).code).toBe(0);
    expect(defaults.copyGit(["log", "-1", "--format=%an|%ae|%at|%s"])).toBe("workspace|workspace@example.invalid|946684800|Initial commit");
  });

  it("ADM-01 refuses a copy that already has a .git", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const head = fixture.copyGit(["rev-parse", "HEAD"]);
    const again = await fixture.commitNeutral();
    expect(again.code).toBe(2);
    expect(again.stderr).toContain("git_exists");
    expect(fixture.copyGit(["rev-parse", "HEAD"])).toBe(head);
  });

  it("removes its partial .git when git refuses a path, so the copy is left as it was", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    mkdirSync(join(fixture.copy, "vendor", ".git"), { recursive: true });
    writeFileSync(join(fixture.copy, "vendor", ".git", "config"), "synthetic\n");
    const result = await fixture.commitNeutral();
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("commit-neutral: git_failed\n");
    expect(existsSync(join(fixture.copy, ".git"))).toBe(false);
    expect(existsSync(join(fixture.copy, "vendor", ".git", "config"))).toBe(true);
  });

  it("refuses a malformed policy and a missing directory", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    writeFileSync(fixture.policyPath, JSON.stringify({ exclusions: [], extra: true }));
    expect((await fixture.commitNeutral()).code).toBe(2);
    expect(existsSync(join(fixture.copy, ".git"))).toBe(false);
    fixture.writePolicy();
    const missing = await cli(["commit-neutral", "--dir", join(fixture.root, "absent"), "--policy", fixture.policyPath]);
    expect(missing.code).toBe(2);
  });
});

describe("history checks", () => {
  it("ADM-01 refuses a copy without .git with git_missing", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_missing"]);
    expect(locations(result, "git_missing")).toEqual([".git"]);
  });

  it("ADM-01 refuses a .git file pointing elsewhere with git_missing", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    writeFileSync(join(fixture.copy, ".git"), `gitdir: ${join(fixture.repo, ".git")}\n`);
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_missing"]);
  });

  it("ADM-01 refuses a full-history clone with git_history", async () => {
    const fixture = new Fixture();
    await fixture.prepareInputs();
    cloneInto(fixture, []);
    const result = await fixture.audit();
    expect(result.code).toBe(1);
    expect(reasons(result)).toContain("git_history");
    expect(reasons(result)).toContain("git_extra_ref");
    expect(reasons(result)).toContain("git_identity");
  });

  it("ADM-01 refuses a depth-1 shallow clone with git_history at .git/shallow", async () => {
    const fixture = new Fixture();
    await fixture.prepareInputs();
    cloneInto(fixture, ["--depth=1"]);
    const result = await fixture.audit();
    expect(locations(result, "git_history")).toContain(".git/shallow");
  });

  it("ADM-01 refuses a second commit with git_history", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const tree = fixture.copyGit(["rev-parse", "HEAD^{tree}"]);
    const second = fixture.copyGit(["commit-tree", tree, "-p", "HEAD", "-m", NEUTRAL.message], neutralEnv());
    fixture.copyGit(["-c", "core.logAllRefUpdates=false", "update-ref", "refs/heads/main", second]);
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_history"]);
  });

  it("ADM-01 refuses a reflog with git_history", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    mkdirSync(join(fixture.copy, ".git", "logs"));
    writeFileSync(join(fixture.copy, ".git", "logs", "HEAD"), `${"0".repeat(40)} ${"1".repeat(40)} x <x@example.invalid> 1 +0000\tcommit: older\n`);
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_history"]);
    expect(locations(result, "git_history")).toEqual([".git/logs/HEAD"]);
  });

  it("ADM-01 refuses grafts and an alternates file with git_history", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const emptyStore = tempRoot();
    mkdirSync(join(fixture.copy, ".git", "objects", "info"), { recursive: true });
    writeFileSync(join(fixture.copy, ".git", "objects", "info", "alternates"), `${emptyStore}\n`);
    mkdirSync(join(fixture.copy, ".git", "info"), { recursive: true });
    writeFileSync(join(fixture.copy, ".git", "info", "grafts"), "\n");
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_history"]);
    expect(locations(result, "git_history")).toEqual([".git/info/grafts", ".git/objects/info/alternates"]);
  });

  it("ADM-01 refuses a replace ref with git_history and git_extra_ref", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const tree = fixture.copyGit(["rev-parse", "HEAD^{tree}"]);
    const other = fixture.copyGit(["commit-tree", tree, "-m", "replacement"], neutralEnv());
    fixture.copyGit(["update-ref", `refs/replace/${fixture.copyGit(["rev-parse", "HEAD"])}`, other]);
    const result = await fixture.audit();
    expect(reasons(result)).toContain("git_extra_ref");
    expect(reasons(result)).toContain("git_history");
  });

  it("ADM-01 refuses a non-neutral identity with git_identity", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    const { home } = buildMachineHome();
    const emptyTemplate = tempRoot();
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["init", "-q", `--template=${emptyTemplate}`], { cwd: fixture.copy, env });
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.logAllRefUpdates=false", "add", "-A"], { cwd: fixture.copy, env });
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.logAllRefUpdates=false", "commit", "-q", "-m", "Initial commit"], { cwd: fixture.copy, env });
    execFileSync("git", ["-c", "core.logAllRefUpdates=false", "branch", "-q", "-m", "main"], { cwd: fixture.copy, env });
    unlinkSync(join(fixture.copy, ".git", "COMMIT_EDITMSG"));
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_identity", "git_tree_mismatch"]);
    expect(locations(result, "git_identity")).toEqual([".git"]);
    // An index written by `git commit` carries stat data, so it is not the index commit-neutral leaves.
    expect(locations(result, "git_tree_mismatch")).toEqual([".git/index"]);
  });

  it("ADM-01 refuses a commit whose identity differs from the audit policy with git_identity", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    fixture.writePolicy({ dependency_links: [], exclusions: EXCLUSIONS, neutral_commit: { ...NEUTRAL, message: "Another message" } });
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_identity"]);
    expect(result.report.git).toMatchObject({ message_matches_policy: false });
  });

  it("ADM-01 refuses a tree that does not hold exactly the copy's files with git_tree_mismatch", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    writeFileSync(join(fixture.copy, "late.txt"), "added after the commit\n");
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_tree_mismatch", "unlisted_file"]);
    expect(locations(result, "git_tree_mismatch")).toEqual(["late.txt"]);
  });

  it("ADM-01 refuses a tag, a remote, a remote ref, a stash and ORIG_HEAD with git_extra_ref", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const head = fixture.copyGit(["rev-parse", "HEAD"]);
    fixture.copyGit(["tag", "v1"]);
    fixture.copyGit(["remote", "add", "origin", "https://example.invalid/upstream.git"]);
    fixture.copyGit(["-c", "core.logAllRefUpdates=false", "update-ref", "refs/remotes/origin/main", head]);
    fixture.copyGit(["-c", "core.logAllRefUpdates=false", "update-ref", "refs/stash", head]);
    writeFileSync(join(fixture.copy, ".git", "ORIG_HEAD"), `${head}\n`);
    writeFileSync(join(fixture.copy, ".git", "FETCH_HEAD"), `${head}\t\tbranch 'main' of example.invalid\n`);
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_extra_ref"]);
    expect(locations(result, "git_extra_ref")).toEqual([
      ".git/FETCH_HEAD",
      ".git/ORIG_HEAD",
      ".git/config",
      ".git/refs/remotes/origin/main",
      ".git/refs/stash",
      ".git/refs/tags/v1",
    ]);
  });

  it("ADM-01 refuses a branch other than main and a detached HEAD with git_extra_ref", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const head = fixture.copyGit(["rev-parse", "HEAD"]);
    fixture.copyGit(["-c", "core.logAllRefUpdates=false", "branch", "topic"]);
    writeFileSync(join(fixture.copy, ".git", "HEAD"), `${head}\n`);
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_extra_ref"]);
    expect(locations(result, "git_extra_ref")).toEqual([".git/HEAD", ".git/refs/heads/topic"]);
  });

  it("ADM-01 refuses an index that names a file the commit does not hold with git_tree_mismatch", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const blob = execFileSync("git", ["hash-object", "--stdin"], { input: "synthetic notes\n", encoding: "utf8" }).trim();
    fixture.copyGit(["update-index", "--add", "--cacheinfo", `100644,${blob},answers/notes.txt`]);
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_tree_mismatch"]);
    expect(locations(result, "git_tree_mismatch")).toEqual([".git/index"]);
  });

  it("ADM-01 refuses a copy whose only branch is not main, and still checks HEAD's commit", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const head = fixture.copyGit(["rev-parse", "HEAD"]);
    fixture.copyGit(["-c", "core.logAllRefUpdates=false", "branch", "-m", "main", "trunk"]);
    writeFileSync(join(fixture.copy, "late.txt"), "added after the commit\n");
    const result = await fixture.audit();
    expect(locations(result, "git_history")).toEqual([".git"]);
    expect(locations(result, "git_extra_ref")).toEqual([".git/HEAD", ".git/refs/heads/trunk"]);
    expect(locations(result, "git_tree_mismatch")).toEqual(["late.txt"]);
    expect(result.report.git).toMatchObject({ commit: head });
  });

  it("ADM-01 refuses a stray unreachable blob of the original file with git_extra_object", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: fixture.copy, input: ORIGINAL_QUERY, env: fixtureGitEnv(), encoding: "utf8" }).trim();
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_extra_object"]);
    expect(locations(result, "git_extra_object")).toEqual([`.git/objects/${blob.slice(0, 2)}/${blob.slice(2)}`]);
  });

  it("ADM-01 refuses a pack of upstream history with no index with git_extra_object", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const pack = execFileSync("git", ["pack-objects", "--all", "--stdout"], { cwd: fixture.repo, env: fixtureGitEnv(), input: "" });
    mkdirSync(join(fixture.copy, ".git", "objects", "pack"), { recursive: true });
    writeFileSync(join(fixture.copy, ".git", "objects", "pack", "stash.pack"), pack);
    writeFileSync(join(fixture.copy, ".git", "objects", "notes.txt"), "x\n");
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_extra_object"]);
    expect(locations(result, "git_extra_object")).toEqual([".git/objects/notes.txt", ".git/objects/pack/stash.pack"]);
  });

  it("ADM-01 refuses a clone under .git/modules, leftover messages and info files with git_history", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    execFileSync("git", ["clone", "-q", "--bare", fixture.repo, join(fixture.copy, ".git", "modules", "old")], { env: fixtureGitEnv() });
    writeFileSync(join(fixture.copy, ".git", "COMMIT_EDITMSG"), "Older message\n");
    mkdirSync(join(fixture.copy, ".git", "info"));
    writeFileSync(join(fixture.copy, ".git", "info", "exclude"), "\n");
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_history"]);
    expect(locations(result, "git_history")).toEqual([".git/COMMIT_EDITMSG", ".git/info/exclude", ".git/modules"]);
  });

  it("ADM-01 refuses a file under refs/ that git does not read as a ref with git_extra_ref", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    writeFileSync(join(fixture.copy, ".git", "refs", "notes.txt"), "not a ref\n");
    const result = await fixture.audit();
    expect(result.code).toBe(1);
    expect(locations(result, "git_extra_ref")).toEqual([".git/refs/notes.txt"]);
  });

  it("ADM-07 refuses a strict term in .git/config and leftover git files without printing it", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    fixture.copyGit(["config", "branch.main.description", `mentions ${STRICT}`]);
    writeFileSync(join(fixture.copy, ".git", "MERGE_MSG"), `line\n${STRICT}\n`);
    const result = await fixture.audit();
    expect(locations(result, "strict_term")).toEqual([".git/MERGE_MSG:2", `.git/config:${String(configLine(fixture))}`]);
    expect(locations(result, "git_history")).toEqual([".git/MERGE_MSG"]);
    expect(result.stdout + result.reportText).not.toContain(STRICT);
  });

  it("ADM-01 writes only loose objects, and refuses any pack, even a complete one, with git_extra_object", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    expect(readdirSync(join(fixture.copy, ".git", "objects", "pack"))).toEqual([]);
    fixture.copyGit(["repack", "-a", "-d", "-q"]);
    const result = await fixture.audit();
    expect(locations(result, "git_extra_object").filter((path) => path.startsWith(".git/objects/pack/pack-"))).toHaveLength(3);
  });

  it("ADM-01 refuses a reachable loose object rewritten with another version's bytes or with trailing data", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const blob = fixture.copyGit(["rev-parse", `HEAD:${MUTATED_PATH}`]);
    const file = join(fixture.copy, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    const original = readFileSync(file);
    chmodSync(file, 0o644);
    writeFileSync(file, deflateSync(Buffer.from(`blob ${String(Buffer.byteLength(ORIGINAL_QUERY))}\0${ORIGINAL_QUERY}`)));
    const rewritten = await fixture.audit();
    expect(locations(rewritten, "git_extra_object")).toContain(`.git/objects/${blob.slice(0, 2)}/${blob.slice(2)}`);
    writeFileSync(file, Buffer.concat([original, Buffer.from(STRICT)]));
    const trailing = await fixture.audit();
    expect(reasons(trailing)).toEqual(["git_extra_object"]);
    expectNoTerm(trailing);
  });

  it("ADM-01 refuses an index with an extra extension, and other files in the object store", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const index = join(fixture.copy, ".git", "index");
    const body = readFileSync(index).subarray(0, -20);
    const extension = Buffer.from(`hidden ${STRICT}`);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(extension.length);
    const withExtension = Buffer.concat([body, Buffer.from("ZZZZ"), size, extension]);
    writeFileSync(index, Buffer.concat([withExtension, createHash("sha1").update(withExtension).digest()]));
    mkdirSync(join(fixture.copy, ".git", "objects", "info"), { recursive: true });
    writeFileSync(join(fixture.copy, ".git", "objects", "info", "packs"), `P ${STRICT}\n`);
    const result = await fixture.audit();
    expect(locations(result, "git_tree_mismatch")).toEqual([".git/index"]);
    expect(locations(result, "git_extra_object")).toEqual([".git/objects/info/packs"]);
    expectNoTerm(result);
  });

  it("ADM-01 refuses a FIFO, a symlink and an unreadable directory under .git without hanging", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    execFileSync("mkfifo", [join(fixture.copy, ".git", "MERGE_MSG")]);
    symlinkSync(fixture.repo, join(fixture.copy, ".git", "refs", "linked"));
    mkdirSync(join(fixture.copy, ".git", "refs", "locked"));
    chmodSync(join(fixture.copy, ".git", "refs", "locked"), 0o000);
    onTestFinished(() => {
      chmodSync(join(fixture.copy, ".git", "refs", "locked"), 0o755);
    });
    const result = await fixture.audit();
    expect(result.code).toBe(1);
    expect(locations(result, "git_history")).toEqual(expect.arrayContaining([".git/MERGE_MSG", ".git/refs/linked", ".git/refs/locked"]));
  });

  it("ADM-01 refuses an empty subtree in the commit tree, whatever its name, without printing it", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const emptyTree = fixture.copyGit(["mktree"], fixtureGitEnv());
    const listing = fixture.copyGit(["ls-tree", "HEAD"]);
    const tree = execFileSync("git", ["mktree"], {
      cwd: fixture.copy,
      env: fixtureGitEnv(),
      input: `${listing}\n040000 tree ${emptyTree}\t${STRICT} old answer\n`,
      encoding: "utf8",
    }).trim();
    const commit = fixture.copyGit(["commit-tree", tree, "-m", NEUTRAL.message], neutralEnv());
    fixture.copyGit(["-c", "core.logAllRefUpdates=false", "update-ref", "refs/heads/main", commit]);
    fixture.copyGit(["read-tree", "refs/heads/main"]);
    fixture.copyGit(["prune", "--expire=now"]);
    const result = await fixture.audit();
    expect(locations(result, "git_tree_mismatch")).toEqual(["[redacted-1]"]);
    expectNoTerm(result);
  });

  it("ADM-01 refuses a tree object whose bytes differ though its listing matches, with git_tree_mismatch at .git", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const raw = execFileSync("git", ["cat-file", "tree", "HEAD^{tree}"], { cwd: fixture.copy, env: fixtureGitEnv() });
    const padded = Buffer.from(raw.toString("latin1").replace("40000 src\0", "040000 src\0"), "latin1");
    expect(padded.equals(raw)).toBe(false);
    const tree = execFileSync("git", ["hash-object", "-t", "tree", "-w", "--literally", "--stdin"], { cwd: fixture.copy, env: fixtureGitEnv(), input: padded, encoding: "utf8" }).trim();
    const commit = fixture.copyGit(["commit-tree", tree, "-m", NEUTRAL.message], neutralEnv());
    fixture.copyGit(["-c", "core.logAllRefUpdates=false", "update-ref", "refs/heads/main", commit]);
    fixture.copyGit(["read-tree", "refs/heads/main"]);
    fixture.copyGit(["prune", "--expire=now"]);
    const result = await fixture.audit();
    expect(result.report.findings).toEqual([{ line: null, path: ".git", reason: "git_tree_mismatch" }]);
  });

  it("ADM-07 does not scan names git chooses inside .git, such as object names and fixed directories", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const objectDirectory = readdirSync(join(fixture.copy, ".git", "objects")).find((name) => /^[0-9a-f]{2}$/.test(name)) ?? "";
    const objectName = readdirSync(join(fixture.copy, ".git", "objects", objectDirectory))[0] ?? "";
    const commit = fixture.copyGit(["rev-parse", "HEAD"]);
    const tree = fixture.copyGit(["rev-parse", "HEAD^{tree}"]);
    fixture.writeTerms(
      `strict:${STRICT}\nstrict:${objectName.slice(4, 12)}\nstrict:${commit.slice(10, 18)}\nstrict:${tree.slice(10, 18)}\nstrict:pack\nstrict:heads\n`,
    );
    const result = await fixture.audit();
    expect(result.report.findings).toEqual([]);
    expect(result.code).toBe(0);
  });

  it("ADM-01 refuses extra commit headers and continuation lines with git_identity", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const tree = fixture.copyGit(["rev-parse", "HEAD^{tree}"]);
    const ident = "workspace <workspace@example.invalid> 946684800 +0000";
    const raw = `tree ${tree}\n aGlkZGVuIGRhdGE=\nauthor ${ident}\ncommitter ${ident}\n\n${NEUTRAL.message}\n`;
    const commit = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { cwd: fixture.copy, env: fixtureGitEnv(), input: raw, encoding: "utf8" }).trim();
    fixture.copyGit(["-c", "core.logAllRefUpdates=false", "update-ref", "refs/heads/main", commit]);
    fixture.copyGit(["prune", "--expire=now"]);
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_identity"]);
  });

  it("ADM-07 refuses a strict term in an empty directory name inside .git", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    mkdirSync(join(fixture.copy, ".git", "refs", STRICT));
    mkdirSync(join(fixture.copy, ".git", "objects", "notes"));
    mkdirSync(join(fixture.copy, ".git", "objects", "pack", STRICT));
    const result = await fixture.audit();
    expect(locations(result, "strict_term")).toEqual([".git/objects/pack/[redacted-1]", ".git/refs/[redacted-1]"]);
    expect(locations(result, "git_extra_object")).toEqual([".git/objects/notes", ".git/objects/pack/[redacted-1]"]);
    expectNoTerm(result);
  });

  it("ADM-01 refuses a FIFO where git would read HEAD or config, without running git on it", async () => {
    for (const name of ["HEAD", "config"]) {
      const fixture = new Fixture();
      await fixture.ready();
      unlinkSync(join(fixture.copy, ".git", name));
      execFileSync("mkfifo", [join(fixture.copy, ".git", name)]);
      const result = await fixture.audit();
      expect(result.code).toBe(1);
      expect(locations(result, "git_history")).toContain(`.git/${name}`);
    }
  });

  it("ADM-01 refuses a sample hook with git_hooks", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    mkdirSync(join(fixture.copy, ".git", "hooks"), { recursive: true });
    writeFileSync(join(fixture.copy, ".git", "hooks", "pre-commit.sample"), "#!/bin/sh\n");
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["git_hooks"]);
    expect(locations(result, "git_hooks")).toEqual([".git/hooks/pre-commit.sample"]);
  });
});
