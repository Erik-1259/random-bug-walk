import { existsSync, readdirSync, readFileSync } from "node:fs";
import { encodeCanonical } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import { runPipeline, screenResultProblem, type Caps, type PipelineInput } from "../src/pipeline.ts";
import type { FindSites, Screen, Site } from "../src/types.ts";
import { CLEAN, RULE, SYMPTOM, finder, hit, makeHost, miss, scripted, site, tempDir, threeSites } from "./support.ts";

const CAPS: Caps = { maxCandidates: 10, maxScreenSpendMicrousd: 2_000_000, screenBudget: { maxAttempts: 3, maxCostMicrousd: 250_000 } };

function input(findSites: FindSites, screen: Screen, overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    rule: RULE,
    hostDir: makeHost(),
    symptom: SYMPTOM,
    findSites,
    screen,
    caps: CAPS,
    dryRun: false,
    scratchBase: tempDir("rbw-candidates-scratch-"),
    runId: "00000000-0000-4000-8000-000000000000",
    now: () => new Date("2026-10-13T12:00:00.000Z"),
    implementations: { findSites: "fakeFindSites", screen: "fakeScreen" },
    ...overrides,
  };
}

describe("planting", () => {
  it("screens each candidate in its own copy with only that site planted and without .git or node_modules", async () => {
    const screen = scripted([miss(), miss(), miss()]);
    await runPipeline(input(finder(threeSites()), screen));
    expect(screen.calls).toHaveLength(3);
    // Highest confidence first: beta (0.9), gamma (0.7), alpha (0.5).
    const [beta, gamma, alpha] = screen.calls;
    expect(beta?.files["src/beta.ts"]).not.toContain("store.lock(id);");
    expect(beta?.files["src/alpha.ts"]).toBe(CLEAN["src/alpha.ts"]);
    expect(beta?.files["src/gamma.ts"]).toBe(CLEAN["src/gamma.ts"]);
    expect(gamma?.files["src/gamma.ts"]).toContain("filter((x) => x)");
    expect(gamma?.files["src/beta.ts"]).toBe(CLEAN["src/beta.ts"]);
    expect(alpha?.files["src/alpha.ts"]).not.toContain("store.lock(id);");
    expect(new Set(screen.calls.map((call) => call.tree)).size).toBe(3);
    expect(screen.calls.every((call) => !call.hasGit && !call.hasNodeModules)).toBe(true);
    expect(screen.calls.every((call) => call.symptom === SYMPTOM)).toBe(true);
  });

  it("never changes the host tree", async () => {
    const run = input(finder(threeSites()), scripted([miss(), miss(), miss()]));
    await runPipeline(run);
    const fresh = makeHost();
    for (const path of Object.keys(CLEAN)) {
      expect(existsSync(`${run.hostDir}/${path}`)).toBe(existsSync(`${fresh}/${path}`));
    }
    for (const [path, text] of Object.entries(CLEAN)) {
      expect(readFileSync(`${run.hostDir}/${path}`, "utf8")).toBe(text);
    }
  });

  it("removes its scratch copies by default and keeps them when asked", async () => {
    const removed = input(finder(threeSites()), scripted([miss(), miss(), miss()]));
    const outcome = await runPipeline(removed);
    expect(outcome.scratchDir).toBeNull();
    expect(readdirSync(removed.scratchBase)).toEqual([]);

    const kept = input(finder(threeSites()), scripted([miss(), miss(), miss()]), { keepScratch: true });
    const keptOutcome = await runPipeline(kept);
    expect(keptOutcome.scratchDir).not.toBeNull();
    expect(readdirSync(keptOutcome.scratchDir ?? "")).toHaveLength(3);
  });

  it("records sites that are invalid or do not plant, without screening them", async () => {
    const otherFile: Site = { ...site("src/alpha.ts", "  store.lock(id);\n", "", 0.8), file: "src/beta.ts" };
    const stale = site("src/gamma.ts", "filter(Boolean)", "filter(x)", 0.6);
    stale.diff = stale.diff.replace("filter(Boolean)", "filter(Nothing)");
    const sites: Site[] = [
      { file: "../outside.ts", line: 1, diff: "", confidence: 0.99 },
      { file: "src/alpha.ts", line: 0, diff: "", confidence: 0.98 },
      { file: "src/alpha.ts", line: 1, diff: "", confidence: 1.5 },
      { file: "src/missing.ts", line: 1, diff: "x", confidence: 0.97 },
      otherFile,
      stale,
      site("src/beta.ts", "  store.lock(id);\n", "", 0.4),
    ];
    const screen = scripted([miss()]);
    const { record } = await runPipeline(input(finder(sites), screen));
    expect(screen.calls).toHaveLength(1);
    expect(record.candidates.map((entry) => [entry.status, entry.reason])).toEqual([
      ["invalid_site", "bad_confidence"],
      ["invalid_site", "bad_path"],
      ["invalid_site", "bad_line"],
      ["plant_failed", "file_missing"],
      ["plant_failed", "path_mismatch"],
      ["plant_failed", "does_not_apply"],
      ["screened", null],
    ]);
    expect(record.totals.planted).toBe(1);
  });

  it("collapses duplicate sites", async () => {
    const [first] = threeSites();
    if (first === undefined) throw new Error("fixture");
    const screen = scripted([miss()]);
    const { record } = await runPipeline(input(finder([first, { ...first }]), screen));
    expect(screen.calls).toHaveLength(1);
    expect(record.totals).toMatchObject({ sites_found: 2, duplicates: 1, planted: 1 });
  });

  it("refuses a finder result that is not a list of sites", async () => {
    await expect(runPipeline(input(() => [{ file: "src/alpha.ts" }] as unknown as Site[], scripted([])))).rejects.toThrow(/site finder/);
  });
});

