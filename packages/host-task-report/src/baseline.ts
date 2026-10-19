// The pinned baseline of the task-report host: the vendored app's identity, its dependency
// manifests and the frozen original suite (test IDs and file hashes). Imports only node:
// built-ins, so it loads in the copy image.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffFiles, hashTree, isRecord, isSha256, sha256Hex, treeSha256 } from "./hash.ts";
import type { SuiteTest } from "./suite/report.ts";

export const BASELINE_FILE = fileURLToPath(new URL("../baseline/task-report-ca4a71f.json", import.meta.url));
export const BASELINE_FORMAT = "rbw.task-report.baseline.v1";
/** The original-suite runner's arguments after `test --config <config>`, as the freeze recorded them. */
export const RUN_CLI_ARGS: readonly string[] = ["--workers=1", "--retries=0", "--reporter=json", "--global-timeout=600000"];

export class BaselineError extends Error {
  override name = "BaselineError";
}

export interface Baseline {
  sha256: string;
  baseline_id: string;
  source: { path: string; commit: string; git_tree: string; file_count: number; tree_sha256: string; files: Record<string, string> };
  contract_sha256: string;
  dependency_manifests: string[];
  suite: {
    revision: string;
    files: Record<string, string>;
    tree_sha256: string;
    config_path: string;
    config_sha256: string;
    cli_args: string[];
    playwright_version: string;
    tests: SuiteTest[];
  };
  runtime: Record<string, string | number>;
}

function fileMap(value: unknown, what: string): Record<string, string> {
  if (!isRecord(value) || !Object.values(value).every(isSha256)) throw new BaselineError(`${what} is not a map of SHA-256 values`);
  return value as Record<string, string>;
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new BaselineError(`${what} is not a list of strings`);
  return value;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new BaselineError(`${what} is missing`);
  return value;
}

/** Parses and checks the manifest: internally consistent hashes, unique test IDs, the runner arguments. */
export function parseBaseline(bytes: Buffer): Baseline {
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new BaselineError("the baseline manifest is not JSON");
  }
  if (!isRecord(data) || data.format !== BASELINE_FORMAT) throw new BaselineError(`the baseline manifest is not ${BASELINE_FORMAT}`);
  const source = data.source;
  const suite = data.original_suite;
  const contract = data.contract;
  if (!isRecord(source) || !isRecord(suite) || !isRecord(contract) || !isRecord(suite.runner) || !isRecord(data.runtime)) {
    throw new BaselineError("the baseline manifest is missing a section");
  }
  const sourceFiles = fileMap(source.files, "source.files");
  if (source.tree_sha256 !== treeSha256(sourceFiles)) throw new BaselineError("source.tree_sha256 differs from source.files");
  if (source.file_count !== Object.keys(sourceFiles).length) throw new BaselineError("source.file_count differs from source.files");
  const suiteFiles = fileMap(suite.files, "original_suite.files");
  if (suite.tree_sha256 !== treeSha256(suiteFiles)) throw new BaselineError("original_suite.tree_sha256 differs from its files");
  for (const [path, hash] of Object.entries(suiteFiles)) {
    if (sourceFiles[path] !== hash) throw new BaselineError(`original suite file ${path} is not the baseline source's file`);
  }
  const runner = suite.runner;
  const cliArgs = stringList(runner.cli_args, "original_suite.runner.cli_args");
  if (cliArgs.join(" ") !== RUN_CLI_ARGS.join(" ")) throw new BaselineError("the recorded runner arguments differ from this runner's");
  const configPath = str(runner.config_path, "original_suite.runner.config_path");
  if (suiteFiles[configPath] !== runner.config_sha256) throw new BaselineError("the runner config hash differs from the suite file");
  if (!Array.isArray(suite.tests) || suite.tests.length === 0) throw new BaselineError("the baseline lists no original tests");
  const tests = suite.tests.map((test: unknown): SuiteTest => {
    if (!isRecord(test) || typeof test.id !== "string" || typeof test.file !== "string") throw new BaselineError("the baseline has a malformed test");
    return { id: test.id, file: test.file, title_path: stringList(test.title_path, "a test's title_path") };
  });
  if (suite.test_count !== tests.length) throw new BaselineError("original_suite.test_count differs from its tests");
  if (new Set(tests.map((test) => test.id)).size !== tests.length) throw new BaselineError("the baseline repeats a test ID");
  const manifests = stringList(data.dependency_manifests, "dependency_manifests");
  for (const path of manifests) {
    if (sourceFiles[path] === undefined) throw new BaselineError(`dependency manifest ${path} is not a baseline file`);
  }
  const runtime: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(data.runtime)) {
    if (typeof value !== "string" && typeof value !== "number") throw new BaselineError("runtime values must be strings or numbers");
    runtime[key] = value;
  }
  if (!isSha256(contract.sha256)) throw new BaselineError("contract.sha256 is missing");
  return {
    sha256: sha256Hex(bytes),
    baseline_id: str(data.baseline_id, "baseline_id"),
    source: {
      path: str(source.path, "source.path"),
      commit: str(source.commit, "source.commit"),
      git_tree: str(source.git_tree, "source.git_tree"),
      file_count: Object.keys(sourceFiles).length,
      tree_sha256: treeSha256(sourceFiles),
      files: sourceFiles,
    },
    contract_sha256: contract.sha256,
    dependency_manifests: manifests,
    suite: {
      revision: str(suite.revision, "original_suite.revision"),
      files: suiteFiles,
      tree_sha256: treeSha256(suiteFiles),
      config_path: configPath,
      config_sha256: str(runner.config_sha256, "original_suite.runner.config_sha256"),
      cli_args: cliArgs,
      playwright_version: str(runner.playwright_version, "original_suite.runner.playwright_version"),
      tests,
    },
    runtime,
  };
}

export function loadBaseline(path: string = BASELINE_FILE): Baseline {
  return parseBaseline(readFileSync(path));
}

/** Every difference between a directory and the baseline's original suite, or an empty list. */
export function suiteDifferences(dir: string, baseline: Baseline): string[] {
  const tree = hashTree(dir);
  const diff = diffFiles(tree.files, baseline.suite.files);
  const problems = [...diff.changed.map((p) => `changed: ${p}`), ...diff.missing.map((p) => `missing: ${p}`), ...diff.extra.map((p) => `extra: ${p}`)];
  if (problems.length === 0 && tree.tree_sha256 !== baseline.suite.tree_sha256) problems.push("tree_sha256 differs");
  return problems;
}

/** Every difference between an app tree and the baseline source, or an empty list (node_modules is skipped). */
export function sourceDifferences(dir: string, baseline: Baseline): string[] {
  const tree = hashTree(dir);
  const diff = diffFiles(tree.files, baseline.source.files);
  return [...diff.changed.map((p) => `changed: ${p}`), ...diff.missing.map((p) => `missing: ${p}`), ...diff.extra.map((p) => `extra: ${p}`)];
}

/**
 * The dependency manifests (package.json and package-lock.json) of a supplied app tree compared
 * with the baseline's. The copy image installs the baseline's dependencies, so a tree whose
 * manifests differ cannot be run as given; its copy is invalid.
 */
export function dependencyDifferences(dir: string, baseline: Baseline): string[] {
  const problems: string[] = [];
  for (const path of baseline.dependency_manifests) {
    const file = join(dir, path);
    if (!existsSync(file)) problems.push(`missing: ${path}`);
    else if (sha256Hex(readFileSync(file)) !== baseline.source.files[path]) problems.push(`changed: ${path}`);
  }
  return problems;
}
