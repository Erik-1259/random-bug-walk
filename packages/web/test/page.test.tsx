import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Catalog } from "../src/components/catalog.tsx";
import { CasePage } from "../src/components/case-page.tsx";
import { funnel, NO_VALIDATED_RESULT, REPLAY_STATE, REPLAY_STATE_TEXT, suiteMatrix } from "../src/model.ts";
import { readResults } from "../src/release.ts";
import { AKL, LA } from "../../../packages/admission/test/support/record-set.ts";
import { observe, testOutcome } from "../../../packages/admission/test/support/record-set.ts";
import { cleanup, DEVELOPMENT, DEVELOPMENT_ROOT, NO_RELEASE, syntheticCase } from "./support/results.ts";

afterEach(cleanup);

/** The page's text with tags removed and whitespace collapsed, for reading order and wording. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function cellOrder(html: string): string[] {
  return [...html.matchAll(/data-cell="(\d)"/g)].map((match) => match[1] ?? "");
}

/** The text of each suite-matrix cell, keyed by row and column. */
function matrixText(html: string): Record<string, string> {
  const cells: Record<string, string> = {};
  for (const match of html.matchAll(/<td data-row="(\w+)" data-column="(\w+)"[^>]*>(.*?)<\/td>/g)) cells[`${match[1] ?? ""}/${match[2] ?? ""}`] = text(match[3] ?? "");
  return cells;
}

describe("case page from the development fixture", () => {
  it("renders the six cells in the fixed order", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(DEVELOPMENT)} />);
    expect(cellOrder(html)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("says that no validated example exists and labels the case as development evidence", async () => {
    const page = text(renderToStaticMarkup(<CasePage results={await readResults(DEVELOPMENT)} />));
    expect(page).toContain(NO_VALIDATED_RESULT);
    expect(page).toContain("Development evidence, not validated");
    expect(page).toContain("Synthetic task: the bug in this case was planted on purpose");
  });

  it("shows the symptom and the expected and observed local-day counts with their source timestamps", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(DEVELOPMENT)} />);
    const page = text(html);
    expect(page).toContain("Requested the daily pageview counts for one website from March 7 to March 9, 2026");
    expect(page).toContain("Observed counts differ from the expected local-day counts in 3 of 3 time zones");
    expect(page).toMatch(/America\/Los_Angeles .*2026-03-07T00:00:00Z 3 2 Differs 2026-03-08T00:00:00Z 8 8 Matches 2026-03-09T00:00:00Z 1 2 Differs/);
    expect(page).toMatch(/Pacific\/Auckland .*2026-03-07T00:00:00Z 1 2 Differs/);
    expect(page).toContain("Source timestamps (12 pageviews)");
    expect(page).toContain("pageview 1 2026-03-07T10:59:00Z 1772881140");
  });

  it("shows every matrix cell with its labels and a text status when the run has no admission records", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(DEVELOPMENT)} />);
    const cells = matrixText(html);
    expect(Object.keys(cells)).toEqual(["original/clean", "original/planted", "original/fixed", "added/clean", "added/planted", "added/fixed"]);
    expect(cells["original/planted"]).toBe("Original API suite, planted copy No record in this run");
    expect(cells["added/fixed"]).toBe("Added checks, fixed copy No record in this run");
    expect(text(html)).toContain("Original Umami API suite");
  });

  it("disables replay and validated downloads, and keeps the diagnostic archive available", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(DEVELOPMENT)} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Run verified replay<\/button>/);
    const page = text(html);
    expect(page).toContain(`Replay status: ${REPLAY_STATE_TEXT.disabled}`);
    expect(page).toContain("Validated-task downloads: disabled, because there is no validated release");
    expect(page).toContain("Diagnostic archive (not validated)");
    expect(html).toContain(`href="/runs/${DEVELOPMENT_ROOT}/report.md"`);
    expect(html).toContain(`href="/runs/${DEVELOPMENT_ROOT}/manifest.json"`);
  });

  it("reports calibration as not requested and names what is not in the published records", async () => {
    const page = text(renderToStaticMarkup(<CasePage results={await readResults(DEVELOPMENT)} />));
    expect(page).toContain("Calibration Not requested");
    expect(page).not.toMatch(/\b0 solves\b/);
    expect(page).toContain("Task revision Not in this run's published records");
    expect(page).toContain("Release None. The release step (ADM-09) is planned.");
  });
});

