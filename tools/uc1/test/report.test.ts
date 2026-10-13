// The report's claim wording: the headline, then the detectable difference for the observed
// off-arm rate when both arms have 20 counted attempts, or a note when they do not. The table the
// report quotes must be the pre-registration's generated table.
import { readFileSync } from "node:fs";
import { analyze } from "@rbw/solver";
import type { AttemptRow } from "@rbw/solver";
import { describe, expect, it } from "vitest";
import { DETECTABLE_DIFFERENCE, detectableSentence, reportMarkdown } from "../src/report.ts";
import type { RunSummary } from "../src/report.ts";

const PREREGISTRATION = new URL("../../../docs/uc1-preregistration.md", import.meta.url);

function row(arm: "off" | "on", index: number, solved: boolean, status: AttemptRow["status"] = "counted"): AttemptRow {
  const counted = status === "counted";
  return {
    bug_id: "umami-race-synthetic-001",
    arm,
    index,
    status,
    reruns: counted ? 0 : 2,
    grade1: counted ? (solved ? "pass" : "fail") : null,
    grade2: counted ? (solved ? "pass" : "fail") : null,
    out_of_scope: false,
    prohibited_edits: 0,
    tokens: 1000 + index * 7 + (arm === "on" ? 3 : 0),
    turns: 10 + index,
    cap: null,
    history_elisions: 0,
    tool_calls: { bash: 0, read_file: 1, write_file: 1, rebuild_restart: 1, submit: 1, server_logs: arm === "on" ? 1 : 0 },
    contaminated: false,
  };
}

/** Each arm's rows: the first `solved` counted attempts solved, then `excluded` infrastructure errors. */
function arm(name: "off" | "on", counted: number, solved: number, excluded = 0): AttemptRow[] {
  const offset = name === "off" ? 1 : 2;
  const rows: AttemptRow[] = [];
  for (let i = 0; i < counted; i += 1) rows.push(row(name, i * 2 + offset, i < solved));
  for (let i = 0; i < excluded; i += 1) rows.push(row(name, (counted + i) * 2 + offset, false, "infrastructure_error"));
  return rows;
}

function summary(mode: RunSummary["mode"]): RunSummary {
  return {
    schema_version: 1,
    kind: "uc1_run_summary",
    mode,
    label: null,
    case_id: "umami-race-synthetic-001",
    model: "super",
    model_id: "synthetic-model",
    runtime_profile_sha256: "a".repeat(64),
    rate_sheet_sha256: "b".repeat(64),
    root_execution_id: "00000000-0000-4000-8000-000000000001",
    project_policy_sha256: "c".repeat(64),
    plan: [],
    attempts: [],
    seeded: [],
    grade_disagreements: [],
    spend: { cap_microusd: "0", model_settled_microusd: 0, grade2_settled_microusd: 0, total_settled_microusd: 0, model_per_attempt_mean_microusd: null, model_per_attempt_max_microusd: null, ledger: { settled_microusd: "0", open_microusd: "0", uncertain: [] }, uc1_roots: null },
    stops: [],
    analysis: "results/analysis.json",
  };
}

/** The generated solve table in the pre-registration, as the report's table holds it. */
function preregisteredTable(): string[][] {
  const text = readFileSync(PREREGISTRATION, "utf8");
  const rows = text.split("\n").filter((line) => /^\| \d+% \|/.test(line));
  return rows.map((line) =>
    line
      .split("|")
      .slice(1, 6)
      .map((cell) => cell.trim().replace(/ \(.*\)$/, "")),
  );
}

describe("the detectable-difference sentence", () => {
  it("quotes the pre-registration's generated solve table, row for row", () => {
    const table = preregisteredTable();
    expect(table).toHaveLength(21);
    expect(DETECTABLE_DIFFERENCE.map((entry, solved) => [`${String(solved * 5)}%`, entry.increase[0], entry.increase[1], entry.decrease[0], entry.decrease[1]])).toEqual(table);
  });

  it("follows a full counted run's headline with the row for the observed off-arm rate", () => {
    const analysis = analyze([...arm("off", 20, 2), ...arm("on", 20, 9)]);
    const report = reportMarkdown(summary("run"), analysis);
    const headline = "Illustration on 1 bug, k = 20 off and 20 on.";
    expect(report).toContain(headline);
    const sentence = detectableSentence(analysis.bugs[0]?.arms.off.solved ?? -1, 20, 20);
    expect(sentence).toContain("off-arm rate of 10% (2/20)");
    expect(sentence).toContain("an increase of 43 percentage points at alpha 0.05 and 51 at alpha 0.0167");
    expect(sentence).toContain("no decrease is detectable");
    expect(report).toContain(`${headline}\n\n${sentence}`);
  });

  it("omits the detectable difference after exclusions, with a note that the table assumes 20 counted attempts per arm", () => {
    const analysis = analyze([...arm("off", 19, 2, 1), ...arm("on", 20, 9)]);
    const report = reportMarkdown(summary("run"), analysis);
    expect(report).toContain("Illustration on 1 bug, k = 19 off and 20 on.\n\nThe detectable difference is omitted: the pre-registered table assumes 20 counted attempts per arm.");
    expect(report).not.toContain("percentage points at alpha");
  });

  it("names both directions when both are detectable, and never appears in a pilot report", () => {
    expect(detectableSentence(10, 20, 20)).toContain("an increase of 42 percentage points at alpha 0.05 and 47 at alpha 0.0167, or a decrease of 42 percentage points at alpha 0.05 and 47 at alpha 0.0167");
    expect(detectableSentence(16, 20, 20)).toContain("no increase is detectable; a decrease of 48 percentage points at alpha 0.05 and 54 at alpha 0.0167");
    expect(detectableSentence(7, 20, 20)).toContain("or a decrease of 35 percentage points at alpha 0.05 and none at alpha 0.0167");
    const pilot = reportMarkdown(summary("pilot"), analyze([...arm("off", 2, 0), ...arm("on", 2, 1)]));
    expect(pilot).not.toContain("detectable difference");
    expect(pilot).not.toContain("percentage points at alpha");
  });
});
