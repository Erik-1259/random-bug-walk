import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FAILURE_CODE, loadData } from "../src/f3/data.ts";
import { PROTOCOL_FILE, ProtocolError, evaluateProtocol, loadProtocol, parseProtocol } from "../src/protocol.ts";
import type { CopySummary } from "../src/protocol.ts";
import { block, copy, instance } from "./support.ts";

const data = loadData();
const protocol = loadProtocol();

function nth(copies: CopySummary[], index: number): CopySummary {
  const found = copies[index];
  if (found === undefined) throw new Error(`no copy ${String(index)}`);
  return found;
}

function qualifyingSet(): CopySummary[] {
  return [
    copy("buggy", data.sha256, protocol.sha256, [instance(1, FAILURE_CODE), instance(2, FAILURE_CODE), instance(3, FAILURE_CODE)]),
    copy("fixed", data.sha256, protocol.sha256, [instance(1, "pass"), instance(2, "pass"), instance(3, "pass")]),
    copy("clean", data.sha256, protocol.sha256, [instance(1, "pass")]),
  ];
}

function stateOf(copies: CopySummary[], state: string): ReturnType<typeof evaluateProtocol>["states"][number] {
  const found = evaluateProtocol(protocol, data, copies).states.find((entry) => entry.state === state);
  if (found === undefined) throw new Error(`no ${state}`);
  return found;
}

describe("the declared protocol", () => {
  it("pins the data file and declares buggy 3, fixed 3 and clean 1 fresh instances with 20-trial main and 5-trial control blocks", () => {
    expect(protocol.data_sha256).toBe(data.sha256);
    expect(protocol.states).toEqual({ buggy: { copies: 1, instances: 3 }, fixed: { copies: 1, instances: 3 }, clean: { copies: 1, instances: 1 } });
    expect(protocol.blocks.control).toEqual({ valid_target: 5, max_invalid: 1, max_top_ups: 5 });
    expect(protocol.required_passed).toBe(193);
  });

  it("refuses a protocol whose instance order differs from the copy's", () => {
    const value = JSON.parse(readFileSync(PROTOCOL_FILE, "utf8")) as Record<string, unknown>;
    value.instance_order = ["main", "original_suite"];
    expect(() => parseProtocol(value, "0".repeat(64))).toThrow(ProtocolError);
  });
});

describe("evaluateProtocol", () => {
  it("qualifies when buggy fails every valid main trial, fixed and clean pass every one, and every control passes", () => {
    const evaluation = evaluateProtocol(protocol, data, qualifyingSet());
    expect(evaluation.verdict).toBe("qualified");
    expect(evaluation.states.map((state) => state.verdict)).toEqual(["met", "met", "met"]);
  });

  it("does not qualify when one valid buggy trial passes", () => {
    const copies = qualifyingSet();
    const buggy = nth(copies, 0);
    const first = buggy.instances[0];
    if (first === undefined) throw new Error("no instance");
    first.blocks.main = block({ valid_target: 20 }, { [FAILURE_CODE]: 19, pass: 1 });
    expect(evaluateProtocol(protocol, data, copies).verdict).toBe("not_qualified");
    expect(stateOf(copies, "buggy").reasons.join(" ")).toContain("main had valid trials other than");
  });

  it("does not qualify when a clean or fixed trial shows the failure, or a control fails", () => {
    const clean = qualifyingSet();
    clean[2] = copy("clean", data.sha256, protocol.sha256, [instance(1, FAILURE_CODE)]);
    expect(evaluateProtocol(protocol, data, clean).verdict).toBe("not_qualified");
    const control = qualifyingSet();
    control[0] = copy("buggy", data.sha256, protocol.sha256, [instance(1, FAILURE_CODE), instance(2, FAILURE_CODE, FAILURE_CODE), instance(3, FAILURE_CODE)]);
    expect(stateOf(control, "buggy").verdict).toBe("not_met");
  });

  it("does not qualify when the original suite fails on an instance", () => {
    const copies = qualifyingSet();
    const target = copies[0]?.instances[1];
    if (target === undefined) throw new Error("no instance");
    target.suite = { verdict: "failed", tests_expected: 193, passed: 190 };
    expect(stateOf(copies, "buggy")).toMatchObject({ verdict: "not_met" });
  });

  it("treats an incomplete block as neither reproduction nor a miss", () => {
    const copies = qualifyingSet();
    const target = copies[0]?.instances[2];
    if (target === undefined) throw new Error("no instance");
    target.blocks.main = block({ valid_target: 20 }, { [FAILURE_CODE]: 12 }, 3, "incomplete");
    expect(stateOf(copies, "buggy").verdict).toBe("incomplete");
    expect(evaluateProtocol(protocol, data, copies).verdict).toBe("incomplete");
  });

  it("never counts invalid trials towards the target", () => {
    const copies = qualifyingSet();
    const target = copies[1]?.instances[0];
    if (target === undefined) throw new Error("no instance");
    target.blocks.main = block({ valid_target: 20 }, { pass: 18 }, 2, "complete");
    expect(stateOf(copies, "fixed").verdict).toBe("incomplete");
  });

  it("is incomplete with too few instances, a missing copy, an invalid copy or a suite that did not run", () => {
    const short = qualifyingSet();
    short[0] = copy("buggy", data.sha256, protocol.sha256, [instance(1, FAILURE_CODE), instance(2, FAILURE_CODE)]);
    expect(stateOf(short, "buggy").verdict).toBe("incomplete");
    expect(stateOf(qualifyingSet().slice(1), "buggy").verdict).toBe("incomplete");
    const invalid = qualifyingSet();
    nth(invalid, 2).invalid_reason = "dependency_manifests_differ";
    expect(stateOf(invalid, "clean").verdict).toBe("incomplete");
    const noSuite = qualifyingSet();
    const target = noSuite[2]?.instances[0];
    if (target === undefined) throw new Error("no instance");
    target.suite = null;
    expect(stateOf(noSuite, "clean").verdict).toBe("incomplete");
  });

  it("does not count copies made under another data file or protocol, or smoke copies", () => {
    const other = qualifyingSet();
    nth(other, 2).data_sha256 = "1".repeat(64);
    expect(stateOf(other, "clean").verdict).toBe("incomplete");
    const retuned = qualifyingSet();
    nth(retuned, 1).protocol_sha256 = "2".repeat(64);
    expect(stateOf(retuned, "fixed").verdict).toBe("incomplete");
    const smoke = qualifyingSet();
    nth(smoke, 2).purpose = "smoke";
    expect(stateOf(smoke, "clean").verdict).toBe("incomplete");
  });

  it("refuses to evaluate against a data file the protocol does not pin", () => {
    expect(() => evaluateProtocol({ ...protocol, data_sha256: "3".repeat(64) }, data, qualifyingSet())).toThrow(ProtocolError);
  });
});
