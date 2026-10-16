import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CasePage } from "../src/components/case-page.tsx";
import { HistoricalReplays, RELEASED_TIME_ZONE_CASE } from "../src/components/historical-replays.tsx";
import { caseView, readResults } from "../src/release.ts";
import { addRelease, cleanup, DEVELOPMENT, NO_RELEASE, RELEASE, RELEASE_ID, syntheticCase } from "./support/results.ts";

describe("judge presentation", () => {
  afterEach(cleanup);
  it("links every quick-route stop to an existing anchor and preserves the six section anchors", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(RELEASE)} />);
    for (const id of ["cell-1", "cell-2", "cell-3", "cell-4", "cell-5", "cell-6", "bug-report", "recorded-replays"]) expect(html).toContain(`id="${id}"`);
    for (const match of html.matchAll(/href="#([^"]+)"/g)) expect(html).toContain(`id="${match[1] ?? ""}"`);
    expect(html).toContain('href="/catalog"');
    expect(html.indexOf('id="recorded-replays"')).toBeLessThan(html.indexOf("Start a new replay"));

  });

  it("renders the released time-zone introduction and report for the selected release only", async () => {
    const { dir, root } = syntheticCase();
    addRelease(dir, { releaseId: RELEASED_TIME_ZONE_CASE, root, createdAt: "2026-10-12T09:00:00Z" });
    const results = await readResults(dir);
    const selected = caseView(results, RELEASED_TIME_ZONE_CASE);
    expect(selected).not.toBeNull();
    if (selected === null) throw new Error("Missing test release");
    const html = renderToStaticMarkup(<CasePage results={selected} />);
    expect(html).toContain("All four added checks pass on clean and fixed copies. On the planted copy, the three non-UTC checks fail as expected while the UTC control passes.");
    const summary = (/<section aria-labelledby="bug-report">([\s\S]*?)<\/section>/.exec(html))?.[1];
    expect(summary).toBeDefined();
    expect(summary).toContain("In America/Los_Angeles, daily pageview counts for March 7–9, 2026 should be 3, 8, 1; the recorded API response instead gives 2, 8, 2.");
    expect(summary).toContain("The measurements are API responses. Chart rendering and dashboard interactions described in the report were not independently verified.");
    expect(summary).toContain(`href="/releases/${RELEASED_TIME_ZONE_CASE}/issue.json"`);

    const other = caseView(await readResults(RELEASE), RELEASE_ID);
    expect(other).not.toBeNull();
    if (other === null) throw new Error("Missing other test release");
    for (const state of [other, await readResults(NO_RELEASE)]) {
      const fallback = renderToStaticMarkup(<CasePage results={state} />);
      expect(fallback).not.toContain("The 271 measured original API tests");
      expect(fallback).not.toContain("the three non-UTC checks fail as expected");
      expect(fallback).not.toContain("should be 3, 8, 1; the recorded API response instead gives 2, 8, 2");
      expect(fallback).not.toContain(`href="/releases/${RELEASED_TIME_ZONE_CASE}/issue.json"`);
      expect(fallback).not.toContain("three published replays");
      expect(fallback).toContain(state.release === null
        ? "No frozen bug report has been released for this case."
        : `href="/releases/${RELEASE_ID}/issue.json"`);
    }
  });

  it("does not claim a blind spot when no admission comparison was recorded", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(DEVELOPMENT)} />);
    expect(html).not.toContain("This result demonstrates a test-suite blind spot");
    expect(html).toContain("This comparison does not measure debugging-agent performance.");
  });

  it("shows the historical summary only for the relevant frozen release", () => {
    const html = renderToStaticMarkup(<HistoricalReplays releaseId={RELEASED_TIME_ZONE_CASE} />);
    expect(html).toContain("three published replays");
    expect(html).toContain("all six comparison cells matching expectations");
    expect(html).toContain("added-check suite failed as expected");
    expect(html).toContain("are null");
    expect(html).toContain("do not establish execution on the latest deployment");
    expect(html.match(/>six comparison cells<\/a>/g)).toHaveLength(3);
    expect(html.match(/>public decision fields<\/a>/g)).toHaveLength(3);
    for (const releaseId of [null, "another-release"]) {
      const other = renderToStaticMarkup(<HistoricalReplays releaseId={releaseId} />);
      expect(other).not.toContain("three published replays");
      expect(other).toContain("No historical summary is provided for this case");
    }
  });
});
