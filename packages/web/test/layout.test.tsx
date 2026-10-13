// The case page's layout: per-run file summaries instead of inline file lists, the run file index
// page, the opening paragraph, the replay's labeled six cells and the clarity notes.
import { cpSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ADMISSION_RULES, CasePage, CODE_REPOSITORY, funnelScope, notValidatedReason, RESULTS_REPOSITORY, UMAMI_REPOSITORY } from "../src/components/case-page.tsx";
import { ReplayPanel } from "../src/components/replay.tsx";
import { RunIndex } from "../src/components/run-index.tsx";
import { formatBytes, runFileSummary } from "../src/files.ts";
import type { ReplayStatus } from "../src/model.ts";
import { readResults } from "../src/release.ts";
import { addRunFile, cleanup, copyFixture, copyRelease, DEVELOPMENT, DEVELOPMENT_ROOT, NO_RELEASE, RELEASE, RELEASE_ID, RELEASE_ROOT, runDir, syntheticCase } from "./support/results.ts";

afterEach(cleanup);

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([,.:;])/g, "$1")
    .trim();
}

/** The development fixture with 40 more published files in its run. */
function manyFiles(): string {
  const dir = copyFixture(DEVELOPMENT);
  for (let index = 0; index < 40; index += 1) {
    addRunFile(dir, DEVELOPMENT_ROOT, `logs/synthetic-${String(index).padStart(2, "0")}.log`, DEVELOPMENT_ROOT, new TextEncoder().encode(`synthetic log ${String(index)}\n`));
  }
  return dir;
}

describe("the case page's file summaries", () => {
  it("summarizes each run's files and links its index page instead of listing every file", async () => {
    const results = await readResults(manyFiles());
    const run = results.caseRun;
    const summary = run === null ? null : runFileSummary(run);
    const html = renderToStaticMarkup(<CasePage results={results} />);
    expect(html).not.toContain("synthetic-00.log");
    expect(html).not.toContain("synthetic-39.log");
    expect(html).not.toContain(`href="/runs/${DEVELOPMENT_ROOT}/generated/symptom.json"`);
    expect(html).toContain(`href="/runs/${DEVELOPMENT_ROOT}"`);
    expect(html).toContain(`href="/runs/${DEVELOPMENT_ROOT}/manifest.json"`);
    expect(html).toContain(`href="/runs/${DEVELOPMENT_ROOT}/report.md"`);
    expect(summary?.count).toBe((run?.manifest?.entries.length ?? 0) - (run?.manifest?.entries.filter((entry) => entry.outcome !== "published" && entry.outcome !== "truncated").length ?? 0));
    expect(text(html)).toContain(`${String(summary?.count)} published files, ${formatBytes(summary?.bytes ?? 0)} in all, plus the manifest: manifest.json, report.md, every file of this run.`);
  });

  it("links the released run's index page and keeps the release's files inline under Release files", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(RELEASE)} />);
    const page = text(html);
    expect(page).toContain("Release files release.json");
    expect(page).not.toContain("Validated-task downloads");
    expect(html).toContain(`href="/runs/${RELEASE_ROOT}"`);
    expect(html).toContain(`href="/releases/${RELEASE_ID}/issue.json"`);
  });

  it("writes byte counts in decimal units", () => {
    expect(formatBytes(999)).toBe("999 bytes");
    expect(formatBytes(1000)).toBe("1.0 kB");
    expect(formatBytes(13_648_087)).toBe("13.6 MB");
    expect(formatBytes(2_500_000_000)).toBe("2.5 GB");
  });
});

describe("the run file index page", () => {
  it("lists every manifest entry of the run with a link to each file the site serves", async () => {
    const results = await readResults(manyFiles());
    const run = results.runs.find((item) => item.rootExecutionId === DEVELOPMENT_ROOT);
    if (run?.manifest == null) throw new Error("synthetic: the development run is missing");
    const html = renderToStaticMarkup(<RunIndex results={results} run={run} />);
    for (const entry of run.manifest.entries) expect(html).toContain(`href="/runs/${DEVELOPMENT_ROOT}/${entry.path}"`);
    expect(html).toContain(`href="/runs/${DEVELOPMENT_ROOT}/manifest.json"`);
    expect(html).not.toContain(`href="/runs/${DEVELOPMENT_ROOT}"`);
    const page = text(html);
    expect(page).toContain(`Files of run ${DEVELOPMENT_ROOT}`);
    expect(page).toContain("Diagnostic archive, not validated");
    expect(page).toContain("logs/synthetic-39.log Published 17 bytes");
    // Stacked on a phone, each cell shows its column's label; the headers stay for screen readers.
    expect(html).toContain('<td data-label="Outcome">Published');
    expect(html).toContain('<td data-label="Size">17 bytes</td>');
    expect(html).toContain('data-label="SHA-256" class="hash"');
    expect(html).toContain('<th scope="col">SHA-256</th>');
  });

  it("labels the released run and shows entries that were not produced", async () => {
    const release = await readResults(RELEASE);
    const released = release.runs.find((item) => item.rootExecutionId === RELEASE_ROOT);
    if (released === undefined) throw new Error("synthetic: the released run is missing");
    expect(text(renderToStaticMarkup(<RunIndex results={release} run={released} />))).toContain(`Validated release ${RELEASE_ID}`);
    const diagnostic = await readResults(NO_RELEASE);
    const failed = diagnostic.runs.find((item) => item.rootExecutionId === "00000000-0000-4000-8000-000000002003");
    if (failed === undefined) throw new Error("synthetic: the incomplete run is missing");
    expect(text(renderToStaticMarkup(<RunIndex results={diagnostic} run={failed} />))).toContain("Not produced (stage_failed)");
  });
});

