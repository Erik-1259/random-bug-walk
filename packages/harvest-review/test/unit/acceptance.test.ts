import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCEPTANCE_CASES, acceptanceInputs, parseCases } from "../../src/acceptance.ts";
import { runCommand } from "../../src/commands.ts";
import { candidateKey } from "../../src/review.ts";
import { RATES, SLOT, commandOptions, freshSpend, openDb, replayFetch, spySpend, tempDir } from "../support.ts";
import type { Spy } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

function acceptanceArgs(out: string, cases: string): string[] {
  return ["acceptance", "--rate-sheet", RATES, "--out", out, "--slot-key", SLOT, "--pool", "development", "--cases", cases];
}

async function runCases(cases: string): Promise<{ code: number; spy: Spy; out: string; text: string }> {
  const spy = spySpend(await freshSpend(db));
  const out = join(tempDir(), "acceptance");
  const output: string[] = [];
  const code = await runCommand(commandOptions(acceptanceArgs(out, cases), spy.spend, await replayFetch(), output));
  return { code, spy, out, text: output.join("") };
}

interface Report {
  cases: { case: string; expected: string; ast_grep: string; votes: Record<string, string>; passed: Record<string, boolean> }[];
  models: Record<string, { passed: string[]; failed: string[] }>;
}

describe("the acceptance set", () => {
  it("holds three positives and seven negatives, each a review-inputs entry", () => {
    expect(ACCEPTANCE_CASES.map((entry) => [entry.name, entry.expected])).toEqual([
      ["umami-style-fix", "yes"],
      ["options-user-timezone", "yes"],
      ["member-filters-timezone", "yes"],
      ["not-a-date-operation", "not_yes"],
      ["timezone-offset", "not_yes"],
      ["utc-as-const", "not_yes"],
      ["shadowing-inner-utc", "not_yes"],
      ["replaced-call", "not_yes"],
      ["moved-to-sibling-callback", "not_yes"],
      ["runtime-zone-guess", "not_yes"],
    ]);
    const inputs = acceptanceInputs();
    expect(inputs.candidates).toHaveLength(10);
    const sibling = inputs.candidates.find((entry) => entry.candidate_id.endsWith("moved-to-sibling-callback"));
    expect(sibling?.function).toBe("renderRows/<anonymous>");
    expect(sibling?.before).toHaveLength(2);
    const byName: Record<string, string> = Object.fromEntries(inputs.candidates.map((entry) => [entry.candidate_id.split("/")[1] ?? "", entry.ast_grep]));
    expect(byName).toMatchObject({
      "umami-style-fix": "confirmed",
      "utc-as-const": "confirmed",
      "shadowing-inner-utc": "confirmed",
      "moved-to-sibling-callback": "confirmed",
      "not-a-date-operation": "no_rule_match_on_added_line",
      "timezone-offset": "no_rule_match_on_added_line",
      "replaced-call": "call_added",
      "runtime-zone-guess": "timezone_is_constant",
    });
  });

  it("runs cases 6-10 through review and reports, per model, which of them passed", async () => {
    const { code, spy, out, text } = await runCases("6-10");
    // One synthetic recording has Kimi vote yes on a negative case, so these cases do not pass.
    expect(code).toBe(1);
    expect(spy.reserves).toHaveLength(10);
    const report = JSON.parse(readFileSync(join(out, "acceptance.json"), "utf8")) as Report;
    expect(report.models.super).toEqual({ passed: ACCEPTANCE_CASES.slice(5).map((entry) => entry.name), failed: [] });
    expect(report.models.kimi?.failed).toEqual(["runtime-zone-guess"]);
    expect(report.models.kimi?.passed).toHaveLength(4);
    expect(report.cases.find((entry) => entry.case === "runtime-zone-guess")).toMatchObject({
      expected: "not_yes",
      votes: { super: "no", kimi: "yes" },
      passed: { super: true, kimi: false },
    });
    expect(text).toContain("super: 5 of 5 passed");
    expect(text).toContain("kimi: 4 of 5 passed; failed: runtime-zone-guess");
    expect(JSON.parse(readFileSync(join(out, "review.json"), "utf8"))).toHaveProperty("counts");
  });

  it("runs exactly cases 1-5 with --cases 1-5 and reports only those", async () => {
    const { code, spy, out, text } = await runCases("1-5");
    expect(code).toBe(0);
    const firstFive = ACCEPTANCE_CASES.slice(0, 5).map((entry) => entry.name);
    expect(spy.reserves.map((r) => r.call_name)).toEqual(
      acceptanceInputs()
        .candidates.slice(0, 5)
        .flatMap((entry) => [1, 2].map((ordinal) => `harvest.review:${candidateKey(entry.candidate_id, entry.commit)}:${String(ordinal)}`)),
    );
    const report = JSON.parse(readFileSync(join(out, "acceptance.json"), "utf8")) as Report;
    expect(report.cases.map((entry) => entry.case)).toEqual(firstFive);
    expect(report.models.super).toEqual({ passed: firstFive, failed: [] });
    expect(report.models.kimi).toEqual({ passed: firstFive, failed: [] });
    expect(text).toContain("super: 5 of 5 passed");
  });

  it("reads --cases as a range or a comma list, and refuses a missing, out-of-range or over-cap selection", async () => {
    expect(parseCases("1-5")).toEqual([0, 1, 2, 3, 4]);
    expect(parseCases("6-10")).toEqual([5, 6, 7, 8, 9]);
    expect(parseCases("2,4,10")).toEqual([1, 3, 9]);
    for (const bad of [undefined, "", "0-3", "5-11", "4-2", "1,1", "1-9", "a", "1-", "3,"]) {
      expect(parseCases(bad)).toBeNull();
    }
    const spy = spySpend(await freshSpend(db));
    const output: string[] = [];
    const args = ["acceptance", "--rate-sheet", RATES, "--out", join(tempDir(), "acceptance"), "--slot-key", SLOT, "--pool", "development"];
    expect(await runCommand(commandOptions(args, spy.spend, await replayFetch(), output))).toBe(2);
    expect(output.join("")).toContain("--cases");
    expect(spy.reserves).toHaveLength(0);
  });
});
