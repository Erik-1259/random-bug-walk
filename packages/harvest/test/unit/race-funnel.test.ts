import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@rbw/shapes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand, type CommandDeps } from "../../src/commands.ts";
import { dropReasons, DROP_REASONS } from "../../src/funnel.ts";
import { replay } from "../../src/harvest.ts";
import { loadQueries, QUERIES, RACE_QUERY_FILE } from "../../src/queries.ts";
import { DT1_HARVEST_SHAPE, harvestShape, RACE_HARVEST_SHAPE, UnknownShape } from "../../src/shapes.ts";
import { FIXTURE_DIR } from "../support/generate-fixture.ts";
import { generateRaceFixture, RACE_FIXTURE_DIR } from "../support/generate-race-fixture.ts";
import { steppingClock } from "../support/synthetic-github.ts";
import { syntheticRaceGitHub } from "../support/synthetic-race-github.ts";

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

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

describe("harvest shapes", () => {
  it("defaults to DT-1.tz-arg and looks shapes up by ID", () => {
    expect(DT1_HARVEST_SHAPE.id).toBe("DT-1.tz-arg");
    expect(harvestShape("RC-1.guarded-write")).toBe(RACE_HARVEST_SHAPE);
    expect(() => harvestShape("RC-9.nothing")).toThrow(UnknownShape);
  });

  it("keeps the default shape's drop reasons and gives the race class its own", () => {
    expect(dropReasons(DT1_HARVEST_SHAPE)).toEqual(DROP_REASONS);
    expect(dropReasons(RACE_HARVEST_SHAPE).source_rule_matched).toEqual(["no_write_text_added", "no_rule_match_on_added_line"]);
    expect(dropReasons(RACE_HARVEST_SHAPE).structurally_confirmed).toEqual([
      "function_missing_before",
      "call_added",
      "guard_not_added",
      "guard_not_state",
      "no_read_before_write",
    ]);
  });
});

describe("race query list", () => {
  it("loads its own searches, separate from the time-zone ones", () => {
    const race = loadQueries(RACE_QUERY_FILE);
    expect(race.length).toBeGreaterThan(0);
    expect(race.filter((query) => QUERIES.some((other) => other.q === query.q))).toEqual([]);
    expect(loadQueries(RACE_HARVEST_SHAPE.query_file)).toEqual(race);
  });

  it("searches for race fixes by write API or fix pattern, merged pull requests only, each naming its API", () => {
    const race = loadQueries(RACE_QUERY_FILE);
    const text = race.map((query) => query.q).join("\n");
    for (const term of ["updateMany", "findOneAndUpdate", "compare-and-swap", "check-then-act"]) {
      expect(text, term).toContain(term);
    }
    expect(race.every((query) => /\brace\b/.test(query.q))).toBe(true);
    for (const query of race.filter((entry) => entry.kind === "pulls")) {
      expect(query.q).toMatch(/\bis:pr\b.*\bis:merged\b/);
    }
    expect(race.filter((query) => !query.q.includes(query.api))).toEqual([]);
  });
});

