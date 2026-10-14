// A site with several releases: two synthetic releases in one results directory, the release
// fixture's time-zone case and a race-family case, are read, listed newest first, rendered on their
// own pages and served under their own paths; / keeps showing the first released case. Judge
// replays are counted per release from the release their published request names.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeCanonical, sha256Hex } from "@rbw/schema";
import * as casesRoute from "../app/cases/[release]/page.tsx";
import HomePage from "../app/page.tsx";
import * as releaseRoute from "../app/releases/[release]/[...path]/route.ts";
import { Catalog } from "../src/components/catalog.tsx";
import { CasePage } from "../src/components/case-page.tsx";
import { RunIndex } from "../src/components/run-index.tsx";
import { caseSummaries, funnel, otherRuns, verificationReplays, diagnosticArchives } from "../src/model.ts";
import { caseView, MAX_RELEASES, readResults, ReleaseError, releaseFiles } from "../src/release.ts";
import {
  addJudgeReplay,
  addRelease,
  cleanup,
  copyRelease,
  RACE_RELEASE_CREATED,
  RACE_RELEASE_ID,
  RELEASE_ID,
  RELEASE_ROOT,
  releaseDir,
  twoReleases,
  writeFile,
} from "./support/results.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function refusal(dir: string): Promise<ReleaseError> {
  try {
    await readResults(dir);
  } catch (error) {
    if (error instanceof ReleaseError) return error;
    throw error;
  }
  throw new Error("the results were accepted");
}

/** Synthetic replay roots: two of the race release, one of the time-zone release, one not published yet. */
const REPLAYS = {
  race1: "00000000-0000-4000-8200-000000000011",
  race2: "00000000-0000-4000-8200-000000000012",
  timeZone: "00000000-0000-4000-8200-000000000013",
  running: "00000000-0000-4000-8200-000000000014",
} as const;

function withReplays(dir: string): void {
  addJudgeReplay(dir, REPLAYS.race1, { outcome: "completed", published: true, releaseId: RACE_RELEASE_ID });
  addJudgeReplay(dir, REPLAYS.race2, { outcome: "failed", published: true, releaseId: RACE_RELEASE_ID });
  addJudgeReplay(dir, REPLAYS.timeZone, { outcome: "completed", published: true, releaseId: RELEASE_ID });
  addJudgeReplay(dir, REPLAYS.running, { outcome: null, published: false });
}

describe("reading two releases", () => {
  it("reads both, newest first, each with its run and family, and shows the first released case by default", async () => {
    const { dir, raceRoot } = twoReleases();
    const results = await readResults(dir);
    expect(results.releases.map((item) => [item.release.record.release_id, item.run.rootExecutionId, item.family])).toEqual([
      [RACE_RELEASE_ID, raceRoot, "race"],
      [RELEASE_ID, RELEASE_ROOT, "time-zone"],
    ]);
    expect(results.releases[0]?.release.sha256).toBe(sha256Hex(readFileSync(join(releaseDir(dir, RACE_RELEASE_ID), "release.json"))));
    expect(results.release?.record.release_id).toBe(RELEASE_ID);
    expect(results.caseRun?.rootExecutionId).toBe(RELEASE_ROOT);
    const race = caseView(results, RACE_RELEASE_ID);
    expect(race?.release?.record.release_id).toBe(RACE_RELEASE_ID);
    expect(race?.caseRun?.rootExecutionId).toBe(raceRoot);
    expect(caseView(results, "00000000-0000-4000-8000-000000000699")).toBeNull();
  });

  it("counts both releases in the funnel and keeps both released runs out of the diagnostic archive", async () => {
    const results = await readResults(twoReleases().dir);
    expect(funnel(results).find((step) => step.label === "Validated releases (ADM-09)")?.count).toBe(2);
    expect(diagnosticArchives(results)).toEqual([]);
  });

  it("serves each release's files under its own path", async () => {
    const { dir } = twoReleases();
    const results = await readResults(dir);
    const files = releaseFiles(results).map((file) => `${file.release}/${file.path}`);
    expect(files).toContain(`${RACE_RELEASE_ID}/release.json`);
    expect(files).toContain(`${RACE_RELEASE_ID}/issue.json`);
    expect(files).toContain(`${RELEASE_ID}/release.json`);
    vi.stubEnv("RBW_RESULTS_DIR", dir);
    expect((await releaseRoute.generateStaticParams()).map((item) => `${item.release}/${item.path.join("/")}`)).toEqual(files);
    const response = await releaseRoute.GET(new Request("https://example.invalid/"), { params: Promise.resolve({ release: RACE_RELEASE_ID, path: ["release.json"] }) });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(join(releaseDir(dir, RACE_RELEASE_ID), "release.json")))).toBe(true);
  });
});

