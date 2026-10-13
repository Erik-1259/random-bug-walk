import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Catalog } from "../src/components/catalog.tsx";
import { CasePage } from "../src/components/case-page.tsx";
import { KNOWN_CONDITION_MESSAGE } from "@rbw/controller/judge-types";
import { ReplayPanel } from "../src/components/replay.tsx";
import { funnel, NO_VALIDATED_RESULT, REPLAY_STATE, REPLAY_STATE_HELP, REPLAY_STATE_TEXT, REPLAY_UNAVAILABLE_TEXT, suiteMatrix, VALIDATED_RESULT, type ReplayStatus } from "../src/model.ts";
import { readResults } from "../src/release.ts";
import { AKL, LA } from "../../../packages/admission/test/support/record-set.ts";
import { observe, testOutcome } from "../../../packages/admission/test/support/record-set.ts";
import { cleanup, DEVELOPMENT, DEVELOPMENT_ROOT, NO_RELEASE, RELEASE, RELEASE_ID, RELEASE_ROOT, syntheticCase } from "./support/results.ts";

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
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Plant and verify this example<\/button>/);
    const page = text(html);
    expect(page).toContain(`Replay status: ${REPLAY_STATE_TEXT.disabled}`);
    expect(page).toContain("Release files: none, because there is no validated release");
    expect(page).toContain("Diagnostic archive (not validated)");
    expect(html).toContain(`href="/runs/${DEVELOPMENT_ROOT}/report.md"`);
    expect(html).toContain(`href="/runs/${DEVELOPMENT_ROOT}/manifest.json"`);
  });

  it("reports calibration as not requested and names what is not in the published records", async () => {
    const page = text(renderToStaticMarkup(<CasePage results={await readResults(DEVELOPMENT)} />));
    expect(page).toContain("Calibration Not requested");
    expect(page).not.toMatch(/\b0 solves\b/);
    expect(page).toContain("Task revision Not in this run's published records");
    expect(page).toContain("Release None published yet.");
    expect(page).toContain("No release has been published yet, so no result here is validated.");
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
      ["Factory runs recorded", 1],
      ["Factory runs finished", 1],
      ["Factory runs published", 1],
      ["Factory runs with an observed symptom", 1],
      ["Factory runs with an admission decision", 1],
      ["Admission verdict pass", 0],
      ["Blind spot demonstrated (ADM-08)", 0],
      ["Validated releases (ADM-09)", 0],
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
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Plant and verify this example<\/button>/);
    const page = text(html);
    expect(page).toContain("Release files: none, because there is no validated release");
    expect(page).toContain("00000000-0000-4000-8000-000000002001 failed, not validated");
    expect(page).toContain("00000000-0000-4000-8000-000000002003 incomplete, not validated");
    expect(html).toContain('href="/runs/00000000-0000-4000-8000-000000002001/manifest.json"');
  });

  it("shows the honest funnel, the limitations and the method", async () => {
    const results = await readResults(NO_RELEASE);
    // The running kit check is not a factory run: it is counted apart.
    expect(funnel(results).map((step) => step.count)).toEqual([2, 2, 2, 0, 0, 0, 0, 0]);
    const page = text(renderToStaticMarkup(<CasePage results={results} />));
    expect(page).toContain("Factory runs recorded 2");
    expect(page).toContain("Runs counted apart from the factory funnel Verification replays (judge) 0 Kit checks 1");
    expect(page).not.toContain("A replay's published records");
    expect(page).toContain("Calibration: not requested");
    expect(page).toContain("13 fresh app copies");
  });

  it("has a text for every replay state", () => {
    expect(Object.keys(REPLAY_STATE_TEXT).sort()).toEqual(["disabled", "incomplete", "needs_reconciliation", "not_reproduced", "ready", "running", "starting", "unavailable", "unknown", "verified"]);
    for (const value of Object.values(REPLAY_STATE_TEXT)) expect(value.length).toBeGreaterThan(0);
  });
});

