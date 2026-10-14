// The report's claim wording: the headline, then the detectable difference for the observed
// off-arm rate when both arms have 20 counted attempts, or a note when they do not. The table the
// report quotes must be the pre-registration's generated table.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "@rbw/solver";
import type { AttemptRow } from "@rbw/solver";
import { describe, expect, it } from "vitest";
import { DETECTABLE_DIFFERENCE, detectableSentence, reportMarkdown, writeStaging } from "../src/report.ts";
import type { RunSummary } from "../src/report.ts";
import type { RunRecord } from "../src/records.ts";

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
    arms: { off: { wall_ms: null, model_settled_microusd: 0, grade2_settled_microusd: 0 }, on: { wall_ms: null, model_settled_microusd: 0, grade2_settled_microusd: 0 } },
    stops: [],
    analysis: "results/analysis.json",
  };
}

/** Marks the first `n` rows of an arm with a change to each. */
function mark(rows: AttemptRow[], n: number, change: (item: AttemptRow) => AttemptRow): AttemptRow[] {
  return rows.map((item, i) => (i < n ? change(item) : item));
}
const noLogs = (item: AttemptRow): AttemptRow => ({ ...item, tool_calls: { ...item.tool_calls, server_logs: 0 } });
const contaminated = (item: AttemptRow): AttemptRow => ({ ...item, contaminated: true });

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

describe("the per-arm solve counts", () => {
  it("reports each arm's solves over its counted attempts with a 95% Clopper–Pearson interval", () => {
    const analysis = analyze([...arm("off", 20, 2), ...arm("on", 20, 9)]);
    const report = reportMarkdown(summary("run"), analysis);
    const off = analysis.bugs[0]?.arms.off.clopper_pearson_95;
    const on = analysis.bugs[0]?.arms.on.clopper_pearson_95;
    expect(off).not.toBeNull();
    expect(report).toContain(`Solves over all counted attempts (grade 2), with 95% Clopper–Pearson intervals: off 2/20 (${off?.[0] ?? ""} to ${off?.[1] ?? ""}); on 9/20 (${on?.[0] ?? ""} to ${on?.[1] ?? ""}).`);
  });

  it("reports the all-attempt solve counts with intervals when the futility rule stopped the solve test", () => {
    const analysis = analyze([...arm("off", 19, 0, 1), ...arm("on", 20, 0)]);
    const report = reportMarkdown(summary("run"), analysis);
    expect(report).toContain(analysis.bugs[0]?.made_worse.statement ?? "missing");
    const off = analysis.bugs[0]?.arms.off.clopper_pearson_95;
    const on = analysis.bugs[0]?.arms.on.clopper_pearson_95;
    expect(report).toContain(`off 0/19 (${off?.[0] ?? ""} to ${off?.[1] ?? ""}); on 0/20 (${on?.[0] ?? ""} to ${on?.[1] ?? ""}).`);
  });

  it("does not put the solve counts in a pilot report", () => {
    const pilot = reportMarkdown(summary("pilot"), analyze([...arm("off", 2, 0), ...arm("on", 2, 1)]));
    expect(pilot).not.toContain("Clopper–Pearson");
  });
});

