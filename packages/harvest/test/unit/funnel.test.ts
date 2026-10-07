import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DROP_REASONS, STAGES, rankDrops, type CandidateRecord } from "../../src/funnel.ts";
import { replay } from "../../src/harvest.ts";
import { createGitHubClient } from "../../src/github.ts";
import { harvest } from "../../src/harvest.ts";
import { FIXTURE_DIR, generateFixture } from "../support/generate-fixture.ts";
import { SYNTHETIC_MAX, SYNTHETIC_QUERIES, steppingClock, syntheticGitHub } from "../support/synthetic-github.ts";

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("funnel over the committed synthetic run", () => {
  it("matches what the generator produces", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "harvest-fixture-")), "run");
    await generateFixture(out);
    expect(listFiles(out)).toEqual(listFiles(FIXTURE_DIR));
    for (const file of listFiles(FIXTURE_DIR).filter((name) => name.endsWith(".json"))) {
      expect(readFileSync(join(out, file), "utf8"), file).toBe(readFileSync(join(FIXTURE_DIR, file), "utf8"));
    }
  });

  it("replays with no network", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network used during replay")));
    vi.stubGlobal("fetch", fetchSpy);
    const funnel = await replay(FIXTURE_DIR);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(funnel.stages.map((stage) => [stage.stage, stage.count])).toEqual([
      ["harvested", 28],
      ["license_permitted", 23],
      ["diff_fetched", 10],
      ["source_rule_matched", 8],
      ["structurally_confirmed", 3],
    ]);
  });

  it("gives identical funnel bytes to the one the harvest wrote", async () => {
    const { canonicalJson } = await import("@rbw/shapes");
    expect(`${canonicalJson(await replay(FIXTURE_DIR))}\n`).toBe(readFileSync(join(FIXTURE_DIR, "funnel.json"), "utf8"));
  });

  it("covers every drop reason, each with a count, at the stage that owns it", async () => {
    const funnel = await replay(FIXTURE_DIR);
    for (const stage of funnel.stages) {
      const expected = DROP_REASONS[stage.stage];
      expect(Object.keys(stage.drops).sort(), stage.stage).toEqual([...expected].sort());
      expect(stage.drops, stage.stage).toEqual(Object.fromEntries(expected.map((reason) => [reason, reason === "duplicate_commit" ? 2 : 1])));
    }
    expect(STAGES).toEqual(["harvested", "license_permitted", "diff_fetched", "source_rule_matched", "structurally_confirmed"]);
  });

  it("records each candidate's drop and the confirmed pairings", async () => {
    const funnel = await replay(FIXTURE_DIR);
    const byRepo = new Map(funnel.candidates.map((candidate) => [`${candidate.repo}${candidate.pull === null ? "" : `#${String(candidate.pull)}`}`, candidate]));
    const reason = (key: string): string | undefined => byRepo.get(`synthetic-org/synthetic-${key}`)?.drop?.reason;
    expect(reason("repo-gone")).toBe("repo_unavailable");
    expect(reason("forked")).toBe("fork");
    expect(reason("copy")).toBe("duplicate_patch");
    expect(reason("mirror")).toBe("duplicate_commit");
    expect(reason("no-license")).toBe("license_missing");
    expect(reason("other-license")).toBe("license_unrecognized");
    expect(reason("copyleft")).toBe("license_not_permitted");
    expect(reason("commit-gone")).toBe("commit_unavailable");
    expect(reason("merge")).toBe("not_single_parent");
    expect(reason("wide")).toBe("too_many_files");
    expect(reason("docs-only")).toBe("no_ts_js_change");
    expect(reason("no-patch")).toBe("patch_missing");
    expect(reason("parent-gone")).toBe("blob_unavailable");
    expect(reason("huge-blob")).toBe("blob_too_large");
    expect(reason("blob-drift")).toBe("blob_mismatch");
    expect(reason("no-tz-text")).toBe("no_timezone_text_added");
    expect(reason("comment-only")).toBe("no_rule_match_on_added_line");
    expect(reason("new-function")).toBe("function_missing_before");
    expect(reason("new-call")).toBe("call_added");
    expect(reason("already-passed")).toBe("before_has_timezone_argument");
    expect(reason("constant-zone")).toBe("timezone_is_constant");
    expect(reason("global-zone")).toBe("timezone_unbound");
    expect(reason("pull-gone#8")).toBe("pr_unavailable");
    expect(reason("open#9")).toBe("pr_not_merged");
    expect(reason("hook#10")).toBe("duplicate_commit");

    const confirmed = funnel.candidates.filter((candidate) => candidate.stage_reached === "structurally_confirmed");
    expect(confirmed.map((candidate) => [candidate.repo, candidate.drop, candidate.confirmation?.path, candidate.confirmation?.call])).toEqual([
      ["synthetic-org/synthetic-sql", null, "src/queries/stats.ts", 'getDateSQL("created_at", unit, filters.timezone)'],
      ["synthetic-org/synthetic-hook", null, "src/pages/RangePage.tsx", "useDateRange({ timezone })"],
      ["synthetic-org/synthetic-search-license", null, "src/label.ts", "formatDate(d, timezone)"],
    ]);
    expect(confirmed[0]?.confirmation).toMatchObject({ license: "Apache-2.0", before_call: 'getDateSQL("created_at", unit)', function: "statsQuery" });
  });

  it("stops harvesting at the cap, skips repeated search hits and records failed queries", async () => {
    const funnel = await replay(FIXTURE_DIR);
    expect(funnel.harvest.max).toBe(28);
    expect(funnel.harvest.queries.map((query) => [query.status, query.items, query.added])).toEqual([
      [200, 26, 24],
      [422, 0, 0],
      [200, 4, 4],
    ]);
    expect(funnel.candidates.some((candidate) => candidate.repo.endsWith("beyond-max"))).toBe(false);
  });

  it("says which source rule it used and why", async () => {
    const funnel = await replay(FIXTURE_DIR);
    expect(funnel.source_rule).toMatchObject({ basis: "candidate_rule", ids: ["tz-arg.candidate.ts", "tz-arg.candidate.tsx"] });
    expect(funnel.source_rule.reason).toContain("dt-1.tz-arg.source");
    expect(funnel.source_rule.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("takes search results round-robin across queries, so every query that answers contributes", async () => {
    const funnel = await replay(FIXTURE_DIR);
    expect(funnel.candidates.slice(0, 8).map((candidate) => [candidate.query, candidate.id.replace(/@[0-9a-f]+$/, "")])).toEqual([
      [0, "synthetic-org/synthetic-copy"],
      [2, "synthetic-org/synthetic-sql#7"],
      [0, "synthetic-org/synthetic-hook"],
      [2, "synthetic-org/synthetic-pull-gone#8"],
      // The third commit result repeats the first, so it adds nothing in its turn.
      [2, "synthetic-org/synthetic-open#9"],
      [0, "synthetic-org/synthetic-repo-gone"],
      [2, "synthetic-org/synthetic-hook#10"],
      [0, "synthetic-org/synthetic-forked"],
    ]);
  });

  it("reports each query's stage counts and its drop reasons, most frequent first", async () => {
    const funnel = await replay(FIXTURE_DIR);
    const [commits, failing, pulls] = funnel.harvest.queries;
    expect(commits?.stages).toEqual({ harvested: 24, license_permitted: 19, diff_fetched: 9, source_rule_matched: 7, structurally_confirmed: 2 });
    expect(commits?.drops).toHaveLength(22);
    expect(commits?.drops.slice(0, 2)).toEqual([
      { stage: "license_permitted", reason: "fork", count: 1 },
      { stage: "license_permitted", reason: "license_missing", count: 1 },
    ]);
    expect(failing?.stages).toEqual({ harvested: 0, license_permitted: 0, diff_fetched: 0, source_rule_matched: 0, structurally_confirmed: 0 });
    expect(failing?.drops).toEqual([]);
    expect(pulls?.stages).toEqual({ harvested: 4, license_permitted: 4, diff_fetched: 1, source_rule_matched: 1, structurally_confirmed: 1 });
    expect(pulls?.drops).toEqual([
      { stage: "diff_fetched", reason: "duplicate_commit", count: 1 },
      { stage: "diff_fetched", reason: "pr_not_merged", count: 1 },
      { stage: "diff_fetched", reason: "pr_unavailable", count: 1 },
    ]);
  });
});

describe("de-duplication", () => {
  it("drops a fork by the search result's fork flag, before any commit is fetched", async () => {
    const funnel = await replay(FIXTURE_DIR);
    const forked = funnel.candidates.find((candidate) => candidate.repo === "synthetic-org/synthetic-forked");
    expect(forked?.drop).toMatchObject({ stage: "license_permitted", reason: "fork" });
    expect(forked?.license).toBeNull();
  });

  it("drops a repeated commit SHA in another repository and keeps the earlier candidate", async () => {
    const funnel = await replay(FIXTURE_DIR);
    const pull = funnel.candidates.find((candidate) => candidate.id === "synthetic-org/synthetic-sql#7");
    const mirror = funnel.candidates.find((candidate) => candidate.repo === "synthetic-org/synthetic-mirror");
    expect(mirror?.commit).toBe(pull?.commit);
    expect(pull?.stage_reached).toBe("structurally_confirmed");
    expect(mirror?.drop).toMatchObject({ stage: "diff_fetched", reason: "duplicate_commit" });
    expect(mirror?.drop?.detail).toContain("synthetic-org/synthetic-sql#7");
  });

  it("drops a repeated patch in another repository and keeps the earliest commit, even when found later", async () => {
    const funnel = await replay(FIXTURE_DIR);
    const copy = funnel.candidates.find((candidate) => candidate.repo === "synthetic-org/synthetic-copy");
    const hook = funnel.candidates.find((candidate) => candidate.repo === "synthetic-org/synthetic-hook" && candidate.pull === null);
    const index = (repo: string): number => funnel.candidates.findIndex((candidate) => candidate.repo === `synthetic-org/synthetic-${repo}`);
    expect(index("copy")).toBeLessThan(index("hook"));
    expect(copy?.patch_id).toMatch(/^[0-9a-f]{64}$/);
    expect(copy?.patch_id).toBe(hook?.patch_id);
    expect(copy?.commit).not.toBe(hook?.commit);
    expect(hook?.committed_at).toBe("2026-03-01T00:00:00Z");
    expect(copy?.drop).toMatchObject({ stage: "diff_fetched", reason: "duplicate_patch" });
    expect(copy?.drop?.detail).toContain("synthetic-org/synthetic-hook@");
    expect(hook?.stage_reached).toBe("structurally_confirmed");
  });

  it("fetches no blob for a duplicate and no commit for a fork", async () => {
    const github = syntheticGitHub();
    const clock = steppingClock();
    const client = createGitHubClient({ fetch: github.fetch, now: clock.now, sleep: () => Promise.resolve() });
    const out = join(mkdtempSync(join(tmpdir(), "harvest-dedupe-")), "run");
    await harvest({ client, out, max: SYNTHETIC_MAX, queries: SYNTHETIC_QUERIES, clock: clock.date, authenticated: false });
    const urls = github.requests.map((request) => request.url);
    expect(urls.filter((url) => url.startsWith("/repos/synthetic-org/synthetic-forked/"))).toEqual([]);
    expect(urls.filter((url) => url.startsWith("/repos/synthetic-org/synthetic-copy/contents/"))).toEqual([]);
    expect(urls.filter((url) => url.startsWith("/repos/synthetic-org/synthetic-mirror/contents/"))).toEqual([]);
    expect(urls.some((url) => url.startsWith("/repos/synthetic-org/synthetic-copy/commits/"))).toBe(true);
  });
});

describe("license lookup", () => {
  async function liveRequests(): Promise<string[]> {
    const github = syntheticGitHub();
    const clock = steppingClock();
    const client = createGitHubClient({ fetch: github.fetch, now: clock.now, sleep: () => Promise.resolve() });
    const out = join(mkdtempSync(join(tmpdir(), "harvest-license-")), "run");
    await harvest({ client, out, max: SYNTHETIC_MAX, queries: SYNTHETIC_QUERIES, clock: clock.date, authenticated: false });
    return github.requests.map((request) => request.url);
  }

  it("uses a license the search result carries and fetches nothing for it", async () => {
    const urls = await liveRequests();
    expect(urls.filter((url) => /^\/repos\/synthetic-org\/synthetic-search-license(\/license)?$/.test(url))).toEqual([]);
    const funnel = await replay(FIXTURE_DIR);
    const candidate = funnel.candidates.find((entry) => entry.repo === "synthetic-org/synthetic-search-license");
    expect([candidate?.license, candidate?.license_source]).toEqual(["ISC", "search"]);
  });

  it("fetches the license once per repository when the search result lacks it", async () => {
    const urls = await liveRequests();
    expect(urls.filter((url) => url === "/repos/synthetic-org/synthetic-hook/license")).toHaveLength(1);
    expect(urls).not.toContain("/repos/synthetic-org/synthetic-hook");
    const funnel = await replay(FIXTURE_DIR);
    const hook = funnel.candidates.filter((entry) => entry.repo === "synthetic-org/synthetic-hook");
    expect(hook.map((entry) => [entry.license, entry.license_source])).toEqual([
      ["MIT", "license_endpoint"],
      ["MIT", "license_endpoint"],
    ]);
  });

  it("reads the repository record for a pull request, then the license endpoint when the record lists none", async () => {
    const urls = await liveRequests();
    expect(urls).toContain("/repos/synthetic-org/synthetic-sql");
    expect(urls).toContain("/repos/synthetic-org/synthetic-sql/license");
    expect(urls).toContain("/repos/synthetic-org/synthetic-open");
    expect(urls).not.toContain("/repos/synthetic-org/synthetic-open/license");
    const funnel = await replay(FIXTURE_DIR);
    const byId = new Map(funnel.candidates.map((entry) => [entry.id, entry]));
    expect([byId.get("synthetic-org/synthetic-sql#7")?.license, byId.get("synthetic-org/synthetic-sql#7")?.license_source]).toEqual(["Apache-2.0", "license_endpoint"]);
    expect(byId.get("synthetic-org/synthetic-open#9")?.license_source).toBe("repository");
  });

  it("drops as license_missing only after the license endpoint finds none", async () => {
    const urls = await liveRequests();
    expect(urls).toContain("/repos/synthetic-org/synthetic-no-license/license");
    const funnel = await replay(FIXTURE_DIR);
    const candidate = funnel.candidates.find((entry) => entry.repo === "synthetic-org/synthetic-no-license");
    expect(candidate?.drop).toMatchObject({ reason: "license_missing" });
    expect(candidate?.drop?.detail).toContain("license endpoint");
  });
});

describe("drop ranking", () => {
  it("orders by count, then by stage, then by reason", () => {
    const drop = (stage: CandidateRecord["stage_reached"], reason: string): Pick<CandidateRecord, "drop"> => ({ drop: { stage, reason, detail: "synthetic" } });
    expect(
      rankDrops([
        drop("structurally_confirmed", "timezone_unbound"),
        drop("diff_fetched", "no_ts_js_change"),
        drop("license_permitted", "license_missing"),
        drop("diff_fetched", "no_ts_js_change"),
        drop("diff_fetched", "duplicate_patch"),
        { drop: null },
      ]),
    ).toEqual([
      { stage: "diff_fetched", reason: "no_ts_js_change", count: 2 },
      { stage: "license_permitted", reason: "license_missing", count: 1 },
      { stage: "diff_fetched", reason: "duplicate_patch", count: 1 },
      { stage: "structurally_confirmed", reason: "timezone_unbound", count: 1 },
    ]);
  });
});