describe("orientation and clarity", () => {
  it("opens with what a blind-spot example is and links the code, the results and Umami", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(NO_RELEASE)} />);
    for (const href of [CODE_REPOSITORY, RESULTS_REPOSITORY, UMAMI_REPOSITORY]) expect(html).toContain(`href="${href}"`);
    const page = text(html);
    expect(page.indexOf("A blind-spot example is a bug planted on purpose in a pinned copy of Umami")).toBeLessThan(page.indexOf("1. Symptom"));
    expect(page).toContain("that Umami's own original API test suite does not catch, while added checks do");
    expect(page).toContain("Vercel Sandbox");
    expect(page).toContain("Nebius Token Factory");
  });

  it("explains the rule codes next to the matrix and links the admission rules", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(syntheticCase().dir)} />);
    expect(html).toContain(`href="${ADMISSION_RULES}"`);
    const page = text(html);
    const matrix = page.indexOf("Original Umami API suite");
    const codes = page.indexOf("Rule codes refer to the admission rules: ADM-02 to ADM-06");
    expect(codes).toBeGreaterThan(matrix);
    expect(codes).toBeLessThan(page.indexOf("4. Verified replay"));
    expect(page.indexOf("20 times each in the first planted and the first fixed copy")).toBeGreaterThan(matrix);
    expect(page.indexOf("20 times each in the first planted and the first fixed copy")).toBeLessThan(page.indexOf("4. Verified replay"));
  });

  it("says why another run whose admission passed is not validated", async () => {
    const dir = copyRelease();
    const other = syntheticCase();
    cpSync(runDir(other.dir, other.root), join(dir, "repository", "runs", other.root), { recursive: true });
    const results = await readResults(dir);
    const run = results.runs.find((item) => item.rootExecutionId === other.root);
    if (run === undefined) throw new Error("synthetic: the second run is missing");
    const reason = notValidatedReason(results, run);
    expect(reason).toBe(`Its admission also passed with a blind spot demonstrated, but no release names it: the one published release is for run ${RELEASE_ROOT}, whose issue passed the human check (ADM-07).`);
    expect(text(renderToStaticMarkup(<CasePage results={results} />))).toContain(`${other.root} completed, not validated ${reason ?? "none"}`);
    const released = results.runs.find((item) => item.rootExecutionId === RELEASE_ROOT);
    expect(released === undefined ? "missing" : notValidatedReason(results, released)).toBeNull();
    expect(notValidatedReason(await readResults(other.dir), run)).toBeNull();
  });

  it("says the funnel counts only the factory runs published here", async () => {
    const release = await readResults(RELEASE);
    expect(funnelScope(release)).toBe(
      "It counts only the factory runs in this site's results repository and its public store; judge replays and kit checks are counted apart below. Failed and incomplete factory attempts are not published here, so it is not a record of every attempt.",
    );
    expect(text(renderToStaticMarkup(<CasePage results={release} />))).toContain(`Validated releases (ADM-09) 1 ${funnelScope(release)}`);
    expect(funnelScope(await readResults(NO_RELEASE))).toBe(
      "It counts only the factory runs in this site's results repository and its public store; judge replays and kit checks are counted apart below. Attempts that were not published here are not counted, so it is not a record of every attempt.",
    );
  });
});

describe("the replay's six cells", () => {
  const status: ReplayStatus = {
    state: "verified",
    request_id: "00000000-0000-4000-8000-00000000d001",
    message: "synthetic",
    known_condition: false,
    release_id: RELEASE_ID,
    release_created_at: "2026-10-06T11:38:10Z",
    created_at: "2026-12-03T10:00:00Z",
    ended_at: "2026-12-03T10:21:05Z",
    elapsed_seconds: 1265,
    hard_cap_seconds: 2100,
    copies: [],
    cells: (["clean-01", "planted-01"] as const).flatMap((trial_id) => [
      { suite: "original" as const, trial_id, state: "pass", matches_expectation: true, executed_count: 3, expected_count: 3, failing: [] },
      { suite: "added" as const, trial_id, state: trial_id === "planted-01" ? "fail" : "pass", matches_expectation: true, executed_count: 4, expected_count: 4, failing: [] },
    ]),
  };

  it("labels the columns and gives every cell its row and column label for narrow screens", () => {
    const html = renderToStaticMarkup(<ReplayPanel release={{ release_id: RELEASE_ID, created_at: status.release_created_at }} state="verified" reason="" status={status} />);
    expect(html).toMatch(/<thead><tr><td><\/td><th scope="col">clean copy<\/th><th scope="col">planted copy<\/th><th scope="col">fixed copy<\/th><\/tr><\/thead>/);
    const cells = [...html.matchAll(/<td data-replay-row="(\w+)" data-replay-column="(\w+)">(.*?)<\/td>/g)].map((match) => `${match[1] ?? ""}/${match[2] ?? ""}: ${text(match[3] ?? "")}`);
    expect(cells).toEqual([
      "original/clean: Original API suite, clean copy pass, as expected 3 of 3 executed",
      "original/planted: Original API suite, planted copy pass, as expected 3 of 3 executed",
      "original/fixed: Original API suite, fixed copy No record",
      "added/clean: Added checks, clean copy pass, as expected 4 of 4 executed",
      "added/planted: Added checks, planted copy fail, as expected 4 of 4 executed",
      "added/fixed: Added checks, fixed copy No record",
    ]);
    expect(html).toContain('class="matrix"');
  });

  it("announces status changes to screen readers", () => {
    const html = renderToStaticMarkup(<ReplayPanel release={null} state="disabled" reason="synthetic" status={null} />);
    expect(html).toMatch(/<p id="replay-status" class="status status-replay-disabled" role="status" aria-live="polite">/);
  });
});
