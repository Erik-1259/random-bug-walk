import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBaseline } from "../src/baseline.ts";
import { CatalogError, applyChecked, deriveState, loadCatalog, readBaselineTree } from "../src/catalog.ts";
import type { CatalogEntry } from "../src/catalog.ts";
import { FAILURE_CODE, loadData } from "../src/f3/data.ts";
import { sha256Hex, treeSha256 } from "../src/hash.ts";
import { loadProtocol } from "../src/protocol.ts";
import { REPO_ROOT } from "../src/local/cli.ts";

const baseline = loadBaseline();
const catalog = loadCatalog();
const files = readBaselineTree(join(REPO_ROOT, baseline.source.path), baseline);
const target = "src/completions/store.ts";

function entry(): CatalogEntry {
  const [first] = catalog.entries;
  if (first === undefined) throw new Error("no entry");
  return first;
}

function treeOf(state: Map<string, Buffer>): string {
  return treeSha256(Object.fromEntries([...state].map(([path, bytes]) => [path, sha256Hex(bytes)])));
}

describe("catalog v1", () => {
  it("has one F3 entry bound to the check, its data file, its protocol and the baseline", () => {
    expect(catalog.baseline_id).toBe(baseline.baseline_id);
    expect(catalog.entries).toHaveLength(1);
    const f3 = entry();
    expect(f3).toMatchObject({
      entry_id: "task-report-f3-001",
      bug_type: "concurrency",
      criterion: { id: "concurrency.lost-acknowledged-change", version: 1 },
      failure_code: FAILURE_CODE,
      target_path: target,
      difficulty: "not_assessed",
      source_inferable: true,
    });
    const data = loadData();
    expect(f3.check.id).toBe(data.check.id);
    expect(f3.criterion).toEqual(data.check.criterion);
    expect(loadProtocol().data_sha256).toBe(data.sha256);
  });

  it("pins the baseline file, the buggy file and the repair result", () => {
    const f3 = entry();
    expect(f3.baseline_sha256).toBe("5424120c0110adf3a755fe6a1aed2fcd99d87565dce1c4c84a5d62965f67f93f");
    expect(baseline.source.files[target]).toBe(f3.baseline_sha256);
    expect(f3.buggy_sha256).toBe("22eb94274610254f2aee10463418af669afb46a1579468cfb11726d7baa3d71c");
    expect(f3.repair).toMatchObject({ kind: "reverse_of_planted", result_sha256: f3.baseline_sha256 });
  });
});

describe("code states", () => {
  it("clean is the vendored baseline", () => {
    const clean = deriveState(entry(), files, "clean");
    expect(treeOf(clean.files)).toBe(baseline.source.tree_sha256);
  });

  it("buggy changes only the target file, to the pinned planted bytes", () => {
    const buggy = deriveState(entry(), files, "buggy");
    expect(buggy.target_sha256).toBe(entry().buggy_sha256);
    expect(sha256Hex(buggy.files.get(target) ?? Buffer.alloc(0))).toBe(entry().buggy_sha256);
    const changed = [...buggy.files].filter(([path, bytes]) => !bytes.equals(files.get(path) ?? Buffer.alloc(0))).map(([path]) => path);
    expect(changed).toEqual([target]);
    expect(treeOf(buggy.files)).not.toBe(baseline.source.tree_sha256);
  });

  it("the reference repair applied to the buggy file gives back exactly the baseline bytes", () => {
    const fixed = deriveState(entry(), files, "fixed");
    expect(fixed.files.get(target)?.equals(files.get(target) ?? Buffer.alloc(0))).toBe(true);
    expect(sha256Hex(fixed.files.get(target) ?? Buffer.alloc(0))).toBe("5424120c0110adf3a755fe6a1aed2fcd99d87565dce1c4c84a5d62965f67f93f");
    expect(treeOf(fixed.files)).toBe(baseline.source.tree_sha256);
  });

  it("the repair is the planted patch reversed", () => {
    const flip = (line: string): string => (line.startsWith("+") && !line.startsWith("+++") ? `-${line.slice(1)}` : line.startsWith("-") && !line.startsWith("---") ? `+${line.slice(1)}` : line);
    const body = (text: string): string[] => text.split("\n").filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));
    expect(body(entry().repair.text).sort()).toEqual(body(entry().planted.text).map(flip).sort());
  });

  it("refuses a base whose hash differs, a patch for another file and a result whose hash differs", () => {
    const f3 = entry();
    const base = files.get(target) ?? Buffer.alloc(0);
    expect(() => applyChecked(Buffer.concat([base, Buffer.from("\n")]), f3.planted.text, target, f3.baseline_sha256, f3.buggy_sha256)).toThrow(CatalogError);
    expect(() => applyChecked(base, f3.planted.text.replaceAll(target, "src/reports/store.ts"), target, f3.baseline_sha256, f3.buggy_sha256)).toThrow(/only/);
    expect(() => applyChecked(base, f3.planted.text, target, f3.baseline_sha256, f3.baseline_sha256)).toThrow(/differs/);
  });
});

describe("incident description", () => {
  it("describes only the user-visible symptom", () => {
    const text = entry().incident.text;
    expect(text).toMatch(/201/);
    expect(text).toMatch(/daily completion report/);
    for (const hint of [/\bsrc\//, /\.ts\b/, /store/i, /insertCompletion/, /\bquery\b/i, /\bSQL\b/, /\bSELECT\b/, /\bINSERT\b/, /transaction/i, /BEGIN|COMMIT|ROLLBACK/, /\bpool\b/i, /connection/i, /\bfix/i, /\block/i]) {
      expect(text, String(hint)).not.toMatch(hint);
    }
  });
});
