import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRANCH,
  HELPER_TERM,
  HelperFixture,
  IDENTITY,
  WORKTREE_ID,
  expectResponse,
  newRequestId,
  waitFor,
  waitForExit,
} from "./helper-support.ts";
import { STUB_LEAK_MARKER, git, writeFile } from "./support.ts";

const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const IDENT_LINE = `${IDENTITY.name} <${IDENTITY.email}> 1700000000 +0000`;

/**
 * Puts a `git` wrapper first on PATH; `onPush` is shell code run for `git push` and
 * `onFetch` for `git fetch`, each with the arguments in "$@".
 */
function gitWrapperPath(fixture: HelperFixture, onPush: string, onFetch = ""): string {
  const bin = join(fixture.root, "wrapper-bin");
  writeFile(
    join(bin, "git"),
    `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = push ]; then\n    :\n${onPush}\n  fi\n  if [ "$a" = fetch ]; then\n    :\n${onFetch}\n    break\n  fi\ndone\nexec ${realGit} "$@"\n`,
    0o755,
  );
  return `${bin}:${process.env.PATH ?? ""}`;
}

describe("PUB-02 helper push", () => {
  it("publishes a clean candidate and the remote ref equals the SHA", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "src/a.ts": "export const a = 1;\n" });
    const id = fixture.pushRequest(sha);
    const result = await fixture.runOnce();
    expect(result.code).toBe(0);
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
    expect(fixture.remoteHead()).toBe(sha);
    expect(fixture.logLine(id)).toMatch(/outcome=published/);
    expect(fixture.logLine(id)).toContain(`worktree=${WORKTREE_ID}`);
    expect(existsSync(join(fixture.publication, "requests", `${id}.json`))).toBe(false);
  });

  it("blocks a candidate with a forbidden term, reports only the location and leaves the remote unchanged", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "docs/notes.md": `first\nmentions ${HELPER_TERM}\n` });
    const id = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "blocked", locations: ["docs/notes.md:2"] });
    expect(fixture.remoteHead()).toBeNull();
    expect(fixture.remoteHasObject(sha)).toBe(false);
    expect(fixture.logLine(id)).toMatch(/outcome=blocked category=content/);
    expect(fixture.log()).not.toContain(HELPER_TERM);
    expect(fixture.log()).not.toContain(fixture.patterns);
  });

  it("blocks a secret found by gitleaks without relaying it", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "config.ts": `export const k = "${STUB_LEAK_MARKER}";\n` });
    const id = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "blocked", locations: ["config.ts:1"] });
    expect(readFileSync(fixture.responsePath(id), "utf8")).not.toContain(STUB_LEAK_MARKER);
  });

  it("blocks a push to an empty bare remote when approvedBase's own history has a term", async () => {
    const fixture = new HelperFixture({ seedRemoteMain: false, baseFiles: { "old.md": `${HELPER_TERM}\n` } });
    const sha = fixture.commitCandidate({ "src/a.ts": "export {};\n" });
    const id = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "blocked", locations: ["old.md:1"] });
    expect(fixture.remoteHead()).toBeNull();
  });

  it("is idempotent when the same SHA is pushed again", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const first = fixture.pushRequest(sha);
    await fixture.runOnce();
    const second = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(first), { requestId: first, requestedSha: sha, outcome: "published" });
    expectResponse(fixture.readResponse(second), { requestId: second, requestedSha: sha, outcome: "published" });
    expect(fixture.remoteHead()).toBe(sha);
  });

  it("fast-forwards an existing branch and refuses a push that is not a fast-forward", async () => {
    const fixture = new HelperFixture();
    const first = fixture.commitCandidate({ "a.txt": "a\n" });
    fixture.pushRequest(first);
    await fixture.runOnce();
    const second = fixture.commitCandidate({ "b.txt": "b\n" });
    const ff = fixture.pushRequest(second);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(ff), { requestId: ff, requestedSha: second, outcome: "published" });
    git(fixture.workingCopy, ["reset", "-q", "--hard", first]);
    const diverged = fixture.commitCandidate({ "c.txt": "c\n" });
    const id = fixture.pushRequest(diverged);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: diverged, outcome: "blocked", locations: [] });
    expect(fixture.logLine(id)).toMatch(/category=not-fast-forward/);
    expect(fixture.remoteHead()).toBe(second);
  });

  it("refuses a new branch that does not descend from approvedBase", async () => {
    const fixture = new HelperFixture();
    git(fixture.workingCopy, ["checkout", "-q", "--orphan", "unrelated"]);
    const sha = fixture.commitCandidate({ "x.txt": "x\n" });
    const id = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "blocked", locations: [] });
    expect(fixture.logLine(id)).toMatch(/category=not-fast-forward/);
  });

  it("answers stale when the candidate cannot be fetched", async () => {
    const fixture = new HelperFixture();
    const id = fixture.pushRequest("1".repeat(40));
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: "1".repeat(40), outcome: "stale" });
  });

  it("answers stale on a lease rejection and never stale while the remote holds the SHA", async () => {
    const fixture = new HelperFixture();
    const first = fixture.commitCandidate({ "a.txt": "a\n" });
    fixture.pushRequest(first);
    await fixture.runOnce();
    git(fixture.workingCopy, ["push", "-q", fixture.remote, `${fixture.approvedBase}:refs/heads/other`]);
    const other = fixture.commitCandidate({ "o.txt": "o\n" });
    git(fixture.workingCopy, ["push", "-q", fixture.remote, `${other}:refs/heads/other`]);
    git(fixture.workingCopy, ["reset", "-q", "--hard", first]);
    const candidate = fixture.commitCandidate({ "b.txt": "b\n" });
    const path = gitWrapperPath(fixture, `    ${realGit} --git-dir "${fixture.remote}" update-ref refs/heads/${BRANCH} ${other}`);
    const id = fixture.pushRequest(candidate);
    await fixture.runOnce({ env: { PATH: path } });
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: candidate, outcome: "stale" });
    expect(fixture.remoteHead()).toBe(other);
  });

  it("answers published when git performs the push but exits non-zero", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const path = gitWrapperPath(fixture, `    ${realGit} "$@"; exit 1`);
    const id = fixture.pushRequest(sha);
    await fixture.runOnce({ env: { PATH: path } });
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
    expect(fixture.remoteHead()).toBe(sha);
  });

  it("answers unavailable when the push fails without changing the remote", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const path = gitWrapperPath(fixture, "    exit 1");
    const id = fixture.pushRequest(sha);
    await fixture.runOnce({ env: { PATH: path } });
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "unavailable" });
    expect(fixture.remoteHead()).toBeNull();
  });

  it("pushes exactly the requested SHA, not the working copy's later HEAD", async () => {
    const fixture = new HelperFixture();
    const c1 = fixture.commitCandidate({ "a.txt": "a\n" });
    const id = fixture.pushRequest(c1);
    const c2 = fixture.commitCandidate({ "b.txt": `${HELPER_TERM}\n` });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: c1, outcome: "published" });
    expect(fixture.remoteHead()).toBe(c1);
    expect(fixture.remoteHasObject(c2)).toBe(false);
  });

  it("answers unavailable when the pattern file is missing", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    rmSync(fixture.patterns);
    const id = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "unavailable" });
    expect(fixture.remoteHead()).toBeNull();
  });

  it("answers unavailable when gitleaks cannot run", async () => {
    const fixture = new HelperFixture({ gitleaks: { exitStatus: 1 } });
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const id = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "unavailable" });
  });

  it("answers unavailable when the registered working copy is missing", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    fixture.entry.path = join(fixture.root, "missing-clone");
    fixture.writeRegistry();
    const id = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "unavailable" });
  });

  it("blocks a working copy with alternates or a .git file as invalid-worktree", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    writeFile(join(fixture.workingCopy, ".git", "objects", "info", "alternates"), `${join(fixture.remote, "objects")}\n`);
    const alternates = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(alternates), { requestId: alternates, requestedSha: sha, outcome: "blocked", locations: [] });
    expect(fixture.logLine(alternates)).toMatch(/category=invalid-worktree/);
    rmSync(join(fixture.workingCopy, ".git", "objects", "info", "alternates"));

    renameSync(join(fixture.workingCopy, ".git"), join(fixture.root, "moved-git"));
    writeFileSync(join(fixture.workingCopy, ".git"), `gitdir: ${join(fixture.root, "moved-git")}\n`);
    const gitFile = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(gitFile), { requestId: gitFile, requestedSha: sha, outcome: "blocked", locations: [] });
    expect(fixture.logLine(gitFile)).toMatch(/category=invalid-worktree/);
    expect(fixture.remoteHead()).toBeNull();
  });

  it("blocks a candidate that hides a term in an extra commit header and leaves the remote unchanged", async () => {
    const fixture = new HelperFixture();
    const tree = git(fixture.workingCopy, ["rev-parse", "HEAD^{tree}"]);
    const object = writeFile(
      join(fixture.root, "commit.txt"),
      `tree ${tree}\nparent ${fixture.approvedBase}\nauthor ${IDENT_LINE}\ncommitter ${IDENT_LINE}\nx-hidden ${HELPER_TERM}\n\nfeat: innocent\n`,
    );
    const sha = git(fixture.workingCopy, ["hash-object", "-t", "commit", "-w", object]);
    git(fixture.workingCopy, ["update-ref", "refs/heads/main", sha]);
    const id = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "blocked", locations: [`commit-${sha.slice(0, 12)}:2`] });
    expect(fixture.remoteHasObject(sha)).toBe(false);
  });

  it("blocks a term in a repeated committer header or a continuation after the committer line", async () => {
    const fixture = new HelperFixture();
    const tree = git(fixture.workingCopy, ["rev-parse", "HEAD^{tree}"]);
    const variants = [
      `committer ${IDENT_LINE}\ncommitter ${HELPER_TERM} <x@example.invalid> 1700000000 +0000\n`,
      `committer ${IDENT_LINE}\n ${HELPER_TERM}\n`,
      `committer ${IDENT_LINE}\nauthor ${HELPER_TERM}\n`,
    ];
    for (const [index, tail] of variants.entries()) {
      const object = writeFile(
        join(fixture.root, `commit-${String(index)}.txt`),
        `tree ${tree}\nparent ${fixture.approvedBase}\nauthor ${IDENT_LINE}\n${tail}\nfeat: innocent\n`,
      );
      const sha = git(fixture.workingCopy, ["hash-object", "--literally", "-t", "commit", "-w", object]);
      const id = fixture.pushRequest(sha);
      await fixture.runOnce();
      expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "blocked", locations: [`commit-${sha.slice(0, 12)}:2`] });
      expect(fixture.remoteHasObject(sha)).toBe(false);
    }
  });

  it("blocks a request whose SHA names a tag object and sends the remote nothing", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    git(fixture.workingCopy, ["tag", "-a", "-m", `synthetic tag ${HELPER_TERM}`, "synthetic-tag", sha]);
    const tag = git(fixture.workingCopy, ["rev-parse", "synthetic-tag"]);
    const before = git(fixture.root, ["--git-dir", fixture.remote, "count-objects", "-v"]);
    const id = fixture.pushRequest(tag);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: tag, outcome: "blocked", locations: [] });
    expect(fixture.logLine(id)).toMatch(/category=invalid-request/);
    expect(git(fixture.root, ["--git-dir", fixture.remote, "count-objects", "-v"])).toBe(before);
    expect(fixture.remoteHasObject(sha)).toBe(false);
  });

  it("blocks a working copy whose .git is replaced during the fetch and drops the candidate", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const dotGit = join(fixture.workingCopy, ".git");
    const path = gitWrapperPath(fixture, "", `    mv "${dotGit}" "${dotGit}-old"; cp -R "${dotGit}-old" "${dotGit}"`);
    const id = fixture.pushRequest(sha);
    await fixture.runOnce({ env: { PATH: path } });
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "blocked", locations: [] });
    expect(fixture.logLine(id)).toMatch(/category=invalid-worktree/);
    expect(git(fixture.root, ["--git-dir", join(fixture.state, "repositories", `${WORKTREE_ID}.git`), "for-each-ref", "refs/rbw/candidates/"])).toBe("");
    expect(fixture.remoteHead()).toBeNull();
  });

  it("answers published on resume when an earlier push reached the remote, even after the working copy changed", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const bin = join(fixture.root, "flaky-bin");
    writeFile(
      join(bin, "git"),
      `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = push ]; then ${realGit} "$@"; exit 1; fi\n  if [ "$a" = ls-remote ]; then exit 1; fi\ndone\nexec ${realGit} "$@"\n`,
      0o755,
    );
    const id = fixture.pushRequest(sha);
    await fixture.runOnce({ env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
    expect(fixture.readResponse(id)).toBeNull();
    expect(fixture.remoteHead()).toBe(sha);
    expect(fixture.logLine(id)).toMatch(/outcome=pending/);

    renameSync(join(fixture.workingCopy, ".git"), join(fixture.root, "moved-git"));
    writeFileSync(join(fixture.workingCopy, ".git"), `gitdir: ${join(fixture.root, "moved-git")}\n`);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
  });

  it("blocks a working copy with a commondir file as invalid-worktree", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    writeFileSync(join(fixture.workingCopy, ".git", "commondir"), "../other\n");
    const id = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "blocked", locations: [] });
    expect(fixture.logLine(id)).toMatch(/category=invalid-worktree/);
  });
});