describe("the pre-registered tool-use and contamination checks", () => {
  it("reports the on arm's server_logs share with the call count, and each arm's contamination, next to the result", () => {
    const rows = [...mark(arm("off", 20, 2), 3, contaminated), ...mark(mark(arm("on", 20, 9), 4, noLogs), 1, contaminated)];
    const report = reportMarkdown(summary("run"), analyze(rows));
    expect(report).toContain("Tool use: 16 of 20 counted on-arm attempts (80%) called `server_logs` at least once, 16 calls in all.");
    expect(report).toContain("Contamination (attempts that started their own server process or read the app's or the database's process output other than through `server_logs`): off 3/20, on 1/20. A high off-arm rate weakens the claim.");
    expect(report).not.toContain("low share");
    const result = report.indexOf("Solves over all counted attempts");
    expect(report.indexOf("Tool use:")).toBeGreaterThan(result);
    expect(report.indexOf("Contamination (")).toBeGreaterThan(result);
  });

  it("warns next to the result when fewer than half of the on-arm attempts used the tool", () => {
    const report = reportMarkdown(summary("run"), analyze([...arm("off", 20, 2), ...mark(arm("on", 20, 9), 11, noLogs)]));
    expect(report).toContain("Tool use: 9 of 20 counted on-arm attempts (45%) called `server_logs` at least once, 9 calls in all.");
    expect(report).toContain("This is a low share (under half, the report's reading; the pre-registration sets no cutoff): an unused tool cannot help, so the result says little about the tool's effect.");
  });

  it("does not put the checks in a pilot report", () => {
    const pilot = reportMarkdown(summary("pilot"), analyze([...arm("off", 2, 0), ...arm("on", 2, 1)]));
    expect(pilot).not.toContain("Tool use:");
    expect(pilot).not.toContain("Contamination (");
  });
});

describe("the per-arm diagnostics", () => {
  const outOfScope = (item: AttemptRow): AttemptRow => ({ ...item, out_of_scope: true, prohibited_edits: 2, grade1: null, grade2: null });
  const bashUser = (item: AttemptRow): AttemptRow => ({ ...item, tool_calls: { ...item.tool_calls, bash: 3, rebuild_restart: 2 } });

  it("reports each arm's tool calls by tool, out_of_scope and prohibited-edit counts, contamination, and infrastructure errors and reruns", () => {
    const rows = [...mark(mark(arm("off", 20, 2), 1, outOfScope), 5, bashUser), ...mark(mark(arm("on", 19, 9, 1), 3, contaminated), 4, noLogs)];
    const report = reportMarkdown(summary("run"), analyze(rows));
    expect(report).toContain("## Per arm\n");
    expect(report).toContain("| Measure | Off | On |\n|---|---|---|\n| Counted attempts | 20 | 19 |\n");
    expect(report).toContain("| Infrastructure errors (excluded from every outcome) | 0 | 1 |");
    expect(report).toContain("| Infrastructure reruns | 0 | 2 |");
    expect(report).toContain("| Out of scope (unsolved, not graded) | 1 | 0 |");
    expect(report).toContain("| Prohibited edits (changed files besides the target) | 2 | 0 |");
    expect(report).toContain("| Contaminated attempts | 0 | 3 |");
    expect(report).toContain("| Attempts that called `server_logs` | 0 | 15 |");
    // Every tool, in the tool list's order, over the counted attempts only.
    const tools = ["| `bash` calls | 15 | 0 |", "| `read_file` calls | 20 | 19 |", "| `write_file` calls | 20 | 19 |", "| `rebuild_restart` calls | 25 | 19 |", "| `submit` calls | 20 | 19 |", "| `server_logs` calls | 0 | 15 |"];
    expect(report).toContain(tools.join("\n"));
  });

  it("reports each arm's wall time and spend from the summary, and says when the analysis's counts are missing", () => {
    const timed: RunSummary = {
      ...summary("run"),
      arms: {
        off: { wall_ms: { attempts: 20, total: 36_000_000, median: 1_530_000, max: 2_400_000 }, model_settled_microusd: 412_345, grade2_settled_microusd: 2_973_640 },
        on: { wall_ms: null, model_settled_microusd: 0, grade2_settled_microusd: 0 },
      },
    };
    const report = reportMarkdown(timed, analyze([...arm("off", 20, 2), ...arm("on", 20, 9)]));
    expect(report).toContain("| Wall time over counted attempts (total; median; largest) | 600.0 min; 25.5 min; 40.0 min | - |");
    expect(report).toContain("| Model spend, every run at the arm's indexes | $0.4123 | $0.0000 |");
    expect(report).toContain("| Grade 2 spend, every try | $2.9736 | $0.0000 |");
    const unanalyzed = reportMarkdown({ ...timed, analysis: { error: "synthetic" } }, null);
    expect(unanalyzed).toContain("| Measure | Off | On |\n|---|---|---|\n| Wall time over counted attempts (total; median; largest) | 600.0 min; 25.5 min; 40.0 min | - |");
    expect(unanalyzed).toContain("The counts by tool, scope, contamination and infrastructure are not shown: the analysis was not computed.");
    expect(unanalyzed).not.toContain("| Counted attempts |");
  });

  it("puts the same per-arm measurements in a pilot report, as harness evidence", () => {
    const pilot = reportMarkdown(summary("pilot"), analyze([...arm("off", 2, 0), ...arm("on", 2, 1)]));
    expect(pilot).toContain("| Counted attempts | 2 | 2 |");
    expect(pilot).toContain("| `server_logs` calls | 0 | 2 |");
    expect(pilot).toContain("| Model spend, every run at the arm's indexes |");
  });
});