describe("case page with a published release", () => {
  it("names the validated example, labels the released case and keeps the six cells", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(RELEASE)} />);
    expect(cellOrder(html)).toEqual(["1", "2", "3", "4", "5", "6"]);
    const page = text(html);
    expect(page).toContain(VALIDATED_RESULT);
    expect(page).not.toContain(NO_VALIDATED_RESULT);
    expect(page).toContain("Validated release, synthetic planted bug");
    expect(page).not.toContain("Development evidence, not validated");
    expect(page).toContain("Synthetic task: the bug in this case was planted on purpose");
    expect(page).toContain("Comparison (ADM-08): blind spot demonstrated");
  });

  it("keeps replay disabled with the release's reason when the judge routes are not configured", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(RELEASE)} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Plant and verify this example<\/button>/);
    expect(text(html)).toContain(`Replay status: ${REPLAY_STATE_TEXT.disabled}. Verified replay is not enabled on this site.`);
    expect(text(html)).toContain(`Frozen release ${RELEASE_ID}, created 2026-10-06 Replay No replay in this browser yet.`);
    expect(html).not.toContain("judge-passcode");
  });

  it("offers the passcode field with the release when the judge routes are configured for it", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(RELEASE)} judgeEnabled />);
    expect(html).toContain('id="judge-passcode"');
    expect(html).toContain('type="password"');
    expect(text(html)).toContain(`Replay status: ${REPLAY_STATE_TEXT.ready}.`);
  });

  it("shows the release's provenance from its record", async () => {
    const results = await readResults(RELEASE);
    const page = text(renderToStaticMarkup(<CasePage results={results} />));
    const record = results.release?.record;
    expect(page).toContain(`Release ${RELEASE_ID} Release SHA-256 ${results.release?.sha256 ?? "none"} Release created 2026-10-06T11:38:10Z`);
    expect(page).toContain(`Run ${RELEASE_ROOT} (factory, completed)`);
    expect(page).toContain(`Publication ${record?.run.publication_id ?? "none"}`);
    expect(page).toContain(`Results repository commit ${record?.run.repository_commit ?? "none"}`);
    expect(page).toContain("Project policy SHA-256 7749aa26b966e375d324794cc65e7e6ee5b978f83844d30dc283d930fb160c2e Policy umami-uc3-v1");
    expect(page).toContain("Task revision 274265fba006f23e1efc2aee9ac773557894da6f34fd5f4cab29d8d659d66107");
    expect(page).toContain(`Admission's provisional task revision ${results.caseRun?.admission?.evidence.request.task_revision ?? "none"}`);
    expect(page).toContain("Kit version 1390cb9fe50f0189e52d6e35b11eac9860ccaf77b8d1ae2ca94daf85e9fde71e");
    expect(page).toContain(`Kit image ${record?.images.kit_image ?? "none"} Controller image ${record?.images.controller_image ?? "none"}`);
    expect(page).toContain("Family synthetic-family-1 (public_demo), source fix synthetic-upstream at aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(page).toContain("Human check (ADM-07) Approved on 2026-10-14");
    expect(page).toContain("Calibration Not requested");
    expect(page).not.toContain(record?.judge_job.index_sha256 ?? "none");
  });

  it("links the release's files and the released run's files, and no other archive", async () => {
    const html = renderToStaticMarkup(<CasePage results={await readResults(RELEASE)} />);
    for (const path of ["release.json", "issue.json", "issue-check.json", "recordings/card-1.recording.json", "recordings/issue-1.recording.json"]) {
      expect(html).toContain(`href="/releases/${RELEASE_ID}/${path}"`);
    }
    expect(html).toContain(`href="/runs/${RELEASE_ROOT}/manifest.json"`);
    expect(html).toContain(`href="/runs/${RELEASE_ROOT}/report.md"`);
    const page = text(html);
    expect(page).not.toContain("Release files: none");
    expect(page).toContain("Diagnostic archive (not validated) No other published runs.");
    expect(page).not.toContain(`${RELEASE_ROOT} completed, not validated`);
  });

  it("counts the release in the funnel and names the human check in the limitations", async () => {
    const results = await readResults(RELEASE);
    expect(funnel(results).at(-1)).toEqual({ label: "Validated releases (ADM-09)", count: 1 });
    const page = text(renderToStaticMarkup(<CasePage results={results} />));
    expect(page).toContain("Validated releases (ADM-09) 1");
    expect(page).toContain("A human check (ADM-07) approved this issue, and one release (ADM-09) was published.");
    expect(page).not.toContain("No release has been published yet");
    expect(page).toContain("A verified replay is open only to judges with the passcode, one replay at a time");
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
    expect(page).toContain("00000000-0000-4000-8000-000000002001 Factory run Terminal Failed Published");
    expect(page).toContain("00000000-0000-4000-8000-000000002003 Factory run Terminal Incomplete Published");
    expect(page).toContain("00000000-0000-4000-8000-000000002005 Kit check Running None yet Not published");
    expect(page).toContain("results/00000000-0000-4000-8000-000000002004/clean-01/trial-result.json Not produced (stage_failed)");
    expect(html).toContain('href="/runs/00000000-0000-4000-8000-000000002001/logs/00000000-0000-4000-8000-000000002002/run.log"');
  });

  it("marks the released run and says which run is the validated release", async () => {
    const page = text(renderToStaticMarkup(<Catalog results={await readResults(RELEASE)} />));
    expect(page).toContain(`Run ${RELEASE_ROOT} is validated release ${RELEASE_ID}; the other factory runs are not validated.`);
    expect(page).toContain(`${RELEASE_ROOT} Validated release ${RELEASE_ID} Factory run Terminal Completed Published`);
  });

  it("says that no run is a validated release without one", async () => {
    const page = text(renderToStaticMarkup(<Catalog results={await readResults(NO_RELEASE)} />));
    expect(page).toContain("None of them is a validated release.");
    expect(page).not.toContain("Validated release ");
  });

  it("lists the development run's files with their hashes", async () => {
    const page = text(renderToStaticMarkup(<Catalog results={await readResults(DEVELOPMENT)} />));
    expect(page).toContain(`${DEVELOPMENT_ROOT} Factory run Terminal Completed Published`);
    expect(page).toContain("generated/symptom.json Published 3441 bytes 1f0f71b985e1d4f7c336a51cb2371fad8ff0e1ac722c764dfc1d68668482cc7a");
  });
});

