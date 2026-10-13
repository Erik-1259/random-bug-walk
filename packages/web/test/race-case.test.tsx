// A race-family case: the run's generated/symptom.json is a RaceSymptom (@rbw/schema's synthetic
// fixture), and its admission used 11 copies, with no partial-fix or stub-fix copy.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCanonical } from "@rbw/schema";
import { CasePage, methodText } from "../src/components/case-page.tsx";
import { admissionCopies } from "../src/model.ts";
import { isRaceSymptom, readResults, ReleaseError } from "../src/release.ts";
import { addRunFile, cleanup, raceSymptomBytes, syntheticCase } from "./support/results.ts";

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

function raceCase(): ReturnType<typeof syntheticCase> {
  return syntheticCase(undefined, { symptom: raceSymptomBytes(), withoutProbes: true });
}

describe("reading a race-family run", () => {
  it("reads generated/symptom.json as a RaceSymptom and makes the run the case", async () => {
    const built = raceCase();
    const results = await readResults(built.dir);
    const symptom = results.caseRun?.symptom;
    if (symptom == null || !isRaceSymptom(symptom)) throw new Error("expected the race family's symptom");
    expect(symptom.symptom_kind).toBe("concurrent_double_acceptance");
    expect(symptom.expected).toEqual({ accepted: 1, refused: 1 });
    expect(symptom.observed).toEqual({ accepted: 2, refused: 0 });
  });

  it("refuses a race symptom that fails the RaceSymptom rules as symptom_invalid, not as an ObservedSymptom", async () => {
    const built = raceCase();
    const invalid = { ...(JSON.parse(Buffer.from(raceSymptomBytes()).toString("utf8")) as Record<string, unknown>), observed: { accepted: 1, refused: 1 } };
    addRunFile(built.dir, built.root, "generated/symptom.json", built.root, encodeCanonical(invalid));
    const error = await readResults(built.dir).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ReleaseError);
    expect((error as ReleaseError).code).toBe("symptom_invalid");
    expect((error as ReleaseError).message).toContain("RaceSymptom");
  });
});

describe("case page of a race-family run", () => {
  it("shows the two concurrent requests with their times and outcomes, and the expected and observed acceptances", async () => {
    const page = text(renderToStaticMarkup(<CasePage results={await readResults(raceCase().dir)} />));
    expect(page).toContain("Signed in from two browser tabs at once and entered the same unused backup code in both.");
    expect(page).toContain("2 requests sent at the same time overlapped for 86 ms. Expected 1 acceptance and 1 refusal; observed 2 acceptances and 0 refusals.");
    expect(page).toContain("2. Concurrent requests and expected and observed acceptances");
    expect(page).toContain("Request: POST /api/synthetic/verify");
    expect(page).toContain(
      "Concurrent requests, overlapping for 86 ms (times from the first request sent) Request Sent (ms) Answered (ms) HTTP status Outcome Error code request a 0 87 200 Accepted none request b 1 92 200 Accepted none",
    );
    expect(page).toContain("Outcomes of the concurrent requests Outcome Expected Observed Status Accepted 1 2 Differs Refused 1 0 Differs");
    expect(page).toContain("The same requests one after the other (2 requests)");
    expect(page).toContain("reuse after the first use finished 130 171 400 Refused synthetic-invalid-code");
    // The time-zone rendering is not used for a race case.
    expect(page).not.toContain("local-day counts");
    expect(page).not.toContain("Source timestamps");
  });

  it("counts the admission's copies from its records: 11 copies, with no negative-probe copies", async () => {
    const built = raceCase();
    const results = await readResults(built.dir);
    expect(admissionCopies(results.caseRun?.admission ?? null)).toEqual({ total: 11, breakdown: "1 clean, 5 fixed and 5 planted", probes: false });
    const page = text(renderToStaticMarkup(<CasePage results={results} />));
    expect(page).toContain("This case's admission used 11 fresh app copies: 1 clean, 5 fixed and 5 planted.");
    expect(page).toContain("passes in all 11 copies while the added checks pass on clean and fixed copies and fail as declared on planted copies.");
    expect(page).toContain("ADM-02 to ADM-06 cover this run's 11 fresh copies");
    expect(page).toContain("the negative probes (this run has no negative-probe copies)");
    expect(page).not.toContain("13 fresh");
    expect(page).not.toContain("all 13 copies");
  });

  it("counts a time-zone admission's 13 copies from its records, with the probes", async () => {
    const results = await readResults(syntheticCase().dir);
    const admission = results.caseRun?.admission ?? null;
    expect(admissionCopies(admission)).toEqual({ total: 13, breakdown: "1 clean, 5 fixed, 5 planted, 1 partial-fix and 1 stub-fix", probes: true });
    expect(methodText(admission)).toContain("This case's admission used 13 fresh app copies: 1 clean, 5 fixed, 5 planted, 1 partial-fix and 1 stub-fix.");
    expect(methodText(admission)).toContain("fail as declared on planted and probe copies.");
    expect(text(renderToStaticMarkup(<CasePage results={results} />))).not.toContain("no negative-probe copies");
  });
});