describe("the made-worse statement", () => {
  it("states the off-minus-on solve rate and plainly that the tool made this bug worse on solves", () => {
    const analysis = analyze([...arm("off", 20, 15), ...arm("on", 20, 2)]);
    const bug = analysis.bugs[0];
    expect(bug?.made_worse).toMatchObject({ solve: "worse", tokens: "inconclusive" });
    const report = reportMarkdown(summary("run"), analysis);
    const sentence = "Made worse: off-minus-on solve rate 0.650000. On solves, the tool made this bug worse: the on arm solved fewer. On tokens, whether the tool made this bug worse is inconclusive at this sample size.";
    expect(report).toContain(`${bug?.made_worse.statement ?? "missing"}\n\n${sentence}`);
  });

  it("says plainly when the tool did not make this bug worse, and when it made it worse on tokens", () => {
    const heavy = (item: AttemptRow): AttemptRow => ({ ...item, tokens: item.tokens * 3 });
    const analysis = analyze([...arm("off", 20, 2), ...arm("on", 20, 15).map(heavy)]);
    expect(analysis.bugs[0]?.made_worse).toMatchObject({ solve: "not_worse", tokens: "worse" });
    expect(reportMarkdown(summary("run"), analysis)).toContain(
      "Made worse: off-minus-on solve rate -0.650000. On solves, the tool did not make this bug worse: the on arm solved more. On tokens, the tool made this bug worse: the on arm used more.",
    );
  });

  it("does not claim either way on solves when the futility rule stopped the solve test", () => {
    const analysis = analyze([...arm("off", 19, 0, 1), ...arm("on", 20, 0)]);
    expect(analysis.bugs[0]?.futility.triggered).toBe(true);
    expect(reportMarkdown(summary("run"), analysis)).toContain(
      "Made worse: off-minus-on solve rate 0.000000. On solves, the futility rule stopped the test, so this report does not say whether the tool made this bug worse on solves.",
    );
  });

  it("does not put the made-worse statement in a pilot report", () => {
    const pilot = reportMarkdown(summary("pilot"), analyze([...arm("off", 2, 0), ...arm("on", 2, 1)]));
    expect(pilot).not.toContain("Made worse:");
  });
});

describe("the staged report", () => {
  it("carries no local path, as no other staged file does", () => {
    const runDir = mkdtempSync(join(tmpdir(), "rbw-uc1-report-"));
    const screenRecord = join(runDir, "screen.json");
    writeFileSync(screenRecord, "{}\n");
    const report = `# Report\n\n- Index 3 (on), run r0: harness: ENOENT: no such file or directory, open '${runDir}/attempts/003-on/r0/session.json'\n`;
    const staging = writeStaging(runDir, { run: {} as RunRecord, records: [], seeded: [], rows: [], analysisJson: null, summary: summary("pilot"), report, screenRecord });
    const staged = readFileSync(join(staging, "report.md"), "utf8");
    expect(staged).not.toContain(runDir);
    expect(staged).toContain("open './attempts/003-on/r0/session.json'");
  });
});
