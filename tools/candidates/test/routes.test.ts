import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCanonical } from "@rbw/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPO_ROOT, runCommand, type CommandDeps, type ScreenConfig } from "../src/command.ts";
import { BEHAVIORAL_ROUTE, DEFAULT_ROUTE, runBehavioralRoute, STATIC_SCREEN_ROUTE } from "../src/routes.ts";
import type { Screen } from "../src/types.ts";
import { finder, makeHost, miss, RULE, scripted, site, tempDir, threeSites } from "./support.ts";

interface Run {
  code: number;
  out: string;
  err: string;
  outFile: string;
}

async function run(extra: string[], deps: CommandDeps, outFile?: string): Promise<Run> {
  const dir = tempDir("rbw-candidates-route-");
  const rule = join(dir, "xx-1.synthetic.yml");
  writeFileSync(rule, "id: xx-1.synthetic\n");
  const target = outFile ?? join(dir, "record.json");
  let out = "";
  let err = "";
  const code = await runCommand(
    ["--rule", rule, "--host", makeHost(), "--out", target, "--scratch", tempDir("rbw-candidates-route-scratch-"), ...extra],
    { now: () => new Date("2026-10-19T12:00:00.000Z"), runId: () => "22222222-2222-4222-8222-222222222222", ...deps },
    { out: (text) => (out += text), err: (text) => (err += text) },
  );
  return { code, out, err, outFile: target };
}

function readRecord(path: string): Record<string, unknown> {
  return parseCanonical(readFileSync(path)) as Record<string, unknown>;
}

/** A screen and a screen builder that record whether anything touched them. */
function spies(): { screen: Screen & { calls: unknown[] }; buildScreen: ((config: ScreenConfig) => Screen) & { built: number } } {
  const screen = scripted([miss(), miss(), miss()]);
  const buildScreen = Object.assign(
    (): Screen => {
      buildScreen.built += 1;
      return screen;
    },
    { built: 0 },
  );
  return { screen, buildScreen };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the --route option", () => {
  it("defaults to behavioral-qualification/v1", () => {
    expect(DEFAULT_ROUTE).toBe(BEHAVIORAL_ROUTE);
    expect(BEHAVIORAL_ROUTE).toBe("behavioral-qualification/v1");
  });

  it("runs the default route without building or calling a screen, and records its route and difficulty", async () => {
    const { screen, buildScreen } = spies();
    const result = await run([], { findSites: finder(threeSites()), screen, buildScreen });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(screen.calls).toHaveLength(0);
    expect(buildScreen.built).toBe(0);
    const record = readRecord(result.outFile);
    expect(record).toMatchObject({
      record: "candidate_run",
      version: 2,
      route: { route_id: "behavioral-qualification", version: "1" },
      run_id: "22222222-2222-4222-8222-222222222222",
      implementations: { find_sites: "fakeFindSites" },
      caps: { max_candidates: 10 },
      totals: { sites_found: 3, duplicates: 0, planted: 3 },
    });
    const candidates = record.candidates as { status: string; difficulty: unknown }[];
    expect(candidates).toHaveLength(3);
    expect(candidates.every((c) => c.status === "pending_qualification")).toBe(true);
    expect(candidates.every((c) => JSON.stringify(c.difficulty) === JSON.stringify({ status: "not_assessed" }))).toBe(true);
    for (const key of ["screen_model", "symptom_source", "stop_reason", "ranking", "dry_run"]) expect(record).not.toHaveProperty(key);
    expect(result.out).toContain("3 candidates await behavioral qualification");
    expect(result.out).toContain("no screen ran and nothing was spent");
  });

  it("has no screen-budget, key, database or rate-sheet prerequisite", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("TOKEN_FACTORY_SCREEN_KEY", "");
    const { screen, buildScreen } = spies();
    // Kimi's attempts cannot fit the default per-screen budget, and the rate sheet does not exist:
    // both refuse a static-screen run, and neither matters here.
    const missing = join(tempDir("rbw-candidates-route-rates-"), "missing.json");
    const result = await run(["--model", "kimi", "--rate-sheet", missing], { findSites: finder(threeSites()), buildScreen });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(buildScreen.built).toBe(0);
    expect(screen.calls).toHaveLength(0);
    const refused = await run(["--route", STATIC_SCREEN_ROUTE, "--model", "kimi", "--rate-sheet", missing], { findSites: finder(threeSites()), buildScreen });
    expect(refused.code).toBe(2);
  });

  it("keeps static-screen/v1 selectable with its record format unchanged (no route field)", async () => {
    const result = await run(["--route", STATIC_SCREEN_ROUTE, "--dry-run"], { findSites: finder(threeSites()) });
    expect(result.code).toBe(0);
    const record = readRecord(result.outFile);
    expect(record).toMatchObject({ record: "candidate_run", version: 1, dry_run: true, screen_model: "super" });
    expect(record).not.toHaveProperty("route");
    expect(Object.keys(record).sort()).toEqual(
      ["candidates", "caps", "created_at", "dry_run", "host_commit", "implementations", "ranking", "record", "rule", "run_id", "screen_model", "stop_reason", "symptom_source", "totals", "version"].sort(),
    );
  });

  it("refuses an unknown route before anything runs", async () => {
    const result = await run(["--route", "screen"], { findSites: finder(threeSites()) });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--route must be behavioral-qualification\/v1 or static-screen\/v1/);
    expect(existsSync(result.outFile)).toBe(false);
  });

  it("keeps the shared refusals: a record path inside the repository is refused on the default route", async () => {
    const inside = join(REPO_ROOT, "tools", "candidates", "never-written.json");
    const result = await run([], { findSites: finder(threeSites()) }, inside);
    expect(result.code).toBe(2);
    expect(existsSync(inside)).toBe(false);
  });
});

describe("runBehavioralRoute", () => {
  it("records sites that fail to plant and sites over the candidate cap, and plants the rest in memory only", async () => {
    const host = makeHost();
    const bad = site("src/alpha.ts", "store.lock(id);", "store.unlock(id);", 0.95, 3);
    const broken = { ...bad, diff: "not a diff" };
    const record = await runBehavioralRoute({
      rule: RULE,
      hostDir: host,
      findSites: finder([...threeSites(), broken]),
      maxCandidates: 2,
      hostCommit: null,
      runId: "33333333-3333-4333-8333-333333333333",
      now: () => new Date("2026-10-19T12:00:00.000Z"),
      findSitesName: "fakeFindSites",
    });
    expect(record.candidates.map((c) => c.status).sort()).toEqual(["over_candidate_cap", "pending_qualification", "pending_qualification", "plant_failed"]);
    expect(record.totals).toEqual({ sites_found: 4, duplicates: 0, planted: 2 });
    expect(readFileSync(join(host, "src", "alpha.ts"), "utf8")).toContain("store.lock(id);");
  });
});
