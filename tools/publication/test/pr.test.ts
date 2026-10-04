import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRANCH,
  HELPER_TERM,
  HelperFixture,
  OWNER,
  REPOSITORY,
  expectResponse,
  waitFor,
  waitForExit,
  writeStubGh,
  type StubGhOptions,
  type StubPullRequest,
} from "./helper-support.ts";
import { git, writeStubGitleaks } from "./support.ts";

function openPr(overrides: Partial<StubPullRequest> = {}): StubPullRequest {
  return {
    number: 42,
    title: "Synthetic pull request",
    body: "Synthetic body.",
    headRefName: BRANCH,
    state: "OPEN",
    isDraft: true,
    isCrossRepository: false,
    headRepositoryOwner: { login: OWNER },
    comments: [],
    ...overrides,
  };
}

/** A fixture whose remote branch already points at the returned SHA. */
function published(gh: StubGhOptions = {}): { fixture: HelperFixture; sha: string } {
  const fixture = new HelperFixture({ gh });
  const sha = fixture.commitCandidate({ "a.txt": "a\n" });
  git(fixture.workingCopy, ["push", "-q", fixture.remote, `${sha}:refs/heads/${BRANCH}`]);
  return { fixture, sha };
}

function postCalls(fixture: HelperFixture): { args: string[]; bodyFile: string | null }[] {
  return fixture.gh.calls().filter((call) => call.args[1] === "create" || call.args[1] === "comment");
}

function decode(base64: string | null): string {
  return Buffer.from(base64 ?? "", "base64").toString("utf8");
}

const BODY = "Synthetic summary.\n\n- first point\n- second point\n";

