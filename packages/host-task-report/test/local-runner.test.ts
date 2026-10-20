// The local Docker runner's results hash, against a stand-in docker CLI: a collected copy's
// results_sha256 is the SHA-256 of the deterministic results archive the shared runners report,
// over every entry of the results tree, and collect records it as the copy's evidence.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resultsSha256 } from "@rbw/case-package";
import { describe, expect, it } from "vitest";
import { createTaskReportAdapter } from "../adapter/adapter.ts";
import type { CollectedCopy, CopyPlan, CopyRoots, UnpackedPair } from "../adapter/contract.ts";
import { loadKitImage } from "../adapter/kit.ts";
import { createLocalDockerRunner } from "../adapter/local-runner.ts";
import { FAILURE_CODE } from "../src/f3/data.ts";
import { hashTree, sha256Hex } from "../src/hash.ts";
import { loadProtocolV2 } from "../v2/protocol.ts";
import { COPY_V2_FILE } from "../v2/record.ts";
import { copyV2, instanceV2, nth } from "./support-v2.ts";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "rbw-local-runner-test-"));
const adapter = createTaskReportAdapter({ workDir: mkdtempSync(join(work, "adapter-")) });
const kit = loadKitImage();
const entry = nth(adapter.catalog(), 0);

/** The adapter's buggy copy plan and the roots its files are read from, as the harness hands them over. */
async function buggyPlan(): Promise<{ plan: CopyPlan; roots: CopyRoots }> {
  const bug = await adapter.bugCaseInputs(entry);
  const validator = await adapter.validatorInputs(entry);
  const protocol = adapter.protocol(entry);
  const pair: UnpackedPair = {
    bug_case_sha256: "b".repeat(64),
    validator_sha256: "c".repeat(64),
    pair_sha256: "d".repeat(64),
    states: { clean: bug.source, buggy: bug.source, fixed: bug.source },
    evaluator: validator.checks,
    protocol,
  };
  return { plan: nth(adapter.copyPlans("buggy", pair, protocol), 0), roots: { app_root: bug.source.root, evaluator_root: validator.checks.root } };
}

const { plan, roots } = await buggyPlan();

/** A docker CLI on which the pinned kit image is present, every step succeeds and the copy leaves `results`. */
function stubDocker(results: string): string {
  const path = join(mkdtempSync(join(work, "docker-")), "docker");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      `  image) echo "${kit.digest} ${kit.architecture}" ;;`,
      "  inspect) echo 0 ;;",
      `  cp) case "$2" in *:/*) cp -R '${results}' "$3" ;; esac ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

/** The files of a results tree: the copy's record set and one file under each name the earlier tree hash skipped. */
const SKIPPED = ["node_modules/dep/index.js", "test-results/run.txt", ".DS_Store"] as const;

function resultsTree(changed?: string): string {
  const dir = mkdtempSync(join(work, "results-"));
  const summary = copyV2("buggy", [1, 2, 3].map((number) => instanceV2(number, FAILURE_CODE)), loadProtocolV2().sha256, sha256Hex(readFileSync(join(pkg, "catalog/v2.json"))));
  summary.copy_id = plan.copy_id;
  const files: [string, string][] = [[COPY_V2_FILE, `${JSON.stringify(summary, null, 2)}\n`], ...SKIPPED.map((path): [string, string] => [path, "one\n"])];
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), path === changed ? "two\n" : text);
  }
  return dir;
}

function run(results: string): Promise<CollectedCopy> {
  return createLocalDockerRunner({ outDir: mkdtempSync(join(work, "copies-")), docker: stubDocker(results) }).run(plan, roots);
}

describe("the local runner's results hash", () => {
  it("is the SHA-256 of the results archive the shared runners report, and collect records it as the evidence", async () => {
    const results = resultsTree();
    const archive = await resultsSha256(results);
    // The fixture tells the two hashes apart: the tree hash of the results directory is not the archive hash.
    expect(hashTree(results).tree_sha256).not.toBe(archive);
    const collected = await run(results);
    expect(collected).toMatchObject({ copy_id: plan.copy_id, outcome: "ran", exit_code: 0, image_digest: kit.digest, architecture: kit.architecture });
    expect(collected.results_dir).not.toBeNull();
    expect(collected.results_sha256).toBe(archive);
    expect(await resultsSha256(collected.results_dir ?? "")).toBe(archive);
    expect(await adapter.collect(plan, collected)).toMatchObject({ copy_id: plan.copy_id, status: "complete", evidence_sha256: archive });
  });

  it.each(SKIPPED)("changes when only %s changes", async (path) => {
    const before = await run(resultsTree());
    const after = await run(resultsTree(path));
    expect(before.results_sha256).not.toBeNull();
    expect(after.results_sha256).not.toBeNull();
    expect(after.results_sha256).not.toBe(before.results_sha256);
    expect(after.results_sha256).toBe(await resultsSha256(after.results_dir ?? ""));
  });

  it("keeps and hashes a results tree that holds a link, as the shared runners do", async () => {
    const results = resultsTree();
    symlinkSync(COPY_V2_FILE, join(results, "latest.json"));
    const collected = await run(results);
    expect(collected.results_dir).not.toBeNull();
    expect(collected.results_sha256).toBe(await resultsSha256(results));
  });
});
