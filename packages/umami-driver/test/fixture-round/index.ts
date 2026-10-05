// One round's fixture output for the driver's tests: the outcome and response files come from the
// real fixture package's writer (writeObservation), and the Playwright report is a canned one, so
// rounds can be tested without Playwright or an app.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeObservation } from "@rbw/umami-fixture";
import { playwrightReport } from "../helpers.ts";
import type { CannedTest } from "../helpers.ts";

const RESPONSES_DIR = join(dirname(fileURLToPath(import.meta.url)), "responses");

/** What one check does in one round. */
export type RoundCheck =
  | "pass"
  | "assertion_fail"
  | "setup_fail"
  | "skipped"
  | "no_outcome"
  | "contradict"
  | "bad_response_hash"
  | "no_response";

export function cannedResponse(checkId: string): Buffer {
  return readFileSync(join(RESPONSES_DIR, `${checkId}.json`));
}

/** Writes one round's fixture output for the given checks into an existing empty directory. */
export function writeRound(outputDir: string, repeatIndex: number, checks: Readonly<Record<string, RoundCheck>>): void {
  const tests: CannedTest[] = [];
  for (const [checkId, behaviour] of Object.entries(checks)) {
    const observed =
      behaviour === "contradict" ? "assertion_fail" : behaviour === "assertion_fail" || behaviour === "setup_fail" ? behaviour : "pass";
    // A contradicting outcome claims a failure for a test the report shows as passed.
    const result = behaviour === "skipped" ? "skipped" : observed === "pass" || behaviour === "contradict" ? "passed" : "failed";
    tests.push({ id: `synthetic-${checkId}`, file: "tzarg.check.ts", title: checkId, result, duration: 25 });
    if (behaviour === "skipped" || behaviour === "no_outcome") continue;
    writeObservation(outputDir, {
      check_id: checkId,
      repeat_index: repeatIndex,
      observed,
      failure_code: observed === "assertion_fail" ? "local_day_counts_mismatch" : observed === "setup_fail" ? "auth_failed" : null,
      duration_ms: 25,
      response_body: cannedResponse(checkId),
    });
    if (behaviour === "no_response") rmSync(join(outputDir, "responses", `${checkId}.json`));
    if (behaviour === "bad_response_hash") writeFileSync(join(outputDir, "responses", `${checkId}.json`), "{}");
  }
  writeFileSync(join(outputDir, "report.json"), playwrightReport(tests));
}