describe("PUB-02 helper pull request operations", () => {
  it("creates a draft PR from the registered branch with exactly the scanned bytes", async () => {
    const { fixture, sha } = published();
    const title = "--synthetic title that looks like an option";
    const id = fixture.writeRequest({ operation: "pr-create", sha, title, body: BODY });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
    const calls = postCalls(fixture);
    expect(calls).toHaveLength(1);
    const args = calls[0]?.args ?? [];
    expect(args.slice(0, 2)).toEqual(["pr", "create"]);
    expect(args).toContain("--draft");
    expect(args).toContain(`--title=${title}`);
    expect(args.join(" ")).toContain(`--repo ${REPOSITORY}`);
    expect(args.join(" ")).toContain(`--head ${BRANCH}`);
    expect(args.join(" ")).toContain("--base main");
    expect(decode(calls[0]?.bodyFile ?? null)).toBe(BODY);
    expect(fixture.logLine(id)).toMatch(/outcome=published .*pr=100/);
    const list = fixture.gh.calls().find((call) => call.args[1] === "list");
    expect(list?.args).toEqual([
      "pr", "list", "--repo", REPOSITORY, "--head", BRANCH, "--state", "open", "--json",
      "number,title,body,isCrossRepository,headRepositoryOwner",
    ]);
  });

  it("blocks pr-create when a selected open PR exists", async () => {
    const { fixture, sha } = published({ pullRequests: [openPr()] });
    const id = fixture.writeRequest({ operation: "pr-create", sha, title: "Another", body: BODY });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "blocked", locations: [] });
    expect(fixture.logLine(id)).toMatch(/category=pull-request-exists/);
    expect(postCalls(fixture)).toHaveLength(0);
  });

  it("comments on the selected open PR", async () => {
    const { fixture, sha } = published({ pullRequests: [openPr()] });
    const id = fixture.writeRequest({ operation: "pr-comment", sha, body: BODY });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
    const calls = postCalls(fixture);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(0, 3)).toEqual(["pr", "comment", "42"]);
    expect(calls[0]?.args.join(" ")).toContain(`--repo ${REPOSITORY}`);
    expect(decode(calls[0]?.bodyFile ?? null)).toBe(BODY);
    expect(fixture.logLine(id)).toMatch(/pr=42/);
  });

  it("blocks pr-comment without an open PR", async () => {
    const { fixture, sha } = published({ pullRequests: [openPr({ state: "CLOSED" })] });
    const id = fixture.writeRequest({ operation: "pr-comment", sha, body: BODY });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "blocked", locations: [] });
    expect(fixture.logLine(id)).toMatch(/category=no-pull-request/);
  });

  it("never uses a fork PR with the same branch name", async () => {
    const fork = openPr({ number: 7, isCrossRepository: true, headRepositoryOwner: { login: "synthetic-fork" } });
    const sameOwnerName = openPr({ number: 8, isCrossRepository: false, headRepositoryOwner: { login: "synthetic-other" } });
    const { fixture, sha } = published({ pullRequests: [fork, sameOwnerName] });
    const comment = fixture.writeRequest({ operation: "pr-comment", sha, body: BODY });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(comment), { requestId: comment, requestedSha: sha, outcome: "blocked", locations: [] });
    expect(fixture.logLine(comment)).toMatch(/category=no-pull-request/);
    const create = fixture.writeRequest({ operation: "pr-create", sha, title: "Synthetic", body: BODY });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(create), { requestId: create, requestedSha: sha, outcome: "published" });
    expect(postCalls(fixture).map((call) => call.args[1])).toEqual(["create"]);
  });

  it("blocks forbidden text with pr-title, pr-body and pr-comment locations", async () => {
    const { fixture, sha } = published({ pullRequests: [] });
    const title = fixture.writeRequest({ operation: "pr-create", sha, title: `About ${HELPER_TERM}`, body: BODY });
    const body = fixture.writeRequest({ operation: "pr-create", sha, title: "Fine", body: `one\ntwo\n${HELPER_TERM}\n` });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(title), { requestId: title, requestedSha: sha, outcome: "blocked", locations: ["pr-title:1"] });
    expectResponse(fixture.readResponse(body), { requestId: body, requestedSha: sha, outcome: "blocked", locations: ["pr-body:3"] });
    expect(fixture.logLine(title)).toMatch(/category=content/);
    const state = writeStubGh(join(fixture.root, "host", "gh2"), { pullRequests: [openPr()] });
    fixture.gh = state;
    const comment = fixture.writeRequest({ operation: "pr-comment", sha, body: `fine\n${HELPER_TERM}\n` });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(comment), { requestId: comment, requestedSha: sha, outcome: "blocked", locations: ["pr-comment:2"] });
    expect(postCalls(fixture)).toHaveLength(0);
    expect(fixture.log()).not.toContain(HELPER_TERM);
  });

  it("applies the repository URL exception to PR text", async () => {
    const fixture = new HelperFixture({ gh: { pullRequests: [openPr()] } });
    writeFileSync(fixture.patterns, `${HELPER_TERM}\n${OWNER}\n`);
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    git(fixture.workingCopy, ["push", "-q", fixture.remote, `${sha}:refs/heads/${BRANCH}`]);
    const id = fixture.writeRequest({ operation: "pr-comment", sha, body: `See https://github.com/${REPOSITORY}/pull/42\n` });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
  });

  it("answers stale when the remote head differs from the SHA", async () => {
    const { fixture, sha } = published({ pullRequests: [openPr()] });
    const later = fixture.commitCandidate({ "b.txt": "b\n" });
    const id = fixture.writeRequest({ operation: "pr-comment", sha: later, body: BODY });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: later, outcome: "stale" });
    expect(postCalls(fixture)).toHaveLength(0);
    expect(sha).not.toBe(later);
  });

  it("answers unavailable without a repository or when gh fails", async () => {
    const { fixture, sha } = published({ pullRequests: [openPr()] });
    const withoutRepository: Record<string, unknown> = { ...fixture.entry };
    delete withoutRepository.repository;
    fixture.writeRegistry({ "synthetic-worktree": withoutRepository });
    const noRepo = fixture.writeRequest({ operation: "pr-comment", sha, body: BODY });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(noRepo), { requestId: noRepo, requestedSha: sha, outcome: "unavailable" });
    fixture.writeRegistry();
    fixture.gh = writeStubGh(join(fixture.root, "host", "gh-broken"), { broken: true });
    const broken = fixture.writeRequest({ operation: "pr-comment", sha, body: BODY });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(broken), { requestId: broken, requestedSha: sha, outcome: "unavailable" });
  });

  it("answers published when gh fails after posting and unavailable when nothing was posted", async () => {
    const { fixture, sha } = published({ pullRequests: [openPr()], fail: "after-post" });
    const id = fixture.writeRequest({ operation: "pr-comment", sha, body: BODY });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
    fixture.gh = writeStubGh(join(fixture.root, "host", "gh-nopost"), { pullRequests: [openPr()], fail: "without-post" });
    const failed = fixture.writeRequest({ operation: "pr-comment", sha, body: BODY });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(failed), { requestId: failed, requestedSha: sha, outcome: "unavailable" });
  });

  it("sends the scanned bytes even when the claimed request file changes after the claim", async () => {
    const { fixture, sha } = published({ pullRequests: [openPr()] });
    const id = "synthetic-claim-change-1";
    const changed = JSON.stringify({ version: 1, requestId: id, worktreeId: "synthetic-worktree", token: fixture.token, operation: "pr-comment", sha, body: "changed after claim\n" });
    fixture.gitleaks = writeStubGitleaks(join(fixture.root, "host", "gl-change"), {
      onRun: { path: fixture.claimedPath(id), content: changed },
    });
    fixture.writeRequest({ operation: "pr-comment", sha, body: BODY }, id);
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
    expect(postCalls(fixture).map((call) => decode(call.bodyFile))).toEqual([BODY]);
  });

  it("sends the stored bytes after a restart even when the claimed file changed", async () => {
    const { fixture, sha } = published({ pullRequests: [openPr()], kill: "before-post" });
    const id = fixture.writeRequest({ operation: "pr-comment", sha, body: BODY });
    const crashed = await fixture.runOnce();
    expect(crashed.signal).toBe("SIGKILL");
    expect(fixture.readResponse(id)).toBeNull();
    const claimed = fixture.claimedPath(id);
    const original = JSON.parse(readFileSync(claimed, "utf8")) as Record<string, unknown>;
    writeFileSync(claimed, JSON.stringify({ ...original, body: "tampered after claim\n" }));
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
    const comments = fixture.gh.state().pullRequests[0]?.comments ?? [];
    expect(comments.map((comment) => comment.body.replaceAll("\r\n", "\n"))).toEqual([BODY]);
  });

  for (const operation of ["pr-create", "pr-comment"] as const) {
    it(`publishes once after a crash between posting and recording (${operation})`, async () => {
      const pullRequests = operation === "pr-comment" ? [openPr()] : [];
      const { fixture, sha } = published({ pullRequests, kill: "after-post" });
      const fields = operation === "pr-create" ? { title: "Synthetic title", body: BODY } : { body: BODY };
      const id = fixture.writeRequest({ operation, sha, ...fields });
      const crashed = await fixture.runOnce();
      expect(crashed.signal).toBe("SIGKILL");
      expect(fixture.readResponse(id)).toBeNull();
      await fixture.runOnce();
      expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
      expect(postCalls(fixture)).toHaveLength(1);
    });
  }

  it("finds a created PR on resume although GitHub trimmed its title", async () => {
    const { fixture, sha } = published({ kill: "after-post" });
    const id = fixture.writeRequest({ operation: "pr-create", sha, title: "  Synthetic padded title ", body: BODY });
    expect((await fixture.runOnce()).signal).toBe("SIGKILL");
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
    expect(postCalls(fixture)).toHaveLength(1);
  });

  it("rewrites a deleted pr-comment response from its record without posting again", async () => {
    const { fixture, sha } = published({ pullRequests: [openPr()] });
    const id = fixture.writeRequest({ operation: "pr-comment", sha, body: BODY });
    await fixture.runOnce();
    const first = readFileSync(fixture.responsePath(id), "utf8");
    rmSync(fixture.responsePath(id));
    await fixture.runOnce();
    expect(readFileSync(fixture.responsePath(id), "utf8")).toBe(first);
    expect(postCalls(fixture)).toHaveLength(1);
  });

  it("serve creates a PR and comments on it", async () => {
    const { fixture, sha } = published();
    const child = fixture.startServe();
    const exited = waitForExit(child, 60_000);
    try {
      const create = fixture.writeRequest({ operation: "pr-create", sha, title: "Synthetic", body: BODY });
      await waitFor(() => fixture.readResponse(create) !== null);
      expectResponse(fixture.readResponse(create), { requestId: create, requestedSha: sha, outcome: "published" });
      const exists = fixture.writeRequest({ operation: "pr-create", sha, title: "Again", body: BODY });
      await waitFor(() => fixture.readResponse(exists) !== null);
      expectResponse(fixture.readResponse(exists), { requestId: exists, requestedSha: sha, outcome: "blocked", locations: [] });
      const comment = fixture.writeRequest({ operation: "pr-comment", sha, body: BODY });
      await waitFor(() => fixture.readResponse(comment) !== null);
      expectResponse(fixture.readResponse(comment), { requestId: comment, requestedSha: sha, outcome: "published" });
    } finally {
      child.kill("SIGTERM");
    }
    expect((await exited).code).toBe(0);
    expect(postCalls(fixture).map((call) => call.args[1])).toEqual(["create", "comment"]);
  });
});

describe("PUB-02 helper PR text bounds", () => {
  it("sends a title with a leading byte-order mark exactly as scanned", async () => {
    const { fixture, sha } = published({ pullRequests: [] });
    const title = "﻿Synthetic title";
    const id = fixture.writeRequest({ operation: "pr-create", sha, title, body: BODY });
    await fixture.runOnce();
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
    expect(postCalls(fixture)[0]?.args).toContain(`--title=${title}`);
  });

  it("answers unavailable when gh never finishes", async () => {
    const { fixture, sha } = published({ pullRequests: [openPr()], hang: true });
    const id = fixture.writeRequest({ operation: "pr-comment", sha, body: BODY });
    const started = Date.now();
    await fixture.runOnce({ extra: ["--gh-timeout-ms", "1500"] });
    expect(Date.now() - started).toBeLessThan(30_000);
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "unavailable" });
    expect(postCalls(fixture)).toHaveLength(0);
  });
});
