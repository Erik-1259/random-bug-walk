// Judge replays (RootRun kind judge_replay) are verification runs: the funnel counts them apart from
// factory runs, and the catalog, the case page and the run index page label them as replays.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Catalog } from "../src/components/catalog.tsx";
import { CasePage } from "../src/components/case-page.tsx";
import { RunIndex } from "../src/components/run-index.tsx";
import { funnel, otherRuns, REPLAY_VERDICT_NOTE } from "../src/model.ts";
import { publishedFiles, readResults } from "../src/release.ts";
import { cleanup, NO_RELEASE, PAIRED_ROOTS, RELEASE_ID, RELEASE_ROOT, REPLAY_ROOTS, releaseWithPairedComparisons, releaseWithReplays } from "./support/results.ts";

afterEach(cleanup);

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("verification replays", () => {
  it("leaves judge replays out of the factory funnel", async () => {
    const results = await readResults(releaseWithReplays());
    expect(results.runs).toHaveLength(4);
    expect(funnel(results).map((step) => [step.label, step.count])).toEqual([
      ["Factory runs recorded", 1],
      ["Factory runs finished", 1],
      ["Factory runs published", 1],
      ["Factory runs with an observed symptom", 1],
      ["Factory runs with an admission decision", 1],
      ["Admission verdict pass", 1],
      ["Blind spot demonstrated (ADM-08)", 1],
      ["Validated releases (ADM-09)", 1],
    ]);
  });

  it("counts the replays apart, by the outcome their records hold, and says the verdict is not in them", async () => {
    const results = await readResults(releaseWithReplays());
    expect(otherRuns(results).map((step) => [step.label, step.count])).toEqual([
      ["Verification replays (judge)", 3],
      ["Replays completed", 2],
      ["Replays not finished", 1],
    ]);
    const page = text(renderToStaticMarkup(<CasePage results={results} />));
    expect(page).toContain("Runs counted apart from the factory funnel Verification replays (judge) 3 Replays completed 2 Replays not finished 1 A replay's");
    expect(page).not.toContain("Kit checks");
    expect(page).toContain(REPLAY_VERDICT_NOTE);
    expect(REPLAY_VERDICT_NOTE).toBe(
      "A replay's published records do not include its verdict (verified or not reproduced), so the replay lines count each replay's recorded outcome only: completed means the replay's run ended, not that it reproduced the release.",
    );
    expect(page).toContain("Factory runs recorded 1");
  });

  it("lists published replays as verification replays, not as failed or unvalidated factory runs", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(releaseWithReplays())} />);
    const page = text(html);
    expect(page).toContain("Diagnostic archive (not validated) No other published factory runs.");
    expect(page).toContain(`Verification replays (judge) These are judges' replays, not factory runs, so they are not candidates for validation. ${REPLAY_ROOTS[0]} verification replay (judge), completed`);
    for (const root of REPLAY_ROOTS) expect(page).not.toContain(`${root} completed, not validated`);
    expect(html).toContain(`href="/runs/${REPLAY_ROOTS[0]}/report.md"`);
    expect(html).toContain(`href="/runs/${REPLAY_ROOTS[1]}"`);
    expect(html).not.toContain(`href="/runs/${REPLAY_ROOTS[2]}`);
  });

  it("labels replays in the catalog and says they are not factory runs", async () => {
    const page = text(renderToStaticMarkup(<Catalog results={await readResults(releaseWithReplays())} />));
    expect(page).toContain(`Run ${RELEASE_ROOT} is validated release ${RELEASE_ID}; the other factory runs are not validated. Verification replays (judge) are not factory runs.`);
    expect(page).not.toContain("Paired comparisons are not factory runs.");
    expect(page).toContain(`${REPLAY_ROOTS[0]} Verification replay (judge) Terminal Completed Published 1 1`);
    expect(page).toContain(`${REPLAY_ROOTS[2]} Verification replay (judge) Running None yet Not published`);
    expect(page).toContain(`${RELEASE_ROOT} Validated release ${RELEASE_ID} Factory run Terminal Completed Published`);
    const kit = text(renderToStaticMarkup(<Catalog results={await readResults(NO_RELEASE)} />));
    expect(kit).toContain("00000000-0000-4000-8000-000000002005 Kit check Running None yet Not published");
    expect(kit).not.toContain("Verification replays (judge) are not factory runs.");
    expect(kit).not.toContain("Paired comparisons are not factory runs.");
  });

  it("labels a replay's file index page and keeps its file routes", async () => {
    const results = await readResults(releaseWithReplays());
    const replay = results.runs.find((run) => run.rootExecutionId === REPLAY_ROOTS[0]);
    if (replay === undefined) throw new Error("synthetic: the replay is missing");
    const page = text(renderToStaticMarkup(<RunIndex results={results} run={replay} />));
    expect(page).toContain("Verification replay (judge), not a factory run Verification replay (judge), completed.");
    expect(page).not.toContain("not validated");
    expect(publishedFiles(results)).toContainEqual({ root: REPLAY_ROOTS[0], path: "report.md" });
  });
});

describe("paired comparisons", () => {
  it("leaves paired comparison roots out of the factory funnel and counts them apart", async () => {
    const results = await readResults(releaseWithPairedComparisons());
    expect(results.runs).toHaveLength(6);
    expect(funnel(results).slice(0, 3).map((step) => [step.label, step.count])).toEqual([
      ["Factory runs recorded", 1],
      ["Factory runs finished", 1],
      ["Factory runs published", 1],
    ]);
    expect(otherRuns(results).map((step) => [step.label, step.count])).toEqual([
      ["Verification replays (judge)", 3],
      ["Replays completed", 2],
      ["Replays not finished", 1],
      ["Paired comparisons", 2],
    ]);
    const page = text(renderToStaticMarkup(<CasePage results={results} />));
    expect(page).toContain("Replays not finished 1 Paired comparisons 2");
    expect(page).toContain("Diagnostic archive (not validated) No other published factory runs.");
    for (const root of PAIRED_ROOTS) expect(page).not.toContain(`${root} completed, not validated`);
  });

  it("labels paired comparisons in the catalog and on the run index page as not factory runs", async () => {
    const results = await readResults(releaseWithPairedComparisons());
    const catalog = text(renderToStaticMarkup(<Catalog results={results} />));
    expect(catalog).toContain("Verification replays (judge) are not factory runs. Paired comparisons are not factory runs.");
    expect(catalog).toContain(`${PAIRED_ROOTS[0]} Paired comparison Terminal Completed Published 1 1`);
    expect(catalog).toContain(`${PAIRED_ROOTS[1]} Paired comparison Running None yet Not published`);
    const paired = results.runs.find((run) => run.rootExecutionId === PAIRED_ROOTS[0]);
    if (paired === undefined) throw new Error("synthetic: the paired comparison is missing");
    const index = text(renderToStaticMarkup(<RunIndex results={results} run={paired} />));
    expect(index).toContain("Paired comparison, not a factory run Paired comparison, completed.");
    expect(index).not.toContain("not validated");
    expect(publishedFiles(results)).toContainEqual({ root: PAIRED_ROOTS[0], path: "report.md" });
  });
});
