import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseCanonical } from "@rbw/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RATE_SHEET, parseUsd, REPO_ROOT, runCommand, type CommandDeps, type ScreenConfig } from "../src/command.ts";
import { ScreenStopError } from "../src/pipeline.ts";
import type { Screen } from "../src/types.ts";
import { finder, makeHost, miss, scripted, site, tempDir, threeSites } from "./support.ts";

interface Run {
  code: number;
  out: string;
  err: string;
  outFile: string;
}

function files(): { rule: string; outFile: string; scratch: string } {
  const dir = tempDir("rbw-candidates-cli-");
  const rule = join(dir, "xx-1.synthetic.yml");
  writeFileSync(rule, "id: xx-1.synthetic\n");
  return { rule, outFile: join(dir, "record.json"), scratch: tempDir("rbw-candidates-cli-scratch-") };
}

async function run(extra: string[], deps: CommandDeps, outFile?: string, scratch?: string, host?: string): Promise<Run> {
  const paths = files();
  const target = outFile ?? paths.outFile;
  let out = "";
  let err = "";
  const code = await runCommand(
    ["--rule", paths.rule, "--host", host ?? makeHost(), "--out", target, "--scratch", scratch ?? paths.scratch, ...extra],
    { now: () => new Date("2026-10-13T12:00:00.000Z"), runId: () => "11111111-1111-4111-8111-111111111111", ...deps },
    { out: (text) => (out += text), err: (text) => (err += text) },
  );
  return { code, out, err, outFile: target };
}

function readRecord(path: string): Record<string, unknown> {
  return parseCanonical(readFileSync(path)) as Record<string, unknown>;
}

