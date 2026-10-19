import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAILURE_CODE, loadData } from "../src/f3/data.ts";
import { sha256Hex } from "../src/hash.ts";
import { PROTOCOL_FILE, loadProtocol } from "../src/protocol.ts";
import { CATALOG_V2_FILE, entryPins, loadCatalogPins, parseCatalogPins } from "../v2/entry.ts";
import { PROTOCOL_V2_FILE, ProtocolError, VALID_TRIAL_RULES, blockRuleV2, loadProtocolV2, parseProtocolV2 } from "../v2/protocol.ts";
import { BUGGY_TARGET_SHA, CLEAN_TARGET_SHA, ENTRY_ID, TARGET } from "./support-v2.ts";

const v1 = loadProtocol();
const raw = (): Record<string, unknown> => JSON.parse(readFileSync(PROTOCOL_V2_FILE, "utf8")) as Record<string, unknown>;

describe("protocol f3-repeatability version 2", () => {
  const v2 = loadProtocolV2();

  it("is a new identity: the same ID, version 2, its own pinned SHA-256", () => {
    expect(v2.protocol_id).toBe("f3-repeatability");
    expect(v2.version).toBe(2);
    expect(v2.sha256).toBe(sha256Hex(readFileSync(PROTOCOL_V2_FILE)));
    expect(v2.sha256).not.toBe(v1.sha256);
    expect(readFileSync(`${PROTOCOL_V2_FILE}.sha256`, "utf8").split(/\s+/)[0]).toBe(v2.sha256);
  });

  it("keeps every check value of version 1: data file, baseline, suite rule, states and block rules", () => {
    expect(v2.data_sha256).toBe(v1.data_sha256);
    expect(v2.data_sha256).toBe(loadData().sha256);
    expect(v2.baseline_id).toBe(v1.baseline_id);
    expect(v2.required_passed).toBe(v1.required_passed);
    expect(v2.states).toEqual(v1.states);
    expect(v2.blocks).toEqual(v1.blocks);
    expect(v2.min_valid_instances).toEqual({ buggy: 3, fixed: 3, clean: 1 });
  });

  it("gives main the main rule and each control the control rule", () => {
    expect(blockRuleV2(v2, "main")).toEqual({ valid_target: 20, max_invalid: 2, max_top_ups: 10 });
    for (const kind of ["sequential", "valid_partner", "x_alone", "dx_order"] as const) expect(blockRuleV2(v2, kind)).toEqual({ valid_target: 5, max_invalid: 1, max_top_ups: 5 });
  });

  it("declares the check's failure code and the rules the evaluation applies", () => {
    expect(v2.verification_codes.declared).toBe(FAILURE_CODE);
    expect(new Set(Object.values(v2.verification_codes)).size).toBe(4);
    expect(v2.valid_trial_rules).toEqual([...VALID_TRIAL_RULES]);
  });

  it("refuses a file that is version 1's format, another version, a different rule list or a different declared code", () => {
    const sha = "0".repeat(64);
    expect(() => parseProtocolV2(JSON.parse(readFileSync(PROTOCOL_FILE, "utf8")), sha)).toThrow(ProtocolError);
    expect(() => parseProtocolV2({ ...raw(), version: 3 }, sha)).toThrow(ProtocolError);
    expect(() => parseProtocolV2({ ...raw(), valid_trial_rules: VALID_TRIAL_RULES.slice(1) }, sha)).toThrow(ProtocolError);
    expect(() => parseProtocolV2({ ...raw(), verification_codes: { ...(raw().verification_codes as object), declared: "other" } }, sha)).toThrow(ProtocolError);
    const states = raw().states as Record<string, Record<string, unknown>>;
    expect(() => parseProtocolV2({ ...raw(), states: { ...states, buggy: { ...states.buggy, min_valid_instances: 4 } } }, sha)).toThrow(ProtocolError);
    expect(() => parseProtocolV2({ ...raw(), instance_order: ["main"] }, sha)).toThrow(ProtocolError);
  });

  it("refuses a file whose bytes differ from its pin", () => {
    const dir = mkdtempSync(join(tmpdir(), "rbw-protocol-v2-"));
    const file = join(dir, "f3-repeatability.v2.json");
    writeFileSync(file, `${readFileSync(PROTOCOL_V2_FILE, "utf8")} `);
    writeFileSync(`${file}.sha256`, readFileSync(`${PROTOCOL_V2_FILE}.sha256`));
    expect(() => loadProtocolV2(file)).toThrow(ProtocolError);
  });
});

describe("catalog version 2 as the copy reads it", () => {
  const pins = loadCatalogPins();

  it("pins the catalog's own SHA-256, the entry's target hashes, the data file and the version 2 protocol", () => {
    expect(pins.sha256).toBe(sha256Hex(readFileSync(CATALOG_V2_FILE)));
    expect(pins.baseline_id).toBe("task-report@ca4a71f");
    expect(entryPins(pins, ENTRY_ID)).toEqual({
      entry_id: ENTRY_ID,
      target_path: TARGET,
      baseline_sha256: CLEAN_TARGET_SHA,
      buggy_sha256: BUGGY_TARGET_SHA,
      repair_result_sha256: CLEAN_TARGET_SHA,
      data_sha256: loadData().sha256,
      protocol_sha256: loadProtocolV2().sha256,
    });
    expect(() => entryPins(pins, "task-report-f3-999")).toThrow();
  });

  it("refuses a catalog of another format or with a malformed hash", () => {
    const value = JSON.parse(readFileSync(CATALOG_V2_FILE, "utf8")) as { format: string; entries: Record<string, unknown>[] };
    expect(() => parseCatalogPins(Buffer.from(JSON.stringify({ ...value, format: "rbw.task-report.catalog.v1" })))).toThrow();
    const entry = value.entries[0];
    if (entry === undefined) throw new Error("no entry");
    expect(() => parseCatalogPins(Buffer.from(JSON.stringify({ ...value, entries: [{ ...entry, buggy_sha256: "x" }] })))).toThrow();
    expect(() => parseCatalogPins(Buffer.from(JSON.stringify({ ...value, entries: [entry, entry] })))).toThrow();
  });
});