describe("the replay cell", () => {
  const release = { release_id: RELEASE_ID, created_at: "2026-10-06T11:38:10Z" };
  function status(state: ReplayStatus["state"], known: boolean, failing: string[]): ReplayStatus {
    return {
      state,
      request_id: "00000000-0000-4000-8000-00000000d001",
      message: known ? KNOWN_CONDITION_MESSAGE : REPLAY_STATE_TEXT[state],
      known_condition: known,
      release_id: RELEASE_ID,
      release_created_at: release.created_at,
      created_at: "2026-12-03T10:00:00Z",
      ended_at: "2026-12-03T10:21:05Z",
      elapsed_seconds: 1265,
      hard_cap_seconds: 2100,
      copies: ["clean-01", "planted-01", "fixed-01"].map((trial_id) => ({ trial_id, status: "done", started_at: "2026-12-03T10:02:00Z" })),
      cells: (["clean-01", "planted-01", "fixed-01"] as const).flatMap((trial_id) => [
        { suite: "original" as const, trial_id, state: failing.length > 0 ? "fail" : "pass", matches_expectation: failing.length === 0, executed_count: 3, expected_count: 3, failing: failing.map((id) => ({ id, repeat_index: null, failure_code: null })) },
        { suite: "added" as const, trial_id, state: trial_id === "planted-01" ? "fail" : "pass", matches_expectation: true, executed_count: 4, expected_count: 4, failing: [] },
      ]),
    };
  }

  it("shows a verified replay beside the frozen release, with both dates, the known condition, the duration apart from the hard cap and its cells", () => {
    const page = text(renderToStaticMarkup(<ReplayPanel release={release} state="verified" reason="" status={status("verified", true, ["synthetic-spec-0001", "synthetic-spec-0002"])} />));
    expect(page).toContain(`Frozen release ${RELEASE_ID}, created 2026-10-06 Replay Started 2026-12-03`);
    expect(page).toContain(`Replay status: ${REPLAY_STATE_TEXT.verified}. ${KNOWN_CONDITION_MESSAGE}`);
    expect(page).toContain("Measured duration: 21 min 5 s. Hard cap: 35 minutes.");
    expect(page).toContain("clean copy: done planted copy: done fixed copy: done");
    expect(page).toContain("Original API suite, clean copy fail, not as expected 3 of 3 executed; failing: synthetic-spec-0001, synthetic-spec-0002");
  });

  it("shows a not_reproduced replay in text", () => {
    const page = text(renderToStaticMarkup(<ReplayPanel release={release} state="not_reproduced" reason="" status={status("not_reproduced", false, ["synthetic-spec-0003"])} />));
    expect(page).toContain(`Frozen release ${RELEASE_ID}, created 2026-10-06 Replay Started 2026-12-03`);
    expect(page).toContain(`Replay status: ${REPLAY_STATE_TEXT.not_reproduced}.`);
    expect(page).not.toContain(KNOWN_CONDITION_MESSAGE);
  });

  it("shows a disabled replay with the release's date and no replay date", () => {
    const page = text(renderToStaticMarkup(<ReplayPanel release={release} state="disabled" reason="Verified replay is not enabled on this site." status={null} />));
    expect(page).toContain(`Frozen release ${RELEASE_ID}, created 2026-10-06 Replay No replay in this browser yet.`);
    expect(page).toContain(`Replay status: ${REPLAY_STATE_TEXT.disabled}. Verified replay is not enabled on this site.`);
  });

  it("explains every terminal and uncertain state in plain text", () => {
    for (const state of ["not_reproduced", "incomplete", "needs_reconciliation", "unknown"] as const) {
      const help = REPLAY_STATE_HELP[state];
      expect(help?.length ?? 0).toBeGreaterThan(20);
      const page = text(renderToStaticMarkup(<ReplayPanel release={release} state={state} reason="" status={status(state, false, [])} />));
      expect(page).toContain(`Replay status: ${REPLAY_STATE_TEXT[state]}.`);
      expect(page).toContain(help ?? "none");
    }
    const reconciliation = text(renderToStaticMarkup(<ReplayPanel release={release} state="needs_reconciliation" reason="" status={status("needs_reconciliation", false, [])} />));
    expect(reconciliation).toContain("The operator checks the spend ledger");
    expect(reconciliation).toContain("try again later");
  });

  it("shows each unavailable reason's text, even over an earlier replay's status", () => {
    expect(Object.keys(REPLAY_UNAVAILABLE_TEXT).sort()).toEqual(["budget", "busy", "error", "halted", "held", "ledger", "release", "token"]);
    for (const message of Object.values(REPLAY_UNAVAILABLE_TEXT)) {
      expect(message).toMatch(/\.$/);
      for (const earlier of [null, status("verified", false, [])]) {
        const page = text(renderToStaticMarkup(<ReplayPanel release={release} state="unavailable" reason={message} status={earlier} />));
        expect(page).toContain(`Replay status: ${REPLAY_STATE_TEXT.unavailable}. ${message}`);
      }
    }
    expect(REPLAY_UNAVAILABLE_TEXT.held).toContain("the operator");
  });
});