describe("command line", () => {
  it("writes a canonical dry-run record and needs no screen", async () => {
    const result = await run(["--route", "static-screen/v1", "--dry-run"], { findSites: finder(threeSites()) });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const record = readRecord(result.outFile);
    expect(record).toMatchObject({
      dry_run: true,
      rule: { id: "xx-1.synthetic" },
      screen_model: "super",
      symptom_source: "race-class-template-v2",
      implementations: { find_sites: "fakeFindSites", screen: "none" },
    });
    // Each planted candidate carries its own symptom's hash, computed without a model.
    expect((record.candidates as { symptom_sha256: string | null }[]).every((c) => typeof c.symptom_sha256 === "string")).toBe(true);
    expect(result.out).toContain("would screen 3 candidates");
    expect(result.out).toContain("$0.75");
  });

  it("runs the screens with the caps from its options and records the implementations", async () => {
    const screen = scripted([miss(2, 400_000), miss(2, 400_000)]);
    const result = await run(
      ["--route", "static-screen/v1", "--max-candidates", "2", "--max-spend-usd", "1", "--screen-budget-usd", "0.5", "--screen-attempts", "2", "--host-commit", "b".repeat(40)],
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

  it("rejects an unknown --model", async () => {
    const result = await run(["--model", "gpt"], { findSites: finder(threeSites()), screen: scripted([]) });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--model must be super or kimi/);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("records the model a real run used", async () => {
    const result = await run(["--route", "static-screen/v1", "--model", "kimi"], { findSites: finder(threeSites().slice(0, 1)), screen: scripted([miss()]) });
    expect(result.code).toBe(0);
    expect(readRecord(result.outFile)).toMatchObject({ screen_model: "kimi" });
  });

  it("reports a site finder that throws as a pipeline failure, and writes nothing", async () => {
    const broken = () => {
      throw new Error("rule did not compile");
    };
    const result = await run(["--dry-run"], { findSites: broken });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/the site finder failed: Error: rule did not compile/);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("refuses a record path inside the repository", async () => {
    const inside = join(REPO_ROOT, "tools", "candidates", "never-written.json");
    const result = await run(["--dry-run"], { findSites: finder(threeSites()) }, inside);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/outside the repository/);
    expect(existsSync(inside)).toBe(false);
  });

  it("pins the repository root to the real root", () => {
    expect(REPO_ROOT).toBe(resolve(import.meta.dirname, "../../.."));
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("refuses a --scratch inside the repository before anything runs", async () => {
    const inside = join(REPO_ROOT, "tools", "candidates");
    const screen = scripted([miss(), miss(), miss()]);
    const result = await run([], { findSites: finder(threeSites()), screen }, undefined, inside);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--scratch must be outside the repository/);
    expect(screen.calls).toHaveLength(0);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("refuses a --scratch that is a symbolic link into the repository", async () => {
    const link = join(tempDir("rbw-candidates-cli-link-"), "scratch");
    symlinkSync(join(REPO_ROOT, "tools", "candidates"), link, "dir");
    const screen = scripted([miss(), miss(), miss()]);
    const result = await run([], { findSites: finder(threeSites()), screen }, undefined, link);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--scratch must be outside the repository/);
    expect(screen.calls).toHaveLength(0);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("refuses a record path at the repository root", async () => {
    const inside = join(REPO_ROOT, "never-written.json");
    const result = await run(["--dry-run"], { findSites: finder(threeSites()) }, inside);
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

  it("refuses a record path inside the host before anything runs, and writes nothing there", async () => {
    const host = makeHost();
    const inside = join(host, "candidate-run.json");
    const findSites = finder(threeSites());
    const screen = scripted([miss(), miss(), miss()]);
    const result = await run([], { findSites, screen }, inside, undefined, host);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--out must be outside --host/);
    expect(screen.calls).toHaveLength(0);
    expect(existsSync(inside)).toBe(false);
  });

  it("refuses a record path that reaches the host through a symbolic link", async () => {
    const host = makeHost();
    const link = join(tempDir("rbw-candidates-cli-"), "host-link");
    symlinkSync(host, link);
    const inside = join(link, "candidate-run.json");
    const result = await run(["--dry-run"], { findSites: finder(threeSites()), screen: scripted([]) }, inside, undefined, host);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--out must be outside --host/);
    expect(existsSync(join(host, "candidate-run.json"))).toBe(false);
  });

  it("refuses the host itself as the --scratch directory", async () => {
    const host = makeHost();
    const result = await run([], { findSites: finder(threeSites()), screen: scripted([]) }, undefined, host, host);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--scratch must be outside --host/);
  });

  it("prints the kept scratch directory with --keep-scratch", async () => {
    const scratch = tempDir("rbw-candidates-cli-scratch-");
    const result = await run(["--route", "static-screen/v1", "--keep-scratch"], { findSites: finder(threeSites()), screen: scripted([miss(), miss(), miss()]) }, undefined, scratch);
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
      function strayScreen(job: { plantedTree: string }) {
        writeFileSync(join(dirname(job.plantedTree), "stray"), "x");
        return miss(3, 100_000);
      },
      {},
    );
    const result = await run(["--route", "static-screen/v1"], { findSites: finder(threeSites()), screen });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/spent \$0\.30/);
    expect(readRecord(result.outFile)).toMatchObject({ stop_reason: "pipeline_error", totals: { spend_microusd: 300_000 } });
  });

  it("keeps a record that is not canonical as plain JSON and reports it", async () => {
    // A lone surrogate in a finder-supplied diff cannot be encoded as canonical JSON.
    const odd = site("src/gamma.ts", "filter(Boolean)", "filter(\ud800)", 0.7, 1);
    const screen = scripted([miss(3, 100_000)]);
    const result = await run(["--route", "static-screen/v1"], { findSites: finder([odd]), screen });
    expect(screen.calls).toHaveLength(1);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/not canonical JSON/);
    expect(result.err).toMatch(/spent \$0\.10/);
    expect(JSON.parse(readFileSync(result.outFile, "utf8"))).toMatchObject({ totals: { spend_microusd: 100_000 } });
  });

  it("does not overwrite an existing record", async () => {
    const paths = files();
    writeFileSync(paths.outFile, "keep");
    const result = await run(["--dry-run"], { findSites: finder(threeSites()) }, paths.outFile);
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
    const result = await run([...extra, "--dry-run"], { findSites: finder(threeSites()) });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
    expect(existsSync(result.outFile)).toBe(false);
  });
});

describe("command line with the real screen builder", () => {
  const REAL_ENV = { DATABASE_URL: "postgres://synthetic.invalid/x", TOKEN_FACTORY_SCREEN_KEY: "synthetic-key" };

  function builder(screen: Screen): ((config: ScreenConfig) => Screen) & { configs: ScreenConfig[] } {
    const configs: ScreenConfig[] = [];
    return Object.assign(
      (config: ScreenConfig): Screen => {
        configs.push(config);
        return screen;
      },
      { configs },
    );
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds the screen from the run's ledger, rate sheet, scratch and environment options, and uses it", async () => {
    vi.stubEnv("DATABASE_URL", REAL_ENV.DATABASE_URL);
    vi.stubEnv("TOKEN_FACTORY_SCREEN_KEY", REAL_ENV.TOKEN_FACTORY_SCREEN_KEY);
    const screen = scripted([miss()]);
    const buildScreen = builder(screen);
    const scratch = tempDir("rbw-candidates-cli-scratch-");
    const result = await run(["--route", "static-screen/v1"], { findSites: finder(threeSites().slice(0, 1)), buildScreen }, undefined, scratch);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(screen.calls).toHaveLength(1);
    expect(buildScreen.configs).toHaveLength(1);
    expect(buildScreen.configs[0]).toMatchObject({ slotKey: "development", pool: "development", rateSheetPath: DEFAULT_RATE_SHEET, scratchBase: scratch, keepScratch: false });
    expect(buildScreen.configs[0]?.env.DATABASE_URL).toBe(REAL_ENV.DATABASE_URL);

    const sheet = join(tempDir("rbw-candidates-cli-rates-"), "rates.json");
    writeFileSync(sheet, readFileSync(DEFAULT_RATE_SHEET));
    const other = builder(scripted([miss()]));
    const overridden = await run(["--route", "static-screen/v1", "--slot-key", "uc1", "--pool", "uc1-pool", "--rate-sheet", sheet, "--keep-scratch"], {
      findSites: finder(threeSites().slice(0, 1)),
      buildScreen: other,
    });
    expect(overridden.code).toBe(0);
    expect(other.configs[0]).toMatchObject({ slotKey: "uc1", pool: "uc1-pool", rateSheetPath: sheet, keepScratch: true });
  });

  it("exits 2 when the --rate-sheet cannot be read, before the screen is built", async () => {
    vi.stubEnv("DATABASE_URL", REAL_ENV.DATABASE_URL);
    vi.stubEnv("TOKEN_FACTORY_SCREEN_KEY", REAL_ENV.TOKEN_FACTORY_SCREEN_KEY);
    const screen = scripted([miss(), miss(), miss()]);
    // Like the real builder, this reads the rate sheet as soon as it is called.
    const buildScreen = (config: ScreenConfig): Screen => {
      readFileSync(config.rateSheetPath);
      return screen;
    };
    const missing = join(tempDir("rbw-candidates-cli-rates-"), "missing.json");
    const result = await run(["--route", "static-screen/v1", "--rate-sheet", missing], { findSites: finder(threeSites()), buildScreen });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/cannot read the --rate-sheet file/);
    expect(screen.calls).toHaveLength(0);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("refuses a real run with no screen configured", async () => {
    const result = await run(["--route", "static-screen/v1"], { findSites: finder(threeSites()) });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/no screen is configured/);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it.each([
    ["DATABASE_URL", /DATABASE_URL is not set/],
    ["TOKEN_FACTORY_SCREEN_KEY", /TOKEN_FACTORY_SCREEN_KEY is not set/],
  ])("refuses a real run without %s before anything runs, and writes nothing", async (missing, message) => {
    for (const [name, value] of Object.entries(REAL_ENV)) {
      vi.stubEnv(name, name === missing ? "" : value);
    }
    const screen = scripted([miss(), miss(), miss()]);
    const buildScreen = builder(screen);
    const result = await run(["--route", "static-screen/v1"], { findSites: finder(threeSites()), buildScreen });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
    expect(screen.calls).toHaveLength(0);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("refuses a model whose planned attempts cannot fit the per-screen budget, with the screen's own reason", async () => {
    vi.stubEnv("DATABASE_URL", REAL_ENV.DATABASE_URL);
    vi.stubEnv("TOKEN_FACTORY_SCREEN_KEY", REAL_ENV.TOKEN_FACTORY_SCREEN_KEY);
    const screen = scripted([miss(), miss(), miss()]);
    // Kimi's worst-case call is priced above a third of the default $0.25 budget.
    const result = await run(["--route", "static-screen/v1", "--model", "kimi"], { findSites: finder(threeSites()), buildScreen: builder(screen) });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--screen-budget-usd is too small for 3 attempts on kimi: 3 attempts at a worst case of \d+ micro-USD each/);
    expect(screen.calls).toHaveLength(0);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("checks the budget on a dry run of the real screen too", async () => {
    const result = await run(["--route", "static-screen/v1", "--dry-run", "--model", "kimi"], { findSites: finder(threeSites()) });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--screen-budget-usd is too small/);
  });

  it("refuses more attempts than the screen allows", async () => {
    const result = await run(["--dry-run", "--screen-attempts", "9"], { findSites: finder(threeSites()) });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--screen-attempts must be from 1 to 8/);
  });

  it("exits 1 and names the reason when a screen stopped the run, keeping the record", async () => {
    const screen = scripted([new ScreenStopError("operation op-9 is unsettled", 250_000), miss()]);
    const result = await run(["--route", "static-screen/v1"], { findSites: finder(threeSites()), screen });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/stopped screening: screen_stopped/);
    expect(result.err).toContain("op-9");
    expect(readRecord(result.outFile)).toMatchObject({ stop_reason: "screen_stopped", totals: { spend_microusd: 250_000 } });
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
