import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { RuleFileError, applyFix, findMatches, loadRules, type LoadedRule } from "../../src/rules.ts";
import { FIXED_RULE_ID, PLANTED_RULE_ID, RULE_FILE, SOURCE_RULE_FILE, SOURCE_RULE_ID } from "../../src/shape.ts";
import { RULE, TARGET, plant } from "./support.ts";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const TEST_DIR = join(PACKAGE_DIR, "rule-tests");

interface RuleTestCase {
  id: string;
  valid: string[];
  invalid: string[];
}

function allRules(): Map<string, LoadedRule> {
  return new Map([...loadRules(RULE), ...loadRules(readFileSync(SOURCE_RULE_FILE))]);
}

function ruleTestFiles(): RuleTestCase[] {
  return readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => parse(readFileSync(join(TEST_DIR, name), "utf8")) as RuleTestCase);
}

function rule(id: string): LoadedRule {
  const found = allRules().get(id);
  if (found === undefined) {
    throw new Error(`rule ${id} not loaded`);
  }
  return found;
}

describe("rule files", () => {
  it("defines the fixed-form rule with its fix and the planted-form rule in one file", () => {
    const rules = loadRules(RULE);
    expect([...rules.keys()]).toEqual([FIXED_RULE_ID, PLANTED_RULE_ID]);
    expect(rules.get(FIXED_RULE_ID)?.fix).toBe("getDateSQL($FIELD, $UNIT)");
    expect(rules.get(PLANTED_RULE_ID)?.fix).toBeUndefined();
    expect(rules.get(FIXED_RULE_ID)?.metadata).toMatchObject({ shape_id: "DT-1.tz-arg" });
    expect(loadRules(readFileSync(SOURCE_RULE_FILE)).get(SOURCE_RULE_ID)?.language).toBe("Tsx");
  });

  it("covers every rule with valid and invalid test cases", () => {
    expect(ruleTestFiles().map((file) => file.id)).toEqual([FIXED_RULE_ID, PLANTED_RULE_ID, SOURCE_RULE_ID]);
    for (const file of ruleTestFiles()) {
      expect(file.valid.length).toBeGreaterThan(0);
      expect(file.invalid.length).toBeGreaterThan(0);
    }
  });

  it("matches no valid case and every invalid case through the napi engine", () => {
    for (const file of ruleTestFiles()) {
      for (const code of file.valid) {
        expect(findMatches(rule(file.id), code), `${file.id} valid case:\n${code}`).toHaveLength(0);
      }
      for (const code of file.invalid) {
        expect(findMatches(rule(file.id), code).length, `${file.id} invalid case:\n${code}`).toBeGreaterThan(0);
      }
    }
  });

  it("gives the CLI snapshot's fixed output when the napi engine applies the fix template", () => {
    const snapshot = parse(readFileSync(join(TEST_DIR, "__snapshots__", "dt-1.tz-arg-snapshot.yml"), "utf8")) as {
      snapshots: Record<string, { fixed?: string }>;
    };
    const entries = Object.entries(snapshot.snapshots);
    expect(entries.length).toBeGreaterThan(0);
    for (const [code, expected] of entries) {
      expect(applyFix(rule(FIXED_RULE_ID), code)).toBe(expected.fixed);
    }
  });

  it("throws RuleFileError for malformed rule files", () => {
    expect(() => loadRules(Buffer.from("id: [unclosed"))).toThrow(RuleFileError);
    expect(() => loadRules(Buffer.from("language: TypeScript\nrule:\n  pattern: f()\n"))).toThrow(RuleFileError);
    expect(() => loadRules(Buffer.from("id: x\nlanguage: Cobol\nrule:\n  pattern: f()\n"))).toThrow(RuleFileError);
    expect(() => loadRules(Buffer.from("id: x\nlanguage: TypeScript\nrule:\n  nonsense: 1\n"))).toThrow(RuleFileError);
    expect(() => loadRules(Buffer.from("id: x\nlanguage: TypeScript\nrule: {pattern: f()}\n---\nid: x\nlanguage: TypeScript\nrule: {pattern: g()}\n"))).toThrow(RuleFileError);
    expect(() => loadRules(Buffer.from(""))).toThrow(RuleFileError);
  });

  it("throws RuleFileError when the fix names an unbound metavariable", () => {
    const loaded = loadRules(Buffer.from("id: x\nlanguage: TypeScript\nrule: {pattern: f($A)}\nfix: g($B)\n")).get("x");
    if (loaded === undefined) {
      throw new Error("rule x not loaded");
    }
    expect(() => applyFix(loaded, "f(1);")).toThrow(RuleFileError);
  });
});

const require = createRequire(import.meta.url);
const CLI = join(dirname(require.resolve("@ast-grep/cli/package.json")), "ast-grep");

function astGrep(args: string[], cwd = PACKAGE_DIR): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout };
}

describe("ast-grep CLI cross-check", () => {
  it("passes `ast-grep test` for every rule", () => {
    const result = astGrep(["test"]);
    expect(result.stdout).toContain("test result: ok. 3 passed; 0 failed;");
    expect(result.status).toBe(0);
  });

  it("gives the same bytes from `ast-grep scan --update-all` as the napi rewrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "shapes-scan-"));
    try {
      const copy = join(dir, "target.ts");
      writeFileSync(copy, TARGET);
      const result = astGrep(["scan", "--update-all", "--rule", RULE_FILE, copy]);
      expect(result.status).toBe(0);
      const napi = applyFix(rule(FIXED_RULE_ID), TARGET);
      expect(readFileSync(copy, "utf8")).toBe(napi);
      expect(napi).toBe(plant(TARGET));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