describe("PUB-02 helper requests and registry", () => {
  it("answers malformed requests once as blocked with a null SHA", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const cases: [string, string | Uint8Array][] = [];
    const malformed = newRequestId();
    cases.push([malformed, "{not json"]);
    const extraField = newRequestId();
    cases.push([extraField, JSON.stringify({ version: 1, requestId: extraField, worktreeId: WORKTREE_ID, operation: "push", sha, extra: 1 })]);
    const wrongId = newRequestId();
    cases.push([wrongId, JSON.stringify({ version: 1, requestId: "different-id-123", worktreeId: WORKTREE_ID, operation: "push", sha })]);
    const upperSha = newRequestId();
    cases.push([upperSha, JSON.stringify({ version: 1, requestId: upperSha, worktreeId: WORKTREE_ID, operation: "push", sha: sha.toUpperCase() })]);
    const pushTitle = newRequestId();
    cases.push([pushTitle, JSON.stringify({ version: 1, requestId: pushTitle, worktreeId: WORKTREE_ID, operation: "push", sha, title: "t" })]);
    const twoLineTitle = newRequestId();
    cases.push([twoLineTitle, JSON.stringify({ version: 1, requestId: twoLineTitle, worktreeId: WORKTREE_ID, operation: "pr-create", sha, title: "a\nb", body: "x" })]);
    const nulBody = newRequestId();
    cases.push([nulBody, JSON.stringify({ version: 1, requestId: nulBody, worktreeId: WORKTREE_ID, operation: "pr-comment", sha, body: "a\u0000b" })]);
    const longBody = newRequestId();
    cases.push([longBody, JSON.stringify({ version: 1, requestId: longBody, worktreeId: WORKTREE_ID, operation: "pr-comment", sha, body: "x".repeat(65_537) })]);
    const badUtf8 = newRequestId();
    cases.push([badUtf8, Buffer.concat([Buffer.from(`{"version":1,"requestId":"${badUtf8}","worktreeId":"${WORKTREE_ID}","operation":"pr-comment","sha":"${sha}","body":"`), Buffer.from([0xff]), Buffer.from('"}')])]);
    const tooLarge = newRequestId();
    cases.push([tooLarge, JSON.stringify({ version: 1, requestId: tooLarge, worktreeId: WORKTREE_ID, operation: "push", sha, pad: "x".repeat(1_100_000) })]);
    for (const [id, content] of cases) fixture.writeRawRequest(`${id}.json`, content);
    fixture.writeRawRequest("not a valid name.json", "{}");
    fixture.writeRawRequest(".hidden-in-progress.json", "{}");
    await fixture.runOnce();
    for (const [id] of cases) {
      expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: null, outcome: "blocked", locations: [] });
      expect(fixture.logLine(id)).toMatch(/category=invalid-request/);
    }
    expect(fixture.responses().sort()).toEqual(cases.map(([id]) => `${id}.json`).sort());
    expect(fixture.log()).toMatch(/invalid request file name/);
    expect(fixture.remoteHead()).toBeNull();
    const before = fixture.log();
    await fixture.runOnce();
    for (const [id] of cases) expect(fixture.log().split(`request=${id} `).length).toBe(before.split(`request=${id} `).length);
  });

  it("blocks an unknown worktree and invalid registry entries", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const unknown = fixture.writeRequest({ operation: "push", sha, worktreeId: "synthetic-unknown" });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(unknown), { requestId: unknown, requestedSha: sha, outcome: "blocked", locations: [] });
    expect(fixture.logLine(unknown)).toMatch(/category=unknown-worktree/);

    const invalidEntries: Record<string, unknown>[] = [
      { ...fixture.entry, branch: "main" },
      { ...fixture.entry, branch: "bad..branch" },
      { ...fixture.entry, remote: ["https://synthetic-user", "synthetic-token@example.invalid/x.git"].join(":") },
      { ...fixture.entry, remote: "https://" + ["synthetic-token", "github.com/synthetic-owner/synthetic-repo.git"].join("@") },
      { ...fixture.entry, path: "relative/clone" },
      { ...fixture.entry, approvedBase: "abc" },
      { ...fixture.entry, remote: "https://github.com/synthetic-owner/other-repo.git" },
      { ...fixture.entry, remote: "ssh://git@ssh.github.com:443/synthetic-owner/other-repo.git" },
      { ...fixture.entry, remote: "git@synthetic-alias:synthetic-owner/synthetic-repo.git" },
      { ...fixture.entry, remote: join(fixture.workingCopy, ".git") },
      { ...fixture.entry, remote: `file://${join(fixture.inbox, "remote.git")}` },
      { ...fixture.entry, identity: undefined },
      { ...fixture.entry, identity: { name: IDENTITY.name } },
      { ...fixture.entry, identity: { ...IDENTITY, extra: "x" } },
      { ...fixture.entry, token: undefined },
      { ...fixture.entry, token: fixture.token.toUpperCase() },
      { ...fixture.entry, token: fixture.token.slice(1) },
    ];
    for (const entry of invalidEntries) {
      fixture.writeRegistry({ [WORKTREE_ID]: entry });
      const id = fixture.pushRequest(sha);
      await fixture.runOnce();
      expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "blocked", locations: [] });
      expect(fixture.logLine(id)).toMatch(/category=invalid-registration/);
    }
    expect(fixture.remoteHead()).toBeNull();
  });

  it("answers unavailable when the registry is missing or invalid", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    rmSync(fixture.registryPath);
    const missing = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(missing), { requestId: missing, requestedSha: sha, outcome: "unavailable" });
    writeFile(fixture.registryPath, "{ broken");
    const invalid = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(invalid), { requestId: invalid, requestedSha: sha, outcome: "unavailable" });
  });

  it("refuses to start when the registry, pattern file or state lies inside the inbox or a working copy", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const id = fixture.pushRequest(sha);
    const inboxRegistry = writeFile(join(fixture.inbox, "registry.json"), readFileSync(fixture.registryPath));
    const variants = [
      ["--registry", inboxRegistry],
      ["--patterns", writeFile(join(fixture.inbox, "patterns.txt"), `${HELPER_TERM}\n`)],
      ["--state", join(fixture.inbox, "state")],
      ["--state", join(fixture.workingCopy, "state")],
      ["--patterns", writeFile(join(fixture.workingCopy, "patterns.txt"), `${HELPER_TERM}\n`)],
    ];
    for (const extra of variants) {
      const result = await fixture.runOnce({ extra });
      expect(result.code).not.toBe(0);
      expect(fixture.readResponse(id)).toBeNull();
    }
    expect(existsSync(join(fixture.inbox, "state"))).toBe(false);
  });

  it("answers a recorded id from its record and never re-executes it", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const id = fixture.pushRequest(sha);
    await fixture.runOnce();
    const first = readFileSync(fixture.responsePath(id), "utf8");
    git(fixture.root, ["--git-dir", fixture.remote, "update-ref", "-d", `refs/heads/${BRANCH}`]);
    rmSync(fixture.responsePath(id));
    fixture.writeRequest({ operation: "push", sha }, id);
    await fixture.runOnce();
    expect(readFileSync(fixture.responsePath(id), "utf8")).toBe(first);
    expect(fixture.remoteHead()).toBeNull();
  });

  it("never writes through a symlink planted at a response path", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const id = fixture.pushRequest(sha);
    const target = join(fixture.root, "outside-target.json");
    writeFileSync(target, "original");
    symlinkSync(target, fixture.responsePath(id));
    await fixture.runOnce();
    expect(readFileSync(target, "utf8")).toBe("original");
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
  });

  it("writes nothing when responses/ is replaced by a symlink", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const id = fixture.pushRequest(sha);
    const outside = join(fixture.root, "outside-dir");
    mkdirSync(outside);
    rmSync(join(fixture.publication, "responses"), { recursive: true });
    symlinkSync(outside, join(fixture.publication, "responses"));
    const result = await fixture.runOnce();
    expect(result.code).not.toBe(0);
    expect(existsSync(join(outside, `${id}.json`))).toBe(false);
    expect(fixture.log()).toMatch(/inbox layout/);
    expect(existsSync(join(fixture.publication, "requests", `${id}.json`))).toBe(true);
  });

  it("skips a request whose claimed name is occupied and still answers the next one", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const blockedId = fixture.pushRequest(sha);
    mkdirSync(join(fixture.claimedPath(blockedId), "occupied"), { recursive: true });
    const next = fixture.pushRequest(sha);
    const result = await fixture.runOnce();
    expect(result.code).toBe(0);
    expect(fixture.log()).toMatch(/could not be claimed/);
    // The occupying directory is itself adopted from claimed/ and answered as an invalid request.
    expectResponse(fixture.readResponse(blockedId), { requestId: blockedId, requestedSha: null, outcome: "blocked", locations: [] });
    expect(existsSync(join(fixture.publication, "requests", `${blockedId}.json`))).toBe(true);
    expectResponse(fixture.readResponse(next), { requestId: next, requestedSha: sha, outcome: "published" });
  });

  it("creates the inbox layout when it is missing", async () => {
    const fixture = new HelperFixture();
    const result = await fixture.runOnce();
    expect(result.code).toBe(0);
    for (const dir of ["requests", "responses"]) expect(existsSync(join(fixture.publication, dir))).toBe(true);
    expect(existsSync(join(fixture.publication, "claimed"))).toBe(false);
  });

  it("serve answers a malformed request, keeps running and stops on SIGTERM", async () => {
    const fixture = new HelperFixture();
    const child = fixture.startServe();
    const exited = waitForExit(child, 60_000);
    try {
      await waitFor(() => existsSync(join(fixture.publication, "requests")));
      const bad = newRequestId();
      fixture.writeRawRequest(`${bad}.json`, "{not json");
      await waitFor(() => fixture.readResponse(bad) !== null);
      expectResponse(fixture.readResponse(bad), { requestId: bad, requestedSha: null, outcome: "blocked", locations: [] });
      const sha = fixture.commitCandidate({ "a.txt": "a\n" });
      const good = fixture.pushRequest(sha);
      await waitFor(() => fixture.readResponse(good) !== null);
      expectResponse(fixture.readResponse(good), { requestId: good, requestedSha: sha, outcome: "published" });
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toEqual({ code: 0, signal: null });
  });

  it("serve blocks not-fast-forward and content requests", async () => {
    const fixture = new HelperFixture();
    const child = fixture.startServe();
    const exited = waitForExit(child, 60_000);
    try {
      const sha = fixture.commitCandidate({ "a.txt": `${HELPER_TERM}\n` });
      const id = fixture.pushRequest(sha);
      await waitFor(() => fixture.readResponse(id) !== null);
      expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "blocked", locations: ["a.txt:1"] });
      git(fixture.workingCopy, ["checkout", "-q", "--orphan", "unrelated"]);
      const orphan = fixture.commitCandidate({ "x.txt": "x\n" });
      const nff = fixture.pushRequest(orphan);
      await waitFor(() => fixture.readResponse(nff) !== null);
      expectResponse(fixture.readResponse(nff), { requestId: nff, requestedSha: orphan, outcome: "blocked", locations: [] });
      expect(fixture.logLine(nff)).toMatch(/category=not-fast-forward/);
    } finally {
      child.kill("SIGINT");
    }
    expect(await exited).toEqual({ code: 0, signal: null });
  });

  it("serve answers stale, unavailable and every other refusal category", async () => {
    const fixture = new HelperFixture();
    fixture.writeRegistry({
      [WORKTREE_ID]: fixture.entry,
      "synthetic-main": { ...fixture.entry, branch: "main" },
      "synthetic-missing": { ...fixture.entry, path: join(fixture.root, "missing-clone") },
    });
    const child = fixture.startServe();
    const exited = waitForExit(child, 120_000);
    const answer = async (fields: Record<string, unknown>): Promise<{ id: string; response: Record<string, unknown> | null }> => {
      const id = fixture.writeRequest(fields);
      await waitFor(() => fixture.readResponse(id) !== null, 30_000);
      return { id, response: fixture.readResponse(id) };
    };
    try {
      const sha = fixture.commitCandidate({ "a.txt": "a\n" });
      const absent = "0123456789abcdef0123456789abcdef01234567";
      const stale = await answer({ operation: "push", sha: absent });
      expectResponse(stale.response, { requestId: stale.id, requestedSha: absent, outcome: "stale" });

      const missing = await answer({ operation: "push", sha, worktreeId: "synthetic-missing" });
      expectResponse(missing.response, { requestId: missing.id, requestedSha: sha, outcome: "unavailable" });

      const refusals: [string, Record<string, unknown>][] = [
        ["unknown-worktree", { operation: "push", sha, worktreeId: "synthetic-unknown" }],
        ["invalid-registration", { operation: "push", sha, worktreeId: "synthetic-main" }],
      ];
      for (const [category, fields] of refusals) {
        const refused = await answer(fields);
        expectResponse(refused.response, { requestId: refused.id, requestedSha: sha, outcome: "blocked", locations: [] });
        expect(fixture.logLine(refused.id)).toContain(`category=${category}`);
      }

      const alternates = writeFile(join(fixture.workingCopy, ".git", "objects", "info", "alternates"), `${join(fixture.remote, "objects")}\n`);
      const invalid = await answer({ operation: "push", sha });
      expectResponse(invalid.response, { requestId: invalid.id, requestedSha: sha, outcome: "blocked", locations: [] });
      expect(fixture.logLine(invalid.id)).toContain("category=invalid-worktree");
      rmSync(alternates);

      const pushed = await answer({ operation: "push", sha });
      expectResponse(pushed.response, { requestId: pushed.id, requestedSha: sha, outcome: "published" });
      const comment = await answer({ operation: "pr-comment", sha, body: "Synthetic comment.\n" });
      expectResponse(comment.response, { requestId: comment.id, requestedSha: sha, outcome: "blocked", locations: [] });
      expect(fixture.logLine(comment.id)).toContain("category=no-pull-request");
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(fixture.remoteHead("main")).toBe(fixture.approvedBase);
  });

  it("refuses a second helper on the same state directory while one is serving", async () => {
    const fixture = new HelperFixture();
    const child = fixture.startServe();
    const exited = waitForExit(child, 60_000);
    try {
      await waitFor(() => fixture.log().includes("event=serving"));
      const sha = fixture.commitCandidate({ "a.txt": "a\n" });
      const second = await fixture.runOnce();
      expect(second.code).toBe(2);
      expect(second.stderr).toMatch(/another helper/);
      const id = fixture.pushRequest(sha);
      await waitFor(() => fixture.readResponse(id) !== null);
      expect(fixture.log().match(new RegExp(`request=${id} `, "g"))).toHaveLength(1);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toEqual({ code: 0, signal: null });
    expect((await fixture.runOnce()).code).toBe(0);
  });

  it("refuses to start with git older than 2.45.1", async () => {
    const fixture = new HelperFixture();
    const bin = join(fixture.root, "old-git-bin");
    writeFile(join(bin, "git"), `#!/bin/sh\nif [ "$1" = version ] || [ "$1" = --version ]; then echo "git version 2.45.0"; exit 0; fi\nexec ${realGit} "$@"\n`, 0o755);
    const result = await fixture.runOnce({ env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/2\.45\.1/);
  });
});

describe("PUB-02 helper identity and token checks", () => {
  const other = { GIT_AUTHOR_NAME: "synthetic-other", GIT_AUTHOR_EMAIL: "synthetic-other@example.invalid" };

  it("blocks a push with a commit whose author or committer differs from the registered identity", async () => {
    const fixture = new HelperFixture();
    const cases: Record<string, string>[] = [
      other,
      { GIT_AUTHOR_EMAIL: "synthetic-other@example.invalid" },
      { GIT_COMMITTER_NAME: "synthetic-other" },
      { GIT_COMMITTER_EMAIL: "Synthetic-Author@example.invalid" },
    ];
    for (const env of cases) {
      git(fixture.workingCopy, ["reset", "-q", "--hard", fixture.approvedBase]);
      writeFile(join(fixture.workingCopy, "a.txt"), `${JSON.stringify(env)}\n`);
      git(fixture.workingCopy, ["add", "-A"]);
      git(fixture.workingCopy, ["commit", "-q", "--no-verify", "-m", "feat: other identity"], env);
      const bad = git(fixture.workingCopy, ["rev-parse", "HEAD"]);
      const good = fixture.commitCandidate({ "b.txt": "b\n" });
      const id = fixture.pushRequest(good);
      await fixture.runOnce();
      expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: good, outcome: "blocked", locations: [] });
      expect(fixture.logLine(id)).toMatch(/category=identity-mismatch/);
      expect(fixture.remoteHasObject(bad)).toBe(false);
    }
    expect(fixture.log()).not.toMatch(/synthetic-other|synthetic-author|example\.invalid/i);
    expect(fixture.remoteHead()).toBeNull();
  });

  it("checks only the commits the push would publish", async () => {
    const fixture = new HelperFixture();
    writeFile(join(fixture.workingCopy, "a.txt"), "already public\n");
    git(fixture.workingCopy, ["add", "-A"]);
    git(fixture.workingCopy, ["commit", "-q", "--no-verify", "-m", "feat: public"], other);
    const published = git(fixture.workingCopy, ["rev-parse", "HEAD"]);
    git(fixture.workingCopy, ["push", "-q", fixture.remote, `${published}:refs/heads/main`]);
    const sha = fixture.commitCandidate({ "b.txt": "b\n" });
    const id = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
  });

  it("blocks a request with a missing or different token and never logs the token", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const missing = newRequestId();
    fixture.writeRawRequest(`${missing}.json`, JSON.stringify({ version: 1, requestId: missing, worktreeId: WORKTREE_ID, operation: "push", sha }));
    const wrong = fixture.writeRequest({ operation: "push", sha, token: "0".repeat(64) });
    const short = fixture.writeRequest({ operation: "push", sha, token: "abc" });
    const comment = fixture.writeRequest({ operation: "pr-comment", sha, body: "Synthetic.\n", token: "f".repeat(64) });
    await fixture.runOnce();
    for (const id of [missing, wrong, short, comment]) {
      expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "blocked", locations: [] });
      expect(fixture.logLine(id)).toMatch(/category=invalid-token/);
    }
    expect(fixture.remoteHead()).toBeNull();
    expect(fixture.gh.calls()).toEqual([]);
    const good = fixture.pushRequest(sha);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(good), { requestId: good, requestedSha: sha, outcome: "published" });
    expect(fixture.log()).not.toContain(fixture.token);
    for (const name of fixture.responses()) expect(readFileSync(join(fixture.publication, "responses", name), "utf8")).not.toContain(fixture.token);
  });
});