describe("the case pages of two releases", () => {
  it("prerenders one case page per release, and none for an unknown release", async () => {
    const { dir } = twoReleases();
    vi.stubEnv("RBW_RESULTS_DIR", dir);
    expect(casesRoute.dynamic).toBe("force-static");
    expect(casesRoute.dynamicParams).toBe(false);
    expect(await casesRoute.generateStaticParams()).toEqual([{ release: RACE_RELEASE_ID }, { release: RELEASE_ID }]);
    await expect(casesRoute.default({ params: Promise.resolve({ release: "00000000-0000-4000-8000-000000000699" }) })).rejects.toThrow();
  });

  it("renders the race case on its own page and the time-zone case on its own page", async () => {
    const { dir, raceRoot } = twoReleases();
    vi.stubEnv("RBW_RESULTS_DIR", dir);
    const race = text(renderToStaticMarkup(await casesRoute.default({ params: Promise.resolve({ release: RACE_RELEASE_ID }) })));
    expect(race).toContain("2. Concurrent requests and expected and observed acceptances");
    expect(race).toContain(`Release ${RACE_RELEASE_ID}`);
    expect(race).toContain(raceRoot);
    expect(race).toContain(`Frozen release ${RACE_RELEASE_ID}`);
    expect(race).toContain("2 releases (ADM-09) were published; this page shows one of them.");
    const timeZone = text(renderToStaticMarkup(await casesRoute.default({ params: Promise.resolve({ release: RELEASE_ID }) })));
    expect(timeZone).toContain("2. Expected and observed local-day counts");
    expect(timeZone).toContain(`Frozen release ${RELEASE_ID}`);
    const html = renderToStaticMarkup(await casesRoute.default({ params: Promise.resolve({ release: RACE_RELEASE_ID }) }));
    expect(html).toContain(`href="/releases/${RACE_RELEASE_ID}/issue.json"`);
    expect(html).not.toContain(`href="/releases/${RELEASE_ID}/issue.json"`);
  });

  it("lists every case on the home page, newest first, with its family and status, and keeps showing the first released case there", async () => {
    const { dir } = twoReleases();
    vi.stubEnv("RBW_RESULTS_DIR", dir);
    const html = renderToStaticMarkup(await HomePage());
    const page = text(html);
    expect(page).toContain("Released cases");
    expect(page).toContain("This site has 2 released cases, newest first.");
    expect(page).toContain("This page shows the first released case, so links shared before the other cases were added still show it.");
    const raceRow = page.indexOf(`2026-10-12 Race Validated release (ADM-09): admission pass, blind spot demonstrated 0 Release ${RACE_RELEASE_ID}`);
    const timeZoneRow = page.indexOf(`2026-10-06 Time-zone Validated release (ADM-09): admission pass, blind spot demonstrated 0 Release ${RELEASE_ID} (shown below)`);
    expect(raceRow).toBeGreaterThan(-1);
    expect(timeZoneRow).toBeGreaterThan(raceRow);
    expect(html).toContain(`href="/cases/${RACE_RELEASE_ID}"`);
    expect(html).toContain(`href="/cases/${RELEASE_ID}" aria-current="page"`);
    expect(page).toContain("2. Expected and observed local-day counts");
    expect(page).toContain(`Frozen release ${RELEASE_ID}`);
  });

  it("marks both released runs in the catalog and on their file index pages", async () => {
    const { dir, raceRoot } = twoReleases();
    const results = await readResults(dir);
    const catalog = text(renderToStaticMarkup(<Catalog results={results} />));
    expect(catalog).toContain(`Validated release ${RACE_RELEASE_ID}`);
    expect(catalog).toContain(`Validated release ${RELEASE_ID}`);
    expect(catalog).toContain(`run ${raceRoot} is validated release ${RACE_RELEASE_ID}`);
    const run = results.runs.find((item) => item.rootExecutionId === raceRoot);
    if (run === undefined) throw new Error("synthetic: the race run is missing");
    const index = renderToStaticMarkup(<RunIndex results={results} run={run} />);
    expect(index).toContain(`Validated release ${RACE_RELEASE_ID}`);
    expect(index).toContain(`href="/cases/${RACE_RELEASE_ID}"`);
  });
});

