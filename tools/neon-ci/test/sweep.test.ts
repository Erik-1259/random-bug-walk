import { describe, expect, it } from "vitest";
import type { Branch } from "../src/api.ts";
import { parseRfc3339, runSweep, selectStale } from "../src/sweep.ts";
import { config, fakeDeps, project } from "./helpers.ts";
import type { BranchFixture } from "./helpers.ts";

const NOW = Date.parse("2026-10-03T12:00:00Z");

const fixture: BranchFixture[] = [
  { id: "br-old-1", name: "ci-pr-7-100-1", created_at: "2026-10-03T09:00:00Z" },
  { id: "br-young-1", name: "ci-pr-7-101-1", created_at: "2026-10-03T11:00:00Z" },
  { id: "br-prot-1", name: "ci-pr-7-102-1", created_at: "2026-10-03T08:00:00Z", protected: true },
  { id: "br-nodate-1", name: "ci-pr-7-103-1" },
  { id: "br-main-1", name: "main", default: true, created_at: "2026-01-01T00:00:00Z" },
  { id: "br-prev-1", name: "preview/feature-x", created_at: "2026-01-01T00:00:00Z" },
  { id: "br-keep-1", name: "ci-keep", created_at: "2026-01-01T00:00:00Z" },
];

function toBranch(entry: BranchFixture): Branch {
  return {
    id: entry.id,
    name: entry.name,
    isDefault: entry.default === true,
    isProtected: entry.protected === true,
    createdAt: entry.created_at,
    expiresAt: entry.expires_at,
  };
}

describe("selectStale", () => {
  it("selects the worked example", () => {
    const { selected, unknown } = selectStale(fixture.map(toBranch), NOW, 120);
    expect(selected.map((s) => [s.branch.name, s.ageMinutes])).toEqual([["ci-pr-7-100-1", 180]]);
    expect(unknown.map((b) => b.name)).toEqual(["ci-pr-7-103-1"]);
  });

  it("treats a future created_at as too young, even with a zero minimum age", () => {
    const future = toBranch({ id: "br-f-1", name: "ci-pr-1-1-1", created_at: "2026-10-03T12:00:01Z" });
    expect(selectStale([future], NOW, 0).selected).toEqual([]);
  });

  it("selects a branch created exactly at the minimum age", () => {
    const edge = toBranch({ id: "br-e-1", name: "ci-pr-1-1-1", created_at: "2026-10-03T10:00:00Z" });
    expect(selectStale([edge], NOW, 120).selected).toHaveLength(1);
  });

  it("reports an unparseable created_at as unknown", () => {
    const bad = toBranch({ id: "br-b-1", name: "ci-pr-1-1-1", created_at: "2026-02-30T00:00:00Z" });
    expect(selectStale([bad], NOW, 0).unknown).toHaveLength(1);
  });
});

describe("parseRfc3339", () => {
  it("accepts offsets and fractions and rejects other formats", () => {
    expect(parseRfc3339("2026-10-03T12:00:00.123456Z")).toBe(Date.parse("2026-10-03T12:00:00.123Z"));
    expect(parseRfc3339("2026-10-03T14:00:00+02:00")).toBe(NOW);
    expect(parseRfc3339("2026-10-03 12:00:00Z")).toBeUndefined();
    expect(parseRfc3339("2026-10-03")).toBeUndefined();
    expect(parseRfc3339("")).toBeUndefined();
    expect(parseRfc3339(undefined)).toBeUndefined();
  });
});

describe("runSweep", () => {
  function api() {
    return fakeDeps(({ method, path }) => {
      if (method === "GET") return { status: 200, body: { branches: fixture } };
      return { status: 200, body: { path } };
    }, NOW);
  }

  it("a dry run selects the same branches and deletes nothing", async () => {
    const { deps, requests } = api();
    const report = await runSweep(deps, config, 120, true);
    expect(report.lines).toEqual([
      "name=ci-pr-7-100-1 age_minutes=180 outcome=would-delete",
      "name=ci-pr-7-103-1 age_minutes=- outcome=unknown",
    ]);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(report.exitCode).toBe(2);
  });

  it("deletes exactly the selected branch by ID and exits 2 because of the unknown one", async () => {
    const { deps, requests } = api();
    const report = await runSweep(deps, config, 120, false);
    expect(requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`${project}/branches/br-old-1`]);
    expect(report.lines[0]).toBe("name=ci-pr-7-100-1 age_minutes=180 outcome=deleted");
    expect(report.summary).toContain("deleted=1");
    expect(report.exitCode).toBe(2);
  });

  it("exits 1 when a selected branch leaks and keeps going", async () => {
    const two: BranchFixture[] = [
      { id: "br-a-1", name: "ci-pr-1-1-1", created_at: "2026-10-03T01:00:00Z" },
      { id: "br-b-1", name: "ci-pr-2-2-1", created_at: "2026-10-03T01:00:00Z" },
    ];
    const { deps, requests } = fakeDeps(({ method, path }) => {
      if (method === "GET") return { status: 200, body: { branches: two } };
      return path.endsWith("br-a-1") ? { status: 500 } : { status: 200 };
    }, NOW);
    const report = await runSweep(deps, config, 120, false);
    expect(report.exitCode).toBe(1);
    expect(report.lines).toEqual([
      "name=ci-pr-1-1-1 age_minutes=660 outcome=leaked",
      "name=ci-pr-2-2-1 age_minutes=660 outcome=deleted",
    ]);
    expect(requests.some((r) => r.path.endsWith("br-b-1"))).toBe(true);
  });

  it("exits 2 when the listing fails", async () => {
    const { deps } = fakeDeps(() => ({ status: 403 }), NOW);
    expect((await runSweep(deps, config, 120, false)).exitCode).toBe(2);
  });
});
