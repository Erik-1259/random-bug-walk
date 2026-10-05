import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { AFTER, BEFORE, ROUTE, TARGET } from "./support.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "shapes-cli-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const targetFile = join(dir, "target.ts");
const routeFile = join(dir, "route.ts");
writeFileSync(targetFile, TARGET);
writeFileSync(routeFile, ROUTE);

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const TARGET_ARGS = ["confirm-target", "--file", targetFile, "--path", "src/queries/sql/pageviews/getPageviewStats.ts", "--route", routeFile];

function git(repo: string, args: string[]): string {
  const result = spawnSync(
    "git",
    ["-C", repo, "-c", "user.name=synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe("shapes CLI", () => {
  it("exits 2 with usage for an unknown command", () => {
    const result = cli(["confirm-everything"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
  });

  it("exits 1 and prints the reason when the target is not applicable", () => {
    const result = cli(TARGET_ARGS);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^not_applicable: file_hash_mismatch: /);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "not_applicable", reason: "file_hash_mismatch" });
  });

  it("writes identical record bytes on two runs", () => {
    const first = join(dir, "first.json");
    const second = join(dir, "second.json");
    expect(cli([...TARGET_ARGS, "--record", first]).status).toBe(1);
    expect(cli([...TARGET_ARGS, "--record", second]).status).toBe(1);
    const bytes = readFileSync(first, "utf8");
    expect(bytes).toBe(readFileSync(second, "utf8"));
    expect(bytes.startsWith('{"detail":')).toBe(true);
  });

  it("exits 2 for an unreadable input or a malformed rule file", () => {
    expect(cli(["confirm-target", "--file", join(dir, "missing.ts"), "--path", "x.ts", "--route", routeFile]).status).toBe(2);
    const badRule = join(dir, "bad.yml");
    writeFileSync(badRule, "id: [unclosed");
    const result = cli([...TARGET_ARGS, "--rule", badRule]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("rule file");
  });

  it("exits 1 for check-probes on a file with another hash", () => {
    const result = cli(["check-probes", "--planted", targetFile]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^refused: base_hash_mismatch: /);
  });

  it("reads the commit pairing from git and exits 1 for an unsupported source commit", () => {
    const repo = join(dir, "repo");
    spawnSync("git", ["init", "-q", repo]);
    const file = join(repo, "page.tsx");
    writeFileSync(file, BEFORE);
    git(repo, ["add", "page.tsx"]);
    git(repo, ["commit", "-q", "-m", "synthetic before"]);
    const parent = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(file, AFTER);
    git(repo, ["commit", "-q", "-am", "synthetic after"]);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const result = cli(["confirm-source", "--git-dir", join(repo, ".git"), "--commit", commit, "--parent", parent]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^unsupported_source_match: unsupported_commit: /);
    expect(cli(["confirm-source", "--git-dir", join(dir, "no-repo"), "--commit", commit, "--parent", parent]).status).toBe(2);
  });
});
