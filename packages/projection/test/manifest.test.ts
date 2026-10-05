import { readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Fixture, MUTATED_PATH, ORIGINAL_QUERY, cli, git, sha256, tempRoot } from "./support.ts";

interface ManifestFile {
  path: string;
  mode: string;
  size_bytes: number;
  sha256: string;
}

function readManifest(path: string): { host_commit: string; files: ManifestFile[] } {
  return JSON.parse(readFileSync(path, "utf8")) as { host_commit: string; files: ManifestFile[] };
}

describe("manifest", () => {
  it("ADM-01 lists every tracked blob of the pinned commit with mode, size and hash", async () => {
    const fixture = new Fixture();
    const result = await fixture.writeManifest();
    expect(result.code).toBe(0);
    const manifest = readManifest(fixture.manifestPath);
    expect(manifest.host_commit).toBe(fixture.hostCommit);
    expect(manifest.files.map((file) => file.path)).toEqual([
      "README.md",
      "answers/deep/more.txt",
      "answers/notes.txt",
      "bin/run.sh",
      "docs/guide.md",
      "src/app.test.ts",
      "src/app.ts",
      "src/query.ts",
      "tests/api/coverage/bundle.js.map",
      "tests/api/coverage/lcov.info",
    ]);
    const query = manifest.files.find((file) => file.path === MUTATED_PATH);
    expect(query).toEqual({ path: MUTATED_PATH, mode: "100644", size_bytes: Buffer.byteLength(ORIGINAL_QUERY), sha256: sha256(ORIGINAL_QUERY) });
    expect(manifest.files.find((file) => file.path === "bin/run.sh")?.mode).toBe("100755");
  });

  it("ADM-01 reads blob bytes from the commit, not from the working tree", async () => {
    const fixture = new Fixture();
    writeFileSync(join(fixture.repo, MUTATED_PATH), "working tree edit\n");
    writeFileSync(join(fixture.repo, "untracked.txt"), "untracked\n");
    expect((await fixture.writeManifest()).code).toBe(0);
    const manifest = readManifest(fixture.manifestPath);
    expect(manifest.files.find((file) => file.path === MUTATED_PATH)?.sha256).toBe(sha256(ORIGINAL_QUERY));
    expect(manifest.files.some((file) => file.path === "untracked.txt")).toBe(false);
  });

  it("ADM-01 reads an earlier commit when asked, not HEAD", async () => {
    const fixture = new Fixture();
    const older = git(fixture.repo, ["rev-parse", "HEAD~1"]);
    const result = await cli(["manifest", "--repo", fixture.repo, "--commit", older, "--out", fixture.manifestPath]);
    expect(result.code).toBe(0);
    const manifest = readManifest(fixture.manifestPath);
    expect(manifest.host_commit).toBe(older);
    expect(manifest.files).toEqual([
      { path: MUTATED_PATH, mode: "100644", size_bytes: 26, sha256: sha256("an older upstream version\n") },
    ]);
  });

  it("ADM-01 writes sorted canonical bytes and prints their SHA-256", async () => {
    const fixture = new Fixture();
    const first = await fixture.writeManifest();
    const bytes = readFileSync(fixture.manifestPath);
    const text = bytes.toString("utf8");
    expect(text.startsWith('{"files":[{"mode":"100644","path":"README.md","sha256":"')).toBe(true);
    expect(text).not.toMatch(/\s"|":\s|,\s|\n/);
    expect(first.stdout).toContain(`manifest_sha256=${sha256(bytes)}`);
    expect(first.stdout).toContain("files=10");
    expect(first.stdout).toContain("executable=1");
    const second = await fixture.writeManifest();
    expect(readFileSync(fixture.manifestPath)).toEqual(bytes);
    expect(second.stdout).toBe(first.stdout);
  });

  it("ADM-01 refuses a tracked symlink with unsupported_tracked_entry", async () => {
    const fixture = new Fixture();
    symlinkSync("README.md", join(fixture.repo, "link.md"));
    git(fixture.repo, ["add", "link.md"]);
    git(fixture.repo, ["commit", "-q", "-m", "Add a link"]);
    const head = git(fixture.repo, ["rev-parse", "HEAD"]);
    const result = await cli(["manifest", "--repo", fixture.repo, "--commit", head, "--out", fixture.manifestPath]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unsupported_tracked_entry link.md");
    expect(() => statSync(fixture.manifestPath)).toThrow();
  });

  it("ADM-01 refuses a submodule with unsupported_tracked_entry", async () => {
    const fixture = new Fixture();
    git(fixture.repo, ["update-index", "--add", "--cacheinfo", `160000,${fixture.hostCommit},vendor/sub`]);
    git(fixture.repo, ["commit", "-q", "-m", "Add a submodule"]);
    const head = git(fixture.repo, ["rev-parse", "HEAD"]);
    const result = await cli(["manifest", "--repo", fixture.repo, "--commit", head, "--out", fixture.manifestPath]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unsupported_tracked_entry vendor/sub");
  });

  it("refuses a commit that is not 40 lowercase hex or not in the repository", async () => {
    const fixture = new Fixture();
    const short = await cli(["manifest", "--repo", fixture.repo, "--commit", fixture.hostCommit.slice(0, 12), "--out", fixture.manifestPath]);
    expect(short.code).toBe(2);
    const absent = await cli(["manifest", "--repo", fixture.repo, "--commit", "0".repeat(40), "--out", fixture.manifestPath]);
    expect(absent.code).toBe(2);
    const notRepo = await cli(["manifest", "--repo", tempRoot(), "--commit", fixture.hostCommit, "--out", fixture.manifestPath]);
    expect(notRepo.code).toBe(2);
  });

  it("ignores replace refs in the upstream repository", async () => {
    const fixture = new Fixture();
    const older = git(fixture.repo, ["rev-parse", "HEAD~1"]);
    git(fixture.repo, ["replace", fixture.hostCommit, older]);
    expect((await fixture.writeManifest()).code).toBe(0);
    expect(readManifest(fixture.manifestPath).files).toHaveLength(10);
  });
});
