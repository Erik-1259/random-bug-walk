import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand, type CommandDeps } from "../../src/commands.ts";
import { FIXTURE_DIR } from "../support/generate-fixture.ts";
import { steppingClock, syntheticGitHub } from "../support/synthetic-github.ts";

function deps(overrides: Partial<CommandDeps> = {}): CommandDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const clock = steppingClock();
  return {
    env: {},
    fetch: () => Promise.reject(new Error("no network in this test")),
    now: clock.now,
    sleep: () => Promise.resolve(),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    out,
    err,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("command line", () => {
  it("prints the funnel from frozen responses with exit 0 and no network", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network used")));
    const io = deps();
    expect(await runCommand(["funnel", "--in", FIXTURE_DIR], io)).toBe(0);
    expect(io.out.join("")).toBe(readFileSync(join(FIXTURE_DIR, "funnel.json"), "utf8"));
  });

  it("accepts the leading -- that pnpm passes", async () => {
    expect(await runCommand(["--", "funnel", "--in", FIXTURE_DIR], deps())).toBe(0);
  });

  it("refuses bad usage with exit 2", async () => {
    const io = deps();
    expect(await runCommand(["funnel"], io)).toBe(2);
    expect(await runCommand(["harvest", "--out", "x", "--max", "0"], io)).toBe(2);
    expect(await runCommand(["harvest", "--out", "x", "--max", "2.5"], io)).toBe(2);
    expect(await runCommand(["nonsense"], io)).toBe(2);
    expect(io.err.join("")).toContain("usage:");
  });

  it("harvests live through the injected fetch, reads the token from the environment and never prints it", async () => {
    const github = syntheticGitHub();
    const out = join(mkdtempSync(join(tmpdir(), "harvest-cli-")), "run");
    const io = deps({ fetch: github.fetch, env: { GITHUB_TOKEN: "synthetic-token-value" } });
    expect(await runCommand(["harvest", "--out", out, "--max", "3"], io)).toBe(0);
    expect(github.requests.every((request) => request.authorization === "token synthetic-token-value")).toBe(true);
    expect(io.out.join("") + io.err.join("")).not.toContain("synthetic-token-value");
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ max: 3, authenticated: true });
    expect(JSON.stringify(manifest)).not.toContain("synthetic-token-value");
    expect(io.out.join("")).toContain("harvested");
    expect(existsSync(join(out, "funnel.json"))).toBe(true);
  });

  it("refuses to harvest into a directory that already holds a run", async () => {
    const out = mkdtempSync(join(tmpdir(), "harvest-cli-"));
    writeFileSync(join(out, "manifest.json"), "{}");
    const io = deps({ fetch: syntheticGitHub().fetch });
    expect(await runCommand(["harvest", "--out", out], io)).toBe(2);
  });

  it("refuses to replay a run that did not complete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-cli-"));
    const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, completed_at: null }));
    const io = deps();
    expect(await runCommand(["funnel", "--in", dir], io)).toBe(2);
    expect(io.err.join("")).toContain("did not complete");
  });

  it("refuses to replay a run whose manifest an earlier funnel version wrote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-cli-"));
    const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, schema_version: 1 }));
    const io = deps();
    expect(await runCommand(["funnel", "--in", dir], io)).toBe(2);
    expect(io.err.join("")).toContain("earlier version");
  });

  it("prints each query's added and confirmed counts and its top drop reasons after a harvest", async () => {
    const github = syntheticGitHub();
    const out = join(mkdtempSync(join(tmpdir(), "harvest-cli-")), "run");
    const io = deps({ fetch: github.fetch });
    expect(await runCommand(["harvest", "--out", out, "--max", "3"], io)).toBe(0);
    expect(io.out.join("")).toMatch(/^query 1 \(commits\): status 404, added 0, confirmed 0$/m);
  });
});