describe("PUB-02 helper resume and bounds", () => {
  function flakyPushPath(fixture: HelperFixture): string {
    const bin = join(fixture.root, "flaky-bin");
    writeFile(
      join(bin, "git"),
      `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = push ]; then ${realGit} "$@"; exit 1; fi\n  if [ "$a" = ls-remote ]; then exit 1; fi\ndone\nexec ${realGit} "$@"\n`,
      0o755,
    );
    return `${bin}:${process.env.PATH ?? ""}`;
  }

  it("keeps an attempted push pending through a broken registry and settles it once fixed", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const id = fixture.pushRequest(sha);
    await fixture.runOnce({ env: { PATH: flakyPushPath(fixture) } });
    expect(fixture.logLine(id)).toMatch(/outcome=pending/);
    const broken: (() => void)[] = [
      () => {
        rmSync(fixture.registryPath);
      },
      () => {
        fixture.writeRegistry({ "synthetic-elsewhere": fixture.entry });
      },
      () => {
        fixture.writeRegistry({ [WORKTREE_ID]: { ...fixture.entry, branch: "main" } });
      },
      () => {
        fixture.writeRegistry({ [WORKTREE_ID]: { ...fixture.entry, token: "e".repeat(64) } });
      },
    ];
    for (const breakIt of broken) {
      breakIt();
      await fixture.runOnce();
      expect(fixture.readResponse(id)).toBeNull();
      expect(existsSync(join(fixture.state, "records", `${id}.json`))).toBe(false);
    }
    fixture.writeRegistry();
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
  });

  it("answers unavailable when the candidate fetch never finishes", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    execFileSync("mkfifo", [join(fixture.workingCopy, ".git", "synthetic-fifo")]);
    git(fixture.workingCopy, ["config", "--file", join(fixture.workingCopy, ".git", "config"), "include.path", "synthetic-fifo"]);
    const id = fixture.pushRequest(sha);
    const started = Date.now();
    await fixture.runOnce({ extra: ["--git-timeout-ms", "2000"] });
    expect(Date.now() - started).toBeLessThan(30_000);
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "unavailable" });
    expect(fixture.logLine(id)).toMatch(/category=timeout/);
  });

  it("answers unavailable when gitleaks never finishes", async () => {
    const fixture = new HelperFixture({ gitleaks: { hang: true } });
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const id = fixture.pushRequest(sha);
    await fixture.runOnce({ extra: ["--gitleaks-timeout-ms", "1500"] });
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "unavailable" });
    expect(fixture.remoteHead()).toBeNull();
  });

  it("keeps a push that timed out pending and settles it from the remote on the next run", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const path = gitWrapperPath(fixture, "    sleep 30");
    const id = fixture.pushRequest(sha);
    await fixture.runOnce({ env: { PATH: path }, extra: ["--git-timeout-ms", "1500"] });
    expect(fixture.readResponse(id)).toBeNull();
    expect(fixture.logLine(id)).toMatch(/outcome=pending/);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
  });

  it("runs git with stdin ignored and in a session of its own", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const record = join(fixture.root, "git-calls.txt");
    const bin = join(fixture.root, "probe-bin");
    writeFile(
      join(bin, "git"),
      `#!/bin/sh\necho "$(readlink /proc/$$/fd/0) $(cut -d' ' -f6 /proc/$$/stat) $$ $*" >> "${record}"\nexec ${realGit} "$@"\n`,
      0o755,
    );
    const id = fixture.pushRequest(sha);
    await fixture.runOnce({ env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
    const calls = readFileSync(record, "utf8").split("\n").filter((line) => line.length > 0);
    expect(calls.length).toBeGreaterThan(3);
    for (const line of calls) {
      const [stdin, session, pid] = line.split(" ");
      expect(session, line).toBe(pid);
      if (!line.includes("--batch")) expect(stdin, line).toBe("/dev/null");
    }
  });

  it("records unavailable after a request crashed the helper three times", async () => {
    const fixture = new HelperFixture({ gitleaks: { killParent: true } });
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const id = fixture.pushRequest(sha);
    for (let run = 0; run < 3; run += 1) {
      expect((await fixture.runOnce()).signal).toBe("SIGKILL");
      expect(fixture.readResponse(id)).toBeNull();
    }
    const last = await fixture.runOnce();
    expect(last.signal).toBeNull();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "unavailable" });
    expect(fixture.logLine(id)).toMatch(/category=too-many-attempts/);
  });

  it("refuses to start without printing the pattern file path when it cannot be resolved", async () => {
    const fixture = new HelperFixture();
    const patterns = join(fixture.patterns, "below-a-file.txt");
    const result = await fixture.runOnce({ extra: ["--patterns", patterns] });
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).not.toContain(patterns);
    expect(result.stdout + result.stderr).not.toContain(fixture.root);
    expect(result.stderr).toMatch(/refusing to start/);
  });

  it("refuses to start while a lock takeover file is left behind", async () => {
    const fixture = new HelperFixture();
    mkdirSync(fixture.state, { recursive: true });
    writeFileSync(join(fixture.state, "helper.lock"), "999999999\n");
    writeFileSync(join(fixture.state, "helper.lock.takeover"), "");
    const blocked = await fixture.runOnce();
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toMatch(/takeover/);
    rmSync(join(fixture.state, "helper.lock.takeover"));
    const replaced = await fixture.runOnce();
    expect(replaced.code).toBe(0);
    expect(existsSync(join(fixture.state, "helper.lock"))).toBe(false);
  });
});
