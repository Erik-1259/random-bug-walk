import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseCanonical } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import { parseUsd, REPO_ROOT, runCommand, type CommandDeps } from "../src/command.ts";
import { notWired } from "../src/not-wired.ts";
import * as wiring from "../src/wiring.ts";
import { finder, makeHost, miss, scripted, site, tempDir, threeSites } from "./support.ts";

interface Run {
  code: number;
  out: string;
  err: string;
  outFile: string;
}

function files(): { rule: string; symptom: string; outFile: string; scratch: string } {
  const dir = tempDir("rbw-candidates-cli-");
  const rule = join(dir, "xx-1.synthetic.yml");
  const symptom = join(dir, "symptom.txt");
  writeFileSync(rule, "id: xx-1.synthetic\n");
  writeFileSync(symptom, "A record is sometimes written twice.\n");
  return { rule, symptom, outFile: join(dir, "record.json"), scratch: tempDir("rbw-candidates-cli-scratch-") };
}

async function run(extra: string[], deps: CommandDeps, outFile?: string, scratch?: string, host?: string): Promise<Run> {
  const paths = files();
  const target = outFile ?? paths.outFile;
  let out = "";
  let err = "";
  const code = await runCommand(
    ["--rule", paths.rule, "--host", host ?? makeHost(), "--symptom", paths.symptom, "--out", target, "--scratch", scratch ?? paths.scratch, ...extra],
    { now: () => new Date("2026-10-13T12:00:00.000Z"), runId: () => "11111111-1111-4111-8111-111111111111", ...deps },
    { out: (text) => (out += text), err: (text) => (err += text) },
  );
  return { code, out, err, outFile: target };
}

function readRecord(path: string): Record<string, unknown> {
  return parseCanonical(readFileSync(path)) as Record<string, unknown>;
}

