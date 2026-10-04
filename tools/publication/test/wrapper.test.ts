import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HelperFixture, WORKTREE_ID, waitFor } from "./helper-support.ts";
import {
  cleanEnv,
  commit,
  git,
  hookPath,
  initBare,
  initRepo,
  packageDir,
  run,
  tempDir,
  writeFile,
  wrapperPath,
  type RunResult,
} from "./support.ts";

interface Pending {
  result: Promise<RunResult>;
}

function startWrapper(fixture: HelperFixture, args: string[]): Pending {
  return { result: run(wrapperPath, [...args, "--inbox", fixture.inbox], { cwd: fixture.workingCopy, env: cleanEnv(), timeoutMs: 60_000 }) };
}

function requestFiles(fixture: HelperFixture): string[] {
  const dir = join(fixture.publication, "requests");
  return existsSync(dir) ? readdirSync(dir) : [];
}

async function claimNext(fixture: HelperFixture): Promise<{ id: string; request: Record<string, unknown> }> {
  await waitFor(() => requestFiles(fixture).some((name) => !name.startsWith(".")));
  const name = requestFiles(fixture).find((entry) => !entry.startsWith(".")) ?? "";
  const claimed = join(fixture.root, `claimed-${name}`);
  renameSync(join(fixture.publication, "requests", name), claimed);
  return { id: name.replace(/\.json$/, ""), request: JSON.parse(readFileSync(claimed, "utf8")) as Record<string, unknown> };
}

function respond(fixture: HelperFixture, id: string, response: Record<string, unknown>): void {
  writeFileSync(fixture.responsePath(id), JSON.stringify({ version: 1, requestId: id, ...response }));
}

