import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatPatch, parsePatch, structuredPatch } from "diff";
import { afterAll, describe, expect, it } from "vitest";
import { ProbeDataError, checkProbes, loadProbeSet } from "../../src/probes.ts";
import {
  RC1_CHECK_ID,
  RC1_CHECK_IDS,
  RC1_DOUBLE_SPEND_REASON,
  RC1_FIXED_RULE_ID,
  RC1_PLANTED_RULE_ID,
  RC1_PROBE_DIR,
  RC1_RULE_FILE,
  RC1_SERIAL_CHECK_ID,
  RC1_SHAPE_ID,
  RC1_SOURCE_RULE_FILE,
  RC1_SOURCE_RULE_ID,
  RC1_TARGET,
} from "../../src/rc1.ts";
import { applyFix, findMatches, loadRules, type LoadedRule } from "../../src/rules.ts";
import { fixture, sha256 } from "./support.ts";

const RULES = loadRules(readFileSync(RC1_RULE_FILE));
const SOURCE_RULES = loadRules(readFileSync(RC1_SOURCE_RULE_FILE));
const ROUTE = fixture("rc1-route.ts.txt");
const BEFORE = fixture("rc1-source-before.ts.txt");
const AFTER = fixture("rc1-source-after.ts.txt");
const CLEAN_SHA = "3e766a0ba16e2547c234442176c04a0f2fd096d033a7079d21938dd9796acb87";
const PLANTED_SHA = "30426f040a2c4ea1730827644b8947feed39dc8f2487fec1372139f5be9d66fb";
const SYNTHETIC_PATH = "src/synthetic/verify/route.ts";

function rule(rules: Map<string, LoadedRule>, id: string): LoadedRule {
  return rules.get(id) ?? expect.fail(`rule ${id} not loaded`);
}

/** The expected planted text, written by hand so the tests do not reuse the rule's own rewrite. */
function plant(text: string): string {
  const once = text.indexOf(RC1_TARGET.cleanLine);
  expect(once).toBeGreaterThan(-1);
  return text.slice(0, once) + RC1_TARGET.plantedLine + text.slice(once + RC1_TARGET.cleanLine.length);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("RC-1 rule files", () => {
  it("defines the fixed-form rule with its fix and the planted-form rule in one file", () => {
    expect([...RULES.keys()]).toEqual([RC1_FIXED_RULE_ID, RC1_PLANTED_RULE_ID]);
    expect(rule(RULES, RC1_FIXED_RULE_ID).fix).toBe("{ id: $ID }");
    expect(rule(RULES, RC1_PLANTED_RULE_ID).fix).toBeUndefined();
    expect(rule(RULES, RC1_FIXED_RULE_ID).metadata).toMatchObject({ shape_id: RC1_SHAPE_ID, form: "fixed" });
    expect(rule(RULES, RC1_PLANTED_RULE_ID).metadata).toMatchObject({ shape_id: RC1_SHAPE_ID, form: "planted" });
    expect([...SOURCE_RULES.keys()]).toEqual([RC1_SOURCE_RULE_ID]);
    expect(rule(SOURCE_RULES, RC1_SOURCE_RULE_ID).metadata).toMatchObject({ form: "source_anchor" });
  });

  it("selects only the guarded where object of the backup-code updateMany inside POST", () => {
    const matches = findMatches(rule(RULES, RC1_FIXED_RULE_ID), ROUTE);
    expect(matches.map((match) => match.text())).toEqual(["{ id: unusedCodes[matchIndex].id, used: false }"]);
    expect(matches.map((match) => match.range().start.line + 1)).toEqual([lineOf(ROUTE, ROUTE.indexOf(RC1_TARGET.cleanLine))]);
  });

  it("plants the bug by changing only the guard line, and the planted rule then matches that line alone", () => {
    const planted = applyFix(rule(RULES, RC1_FIXED_RULE_ID), ROUTE);
    expect(planted).toBe(plant(ROUTE));
    expect(findMatches(rule(RULES, RC1_FIXED_RULE_ID), planted)).toHaveLength(0);
    expect(findMatches(rule(RULES, RC1_PLANTED_RULE_ID), planted).map((match) => match.text())).toEqual([
      "{ id: unusedCodes[matchIndex].id }",
    ]);
    expect(findMatches(rule(RULES, RC1_PLANTED_RULE_ID), ROUTE)).toHaveLength(0);
    const hunks = structuredPatch("a", "b", ROUTE, planted, undefined, undefined, { context: 3 }).hunks;
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines.filter((line) => /^[-+]/.test(line))).toEqual([
      `-${RC1_TARGET.cleanLine}`,
      `+${RC1_TARGET.plantedLine}`,
    ]);
  });

  it("anchors the source fix: a plain update before it and the guarded updateMany after it", () => {
    const source = rule(SOURCE_RULES, RC1_SOURCE_RULE_ID);
    const method = (text: string): string[] => findMatches(source, text).map((match) => match.getMatch("METHOD")?.text() ?? "");
    expect(method(BEFORE)).toEqual(["update"]);
    expect(method(AFTER)).toEqual(["updateMany"]);
    expect(findMatches(rule(RULES, RC1_FIXED_RULE_ID), BEFORE)).toHaveLength(0);
    expect(findMatches(rule(RULES, RC1_FIXED_RULE_ID), AFTER)).toHaveLength(1);
  });
});

