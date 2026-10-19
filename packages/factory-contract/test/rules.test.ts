import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANDIDATE_REASON_VALUES,
  CANDIDATE_STAGE_VALUES,
  ERROR_CODE_VALUES,
  EVENT_TYPE_VALUES,
  PROBLEM_CODE_VALUES,
  PROBLEM_SEVERITY_VALUES,
  REQUEST_OUTCOME_VALUES,
  STOP_CODE_VALUES,
} from "../src/index.ts";
import { validateContract } from "../src/validate.ts";
import type { JsonObject } from "./support.ts";
import { CONTRACT_DOCUMENT, at, contractFixture, internalFixture, variant } from "./support.ts";

const DOCUMENT = readFileSync(CONTRACT_DOCUMENT, "utf8").split("\n");

/** The lines under a heading, up to the next heading of the same or a higher level. */
function section(heading: string): string[] {
  const start = DOCUMENT.findIndex((line) => line === heading);
  if (start < 0) throw new Error(`no heading ${heading}`);
  const level = heading.indexOf(" ");
  const rest = DOCUMENT.slice(start + 1);
  const end = rest.findIndex((line) => /^#+ /.test(line) && line.indexOf(" ") <= level);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The cells of each table row in the lines, skipping the header and separator rows. */
function rows(lines: string[]): string[][] {
  const table = lines.filter((line) => line.startsWith("|"));
  return table.slice(2).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

/** The backticked codes of a table cell, such as "`candidate_rejected` / `candidate_invalid`". */
function codes(cell: string | undefined): string[] {
  return [...(cell ?? "").matchAll(/`([a-z_]+)`/g)].map((match) => match[1] ?? "");
}

const sorted = (values: readonly string[]) => [...values].sort();

describe("enumerations match the contract document", () => {
  it("problem codes and their severities (section 6.2)", () => {
    const table = rows(section("### 6.2 Problem codes"));
    expect(sorted(table.flatMap((row) => codes(row[0])))).toEqual(sorted(PROBLEM_CODE_VALUES));
    for (const row of table) expect(PROBLEM_SEVERITY_VALUES).toContain(row[1]);
  });

  it("outcomes and stop codes (section 8.1)", () => {
    const table = rows(section("### 8.1 States and outcomes"));
    expect(sorted(table.flatMap((row) => codes(row[0])))).toEqual(sorted(REQUEST_OUTCOME_VALUES));
    expect(sorted(table.flatMap((row) => codes(row[1])))).toEqual(sorted(STOP_CODE_VALUES));
  });

  it("candidate reasons and their stages (section 8.3)", () => {
    const table = rows(section("### 8.3 Candidate reasons"));
    expect(sorted(table.flatMap((row) => codes(row[0])))).toEqual(sorted(CANDIDATE_REASON_VALUES));
    for (const row of table) expect(CANDIDATE_STAGE_VALUES).toContain(row[1]);
  });

  it("event types (section 8.4)", () => {
    const table = rows(section("### 8.4 Events"));
    expect(sorted(table.flatMap((row) => codes(row[0])))).toEqual(sorted(EVENT_TYPE_VALUES));
  });

  it("error codes (section 12)", () => {
    const table = rows(section("## 12. Errors"));
    expect(sorted(table.flatMap((row) => codes(row[1])))).toEqual(sorted(ERROR_CODE_VALUES));
  });
});

const PROBLEM_TABLE = rows(section("### 6.2 Problem codes")).map((row) => [codes(row[0])[0] ?? "", row[1] ?? ""] as const);
const OUTCOME_TABLE = rows(section("### 8.1 States and outcomes")).map((row) => [codes(row[0])[0] ?? "", codes(row[1])] as const);
const REASON_TABLE = rows(section("### 8.3 Candidate reasons")).map((row) => [codes(row[0])[0] ?? "", row[1] ?? ""] as const);
const ENDED_STAGES = ["rejected", "invalid", "incomplete", "skipped"];

describe("the schema applies the document's tables", () => {
  it.each(PROBLEM_TABLE)("problem %s has severity %s and no other", (code, severity) => {
    for (const other of PROBLEM_SEVERITY_VALUES) {
      const problem = { code, severity: other, message: "synthetic", item_key: null };
      expect(validateContract("Problem", problem).length === 0).toBe(other === severity);
    }
  });

  it.each(OUTCOME_TABLE)("outcome %s takes exactly the stop codes %j", (outcome, stopCodes) => {
    const finished = contractFixture("status-fulfilled.json");
    for (const stopCode of STOP_CODE_VALUES) {
      const allowed = stopCodes.includes(stopCode);
      expect(validateContract("RequestFinishedData", { outcome, stop_code: stopCode }).length === 0).toBe(allowed);
      const status = variant(finished, (copy) => {
        copy.outcome = outcome;
        at(copy, ["stop_reason"]).code = stopCode;
      });
      expect(validateContract("RequestStatus", status).length === 0).toBe(allowed);
    }
  });

  it.each(REASON_TABLE)("reason %s belongs to stage %s only", (reason, stage) => {
    const rejected = at(contractFixture("status-zero-result.json"), ["candidates", 0]);
    const record = internalFixture("qualification-record-rejected.json");
    for (const other of ENDED_STAGES) {
      const allowed = other === stage;
      const candidate = variant(rejected, (copy) => {
        copy.stage = other;
        at(copy, ["reason"]).code = reason;
      });
      expect(validateContract("Candidate", candidate).length === 0).toBe(allowed);
      const event: JsonObject = {
        seq: 1, at: "2026-10-20T14:00:00.000Z", type: `candidate_${other}`, host_id: "umami", candidate_id: null,
        item_key: null, case_id: null, message: "synthetic", data: { reason },
      };
      expect(validateContract("Event", event).length === 0).toBe(allowed);
      if (other !== "skipped") {
        const qualification = variant(record, (copy) => {
          copy.verdict = other;
          copy.reason_code = reason;
        });
        expect(validateContract("QualificationRecord", qualification).length === 0).toBe(allowed);
      }
    }
    const active = variant(rejected, (copy) => { copy.stage = "checking"; });
    expect(validateContract("Candidate", active)).toContain("schema:/reason:type");
  });
});