function lines(result: RunResult): string[] {
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

describe("PUB-02 rbw-publish wrapper", () => {
  it("writes a push request for HEAD and exits 0 on published", async () => {
    const fixture = new HelperFixture();
    fixture.ensureLayout();
    const head = fixture.commitCandidate({ "a.txt": "a\n" });
    const pending = startWrapper(fixture, ["push", "--claim-timeout", "20", "--result-timeout", "30"]);
    const { id, request } = await claimNext(fixture);
    expect(id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(request).toEqual({ version: 1, requestId: id, worktreeId: WORKTREE_ID, token: fixture.token, operation: "push", sha: head });
    respond(fixture, id, { requestedSha: head, outcome: "published", publishedSha: head });
    const result = await pending.result;
    expect(lines(result)).toEqual(["published", head]);
    expect(result.code).toBe(0);
  });

  it("maps blocked, unavailable and stale to exit codes 1, 2 and 3", async () => {
    const fixture = new HelperFixture();
    fixture.ensureLayout();
    const head = fixture.commitCandidate({ "a.txt": "a\n" });
    const cases: [Record<string, unknown>, number, string[]][] = [
      [{ outcome: "blocked", locations: ["a.txt:1", "commit-0123456789ab:3"] }, 1, ["blocked", "a.txt:1", "commit-0123456789ab:3"]],
      [{ outcome: "unavailable" }, 2, ["unavailable"]],
      [{ outcome: "stale" }, 3, ["stale"]],
    ];
    for (const [response, code, expected] of cases) {
      const pending = startWrapper(fixture, ["push", "--sha", head, "--claim-timeout", "20", "--result-timeout", "30"]);
      const { id } = await claimNext(fixture);
      respond(fixture, id, { requestedSha: head, ...response });
      const result = await pending.result;
      expect(lines(result)).toEqual(expected);
      expect(result.code).toBe(code);
    }
    const pending = startWrapper(fixture, ["push", "--claim-timeout", "20", "--result-timeout", "30"]);
    const { id } = await claimNext(fixture);
    respond(fixture, id, { requestedSha: head, outcome: "blocked", locations: [] });
    const result = await pending.result;
    expect(result.code).toBe(1);
    expect(lines(result)).toHaveLength(2);
    expect(lines(result)[0]).toBe("blocked");
    expect(lines(result)[1]).toMatch(/refused.*conductor/);
  });

  it("writes pr-create and pr-comment requests with the exact text", async () => {
    const fixture = new HelperFixture();
    fixture.ensureLayout();
    const head = fixture.commitCandidate({ "a.txt": "a\n" });
    const bodyFile = writeFile(join(fixture.root, "body.md"), "Synthetic body.\r\n\nwith unicode \u00e9\n");
    const create = startWrapper(fixture, ["pr-create", "--title", "Synthetic title", "--body-file", bodyFile, "--claim-timeout", "20"]);
    const created = await claimNext(fixture);
    expect(created.request).toEqual({
      version: 1, requestId: created.id, worktreeId: WORKTREE_ID, token: fixture.token, operation: "pr-create", sha: head,
      title: "Synthetic title", body: "Synthetic body.\r\n\nwith unicode \u00e9\n",
    });
    respond(fixture, created.id, { requestedSha: head, outcome: "published", publishedSha: head });
    expect((await create.result).code).toBe(0);
    const comment = startWrapper(fixture, ["pr-comment", "--body-file", bodyFile, "--sha", head, "--claim-timeout", "20"]);
    const commented = await claimNext(fixture);
    expect(commented.request).toEqual({
      version: 1, requestId: commented.id, worktreeId: WORKTREE_ID, token: fixture.token, operation: "pr-comment", sha: head,
      body: "Synthetic body.\r\n\nwith unicode \u00e9\n",
    });
    respond(fixture, commented.id, { requestedSha: head, outcome: "stale" });
    expect((await comment.result).code).toBe(3);
  });

  it("exits 2 without writing a request when a local check fails", async () => {
    const fixture = new HelperFixture();
    fixture.ensureLayout();
    fixture.commitCandidate({ "a.txt": "a\n" });
    const body = writeFile(join(fixture.root, "body.md"), "ok\n");
    const invalidUtf8 = writeFile(join(fixture.root, "bad.md"), Uint8Array.from([0x61, 0xff]));
    const withNul = writeFile(join(fixture.root, "nul.md"), "a\u0000b");
    const longBody = writeFile(join(fixture.root, "long.md"), "x".repeat(65_537));
    const attempts: string[][] = [
      ["push", "--sha", "0000000000000000000000000000000000000001"],
      ["push", "--sha", "not-a-revision"],
      ["pr-create", "--title", "x".repeat(257), "--body-file", body],
      ["pr-create", "--title", "", "--body-file", body],
      ["pr-create", "--title", "two\nlines", "--body-file", body],
      ["pr-create", "--body-file", body],
      ["pr-comment", "--body-file", invalidUtf8],
      ["pr-comment", "--body-file", withNul],
      ["pr-comment", "--body-file", longBody],
      ["pr-comment"],
      ["merge"],
    ];
    for (const args of attempts) {
      const result = await startWrapper(fixture, [...args, "--claim-timeout", "1"]).result;
      expect(result.code, args.join(" ")).toBe(2);
      expect(requestFiles(fixture)).toEqual([]);
    }
    for (const token of [null, "abc", fixture.token.toUpperCase()]) {
      if (token === null) git(fixture.workingCopy, ["config", "--unset", "rbw.worktreeToken"]);
      else git(fixture.workingCopy, ["config", "rbw.worktreeToken", token]);
      const noToken = await startWrapper(fixture, ["push", "--claim-timeout", "1"]).result;
      expect(noToken.code).toBe(2);
      expect(noToken.stdout + noToken.stderr).not.toContain(fixture.token);
      expect(noToken.stdout + noToken.stderr).not.toContain(fixture.token.toUpperCase());
      expect(requestFiles(fixture)).toEqual([]);
    }
    git(fixture.workingCopy, ["config", "rbw.worktreeToken", fixture.token]);
    git(fixture.workingCopy, ["config", "--unset", "rbw.worktreeId"]);
    const noId = await startWrapper(fixture, ["push", "--claim-timeout", "1"]).result;
    expect(noId.code).toBe(2);
    expect(requestFiles(fixture)).toEqual([]);
  });

  it("withdraws an unclaimed request on timeout, and a helper started afterwards publishes nothing", async () => {
    const fixture = new HelperFixture();
    fixture.ensureLayout();
    fixture.commitCandidate({ "a.txt": "a\n" });
    const result = await startWrapper(fixture, ["push", "--claim-timeout", "1", "--result-timeout", "5"]).result;
    expect(lines(result)[0]).toBe("unavailable");
    expect(result.code).toBe(2);
    expect(requestFiles(fixture)).toEqual([]);
    await fixture.runOnce();
    expect(fixture.responses()).toEqual([]);
    expect(fixture.remoteHead()).toBeNull();
  });

  it("keeps waiting for a claimed request and exits 4 with the request id when no response arrives", async () => {
    const fixture = new HelperFixture();
    fixture.ensureLayout();
    const head = fixture.commitCandidate({ "a.txt": "a\n" });
    const late = startWrapper(fixture, ["push", "--claim-timeout", "1", "--result-timeout", "6"]);
    const first = await claimNext(fixture);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    respond(fixture, first.id, { requestedSha: head, outcome: "published", publishedSha: head });
    const lateResult = await late.result;
    expect(lines(lateResult)).toEqual(["published", head]);

    const silent = startWrapper(fixture, ["push", "--claim-timeout", "1", "--result-timeout", "3"]);
    const second = await claimNext(fixture);
    const silentResult = await silent.result;
    expect(silentResult.code).toBe(4);
    expect(silentResult.stdout + silentResult.stderr).toContain(second.id);
  });

  it("publishes end to end with the helper", async () => {
    const fixture = new HelperFixture();
    fixture.ensureLayout();
    const head = fixture.commitCandidate({ "a.txt": "a\n" });
    const pending = startWrapper(fixture, ["push", "--claim-timeout", "30", "--result-timeout", "60"]);
    await waitFor(() => requestFiles(fixture).some((name) => !name.startsWith(".")));
    await fixture.runOnce();
    const result = await pending.result;
    expect(lines(result)).toEqual(["published", head]);
    expect(result.stdout + result.stderr).not.toContain(fixture.token);
    expect(fixture.remoteHead()).toBe(head);
  });
});

describe("PUB-02 pre-push hook", () => {
  it("is tracked as executable together with the wrapper", () => {
    const out = git(packageDir, ["ls-files", "-s", "bin/rbw-publish", "hooks/pre-push"]);
    const modes = out.split("\n").map((line) => line.split(" ")[0]);
    expect(modes).toEqual(["100755", "100755"]);
  });

  it("refuses a direct git push, names the wrapper and leaves the remote unchanged", async () => {
    const root = tempDir();
    const clone = initRepo(join(root, "clone"));
    mkdirSync(join(clone, "tools", "publication", "hooks"), { recursive: true });
    copyFileSync(hookPath, join(clone, "tools", "publication", "hooks", "pre-push"));
    commit(clone, { "a.txt": "a\n" }, "chore: base\n");
    const remote = initBare(join(root, "remote.git"));
    git(clone, ["config", "core.hooksPath", "tools/publication/hooks"]);
    const result = await run("git", ["push", remote, "HEAD:refs/heads/synthetic"], { cwd: clone, env: cleanEnv() });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("tools/publication/bin/rbw-publish push");
    expect(git(root, ["--git-dir", remote, "for-each-ref"])).toBe("");
  });

  it("is a POSIX shell script", () => {
    expect(readFileSync(hookPath, "utf8").startsWith("#!/bin/sh\n")).toBe(true);
    expect(readFileSync(wrapperPath, "utf8").startsWith("#!/bin/sh\n")).toBe(true);
  });
});
