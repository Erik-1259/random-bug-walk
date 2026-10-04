import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRANCH, HelperFixture, OWNER, expectResponse } from "./helper-support.ts";
import { git, writeFile } from "./support.ts";

const HOOK_NAMES = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg",
  "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update",
  "proc-receive", "post-receive", "post-update", "reference-transaction", "push-to-checkout", "pre-auto-gc",
  "post-rewrite", "sendemail-validate", "fsmonitor-watchman", "post-index-change",
];

/** A script that leaves a marker file named after the way it was invoked. */
function markerScript(fixture: HelperFixture): { script: string; markers: string } {
  const markers = join(fixture.root, "markers");
  mkdirSync(markers, { recursive: true });
  const script = writeFile(join(fixture.root, "mark.sh"), `#!/bin/sh\ntouch "${markers}/$(basename "$0")-$$"\nexit 1\n`, 0o755);
  return { script, markers };
}

function setConfig(repo: string, key: string, value: string): void {
  git(repo, ["config", "--file", join(repo, ".git", "config"), key, value]);
}

describe("PUB-02 helper with hostile working copies", () => {
  it("runs nothing from a working copy's config or hooks during a full publish cycle", async () => {
    const fixture = new HelperFixture({
      gh: {
        pullRequests: [],
      },
    });
    const sha = fixture.commitCandidate({ "src/a.ts": "export const a = 1;\n" });
    const { script, markers } = markerScript(fixture);
    const hooks = join(fixture.root, "hostile-hooks");
    for (const name of HOOK_NAMES) {
      writeFile(join(hooks, name), `#!/bin/sh\nexec "${script}"\n`, 0o755);
      writeFile(join(fixture.workingCopy, ".git", "hooks", name), `#!/bin/sh\nexec "${script}"\n`, 0o755);
    }
    const repo = fixture.workingCopy;
    setConfig(repo, "core.fsmonitor", script);
    setConfig(repo, "core.hooksPath", hooks);
    setConfig(repo, "credential.helper", `!${script}`);
    setConfig(repo, "core.sshCommand", script);
    setConfig(repo, "core.askPass", script);
    setConfig(repo, "core.pager", script);
    setConfig(repo, "core.editor", script);
    setConfig(repo, "uploadpack.packObjectsHook", script);
    setConfig(repo, "alias.fetch", `!${script}`);
    setConfig(repo, "alias.upload-pack", `!${script}`);
    setConfig(repo, "alias.push", `!${script}`);
    setConfig(repo, "remote.origin.url", "ssh://example.invalid/synthetic.git");
    setConfig(repo, "remote.origin.uploadpack", script);

    const push = fixture.pushRequest(sha);
    await fixture.runOnce({ env: { GIT_NO_LAZY_FETCH: "0" } });
    expectResponse(fixture.readResponse(push), { requestId: push, requestedSha: sha, outcome: "published" });
    const create = fixture.writeRequest({ operation: "pr-create", sha, title: "Synthetic", body: "Synthetic body.\n" });
    await fixture.runOnce({ env: { GIT_NO_LAZY_FETCH: "0" } });
    expectResponse(fixture.readResponse(create), { requestId: create, requestedSha: sha, outcome: "published" });
    const comment = fixture.writeRequest({ operation: "pr-comment", sha, body: "Synthetic comment.\n" });
    await fixture.runOnce({ env: { GIT_NO_LAZY_FETCH: "0" } });
    expectResponse(fixture.readResponse(comment), { requestId: comment, requestedSha: sha, outcome: "published" });
    expect(fixture.remoteHead(BRANCH)).toBe(sha);
    expect(fixture.gh.state().pullRequests[0]?.headRepositoryOwner.login.toLowerCase()).toBe(OWNER);
    expect(readdirSync(markers)).toEqual([]);
  });

  it("answers stale for a partial clone missing a blob and never runs its promisor command", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "data/missing.txt": "synthetic content only in the lost blob\n" });
    const blob = git(fixture.workingCopy, ["rev-parse", `${sha}:data/missing.txt`]);
    const { script, markers } = markerScript(fixture);
    const repo = fixture.workingCopy;
    setConfig(repo, "core.repositoryformatversion", "1");
    setConfig(repo, "extensions.partialClone", "origin");
    setConfig(repo, "remote.origin.url", "ssh://example.invalid/synthetic.git");
    setConfig(repo, "remote.origin.promisor", "true");
    setConfig(repo, "remote.origin.partialclonefilter", "blob:none");
    setConfig(repo, "core.sshCommand", script);
    rmSync(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

    const id = fixture.pushRequest(sha);
    await fixture.runOnce({ env: { GIT_NO_LAZY_FETCH: "0" } });
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "stale" });
    expect(readdirSync(markers)).toEqual([]);
    expect(fixture.remoteHead()).toBeNull();
  });
});
