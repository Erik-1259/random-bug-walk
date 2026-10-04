import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HelperFixture, expectResponse, newRequestId, waitFor, waitForExit } from "./helper-support.ts";
import { writeStubGitleaks } from "./support.ts";

function listing(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("PUB-02 helper inbox layout", () => {
  it("claims a request into the state directory and creates no claimed/ in the inbox", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const id = fixture.pushRequest(sha);
    const result = await fixture.runOnce();
    expect(result.code).toBe(0);
    expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: sha, outcome: "published" });
    expect(existsSync(join(fixture.publication, "claimed"))).toBe(false);
    expect(lstatSync(fixture.claimedPath(id)).isFile()).toBe(true);
    expect(listing(join(fixture.publication, "requests"))).toEqual([]);
  });

  it("creates nothing through a publication/ symlink and refuses to serve", async () => {
    const fixture = new HelperFixture();
    const outside = join(fixture.root, "outside-publication");
    mkdirSync(outside);
    symlinkSync(outside, fixture.publication);
    const result = await fixture.runOnce();
    expect(result.code).not.toBe(0);
    expect(listing(outside)).toEqual([]);
    expect(fixture.log()).toMatch(/inbox layout invalid/);
  });

  it("refuses to serve and writes nothing when requests/ is a symlink", async () => {
    const fixture = new HelperFixture();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const outside = join(fixture.root, "outside-requests");
    mkdirSync(join(fixture.publication, "responses"), { recursive: true });
    mkdirSync(outside);
    const id = newRequestId();
    writeFileSync(join(outside, `${id}.json`), JSON.stringify({ version: 1, requestId: id, worktreeId: "synthetic-worktree", token: fixture.token, operation: "push", sha }));
    symlinkSync(outside, join(fixture.publication, "requests"));
    const result = await fixture.runOnce();
    expect(result.code).not.toBe(0);
    expect(listing(outside)).toEqual([`${id}.json`]);
    expect(listing(join(fixture.publication, "responses"))).toEqual([]);
    expect(fixture.remoteHead()).toBeNull();
  });

  it("refuses to serve when responses/ is a regular file", async () => {
    const fixture = new HelperFixture();
    mkdirSync(join(fixture.publication, "requests"), { recursive: true });
    writeFileSync(join(fixture.publication, "responses"), "not a directory");
    const result = await fixture.runOnce();
    expect(result.code).not.toBe(0);
    expect(readFileSync(join(fixture.publication, "responses"), "utf8")).toBe("not a directory");
    expect(fixture.log()).toMatch(/inbox layout invalid/);
  });

  it("stops with one alert line when responses/ is replaced while a request is processed", async () => {
    const fixture = new HelperFixture();
    fixture.ensureLayout();
    const responses = join(fixture.publication, "responses");
    fixture.gitleaks = writeStubGitleaks(join(fixture.root, "host", "gl-swap"), { replaceDirectory: responses });
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const id = fixture.pushRequest(sha);
    const next = fixture.pushRequest(sha);
    const result = await fixture.runOnce();
    expect(result.code).not.toBe(0);
    expect(listing(responses)).toEqual([]);
    expect(listing(`${responses}-replaced`)).toEqual([]);
    expect(fixture.log().match(/event="inbox directory changed; serving stopped"/g)).toHaveLength(1);
    expect(existsSync(join(fixture.publication, "requests", `${next}.json`))).toBe(true);
    expect(fixture.logLine(id)).toMatch(/outcome=published/);
  });

  it("serve stops by itself when requests/ is replaced", async () => {
    const fixture = new HelperFixture();
    const child = fixture.startServe();
    const exited = waitForExit(child, 60_000);
    await waitFor(() => fixture.log().includes("event=serving"));
    const requests = join(fixture.publication, "requests");
    // The old directory stays, so the new one cannot reuse its inode.
    renameSync(requests, `${requests}-old`);
    mkdirSync(requests);
    const { code } = await exited;
    expect(code).not.toBe(0);
    expect(fixture.log().match(/event="inbox directory changed; serving stopped"/g)).toHaveLength(1);
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    fixture.pushRequest(sha);
    expect(fixture.responses()).toEqual([]);
  });

  it("answers a symlink, a directory or a FIFO in requests/ as invalid without following it", async () => {
    const fixture = new HelperFixture();
    fixture.ensureLayout();
    const sha = fixture.commitCandidate({ "a.txt": "a\n" });
    const target = join(fixture.root, "outside-request.json");
    const linked = newRequestId();
    writeFileSync(target, JSON.stringify({ version: 1, requestId: linked, worktreeId: "synthetic-worktree", token: fixture.token, operation: "push", sha }));
    symlinkSync(target, join(fixture.publication, "requests", `${linked}.json`));
    const directory = newRequestId();
    mkdirSync(join(fixture.publication, "requests", `${directory}.json`));
    const fifo = newRequestId();
    execFileSync("mkfifo", [join(fixture.publication, "requests", `${fifo}.json`)]);
    const result = await fixture.runOnce();
    expect(result.code).toBe(0);
    for (const id of [linked, directory, fifo]) {
      expectResponse(fixture.readResponse(id), { requestId: id, requestedSha: null, outcome: "blocked", locations: [] });
      expect(fixture.logLine(id)).toMatch(/category=invalid-request/);
    }
    expect(existsSync(target)).toBe(true);
    expect(fixture.remoteHead()).toBeNull();
  });

  it("logs an agent-chosen file name without control or bidirectional characters", async () => {
    const fixture = new HelperFixture();
    fixture.ensureLayout();
    const name = "bad\u001b[31m‮name\u0085\u007f.json";
    writeFileSync(join(fixture.publication, "requests", name), "{}");
    await fixture.runOnce();
    const log = fixture.log();
    expect(log).toMatch(/invalid request file name/);
    const unexpected = log.replace(/[\n\x20-\x7e]/g, "");
    expect(unexpected).toBe("");
  });
});
