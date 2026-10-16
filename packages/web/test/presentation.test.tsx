import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CasePage } from "../src/components/case-page.tsx";
import { HistoricalReplays, RELEASED_TIME_ZONE_CASE } from "../src/components/historical-replays.tsx";
import { readResults } from "../src/release.ts";
import { DEVELOPMENT, RELEASE } from "./support/results.ts";

describe("judge presentation", () => {
  it("links every quick-route stop to an existing anchor and preserves the six section anchors", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(RELEASE)} />);
    for (const id of ["cell-1", "cell-2", "cell-3", "cell-4", "cell-5", "cell-6", "bug-report", "recorded-replays"]) expect(html).toContain(`id="${id}"`);
    for (const match of html.matchAll(/href="#([^"]+)"/g)) expect(html).toContain(`id="${match[1] ?? ""}"`);
    expect(html).toContain('href="/catalog"');
    expect(html.indexOf('id="recorded-replays"')).toBeLessThan(html.indexOf("Start a new replay"));

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
    expect(html).toContain("added checks failed as expected");
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
