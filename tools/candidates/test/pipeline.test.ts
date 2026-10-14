import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeCanonical } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/plant.ts";
import { PipelineError, runPipeline, ScreenStopError, screenResultProblem, type Caps, type PipelineInput } from "../src/pipeline.ts";
import type { FindSites, Screen, Site } from "../src/types.ts";
import { CLEAN, MODEL, RULE, SYMPTOM, diffFor, finder, hit, makeHost, miss, scripted, site, symptomFor, tempDir, threeSites } from "./support.ts";

const CAPS: Caps = { maxCandidates: 10, maxScreenSpendMicrousd: 2_000_000, screenBudget: { maxAttempts: 3, maxCostMicrousd: 250_000 } };

function input(findSites: FindSites, screen: Screen, overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    rule: RULE,
    hostDir: makeHost(),
    symptomFor,
    symptomSource: "test-symptom",
    screenModel: MODEL,
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
    expect(screen.calls.every((call) => call.symptom.text.startsWith(SYMPTOM.text))).toBe(true);
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

  it("never writes through a host path that is a symbolic link to the host tree", async () => {
    const real = makeHost();
    const link = join(tempDir("rbw-candidates-link-"), "host");
    symlinkSync(real, link, "dir");
    const screen = scripted([miss(), miss(), miss()]);
    await runPipeline(input(finder(threeSites()), screen, { hostDir: link }));
    expect(screen.calls).toHaveLength(3);
    expect(screen.calls[0]?.files["src/beta.ts"]).not.toContain("store.lock(id);");
    for (const [path, text] of Object.entries(CLEAN)) {
      expect(readFileSync(join(real, path), "utf8")).toBe(text);
    }
  });

  it("refuses a site whose path runs through a symbolic link, without writing through it", async () => {
    const host = makeHost();
    const outside = tempDir("rbw-candidates-outside-");
    writeFileSync(join(outside, "gamma.ts"), CLEAN["src/gamma.ts"] ?? "");
    symlinkSync(outside, join(host, "linked"), "dir");
    mkdirSync(join(host, "deep"));
    symlinkSync(join(host, "src"), join(host, "deep", "src"), "dir");
    const viaOutside: Site = { ...site("src/gamma.ts", "filter(Boolean)", "filter((x) => x)", 0.9, 1) };
    viaOutside.diff = viaOutside.diff.replaceAll("src/gamma.ts", "linked/gamma.ts");
    viaOutside.file = "linked/gamma.ts";
    const viaInside: Site = { ...viaOutside, confidence: 0.8, file: "deep/src/gamma.ts", diff: viaOutside.diff.replaceAll("linked/gamma.ts", "deep/src/gamma.ts") };
    const screen = scripted([]);
    const { record } = await runPipeline(input(finder([viaOutside, viaInside]), screen, { hostDir: host }));
    expect(screen.calls).toHaveLength(0);
    expect(record.candidates.map((entry) => [entry.status, entry.reason])).toEqual([
      ["plant_failed", "file_missing"],
      ["plant_failed", "file_missing"],
    ]);
    expect(readFileSync(join(outside, "gamma.ts"), "utf8")).toBe(CLEAN["src/gamma.ts"]);
    expect(readFileSync(join(host, "src", "gamma.ts"), "utf8")).toBe(CLEAN["src/gamma.ts"]);
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

  it("refuses a diff over two files, a diff that changes nothing and a backslash path", async () => {
    const twoFiles: Site = { ...site("src/beta.ts", "  store.lock(id);\n", "", 0.9), diff: diffFor("src/beta.ts", "  store.lock(id);\n", "") + diffFor("src/gamma.ts", "filter(Boolean)", "filter(x)") };
    // A hunk whose removed and added lines are the same text.
    const noChange: Site = { file: "src/gamma.ts", line: 1, confidence: 0.8, diff: "" };
    noChange.diff = ["--- a/src/gamma.ts", "+++ b/src/gamma.ts", "@@ -1,1 +1,1 @@", `-${(CLEAN["src/gamma.ts"] ?? "").trimEnd()}`, `+${(CLEAN["src/gamma.ts"] ?? "").trimEnd()}`, ""].join("\n");
    const backslash: Site = { ...site("src/alpha.ts", "  store.lock(id);\n", "", 0.7, 3), file: "src\\alpha.ts" };
    const screen = scripted([]);
    const { record } = await runPipeline(input(finder([twoFiles, noChange, backslash]), screen));
    expect(screen.calls).toHaveLength(0);
    expect(record.candidates.map((entry) => [entry.status, entry.reason])).toEqual([
      ["plant_failed", "not_one_file"],
      ["plant_failed", "no_change"],
      ["invalid_site", "bad_path"],
    ]);
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

describe("screen jobs", () => {
  it("gives each screen its own target path, clean text, symptom and the run's model", async () => {
    const screen = scripted([miss(), miss(), miss()]);
    const { record } = await runPipeline(input(finder(threeSites()), screen, { screenModel: "kimi" }));
    expect(screen.calls.map((call) => call.targetPath)).toEqual(["src/beta.ts", "src/gamma.ts", "src/alpha.ts"]);
    for (const [index, call] of screen.calls.entries()) {
      const entry = record.candidates[index];
      // The clean text is the unplanted file, for scoring; the model never sees it.
      expect(call.cleanText).toBe(CLEAN[call.targetPath]);
      expect(call.model).toBe("kimi");
      // Each symptom was made for its own site, and the record holds that symptom's hash.
      expect(entry?.file).toBe(call.targetPath);
      expect(call.symptom.text).toContain(`(${call.targetPath}:${String(entry?.line)})`);
      expect(entry?.symptom_sha256).toBe(sha256Hex(call.symptom.text));
    }
  });

  it("records no symptom hash for a site that was not planted", async () => {
    const sites: Site[] = [
      { file: "../outside.ts", line: 1, diff: "", confidence: 0.99 },
      { file: "src/missing.ts", line: 1, diff: "x", confidence: 0.97 },
      ...threeSites(),
    ];
    const { record } = await runPipeline(input(finder(sites), scripted([miss(), miss()]), { caps: { ...CAPS, maxCandidates: 2 } }));
    expect(record.candidates.map((entry) => [entry.status, entry.symptom_sha256 === null])).toEqual([
      ["invalid_site", true],
      ["plant_failed", true],
      ["screened", false],
      ["screened", false],
      ["over_candidate_cap", true],
    ]);
  });
});

describe("a screen that stops the run", () => {
  it("records the stop, charges what the screen says, and starts no further screen", async () => {
    const stop = new ScreenStopError("operation op-1 is unsettled; root execution root-1", 250_000);
    const screen = scripted([miss(3, 50_000), stop, miss(), miss()]);
    const sites = [...threeSites(), site("src/alpha.ts", "return row;", "return null;", 0.1, 4)];
    const { record } = await runPipeline(input(finder(sites), screen));
    expect(screen.calls).toHaveLength(2);
    expect(record.stop_reason).toBe("screen_stopped");
    expect(record.candidates.map((entry) => entry.status)).toEqual(["screened", "screen_error", "skipped_after_screen_stop", "skipped_after_screen_stop"]);
    expect(record.candidates[1]).toMatchObject({ charged_microusd: 250_000, screen: null });
    expect(record.candidates[1]?.reason).toContain("op-1");
    expect(record.candidates[1]?.reason).toContain("root-1");
    expect(record.totals.spend_microusd).toBe(300_000);
  });

  it("charges nothing for a screen that stopped before it started", async () => {
    const screen = scripted([new ScreenStopError("the screen did not start: DATABASE_URL is not set", 0), miss()]);
    const { record } = await runPipeline(input(finder(threeSites()), screen));
    expect(screen.calls).toHaveLength(1);
    expect(record.candidates[0]).toMatchObject({ status: "screen_error", charged_microusd: 0 });
    expect(record.totals.spend_microusd).toBe(0);
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

  it("charges a malformed result's reported cost when it is over budget, and stops screening", async () => {
    const screen = scripted([{ verdict: "not_located", hits: 0, attempts: 99, costMicrousd: 50_000_000 }, miss(), miss()]);
    const { record } = await runPipeline(input(finder(threeSites()), screen, { caps: { ...CAPS, maxScreenSpendMicrousd: 1_000_000 } }));
    expect(screen.calls).toHaveLength(1);
    expect(record.candidates[0]).toMatchObject({ status: "screen_error", charged_microusd: 50_000_000 });
    expect(record.stop_reason).toBe("screen_overspent");
    expect(record.candidates.map((entry) => entry.status)).toEqual(["screen_error", "skipped_after_overspend", "skipped_after_overspend"]);
    expect(record.totals.spend_microusd).toBe(50_000_000);
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

  it("breaks a tie in attempts by finder confidence, then by file and line", async () => {
    const sites = [...threeSites(), site("src/alpha.ts", "return row;", "return null;", 0.5, 4)];
    // Order screened: beta 0.9, gamma 0.7, alpha line 3 at 0.5, alpha line 4 at 0.5; all miss three times.
    const screen = scripted([miss(3), miss(3), miss(3), miss(3)]);
    const { record } = await runPipeline(input(finder(sites), screen));
    const byId = (id: string) => record.candidates.find((entry) => entry.candidate_id === id);
    expect(record.ranking.map((id) => [byId(id)?.file, byId(id)?.line])).toEqual([
      ["src/beta.ts", 2],
      ["src/gamma.ts", 1],
      ["src/alpha.ts", 3],
      ["src/alpha.ts", 4],
    ]);
  });

});

describe("unexpected failures", () => {
  it("removes the scratch directory and throws a pipeline error that carries the record of the spend so far", async () => {
    // The screen leaves a stray file in the run's scratch directory, so the final removal fails.
    const screen = Object.assign(
      function strayScreen(job: { plantedTree: string }) {
        writeFileSync(join(dirname(job.plantedTree), "stray"), "x");
        return miss(3, 100_000);
      },
      {},
    );
    const run = input(finder(threeSites()), screen);
    const error: unknown = await runPipeline(run).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PipelineError);
    const record = (error as PipelineError).record;
    expect(record).toMatchObject({ stop_reason: "pipeline_error", totals: { screened: 3, spend_microusd: 300_000 } });
    expect((error as PipelineError).message).toMatch(/\$0\.30/);
    expect(readdirSync(run.scratchBase)).toEqual([]);
  });

  it("marks the candidates it never reached when the scratch directory cannot be made", async () => {
    const screen = scripted([]);
    const run = input(finder(threeSites()), screen, { scratchBase: join(tempDir("rbw-candidates-gone-"), "missing") });
    const error: unknown = await runPipeline(run).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PipelineError);
    expect(screen.calls).toHaveLength(0);
    expect((error as PipelineError).record?.candidates.map((entry) => entry.status)).toEqual(["skipped_after_error", "skipped_after_error", "skipped_after_error"]);
    expect((error as PipelineError).record?.totals.spend_microusd).toBe(0);
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
      symptom_source: "test-symptom",
      screen_model: "super",
      implementations: { find_sites: "fakeFindSites", screen: "fakeScreen" },
    });
    expect(record.rule.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.candidates[0]?.symptom_sha256).toMatch(/^[0-9a-f]{64}$/);
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

describe("planted-form confirmation", () => {
  it("plants a confirmed site before an unconfirmed one of higher confidence and records the state", async () => {
    const [, beta, gamma] = threeSites();
    if (beta === undefined || gamma === undefined) throw new Error("fixture sites missing");
    const unconfirmed: Site = { ...beta, confidence: 0.9, plantedFormConfirmed: false, confidenceLevel: "low" };
    const confirmed: Site = { ...gamma, confidence: 0.6, plantedFormConfirmed: true, confidenceLevel: "medium" };
    const screen = scripted([miss()]);
    const { record } = await runPipeline(input(finder([unconfirmed, confirmed]), screen, { caps: { ...CAPS, maxCandidates: 1 } }));
    expect(screen.calls).toHaveLength(1);
    expect(record.candidates.map((entry) => [entry.file, entry.status, entry.planted_form_confirmed, entry.confidence_level])).toEqual([
      [confirmed.file, "screened", true, "medium"],
      [unconfirmed.file, "over_candidate_cap", false, "low"],
    ]);
  });

  it("ranks a confirmed survivor before an unconfirmed one with as many misses", async () => {
    const [, beta, gamma] = threeSites();
    if (beta === undefined || gamma === undefined) throw new Error("fixture sites missing");
    const unconfirmed: Site = { ...beta, confidence: 0.9, plantedFormConfirmed: false, confidenceLevel: "low" };
    const confirmed: Site = { ...gamma, confidence: 0.6, plantedFormConfirmed: true, confidenceLevel: "medium" };
    const { record } = await runPipeline(input(finder([unconfirmed, confirmed]), scripted([miss(), miss()])));
    const byId = new Map(record.candidates.map((entry) => [entry.candidate_id, entry.file]));
    expect(record.ranking.map((id) => byId.get(id))).toEqual([confirmed.file, unconfirmed.file]);
  });

  it("records null for both fields when the finder does not report them", async () => {
    const { record } = await runPipeline(input(finder(threeSites()), scripted([miss(), miss(), miss()])));
    expect(record.candidates.every((entry) => entry.planted_form_confirmed === null && entry.confidence_level === null)).toBe(true);
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
    [{ verdict: "inconclusive", hits: 1, attempts: 2, costMicrousd: 0 }, "screen returned inconclusive with hits"],
  ])("rejects %j", (result, problem) => {
    expect(screenResultProblem(result, budget)).toBe(problem);
  });

  it("accepts well-formed results, including one over its cost budget (the pipeline stops on that)", () => {
    expect(screenResultProblem({ verdict: "located", hits: 1, attempts: 3, costMicrousd: 50 }, budget)).toBeNull();
    expect(screenResultProblem({ verdict: "inconclusive", hits: 0, attempts: 0, costMicrousd: 0 }, budget)).toBeNull();
    expect(screenResultProblem({ verdict: "not_located", hits: 0, attempts: 1, costMicrousd: 500 }, budget)).toBeNull();
  });
});