const require = createRequire(import.meta.url);
const CLI = join(dirname(require.resolve("@ast-grep/cli/package.json")), "ast-grep");

describe("RC-1 ast-grep CLI cross-check", () => {
  it("gives the same bytes from `ast-grep scan --update-all` as the napi rewrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "shapes-rc1-scan-"));
    scratch.push(dir);
    const copy = join(dir, "route.ts");
    writeFileSync(copy, ROUTE);
    const result = spawnSync(process.execPath, [CLI, "scan", "--update-all", "--rule", RC1_RULE_FILE, copy], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(readFileSync(copy, "utf8")).toBe(applyFix(rule(RULES, RC1_FIXED_RULE_ID), ROUTE));
    expect(readFileSync(copy, "utf8")).toBe(plant(ROUTE));
  });
});

describe("committed probe data for RC-1.atomic-backup-code", () => {
  const set = loadProbeSet(RC1_PROBE_DIR);

  it("records the mutation alone, from the pinned clean hash to the pinned planted hash", () => {
    expect(set.data.shape_id).toBe(RC1_SHAPE_ID);
    expect(set.data.target_path).toBe(RC1_TARGET.path);
    expect(set.data.host_commit).toBe(RC1_TARGET.hostCommit);
    expect(set.data.clean_sha256).toBe(CLEAN_SHA);
    expect(set.data.planted_sha256).toBe(PLANTED_SHA);
    expect([RC1_TARGET.sha256, RC1_TARGET.resultSha256]).toEqual([CLEAN_SHA, PLANTED_SHA]);
    expect(set.data.probes.map((probe) => [probe.id, probe.base_sha256, probe.result_sha256])).toEqual([
      ["mutation", CLEAN_SHA, PLANTED_SHA],
    ]);
    expect(set.data.fixed_reference).toMatchObject({ base_sha256: PLANTED_SHA, result_sha256: CLEAN_SHA });
  });

  it("ADM-06 is recorded as not applicable, with its reason", () => {
    expect(set.data.adm_06?.status).toBe("not_applicable");
    expect(set.data.adm_06?.reason).toMatch(/not applicable/);
  });

  it("names the race fixture's two checks: the serial control passes and the race fails with a double spend on the planted copy", () => {
    expect(set.data.checks).toEqual([...RC1_CHECK_IDS]);
    expect(RC1_CHECK_IDS).toEqual([RC1_SERIAL_CHECK_ID, RC1_CHECK_ID]);
    expect(set.data.probes[0]?.expected).toEqual({
      [RC1_SERIAL_CHECK_ID]: { outcome: "pass" },
      [RC1_CHECK_ID]: { outcome: "assertion_fail", reason: RC1_DOUBLE_SPEND_REASON },
    });
    expect(set.data.invalid_outcomes.outcomes).toEqual(["build_error", "crash", "missing_result", "setup_failure", "timeout"]);
  });

  it("has a mutation patch that changes line 97 of the target file in one hunk", () => {
    const [patch, ...rest] = parsePatch(set.patches.get("mutation") ?? "");
    expect(rest).toHaveLength(0);
    expect(patch?.oldFileName).toBe(`a/${RC1_TARGET.path}`);
    expect(patch?.newFileName).toBe(`b/${RC1_TARGET.path}`);
    expect(patch?.hunks).toHaveLength(1);
    expect(patch?.hunks[0]).toMatchObject({ oldStart: 94, oldLines: 7, newStart: 94, newLines: 7 });
    expect(patch?.hunks[0]?.lines.filter((line) => /^[-+]/.test(line))).toEqual([
      `-${RC1_TARGET.cleanLine}`,
      `+${RC1_TARGET.plantedLine}`,
    ]);
    expect(RC1_TARGET.line).toBe(97);
  });

  it("refuses a planted file with any other hash", () => {
    expect(checkProbes(set, Buffer.from(plant(ROUTE)))).toMatchObject({ status: "refused", reason: "base_hash_mismatch" });
  });
});