describe("caps", () => {
  it("plants at most the candidate cap, taking the most confident sites, and an unplantable site takes no slot", async () => {
    const broken: Site = { file: "src/missing.ts", line: 1, diff: "x", confidence: 0.95 };
    const screen = scripted([miss(), miss()]);
    const { record } = await runPipeline(input(finder([broken, ...threeSites()]), screen, { caps: { ...CAPS, maxCandidates: 2 } }));
    expect(screen.calls).toHaveLength(2);
    expect(record.candidates.map((entry) => [entry.file, entry.status])).toEqual([
      ["src/missing.ts", "plant_failed"],
      ["src/beta.ts", "screened"],
      ["src/gamma.ts", "screened"],
      ["src/alpha.ts", "over_candidate_cap"],
    ]);
  });

  it("starts no screen whose budget does not fit in what is left of the spend cap", async () => {
    // Each screen charges 250,000 of the 850,000 cap: after three, 100,000 is left, which is less
    // than one screen's budget, so the fourth is skipped.
    const sites = [...threeSites(), site("src/alpha.ts", "return row;", "return null;", 0.1, 4)];
    const screen = scripted([miss(3, 250_000), miss(3, 250_000), miss(3, 250_000), miss()]);
    const caps = { ...CAPS, maxScreenSpendMicrousd: 850_000 };
    const { record } = await runPipeline(input(finder(sites), screen, { caps }));
    expect(screen.calls).toHaveLength(3);
    expect(record.candidates.map((entry) => entry.status)).toEqual(["screened", "screened", "screened", "skipped_spend_cap"]);
    expect(record.stop_reason).toBe("spend_cap");
    expect(record.totals.spend_microusd).toBe(750_000);
    expect(record.totals.spend_microusd).toBeLessThanOrEqual(caps.maxScreenSpendMicrousd);
  });

  it("passes each screen its budget", async () => {
    const screen = scripted([miss()]);
    await runPipeline(input(finder(threeSites().slice(0, 1)), screen));
    expect(screen.calls[0]?.budget).toEqual(CAPS.screenBudget);
  });

  it("charges the whole budget for a screen that throws, and carries on", async () => {
    const screen = scripted([new Error("probe failed"), miss(3, 50_000), miss(3, 50_000)]);
    const { record } = await runPipeline(input(finder(threeSites()), screen));
    expect(screen.calls).toHaveLength(3);
    expect(record.candidates[0]).toMatchObject({ status: "screen_error", reason: "Error: probe failed", charged_microusd: 250_000, screen: null });
    expect(record.totals.spend_microusd).toBe(350_000);
  });

  it("charges the whole budget for a malformed screen result", async () => {
    const screen = scripted([{ verdict: "not_located", hits: 0, attempts: 4, costMicrousd: 10 }]);
    const { record } = await runPipeline(input(finder(threeSites().slice(0, 1)), screen));
    expect(record.candidates[0]).toMatchObject({ status: "screen_error", reason: "screen made more attempts than its budget allows", charged_microusd: 250_000 });
    expect(record.ranking).toEqual([]);
  });

  it("stops screening after a screen spends more than its budget", async () => {
    const screen = scripted([miss(3, 300_000), miss(), miss()]);
    const { record } = await runPipeline(input(finder(threeSites()), screen));
    expect(screen.calls).toHaveLength(1);
    expect(record.stop_reason).toBe("screen_overspent");
    expect(record.candidates.map((entry) => entry.status)).toEqual(["screened", "skipped_after_overspend", "skipped_after_overspend"]);
    expect(record.totals.spend_microusd).toBe(300_000);
  });

  it("refuses caps that are not positive integers", async () => {
    await expect(runPipeline(input(finder([]), scripted([]), { caps: { ...CAPS, maxCandidates: 0 } }))).rejects.toThrow(/candidate cap/);
    await expect(
      runPipeline(input(finder([]), scripted([]), { caps: { ...CAPS, screenBudget: { maxAttempts: 3, maxCostMicrousd: 0 } } })),
    ).rejects.toThrow(/per-screen budget/);
  });
});