describe("judge replays per release", () => {
  it("attributes each published replay to the release its request names, and counts each case page's own", async () => {
    const { dir } = twoReleases();
    withReplays(dir);
    const results = await readResults(dir);
    expect(results.runs.find((run) => run.rootExecutionId === REPLAYS.race1)?.replayReleaseId).toBe(RACE_RELEASE_ID);
    expect(results.runs.find((run) => run.rootExecutionId === REPLAYS.running)?.replayReleaseId).toBeNull();
    const race = caseView(results, RACE_RELEASE_ID);
    const timeZone = caseView(results, RELEASE_ID);
    if (race === null || timeZone === null) throw new Error("synthetic: a release is missing");
    expect(verificationReplays(race).map((run) => run.rootExecutionId)).toEqual([REPLAYS.race1, REPLAYS.race2]);
    expect(verificationReplays(timeZone).map((run) => run.rootExecutionId)).toEqual([REPLAYS.timeZone]);
    expect(otherRuns(race)).toEqual([
      { label: "Verification replays (judge) of this release", count: 2 },
      { label: "Replays completed", count: 1 },
      { label: "Replays failed", count: 1 },
      { label: "Verification replays not yet matched to a release", count: 1 },
    ]);
    expect(otherRuns(timeZone)).toEqual([
      { label: "Verification replays (judge) of this release", count: 1 },
      { label: "Replays completed", count: 1 },
      { label: "Verification replays not yet matched to a release", count: 1 },
    ]);
    expect(caseSummaries(results).map((item) => [item.releaseId, item.replays])).toEqual([
      [RACE_RELEASE_ID, 2],
      [RELEASE_ID, 1],
    ]);
    const page = text(renderToStaticMarkup(<CasePage results={race} />));
    expect(page).toContain(REPLAYS.race1);
    expect(page).not.toContain(REPLAYS.timeZone);
  });

  it("counts every replay on the one case page when the site has one release, as before", async () => {
    const dir = copyRelease();
    addJudgeReplay(dir, REPLAYS.race1, { outcome: "completed", published: true, releaseId: RACE_RELEASE_ID });
    addJudgeReplay(dir, REPLAYS.running, { outcome: null, published: false });
    const results = await readResults(dir);
    expect(otherRuns(results)).toEqual([
      { label: "Verification replays (judge)", count: 2 },
      { label: "Replays completed", count: 1 },
      { label: "Replays not finished", count: 1 },
    ]);
    expect(renderToStaticMarkup(<CasePage results={results} home />)).not.toContain("Released cases");
  });
});

describe("release sets that are refused", () => {
  it(`more than ${String(MAX_RELEASES)} entries, naming the count, before any of them is read`, async () => {
    const dir = copyRelease();
    for (let index = 1; index <= MAX_RELEASES; index += 1) mkdirSync(releaseDir(dir, `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
    const error = await refusal(dir);
    expect(error.code).toBe("release_invalid");
    expect(error.message).toBe(`release_invalid: releases/ holds ${String(MAX_RELEASES + 1)} entries; at most ${String(MAX_RELEASES)} releases are supported`);
  });

  it(`exactly ${String(MAX_RELEASES)} entries pass the count and are each checked, naming the first invalid one`, async () => {
    const dir = copyRelease();
    for (let index = 1; index < MAX_RELEASES; index += 1) mkdirSync(releaseDir(dir, `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
    const error = await refusal(dir);
    expect(error.message).toBe("release_invalid: releases/00000000-0000-4000-8000-000000000001 has no release.json");
  });

  it("two releases of one run, naming both", async () => {
    const dir = copyRelease();
    addRelease(dir, { releaseId: RACE_RELEASE_ID, root: RELEASE_ROOT, createdAt: RACE_RELEASE_CREATED });
    const error = await refusal(dir);
    expect(error.code).toBe("release_invalid");
    expect(error.message).toBe(`release_invalid: releases/${RELEASE_ID} and releases/${RACE_RELEASE_ID} both name runs/${RELEASE_ROOT}`);
  });

  it("an invalid release beside a valid one, naming it", async () => {
    const { dir } = twoReleases();
    writeFile(join(releaseDir(dir, RACE_RELEASE_ID), "issue.json"), encodeCanonical({ synthetic: true }));
    const error = await refusal(dir);
    expect(error.message).toBe(`release_invalid: releases/${RACE_RELEASE_ID}/issue.json differs from its release entry`);
  });
});