/** Writes a mutation-only probe set for the synthetic route, built the same way as the committed set. */
function syntheticProbeDir(edit: (data: Record<string, unknown>) => void = () => undefined): string {
  const planted = plant(ROUTE);
  const dir = mkdtempSync(join(tmpdir(), "shapes-rc1-probes-"));
  scratch.push(dir);
  const patch = structuredPatch(`a/${SYNTHETIC_PATH}`, `b/${SYNTHETIC_PATH}`, ROUTE, planted, undefined, undefined, { context: 3 });
  writeFileSync(join(dir, "mutation.patch"), formatPatch({ ...patch, isGit: true }));
  const data = JSON.parse(readFileSync(join(RC1_PROBE_DIR, "probes.json"), "utf8")) as Record<string, unknown> & {
    probes: Record<string, unknown>[];
  };
  data.target_path = SYNTHETIC_PATH;
  data.clean_sha256 = sha256(ROUTE);
  data.planted_sha256 = sha256(planted);
  data.fixed_reference = { ...(data.fixed_reference as object), base_sha256: sha256(planted), result_sha256: sha256(ROUTE) };
  data.probes = data.probes.map((probe) => ({ ...probe, base_sha256: sha256(ROUTE), result_sha256: sha256(planted) }));
  edit(data);
  writeFileSync(join(dir, "probes.json"), JSON.stringify(data));
  return dir;
}

describe("mutation-only probe set with ADM-06 not applicable", () => {
  it("confirms the mutation and its fixed reference, and carries the ADM-06 status into the record", () => {
    const outcome = checkProbes(loadProbeSet(syntheticProbeDir()), Buffer.from(plant(ROUTE)));
    expect(outcome.status).toBe("confirmed");
    if (outcome.status !== "confirmed") {
      return;
    }
    expect(outcome.record.probes.map((probe) => probe.id)).toEqual(["mutation"]);
    expect(outcome.record.fixed_reference.result_sha256).toBe(sha256(ROUTE));
    expect(outcome.record.adm_06?.status).toBe("not_applicable");
  });

  it("refuses a set that records ADM-06 as not applicable and still holds partial or stub probes", () => {
    const dir = syntheticProbeDir((data) => {
      const probes = data.probes as Record<string, unknown>[];
      data.probes = [...probes, { ...probes[0], id: "stub", patch: "mutation.patch" }];
    });
    expect(() => loadProbeSet(dir)).toThrow(ProbeDataError);
  });

  it("refuses an ADM-06 entry that is not a not_applicable status with a reason", () => {
    for (const adm06 of [{ status: "applicable", reason: "x" }, { status: "not_applicable" }, { status: "not_applicable", reason: "x", extra: 1 }, "n/a"]) {
      const dir = syntheticProbeDir((data) => {
        data.adm_06 = adm06;
      });
      expect(() => loadProbeSet(dir), JSON.stringify(adm06)).toThrow(ProbeDataError);
    }
  });
});
