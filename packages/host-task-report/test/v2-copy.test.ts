import { describe, expect, it } from "vitest";
import { FAILURE_CODE } from "../src/f3/data.ts";
import { parseCopyArgsV2, UsageError } from "../v2/args.ts";
import { outcomesFromTrials } from "../v2/copy.ts";
import { COPY_V2_FORMAT, parseCopySummaryV2, RecordError } from "../v2/record.ts";
import { copyV2, instanceV2 } from "./support-v2.ts";

const base = ["--state", "buggy", "--copy-id", "f3q2-0123456789abcdef-buggy-1", "--entry", "task-report-f3-001"];

describe("copy driver arguments", () => {
  it("takes the state, the copy ID, the entry and the purpose", () => {
    expect(parseCopyArgsV2(base)).toEqual({ state: "buggy", purpose: "counted", copyId: "f3q2-0123456789abcdef-buggy-1", entryId: "task-report-f3-001", instances: null, mainTarget: null, controlTarget: null });
  });

  it("refuses another copy ID prefix, a missing entry, unknown arguments and overrides on a counted copy", () => {
    expect(() => parseCopyArgsV2(["--state", "buggy", "--copy-id", "f3q-old-1", "--entry", "task-report-f3-001"])).toThrow(UsageError);
    expect(() => parseCopyArgsV2(["--state", "buggy", "--copy-id", "f3q2-a"])).toThrow(UsageError);
    expect(() => parseCopyArgsV2([...base, "--extra", "1"])).toThrow(UsageError);
    expect(() => parseCopyArgsV2([...base, "--instances", "1"])).toThrow(UsageError);
    expect(() => parseCopyArgsV2(["--state", "other", "--copy-id", "f3q2-a", "--entry", "task-report-f3-001"])).toThrow(UsageError);
  });

  it("allows reduced counts only on a smoke copy of the clean state", () => {
    const smoke = ["--state", "clean", "--copy-id", "f3q2-smoke-1", "--entry", "task-report-f3-001", "--purpose", "smoke", "--instances", "1", "--main-target", "2", "--control-target", "1"];
    expect(parseCopyArgsV2(smoke)).toMatchObject({ purpose: "smoke", instances: 1, mainTarget: 2, controlTarget: 1 });
    expect(() => parseCopyArgsV2([...base, "--purpose", "smoke"])).toThrow(UsageError);
  });
});

describe("trial outcomes from trials.jsonl", () => {
  const line = (kind: string, index: number, outcome: string): string => JSON.stringify({ observation: { kind, index }, classification: { outcome } });

  it("keeps each block's outcomes in run order", () => {
    const text = [line("main", 1, FAILURE_CODE), line("main", 2, "invalid"), line("main", 3, FAILURE_CODE), line("sequential", 1, "pass")].join("\n") + "\n";
    expect(outcomesFromTrials(text)).toEqual({ main: [FAILURE_CODE, "invalid", FAILURE_CODE], sequential: ["pass"] });
    expect(outcomesFromTrials("")).toEqual({});
  });

  it("refuses a gap or a repeat in a block's indices, an unknown kind or outcome, and a line that is not a trial", () => {
    expect(() => outcomesFromTrials([line("main", 1, "pass"), line("main", 3, "pass")].join("\n"))).toThrow();
    expect(() => outcomesFromTrials([line("main", 1, "pass"), line("main", 1, "pass")].join("\n"))).toThrow();
    expect(() => outcomesFromTrials(line("other", 1, "pass"))).toThrow();
    expect(() => outcomesFromTrials(line("main", 1, "maybe"))).toThrow();
    expect(() => outcomesFromTrials("{not json")).toThrow();
  });
});

describe("copy.json of evaluator v2", () => {
  const valid = copyV2("buggy", [instanceV2(1, FAILURE_CODE)], "a".repeat(64), "b".repeat(64));

  it("parses a record set the driver writes", () => {
    const parsed = parseCopySummaryV2(JSON.parse(JSON.stringify(valid)));
    expect(parsed).toEqual(valid);
    expect(parsed.format).toBe(COPY_V2_FORMAT);
  });

  it("refuses version 1's format, a malformed hash, an unknown state, outcome or kind, and a missing field", () => {
    const variants: unknown[] = [
      { ...valid, format: "rbw.task-report.copy.v1" },
      { ...valid, catalog_sha256: "x" },
      { ...valid, state: "other" },
      { ...valid, source_files: { "a.ts": "nothex" } },
      { ...valid, instances: [{ ...instanceV2(1, FAILURE_CODE), trials: { main: ["maybe"] } }] },
      { ...valid, instances: [{ ...instanceV2(1, FAILURE_CODE), trials: { other: ["pass"] } }] },
      { ...valid, instances: [{ ...instanceV2(1, FAILURE_CODE), failure: { kind: "later", detail: "x" } }] },
      { ...valid, rules: { main: { valid_target: 20 } } },
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "entry_id")),
      null,
    ];
    for (const variant of variants) expect(() => parseCopySummaryV2(variant)).toThrow(RecordError);
  });
});