describe("funnel over the committed synthetic race run", () => {
  it("matches what the generator produces", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "harvest-race-fixture-")), "run");
    await generateRaceFixture(out);
    expect(listFiles(out)).toEqual(listFiles(RACE_FIXTURE_DIR));
    for (const file of listFiles(RACE_FIXTURE_DIR).filter((name) => name.endsWith(".json"))) {
      expect(readFileSync(join(out, file), "utf8"), file).toBe(readFileSync(join(RACE_FIXTURE_DIR, file), "utf8"));
    }
  });

  it("records the race shape in the manifest and replays it with no network", async () => {
    const manifest = JSON.parse(readFileSync(join(RACE_FIXTURE_DIR, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.shape_id).toBe("RC-1.guarded-write");
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network used during replay")));
    vi.stubGlobal("fetch", fetchSpy);
    const funnel = await replay(RACE_FIXTURE_DIR);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(funnel.shape_id).toBe("RC-1.guarded-write");
    expect(funnel.source_rule).toMatchObject({ file: "packages/harvest/rules/race-guard.candidate.yml", ids: ["race-guard.candidate.ts", "race-guard.candidate.tsx"] });
    expect(funnel.stages.map((stage) => [stage.stage, stage.count])).toEqual([
      ["harvested", 11],
      ["license_permitted", 10],
      ["diff_fetched", 10],
      ["source_rule_matched", 8],
      ["structurally_confirmed", 3],
    ]);
    expect(`${canonicalJson(funnel)}\n`).toBe(readFileSync(join(RACE_FIXTURE_DIR, "funnel.json"), "utf8"));
  });

  it("covers every race drop reason after the license, each once, and records the guard of each confirmation", async () => {
    const funnel = await replay(RACE_FIXTURE_DIR);
    const reasons = dropReasons(RACE_HARVEST_SHAPE);
    for (const stage of funnel.stages.filter((entry) => entry.stage === "source_rule_matched" || entry.stage === "structurally_confirmed")) {
      expect(stage.drops, stage.stage).toEqual(Object.fromEntries(reasons[stage.stage].map((reason) => [reason, 1])));
    }
    const confirmed = funnel.candidates.filter((candidate) => candidate.confirmation !== null);
    expect(confirmed.map((candidate) => [candidate.repo, candidate.confirmation !== null && "guard" in candidate.confirmation ? candidate.confirmation.guard : null])).toEqual([
      ["synthetic-org/synthetic-redeem", "redeemed: false"],
      ["synthetic-org/synthetic-claim", 'status: "open"'],
      ["synthetic-org/synthetic-stock", "stock: { $gt: 0 }"],
    ]);
    expect(funnel.candidates.find((candidate) => candidate.repo.endsWith("synthetic-redeem"))?.confirmation).toMatchObject({
      callee: "db.coupon.updateMany",
      before_line: 6,
      function: "redeem",
    });
  });

  it("keeps the default shape's manifest free of a shape field", () => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("shape_id");
  });
});

describe("command line with --shape", () => {
  it("harvests the race class with its own queries and rule, and prints the shape", async () => {
    const github = syntheticRaceGitHub();
    const out = join(mkdtempSync(join(tmpdir(), "harvest-race-cli-")), "run");
    const io = deps({ fetch: github.fetch });
    expect(await runCommand(["harvest", "--out", out, "--max", "2", "--shape", "RC-1.guarded-write"], io)).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { shape_id: string; queries: { q: string }[] };
    expect(manifest.shape_id).toBe("RC-1.guarded-write");
    expect(manifest.queries).toEqual(loadQueries(RACE_QUERY_FILE).map((query) => ({ api: query.api, kind: query.kind, q: query.q })));
    expect(github.requests[0]?.url).toContain("updateMany");
    expect(io.out.join("")).toContain("(RC-1.guarded-write, unauthenticated)");
  });

  it("prints the race funnel from frozen responses", async () => {
    const io = deps();
    expect(await runCommand(["funnel", "--in", RACE_FIXTURE_DIR], io)).toBe(0);
    expect(io.out.join("")).toBe(readFileSync(join(RACE_FIXTURE_DIR, "funnel.json"), "utf8"));
  });

  it("refuses an unknown shape, and a shape given to funnel, with exit 2", async () => {
    const io = deps();
    expect(await runCommand(["harvest", "--out", "x", "--shape", "RC-9.nothing"], io)).toBe(2);
    expect(io.err.join("")).toContain("no harvest shape RC-9.nothing");
    expect(await runCommand(["funnel", "--in", RACE_FIXTURE_DIR, "--shape", "RC-1.guarded-write"], io)).toBe(2);
  });

  it("refuses to replay a run whose manifest names an unknown shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-race-cli-"));
    const manifest = JSON.parse(readFileSync(join(RACE_FIXTURE_DIR, "manifest.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, shape_id: "RC-9.nothing" }));
    const io = deps();
    expect(await runCommand(["funnel", "--in", dir], io)).toBe(2);
    expect(io.err.join("")).toContain("no harvest shape");
  });
});