describe("ranking", () => {
  it("ranks only survivors: more missed attempts first, then finder confidence", async () => {
    const sites = [...threeSites(), site("src/alpha.ts", "return row;", "return null;", 0.1, 4)];
    // Order screened: beta 0.9, gamma 0.7, alpha 0.5, alpha-return 0.1.
    const screen = scripted([miss(2), hit(), miss(3), { verdict: "inconclusive", hits: 0, attempts: 0, costMicrousd: 0 }]);
    const { record } = await runPipeline(input(finder(sites), screen));
    const byFile = (id: string) => record.candidates.find((entry) => entry.candidate_id === id);
    expect(record.ranking.map((id) => [byFile(id)?.file, byFile(id)?.line])).toEqual([
      ["src/alpha.ts", 3],
      ["src/beta.ts", 2],
    ]);
    expect(record.candidates.map((entry) => entry.rank)).toEqual([2, null, 1, null]);
    expect(record.totals).toMatchObject({ screened: 4, survivors: 2, located: 1, inconclusive: 1 });
  });
});

describe("dry run", () => {
  it("lists and checks candidates without copies, screens or spend, and projects the most the screens could spend", async () => {
    const screen = scripted([]);
    const run = input(finder(threeSites()), screen, { dryRun: true, caps: { ...CAPS, maxScreenSpendMicrousd: 600_000 } });
    const { record, scratchDir } = await runPipeline(run);
    expect(screen.calls).toHaveLength(0);
    expect(scratchDir).toBeNull();
    expect(readdirSync(run.scratchBase)).toEqual([]);
    expect(record.candidates.map((entry) => entry.status)).toEqual(["would_screen", "would_screen", "would_screen"]);
    expect(record.totals.spend_microusd).toBe(0);
    // Three candidates at 250,000 each, but only two whole budgets fit in 600,000.
    expect(record.totals.max_spend_microusd).toBe(500_000);
    expect(record.dry_run).toBe(true);
  });
});

describe("run record", () => {
  it("records the rule and symptom by hash and each candidate's site and diff", async () => {
    const { record } = await runPipeline(input(finder(threeSites().slice(0, 1)), scripted([miss()]), { hostCommit: "a".repeat(40) }));
    expect(record).toMatchObject({
      record: "candidate_run",
      version: 1,
      run_id: "00000000-0000-4000-8000-000000000000",
      created_at: "2026-10-13T12:00:00.000Z",
      rule: { id: "XX-1.synthetic" },
      host_commit: "a".repeat(40),
      implementations: { find_sites: "fakeFindSites", screen: "fakeScreen" },
    });
    expect(record.rule.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.symptom_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain(SYMPTOM.text);
    expect(record.candidates[0]).toMatchObject({ file: "src/alpha.ts", line: 3, confidence_ppm: 500_000, screen: { verdict: "not_located", hits: 0, attempts: 3, cost_microusd: 100_000 } });
    expect(record.candidates[0]?.diff).toContain("-  store.lock(id);");
  });

  it("encodes as canonical JSON, including fractional confidences and invalid sites", async () => {
    const sites: Site[] = [...threeSites(), { file: "src/alpha.ts", line: 1.5, diff: "", confidence: 1 / 3 }];
    const { record } = await runPipeline(input(finder(sites), scripted([miss(), hit(), miss()])));
    expect(() => encodeCanonical(record)).not.toThrow();
    expect(record.candidates.map((entry) => entry.confidence_ppm)).toEqual([900_000, 700_000, 500_000, 333_333]);
    expect(record.candidates[3]).toMatchObject({ line: 0, status: "invalid_site", reason: "bad_line" });
  });
});

describe("screenResultProblem", () => {
  const budget = { maxAttempts: 3, maxCostMicrousd: 100 };
  it.each([
    [null, "screen returned no result object"],
    [{ verdict: "maybe", hits: 0, attempts: 1, costMicrousd: 0 }, "screen returned an unknown verdict"],
    [{ verdict: "located", hits: 1.5, attempts: 2, costMicrousd: 0 }, "screen returned hits, attempts or cost that are not non-negative integers"],
    [{ verdict: "located", hits: 1, attempts: 1, costMicrousd: -1 }, "screen returned hits, attempts or cost that are not non-negative integers"],
    [{ verdict: "located", hits: 3, attempts: 2, costMicrousd: 0 }, "screen returned more hits than attempts"],
    [{ verdict: "located", hits: 0, attempts: 2, costMicrousd: 0 }, "screen returned located with no hits"],
    [{ verdict: "not_located", hits: 1, attempts: 2, costMicrousd: 0 }, "screen returned not_located with hits or with no attempts"],
    [{ verdict: "not_located", hits: 0, attempts: 0, costMicrousd: 0 }, "screen returned not_located with hits or with no attempts"],
  ])("rejects %j", (result, problem) => {
    expect(screenResultProblem(result, budget)).toBe(problem);
  });

  it("accepts well-formed results, including one over its cost budget (the pipeline stops on that)", () => {
    expect(screenResultProblem({ verdict: "located", hits: 1, attempts: 3, costMicrousd: 50 }, budget)).toBeNull();
    expect(screenResultProblem({ verdict: "inconclusive", hits: 0, attempts: 0, costMicrousd: 0 }, budget)).toBeNull();
    expect(screenResultProblem({ verdict: "not_located", hits: 0, attempts: 1, costMicrousd: 500 }, budget)).toBeNull();
  });
});