describe("command line", () => {
  it("writes a canonical dry-run record with an unwired screen", async () => {
    const result = await run(["--dry-run"], { findSites: finder(threeSites()), screen: wiring.screen });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const record = readRecord(result.outFile);
    expect(record).toMatchObject({ dry_run: true, rule: { id: "xx-1.synthetic" }, implementations: { find_sites: "fakeFindSites", screen: "none" } });
    expect(result.out).toContain("would screen 3 candidates");
    expect(result.out).toContain("$0.75");
  });

  it("runs the screens with the caps from its options and records the implementations", async () => {
    const screen = scripted([miss(2, 400_000), miss(2, 400_000)]);
    const result = await run(
      ["--max-candidates", "2", "--max-spend-usd", "1", "--screen-budget-usd", "0.5", "--screen-attempts", "2", "--host-commit", "b".repeat(40)],
      { findSites: finder(threeSites()), screen },
    );
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(screen.calls.map((call) => call.budget)).toEqual([
      { maxAttempts: 2, maxCostMicrousd: 500_000 },
      { maxAttempts: 2, maxCostMicrousd: 500_000 },
    ]);
    const record = readRecord(result.outFile);
    expect(record).toMatchObject({
      dry_run: false,
      host_commit: "b".repeat(40),
      implementations: { find_sites: "fakeFindSites", screen: "fakeScreen" },
      caps: { max_candidates: 2, max_screen_spend_microusd: 1_000_000, screen_budget: { max_attempts: 2, max_cost_microusd: 500_000 } },
      totals: { screened: 2, survivors: 2, spend_microusd: 800_000 },
    });
    expect(result.out).toContain("2 survived");
  });

  it("refuses a real run while the screen is unwired, and writes nothing", async () => {
    const result = await run([], { findSites: finder(threeSites()), screen: wiring.screen });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/screen is not wired yet/);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("reports an unwired site finder, and writes nothing", async () => {
    const result = await run(["--dry-run"], { findSites: wiring.findSites, screen: notWired("screen", "x") });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/findSites is not wired yet/);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("reports a site finder that throws as a pipeline failure, and writes nothing", async () => {
    const broken = () => {
      throw new Error("rule did not compile");
    };
    const result = await run(["--dry-run"], { findSites: broken, screen: wiring.screen });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/the site finder failed: Error: rule did not compile/);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("refuses a record path inside the repository", async () => {
    const inside = join(REPO_ROOT, "tools", "candidates", "never-written.json");
    const result = await run(["--dry-run"], { findSites: finder(threeSites()), screen: wiring.screen }, inside);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/outside the repository/);
    expect(existsSync(inside)).toBe(false);
  });

  it("pins the repository root to the real root", () => {
    expect(REPO_ROOT).toBe(resolve(import.meta.dirname, "../../.."));
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("refuses a record path at the repository root", async () => {
    const inside = join(REPO_ROOT, "never-written.json");
    const result = await run(["--dry-run"], { findSites: finder(threeSites()), screen: wiring.screen }, inside);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/outside the repository/);
    expect(existsSync(inside)).toBe(false);
  });

  it("refuses an existing --out on a real run before any screen runs", async () => {
    const paths = files();
    writeFileSync(paths.outFile, "keep");
    const screen = scripted([miss(), miss(), miss()]);
    const result = await run([], { findSites: finder(threeSites()), screen }, paths.outFile);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/cannot write --out/);
    expect(screen.calls).toHaveLength(0);
    expect(readFileSync(paths.outFile, "utf8")).toBe("keep");
  });

  it("refuses an --out in a missing directory before any screen runs", async () => {
    const target = join(tempDir("rbw-candidates-cli-"), "missing", "record.json");
    const screen = scripted([miss(), miss(), miss()]);
    const result = await run([], { findSites: finder(threeSites()), screen }, target);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/cannot write --out/);
    expect(screen.calls).toHaveLength(0);
    expect(existsSync(dirname(target))).toBe(false);
  });

  it("refuses a missing --scratch directory before any screen runs, and writes nothing", async () => {
    const screen = scripted([miss(), miss(), miss()]);
    const result = await run([], { findSites: finder(threeSites()), screen }, undefined, join(tempDir("rbw-candidates-cli-"), "missing"));
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--scratch must be a directory/);
    expect(screen.calls).toHaveLength(0);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("refuses a --scratch directory inside the host before any screen runs, and writes nothing", async () => {
    const host = makeHost();
    const nested = join(host, ".scratch");
    mkdirSync(nested);
    const screen = scripted([miss(), miss(), miss()]);
    const result = await run([], { findSites: finder(threeSites()), screen }, undefined, nested, host);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--scratch must be outside --host/);
    expect(screen.calls).toHaveLength(0);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("refuses the host itself as the --scratch directory", async () => {
    const host = makeHost();
    const result = await run([], { findSites: finder(threeSites()), screen: scripted([]) }, undefined, host, host);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--scratch must be outside --host/);
  });

  it("prints the kept scratch directory with --keep-scratch", async () => {
    const scratch = tempDir("rbw-candidates-cli-scratch-");
    const result = await run(["--keep-scratch"], { findSites: finder(threeSites()), screen: scripted([miss(), miss(), miss()]) }, undefined, scratch);
    expect(result.code).toBe(0);
    const match = /^scratch kept: (.+)$/m.exec(result.out);
    expect(match).not.toBeNull();
    const kept = match?.[1] ?? "";
    expect(dirname(kept)).toBe(scratch);
    expect(existsSync(kept)).toBe(true);
  });

  it("leaves no empty record behind when the site finder fails on a real run", async () => {
    const broken = () => {
      throw new Error("rule did not compile");
    };
    const result = await run([], { findSites: broken, screen: scripted([]) });
    expect(result.code).toBe(1);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("writes the partial record and reports the spend when the pipeline fails after screens ran", async () => {
    const screen = Object.assign(
      function strayScreen(tree: string) {
        writeFileSync(join(dirname(tree), "stray"), "x");
        return miss(3, 100_000);
      },
      {},
    );
    const result = await run([], { findSites: finder(threeSites()), screen });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/spent \$0\.30/);
    expect(readRecord(result.outFile)).toMatchObject({ stop_reason: "pipeline_error", totals: { spend_microusd: 300_000 } });
  });

  it("keeps a record that is not canonical as plain JSON and reports it", async () => {
    // A lone surrogate in a finder-supplied diff cannot be encoded as canonical JSON.
    const odd = site("src/gamma.ts", "filter(Boolean)", "filter(\ud800)", 0.7, 1);
    const screen = scripted([miss(3, 100_000)]);
    const result = await run([], { findSites: finder([odd]), screen });
    expect(screen.calls).toHaveLength(1);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/not canonical JSON/);
    expect(result.err).toMatch(/spent \$0\.10/);
    expect(JSON.parse(readFileSync(result.outFile, "utf8"))).toMatchObject({ totals: { spend_microusd: 100_000 } });
  });

  it("does not overwrite an existing record", async () => {
    const paths = files();
    writeFileSync(paths.outFile, "keep");
    const result = await run(["--dry-run"], { findSites: finder(threeSites()), screen: wiring.screen }, paths.outFile);
    expect(result.code).toBe(2);
    expect(readFileSync(paths.outFile, "utf8")).toBe("keep");
  });

  it.each([
    [["--max-candidates", "0"], /--max-candidates/],
    [["--max-spend-usd", "1.2345678"], /--max-spend-usd/],
    [["--screen-budget-usd", "0"], /--screen-budget-usd/],
    [["--host-commit", "abc"], /--host-commit/],
    [["--unknown"], /Unknown option/],
  ])("rejects bad usage %j", async (extra, message) => {
    const result = await run([...extra, "--dry-run"], { findSites: finder(threeSites()), screen: wiring.screen });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
    expect(existsSync(result.outFile)).toBe(false);
  });
});

describe("parseUsd", () => {
  it("parses decimal dollars to integer micro-USD without floating-point error", () => {
    expect(parseUsd("0.25", "--x")).toBe(250_000);
    expect(parseUsd("2", "--x")).toBe(2_000_000);
    expect(parseUsd("0.000001", "--x")).toBe(1);
    expect(parseUsd("40.1", "--x")).toBe(40_100_000);
  });

  it.each(["", "-1", "1e3", "0.1234567", "1,5", "$2"])("rejects %j", (text) => {
    expect(() => parseUsd(text, "--x")).toThrow(/--x/);
  });
});
