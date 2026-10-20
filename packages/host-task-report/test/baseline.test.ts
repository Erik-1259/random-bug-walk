import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASELINE_FILE, BaselineError, RUN_CLI_ARGS, dependencyDifferences, loadBaseline, parseBaseline, sourceDifferences, suiteDifferences } from "../src/baseline.ts";
import { hashTree, sha256Hex } from "../src/hash.ts";
import { REPO_ROOT } from "../src/local/cli.ts";

const baseline = loadBaseline();
const appDir = join(REPO_ROOT, baseline.source.path);

function copyOf(paths: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "task-report-baseline-"));
  for (const path of paths) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    copyFileSync(join(appDir, path), join(dir, path));
  }
  return dir;
}

describe("baseline identity", () => {
  it("names the pinned commit, its git tree and 40 files", () => {
    expect(baseline.baseline_id).toBe("task-report@ca4a71f");
    expect(baseline.source).toMatchObject({
      path: "hosts/task-report/app",
      commit: "ca4a71fc4486ba68fda9fd9f5c13a5664edb36fa",
      git_tree: "f281f20356277e5f6bdbf0c7f4be6bac2fafa33a",
      file_count: 40,
    });
  });

  it("the vendored app is byte-identical to the manifest", () => {
    const tree = hashTree(appDir);
    expect(tree.files).toEqual(baseline.source.files);
    expect(tree.tree_sha256).toBe(baseline.source.tree_sha256);
    expect(sourceDifferences(appDir, baseline)).toEqual([]);
  });

  it("the README's contract section is the pinned contract", () => {
    const readme = readFileSync(join(appDir, "README.md"), "utf8");
    const marker = "## Contract\n\n";
    expect(sha256Hex(readme.slice(readme.indexOf(marker) + marker.length))).toBe(baseline.contract_sha256);
  });

  it("records the frozen original suite: 193 unique tests and its files, all inside the baseline", () => {
    expect(baseline.suite.revision).toBe("ordinary-v1");
    expect(baseline.suite.tests).toHaveLength(193);
    expect(new Set(baseline.suite.tests.map((test) => test.id)).size).toBe(193);
    expect(baseline.suite.tree_sha256).toBe("8ec1e3d58c3fb62e6de601c4b726201e38c11d697a15e0e86fc1808bd93812fc");
    expect(baseline.suite.playwright_version).toBe("1.63.0");
    expect(baseline.suite.cli_args).toEqual([...RUN_CLI_ARGS]);
    const suitePaths = Object.keys(baseline.suite.files);
    expect(suitePaths.filter((path) => !path.startsWith("test/"))).toEqual(["package.json", "playwright.config.ts", "tsconfig.json"]);
    expect(suitePaths.filter((path) => path.startsWith("test/"))).toHaveLength(9);
    for (const test of baseline.suite.tests) expect(baseline.suite.files[test.file], test.file).toBeDefined();
  });

  it("the vendored suite files equal the frozen suite, and any change is a difference", () => {
    const suite = copyOf(Object.keys(baseline.suite.files));
    expect(suiteDifferences(suite, baseline)).toEqual([]);
    writeFileSync(join(suite, "test/routing.spec.ts"), "// changed\n", { flag: "a" });
    writeFileSync(join(suite, "test/extra.spec.ts"), "\n");
    expect(suiteDifferences(suite, baseline)).toEqual(["changed: test/routing.spec.ts", "extra: test/extra.spec.ts"]);
  });

  it("detects changed or missing dependency manifests", () => {
    const tree = copyOf(Object.keys(baseline.source.files));
    expect(dependencyDifferences(tree, baseline)).toEqual([]);
    writeFileSync(join(tree, "package-lock.json"), "{}\n");
    expect(dependencyDifferences(tree, baseline)).toEqual(["changed: package-lock.json"]);
    const bare = copyOf(["package-lock.json"]);
    expect(dependencyDifferences(bare, baseline)).toEqual(["missing: package.json"]);
  });

  it("refuses a manifest whose hashes are not internally consistent", () => {
    const value = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as { source: { files: Record<string, string> } };
    value.source.files["README.md"] = "0".repeat(64);
    expect(() => parseBaseline(Buffer.from(JSON.stringify(value)))).toThrow(BaselineError);
  });
});