describe("case page with admission records", () => {
  it("shows the six cells' observed states and whether each matches its expectation", async () => {
    const built = syntheticCase();
    const cells = matrixText(renderToStaticMarkup(<CasePage results={await readResults(built.dir)} />));
    expect(cells["original/clean"]).toBe("Original API suite, clean copy Pass, as expected 3 of 3 executed");
    expect(cells["original/planted"]).toBe("Original API suite, planted copy Pass, as expected 3 of 3 executed");
    expect(cells["added/clean"]).toBe("Added checks, clean copy Pass, as expected 4 of 4 executed");
    expect(cells["added/planted"]).toMatch(/^Added checks, planted copy Fail, as expected 80 of 80 executed; 60 failing results: tzarg\.auckland-day-counts, tzarg\.kolkata-day-counts, tzarg\.la-day-counts$/);
    expect(cells["added/fixed"]).toBe("Added checks, fixed copy Pass, as expected 80 of 80 executed");
  });

  it("marks a cell that differs from its expectation in text", async () => {
    const built = syntheticCase((draft) => {
      testOutcome(draft, "planted-01", "synthetic-spec-0002", "failed");
      observe(draft, "fixed-01", LA, 3, "assertion_fail", "local_day_counts_mismatch");
    });
    const html = renderToStaticMarkup(<CasePage results={await readResults(built.dir)} />);
    const cells = matrixText(html);
    expect(cells["original/planted"]).toBe("Original API suite, planted copy Fail, not as expected 3 of 3 executed; 1 failing result: synthetic-spec-0002");
    expect(cells["added/fixed"]).toBe("Added checks, fixed copy Fail, not as expected 80 of 80 executed; 1 failing result: tzarg.la-day-counts");
    expect(html).toContain('class="status status-fail"');
  });

  it("names the measured original API suite with its test count and the comparison outcome", async () => {
    const built = syntheticCase();
    const page = text(renderToStaticMarkup(<CasePage results={await readResults(built.dir)} />));
    expect(page).toContain("Original Umami API suite (3 tests measured)");
    expect(page).toContain("Comparison (ADM-08): blind spot demonstrated");
    expect(page).toContain("Admission verdict (ADM-02 to ADM-06): pass");
    expect(page).toContain(NO_VALIDATED_RESULT);
  });

  it("counts the funnel from the records", async () => {
    const built = syntheticCase((draft) => {
      observe(draft, "planted-02", AKL, 1, "pass", null);
    });
    const results = await readResults(built.dir);
    expect(funnel(results).map((step) => [step.label, step.count])).toEqual([
      ["Runs recorded", 1],
      ["Runs finished", 1],
      ["Runs published", 1],
      ["Runs with an observed symptom", 1],
      ["Runs with an admission decision", 1],
      ["Admission verdict pass", 0],
      ["Blind spot demonstrated (ADM-08)", 0],
      ["Validated releases (ADM-09, planned)", 0],
    ]);
  });
});

describe("no-release state", () => {
  it("renders the six cells, says that no validated example exists and shows no case", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(NO_RELEASE)} />);
    expect(cellOrder(html)).toEqual(["1", "2", "3", "4", "5", "6"]);
    const page = text(html);
    expect(page).toContain(NO_VALIDATED_RESULT);
    expect(page).toContain("No published run holds an observed symptom yet.");
    expect(page).not.toContain("Development evidence, not validated");
  });

  it("disables replay and validated downloads, and links the diagnostic archives with their status", async () => {
    const results = await readResults(NO_RELEASE);
    expect(REPLAY_STATE).toEqual({ state: "disabled", reason: "There is no validated release to replay." });
    const html = renderToStaticMarkup(<CasePage results={results} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Run verified replay<\/button>/);
    const page = text(html);
    expect(page).toContain("Validated-task downloads: disabled, because there is no validated release");
    expect(page).toContain("00000000-0000-4000-8000-000000002001 failed, not validated");
    expect(page).toContain("00000000-0000-4000-8000-000000002003 incomplete, not validated");
    expect(html).toContain('href="/runs/00000000-0000-4000-8000-000000002001/manifest.json"');
  });

  it("shows the honest funnel, the limitations and the method", async () => {
    const results = await readResults(NO_RELEASE);
    expect(funnel(results).map((step) => step.count)).toEqual([3, 2, 2, 0, 0, 0, 0, 0]);
    const page = text(renderToStaticMarkup(<CasePage results={results} />));
    expect(page).toContain("Runs recorded 3");
    expect(page).toContain("Calibration: not requested");
    expect(page).toContain("13 fresh app copies");
  });

  it("has a text for every replay state", () => {
    expect(Object.keys(REPLAY_STATE_TEXT).sort()).toEqual(["disabled", "failed", "passed", "ready", "running", "starting"]);
    for (const value of Object.values(REPLAY_STATE_TEXT)) expect(value.length).toBeGreaterThan(0);
  });
});

describe("suite matrix", () => {
  it("has six cells in row and column order", () => {
    expect(suiteMatrix(null).map((cell) => `${cell.row}/${cell.column}/${cell.status}`)).toEqual([
      "original/clean/no_record",
      "original/planted/no_record",
      "original/fixed/no_record",
      "added/clean/no_record",
      "added/planted/no_record",
      "added/fixed/no_record",
    ]);
  });
});

describe("diagnostic catalog", () => {
  it("lists every run with its real status, including failed, incomplete and running runs", async () => {
    const html = renderToStaticMarkup(<Catalog results={await readResults(NO_RELEASE)} />);
    const page = text(html);
    expect(page).toContain("00000000-0000-4000-8000-000000002001 factory Terminal Failed Published");
    expect(page).toContain("00000000-0000-4000-8000-000000002003 factory Terminal Incomplete Published");
    expect(page).toContain("00000000-0000-4000-8000-000000002005 kit_check Running None yet Not published");
    expect(page).toContain("results/00000000-0000-4000-8000-000000002004/clean-01/trial-result.json Not produced (stage_failed)");
    expect(html).toContain('href="/runs/00000000-0000-4000-8000-000000002001/logs/00000000-0000-4000-8000-000000002002/run.log"');
  });

  it("lists the development run's files with their hashes", async () => {
    const page = text(renderToStaticMarkup(<Catalog results={await readResults(DEVELOPMENT)} />));
    expect(page).toContain(`${DEVELOPMENT_ROOT} factory Terminal Completed Published`);
    expect(page).toContain("generated/symptom.json Published 3441 bytes 1f0f71b985e1d4f7c336a51cb2371fad8ff0e1ac722c764dfc1d68668482cc7a");
  });
});
