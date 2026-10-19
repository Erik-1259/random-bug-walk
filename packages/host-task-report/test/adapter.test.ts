import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalDigest } from "@rbw/schema";
import { validateContract } from "@rbw/factory-contract/validate";
import type { DefName } from "@rbw/factory-contract";
import { applyPatch, parsePatch } from "diff";
import { describe, expect, it } from "vitest";
import { createTaskReportAdapter, taskReportAdapter } from "../adapter/adapter.ts";
import { CHECK_PACKAGE_ENTRY, CHECK_PACKAGE_FILES, checkPackageListing, checkSetSha256 } from "../adapter/check-package.ts";
import type { CollectedCopy, CopyPlan, UnpackedPair } from "../adapter/contract.ts";
import { COPY_COMMAND, COPY_DESTINATIONS, loadKitImage } from "../adapter/kit.ts";
import { FAILURE_CODE } from "../src/f3/data.ts";
import { sha256Hex, treeSha256 } from "../src/hash.ts";
import { COPY_ID } from "../v2/args.ts";
import { EXPECTED_CELLS } from "../v2/evaluate.ts";
import { loadProtocolV2 } from "../v2/protocol.ts";
import type { CopySummaryV2 } from "../v2/record.ts";
import { BUGGY_TARGET_SHA, BUGGY_TREE, CLEAN_TARGET_SHA, CLEAN_TREE, ENTRY_ID, TARGET, baseline, copyV2, instanceV2, nth, stateFiles } from "./support-v2.ts";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "rbw-adapter-test-"));
const adapter = createTaskReportAdapter({ workDir: work });
const entry = nth(adapter.catalog(), 0);
const protocolV2 = loadProtocolV2();
const kit = loadKitImage();

function errors(name: DefName, value: unknown): string[] {
  return validateContract(name, value);
}

function readSet(root: string, files: readonly { path: string; sha256: string }[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const file of files) {
    const bytes = readFileSync(join(root, file.path));
    expect(sha256Hex(bytes), file.path).toBe(file.sha256);
    out.set(file.path, bytes);
  }
  return out;
}

function listingOf(files: Record<string, string>): { path: string; sha256: string }[] {
  return Object.keys(files)
    .sort()
    .map((path) => ({ path, sha256: files[path] ?? "" }));
}

function unpacked(): UnpackedPair {
  return {
    bug_case_sha256: "b".repeat(64),
    validator_sha256: "c".repeat(64),
    pair_sha256: "d".repeat(64),
    states: {
      clean: { root: "/nonexistent/synthetic/clean", files: listingOf(stateFiles("clean")) },
      buggy: { root: "/nonexistent/synthetic/buggy", files: listingOf(stateFiles("buggy")) },
      fixed: { root: "/nonexistent/synthetic/fixed", files: listingOf(stateFiles("fixed")) },
    },
    evaluator: { root: "/nonexistent/synthetic/evaluator", files: checkPackageListing(pkg) },
    protocol: adapter.protocol(entry),
  };
}

/** Applies every file patch of a unified diff to a tree in memory. */
function applyTo(tree: Map<string, Buffer>, patchText: string): Map<string, Buffer> {
  const out = new Map(tree);
  for (const patch of parsePatch(patchText)) {
    const path = (patch.oldFileName ?? "").replace(/^a\//, "");
    const base = out.get(path);
    if (base === undefined) throw new Error(`no ${path}`);
    const result = applyPatch(base.toString("utf8"), patch);
    if (result === false) throw new Error(`patch does not apply to ${path}`);
    out.set(path, Buffer.from(result, "utf8"));
  }
  return out;
}

const treeOf = (tree: Map<string, Buffer>): string => treeSha256(Object.fromEntries([...tree].map(([path, bytes]) => [path, sha256Hex(bytes)])));

describe("baseline and catalog", () => {
  it("names the pinned baseline and its frozen original suite", () => {
    const identity = adapter.baseline();
    expect(identity).toEqual({
      host_id: "task-report",
      baseline_id: "task-report@ca4a71f",
      app_commit: "ca4a71fc4486ba68fda9fd9f5c13a5664edb36fa",
      original_suite: {
        suite_id: "task-report-original-suite-ordinary-v1",
        sha256: "8ec1e3d58c3fb62e6de601c4b726201e38c11d697a15e0e86fc1808bd93812fc",
        test_count: 193,
        test_ids_sha256: canonicalDigest(baseline.suite.tests.map((test) => test.id).sort()).sha256,
      },
    });
    expect(errors("BaselineIdentity", identity)).toEqual([]);
    expect(taskReportAdapter.baseline()).toEqual(identity);
  });

  it("has one F3 entry that targets the lost acknowledged change criterion, without an entry failure code", () => {
    expect(adapter.catalog()).toHaveLength(1);
    expect(entry).toMatchObject({ entry_id: ENTRY_ID, source_id: "task-report-concurrency", catalog_version: "2", host_id: "task-report", bug_type_id: "concurrency", difficulty: { status: "not_assessed" } });
    expect(entry.criteria).toEqual([{ criterion_id: "concurrency.lost-acknowledged-change", version: "1" }]);
    expect("failure_code" in entry).toBe(false);
    expect(errors("CatalogEntry", entry)).toEqual([]);
  });

  it("pins the planted change, the reference repair and the incident", () => {
    expect(entry.plant.targets).toEqual([{ path: TARGET, before_sha256: CLEAN_TARGET_SHA, after_sha256: BUGGY_TARGET_SHA }]);
    expect(entry.plant.patch_sha256).toBe(sha256Hex(entry.plant.patch));
    expect(entry.plant.patch_sha256).toBe("d901b154c44fcbed9735270529c143361fcfa48ebce36bb2b29b41cae6f11c78");
    expect(entry.reference_repair).toMatchObject({ kind: "revert", patch_sha256: "552b23d0ac417a6cc917ecc4806afd893236780419cc736b09369ad6fc41f82f", result_sha256: [{ path: TARGET, sha256: CLEAN_TARGET_SHA }] });
    expect(entry.incident).toEqual({ path: "incident.md", sha256: "eeb5deddff4582da215dc9c13c0afd49e25e355a6adebdbd197879a270eb9ed7" });
  });

  it("binds verification to the version 2 check set and protocol, and the environment to the kit image", () => {
    const listing = checkPackageListing(pkg);
    expect(entry.verification).toEqual({
      check_set_id: "task-report-f3",
      version: "2",
      check_set_sha256: checkSetSha256(listing),
      expected_vectors_sha256: canonicalDigest({ cells: EXPECTED_CELLS, trials: (JSON.parse(readFileSync(join(pkg, "data/f3.v1.json"), "utf8")) as { expected: unknown }).expected }).sha256,
      protocol_id: "f3-repeatability",
      protocol_sha256: protocolV2.sha256,
    });
    expect(entry.environment).toEqual({ kit_image: kit.reference, kit_image_digest: kit.digest, environment_sha256: canonicalDigest({ host_id: "task-report", kit_image_digest: kit.digest }).sha256 });
  });

  it("shows the client nothing that locates or explains the planted change", () => {
    const fields = [entry.presentation.title, entry.presentation.observed_failure, entry.presentation.how_checked, entry.presentation.repetition_summary];
    const text = fields.join("\n");
    for (const banned of [TARGET, "store.ts", "completions/", "FOR SHARE", "BEGIN", "ROLLBACK", "transaction", "lock", "gate", "pool", FAILURE_CODE, "f3"]) {
      expect(text.toLowerCase(), banned).not.toContain(banned.toLowerCase());
    }
    for (const field of fields) expect(field.trim().length).toBeGreaterThan(20);
  });

  it("declares the version 2 protocol from the catalog alone, and is always available", () => {
    const protocol = adapter.protocol(entry);
    expect(protocol).toEqual({
      protocol_id: "f3-repeatability",
      version: "2",
      sha256: protocolV2.sha256,
      per_state: { clean: { copies: 1, rounds_per_copy: 1, min_valid_runs: 1 }, buggy: { copies: 1, rounds_per_copy: 3, min_valid_runs: 3 }, fixed: { copies: 1, rounds_per_copy: 3, min_valid_runs: 3 } },
      valid_trial_rules: protocolV2.valid_trial_rules,
    });
    expect(errors("Protocol", protocol)).toEqual([]);
    expect(adapter.availability()).toEqual({ available: true, reason: null });
    expect(() => adapter.protocol({ ...entry, entry_id: "task-report-f3-999" })).toThrow();
    expect(() => adapter.protocol({ ...entry, verification: { ...entry.verification, protocol_sha256: "1".repeat(64) } })).toThrow();
  });
});

describe("bugCaseInputs", () => {
  it("gives the buggy tree with the unchanged original suite, the incident, provenance and the runtime", async () => {
    const inputs = await adapter.bugCaseInputs(entry);
    expect(errors("BugCaseInputs", inputs)).toEqual([]);
    expect(inputs).toMatchObject({ host_id: "task-report", entry_id: ENTRY_ID, baseline: adapter.baseline() });
    const source = readSet(inputs.source.root, inputs.source.files);
    expect(source.size).toBe(40);
    expect(treeOf(source)).toBe(BUGGY_TREE);
    expect(sha256Hex(source.get(TARGET) ?? "")).toBe(BUGGY_TARGET_SHA);
    for (const [path, hash] of Object.entries(baseline.suite.files)) expect(sha256Hex(source.get(path) ?? ""), path).toBe(hash);
    expect(inputs.source.files.map((file) => file.path)).toEqual([...inputs.source.files.map((file) => file.path)].sort());
    expect([...source.keys()].some((path) => path.startsWith(".git/") || path === ".git")).toBe(false);
    const incident = readSet(inputs.incident.root, inputs.incident.files);
    expect([...incident.keys()].sort()).toEqual(["incident.md", "provenance.json"]);
    expect(sha256Hex(incident.get("incident.md") ?? "")).toBe(entry.incident.sha256);
    expect(JSON.parse((incident.get("provenance.json") ?? "").toString("utf8"))).toMatchObject({ host_id: "task-report", baseline_id: "task-report@ca4a71f", app_commit: "ca4a71fc4486ba68fda9fd9f5c13a5664edb36fa", license: "MIT" });
    expect(inputs.runtime).toMatchObject({ kit_image: kit.reference, kit_image_digest: kit.digest });
    expect(inputs.runtime.setup.length).toBeGreaterThan(0);
  });

  it("writes each call's files to a new directory", async () => {
    const first = await adapter.bugCaseInputs(entry);
    const second = await adapter.bugCaseInputs(entry);
    expect(first.source.root).not.toBe(second.source.root);
    expect(first.source.files).toEqual(second.source.files);
  });

  it("contains no check, data, expected value, planted change or repair (sentinels)", async () => {
    const copy = mkdtempSync(join(tmpdir(), "rbw-adapter-sentinel-"));
    for (const dir of ["catalog", "data", "v2", "src", "baseline"]) cpSync(join(pkg, dir), join(copy, dir), { recursive: true });
    const sentinel = { check: "SENTINEL-CHECK-7F3A", data: "SENTINEL-DATA-91C2", protocol: "SENTINEL-PROTOCOL-44D0", planted: "SENTINEL-PLANTED-0B6E", repair: "SENTINEL-REPAIR-C5A9" };
    const tsFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? tsFiles(join(dir, name)) : name.endsWith(".ts") ? [join(dir, name)] : []));
    for (const file of [...tsFiles(join(copy, "src")), ...tsFiles(join(copy, "v2"))]) writeFileSync(file, `${readFileSync(file, "utf8")}// ${sentinel.check}\n`);
    const pin = (file: string): string => {
      const hash = sha256Hex(readFileSync(file));
      writeFileSync(`${file}.sha256`, `${hash}  ${file.slice(file.lastIndexOf("/") + 1)}\n`);
      return hash;
    };
    const dataFile = join(copy, "data/f3.v1.json");
    const dataValue = JSON.parse(readFileSync(dataFile, "utf8")) as { check: { observable: string } };
    dataValue.check.observable += ` ${sentinel.data}`;
    writeFileSync(dataFile, `${JSON.stringify(dataValue, null, 2)}\n`);
    const dataSha = pin(dataFile);
    const protocolFile = join(copy, "v2/protocol/f3-repeatability.v2.json");
    const protocolValue = JSON.parse(readFileSync(protocolFile, "utf8")) as { check: { data_sha256: string }; decision: { block: string } };
    protocolValue.check.data_sha256 = dataSha;
    protocolValue.decision.block += ` ${sentinel.protocol}`;
    writeFileSync(protocolFile, `${JSON.stringify(protocolValue, null, 2)}\n`);
    const protocolSha = pin(protocolFile);
    const planted = join(copy, "catalog/f3/planted.patch");
    writeFileSync(planted, `${sentinel.planted}\n${readFileSync(planted, "utf8")}`);
    const repair = join(copy, "catalog/f3/repair.patch");
    writeFileSync(repair, `${sentinel.repair}\n${readFileSync(repair, "utf8")}`);
    const catalogFile = join(copy, "catalog/v2.json");
    const catalogValue = JSON.parse(readFileSync(catalogFile, "utf8")) as { entries: Record<string, Record<string, unknown>>[] };
    const first = nth(catalogValue.entries, 0);
    Object.assign(first.check_set ?? {}, { data_sha256: dataSha, protocol_sha256: protocolSha });
    Object.assign(first.planted_patch ?? {}, { sha256: sha256Hex(readFileSync(planted)) });
    Object.assign(first.reference_repair ?? {}, { sha256: sha256Hex(readFileSync(repair)) });
    Object.assign(first.clean_reconstruction ?? {}, { sha256: sha256Hex(readFileSync(repair)) });
    writeFileSync(catalogFile, `${JSON.stringify(catalogValue, null, 2)}\n`);

    const marked = createTaskReportAdapter({ packageDir: copy, repoRoot: repo, workDir: join(copy, "work") });
    const markedEntry = nth(marked.catalog(), 0);
    const inputs = await marked.bugCaseInputs(markedEntry);
    const texts = [JSON.stringify(inputs), ...[...readSet(inputs.source.root, inputs.source.files).values(), ...readSet(inputs.incident.root, inputs.incident.files).values()].map((bytes) => bytes.toString("utf8"))];
    const everything = texts.join("\n");
    for (const value of Object.values(sentinel)) expect(everything, value).not.toContain(value);
    expect(everything).not.toContain(FAILURE_CODE);
    expect(everything).not.toContain('"expected"');
    expect(everything).not.toContain(nth(entry.plant.patch.split("\n"), 0));
    expect(everything).not.toContain(`--- a/${TARGET}`);
    // The buggy file is the planted one; the app's README states the contract's query, so the change is source-inferable (difficulty not assessed).
    expect(readFileSync(join(inputs.source.root, TARGET), "utf8")).not.toContain("SELECT t.id, COALESCE");

    const validator = await marked.validatorInputs(markedEntry);
    const material = [JSON.stringify(validator), ...[...readSet(validator.checks.root, validator.checks.files).values()].map((bytes) => bytes.toString("utf8"))].join("\n");
    for (const value of [sentinel.check, sentinel.data, sentinel.protocol, sentinel.repair]) expect(material, value).toContain(value);
  });
});

describe("validatorInputs", () => {
  it("gives the check package, the expected cells, the clean reconstruction, the reference repair and the protocol", async () => {
    const inputs = await adapter.validatorInputs(entry);
    expect(errors("ValidatorInputs", inputs)).toEqual([]);
    expect(inputs.checks.files).toEqual(checkPackageListing(pkg));
    readSet(inputs.checks.root, inputs.checks.files);
    expect(inputs.expected).toEqual(EXPECTED_CELLS);
    expect(inputs.reference_repair).toEqual(entry.reference_repair);
    expect(inputs.clean_reconstruction.patch_sha256).toBe(sha256Hex(inputs.clean_reconstruction.patch));
    expect(inputs.protocol).toEqual(adapter.protocol(entry));
  });

  it("rebuilds clean and fixed from the exported buggy source the way the harness does", async () => {
    const bug = await adapter.bugCaseInputs(entry);
    const validator = await adapter.validatorInputs(entry);
    const buggy = readSet(bug.source.root, bug.source.files);
    const clean = applyTo(buggy, validator.clean_reconstruction.patch);
    expect(treeOf(clean)).toBe(CLEAN_TREE);
    const fixed = applyTo(buggy, validator.reference_repair.patch);
    for (const result of validator.reference_repair.result_sha256) expect(sha256Hex(fixed.get(result.path) ?? "")).toBe(result.sha256);
    expect(treeOf(fixed)).toBe(CLEAN_TREE);
  });

  it("lists exactly the copy driver and every module it imports, the data file, the protocol, the baseline and the catalog", () => {
    const seen = new Set<string>();
    const visit = (path: string): void => {
      if (seen.has(path)) return;
      seen.add(path);
      const text = readFileSync(join(pkg, path), "utf8");
      for (const match of text.matchAll(/^(?:import|export)[^"']*?from\s+["'](\.{1,2}\/[^"']+)["']/gm)) {
        const spec = match[1] ?? "";
        visit(join(dirname(path), spec).replaceAll("\\", "/"));
      }
    };
    visit(CHECK_PACKAGE_ENTRY);
    const pinnedFiles = ["data/f3.v1.json", "data/f3.v1.json.sha256", "v2/protocol/f3-repeatability.v2.json", "v2/protocol/f3-repeatability.v2.json.sha256", "baseline/task-report-ca4a71f.json", "catalog/v2.json"];
    expect([...CHECK_PACKAGE_FILES].sort()).toEqual([...seen, ...pinnedFiles].sort());
    expect(CHECK_PACKAGE_FILES).not.toContain("package.json");
    expect(CHECK_PACKAGE_FILES.some((path) => path.startsWith("adapter/") || path.startsWith("catalog/f3/"))).toBe(false);
  });
});

describe("copyPlans", () => {
  it("places the harness-built tree as data with the check package, on the kit image, within the copy limits", () => {
    const pair = unpacked();
    for (const state of ["clean", "buggy", "fixed"] as const) {
      const plans = adapter.copyPlans(state, pair, pair.protocol);
      expect(plans).toHaveLength(1);
      const plan = nth(plans, 0);
      expect(errors("CopyPlan", plan)).toEqual([]);
      expect(plan.destinations).toEqual(COPY_DESTINATIONS);
      expect(plan).toMatchObject({ host_id: "task-report", state, image: { reference: kit.reference, digest: kit.digest } });
      expect(plan.files).toEqual(pair.states[state].files);
      expect(plan.evaluator_files).toEqual(pair.evaluator.files);
      expect(plan.copy_id).toMatch(COPY_ID);
      expect(plan.command).toEqual([COPY_COMMAND, "--state", state, "--copy-id", plan.copy_id, "--entry", ENTRY_ID]);
      expect(plan.limits.vcpus).toBeLessThanOrEqual(4);
      expect(plan.limits.memory_mb).toBeLessThanOrEqual(8192);
      expect(plan.limits.timeout_s).toBeLessThanOrEqual(720);
      expect(plan.limits.network).toBe("none");
      expect(adapter.copyPlans(state, pair, pair.protocol)).toEqual(plans);
    }
    expect(nth(adapter.copyPlans("clean", pair, pair.protocol), 0).copy_id).not.toBe(nth(adapter.copyPlans("buggy", pair, pair.protocol), 0).copy_id);
  });

  it("applies no patch and reads no tree: it maps whatever listing the harness built", () => {
    const pair = unpacked();
    pair.states.clean = { root: "/nonexistent/other", files: pair.states.buggy.files };
    expect(nth(adapter.copyPlans("clean", pair, pair.protocol), 0).files).toEqual(pair.states.buggy.files);
  });

  it("refuses a check package, a protocol or a buggy tree it does not know", () => {
    const pair = unpacked();
    const changed = unpacked();
    changed.evaluator.files = changed.evaluator.files.map((file, index) => (index === 0 ? { ...file, sha256: "7".repeat(64) } : file));
    expect(() => adapter.copyPlans("buggy", changed, changed.protocol)).toThrow();
    const extra = unpacked();
    extra.evaluator.files = [...extra.evaluator.files, { path: "package.json", sha256: "8".repeat(64) }];
    expect(() => adapter.copyPlans("buggy", extra, extra.protocol)).toThrow();
    expect(() => adapter.copyPlans("buggy", pair, { ...pair.protocol, sha256: "9".repeat(64) })).toThrow();
    const otherProtocol = unpacked();
    otherProtocol.protocol = { ...otherProtocol.protocol, version: "1" };
    expect(() => adapter.copyPlans("buggy", otherProtocol, pair.protocol)).toThrow();
    const unknown = unpacked();
    unknown.states.buggy = unknown.states.clean;
    expect(() => adapter.copyPlans("buggy", unknown, unknown.protocol)).toThrow();
  });
});

describe("collect", () => {
  const pair = unpacked();
  const planOf = (state: "clean" | "buggy" | "fixed"): CopyPlan => nth(adapter.copyPlans(state, pair, pair.protocol), 0);
  const resultsWith = (summary: CopySummaryV2 | null): string => {
    const dir = mkdtempSync(join(work, "results-"));
    if (summary !== null) writeFileSync(join(dir, "copy.json"), `${JSON.stringify(summary, null, 2)}\n`);
    return dir;
  };
  const collected = (plan: CopyPlan, results: string | null, over: Partial<CollectedCopy> = {}): CollectedCopy => ({
    copy_id: plan.copy_id,
    outcome: "ran",
    exit_code: 0,
    results_dir: results,
    image_digest: kit.digest,
    architecture: "arm64",
    started_at: "2030-01-01T00:00:00.000Z",
    finished_at: "2030-01-01T00:01:30.000Z",
    results_sha256: results === null ? null : "e".repeat(64),
    ...over,
  });
  const summaryFor = (plan: CopyPlan, main: typeof FAILURE_CODE | "pass"): CopySummaryV2 => {
    const count = plan.state === "clean" ? 1 : 3;
    const summary = copyV2(plan.state, Array.from({ length: count }, (_, index) => instanceV2(index + 1, main)), protocolV2.sha256, sha256Hex(readFileSync(join(pkg, "catalog/v2.json"))));
    summary.copy_id = plan.copy_id;
    return summary;
  };

  it("evaluates a copy's record set into a complete record with the results hash as its evidence", async () => {
    const plan = planOf("buggy");
    expect(errors("CollectedCopy", collected(plan, resultsWith(null)))).toEqual([]);
    expect(errors("CollectedCopy", collected(plan, null, { outcome: "setup_failed", exit_code: null }))).toEqual([]);
    const record = await adapter.collect(plan, collected(plan, resultsWith(summaryFor(plan, FAILURE_CODE))));
    expect(errors("CopyRecord", record)).toEqual([]);
    expect(record).toMatchObject({ copy_id: plan.copy_id, state: "buggy", status: "complete", image_digest: kit.digest, architecture: "arm64", evidence_sha256: "e".repeat(64) });
    expect(record.verification).toMatchObject({ observed: "fail", failure_codes: [FAILURE_CODE], runs_valid: 3, runs_total: 3 });
    expect(record.original_suite).toMatchObject({ observed: "pass", executed: 579, expected: 579, suite_sha256: baseline.suite.tree_sha256 });
  });

  it("makes a setup failure invalid and a timeout incomplete, never a pass or a detection", async () => {
    const plan = planOf("buggy");
    const setup = await adapter.collect(plan, collected(plan, null, { outcome: "setup_failed", exit_code: null }));
    expect(setup).toMatchObject({ status: "invalid", original_suite: { observed: "error" }, verification: { observed: "error" } });
    expect(errors("CopyRecord", setup)).toEqual([]);
    const timeout = await adapter.collect(plan, collected(plan, null, { outcome: "timed_out", exit_code: null }));
    expect(timeout).toMatchObject({ status: "incomplete", original_suite: { observed: "incomplete" }, verification: { observed: "incomplete" } });
    expect(errors("CopyRecord", timeout)).toEqual([]);
  });

  it("is invalid without a usable record set, after a failed exit, for another copy or on another image", async () => {
    const plan = planOf("fixed");
    expect((await adapter.collect(plan, collected(plan, resultsWith(null)))).status).toBe("invalid");
    const bad = resultsWith(null);
    writeFileSync(join(bad, "copy.json"), "{not json");
    expect((await adapter.collect(plan, collected(plan, bad))).status).toBe("invalid");
    const good = resultsWith(summaryFor(plan, "pass"));
    expect((await adapter.collect(plan, collected(plan, good))).status).toBe("complete");
    expect((await adapter.collect(plan, collected(plan, good, { exit_code: 1 }))).status).toBe("invalid");
    expect((await adapter.collect(plan, collected(plan, good, { copy_id: "f3q2-other" }))).status).toBe("invalid");
    expect((await adapter.collect(plan, collected(plan, good, { image_digest: `sha256:${"f".repeat(64)}` }))).status).toBe("invalid");
  });

  it("is incomplete when the copy ran another tree than the plan's state", async () => {
    const plan = planOf("buggy");
    const summary = summaryFor(plan, FAILURE_CODE);
    summary.source_files = stateFiles("clean");
    summary.source_tree_sha256 = CLEAN_TREE;
    expect((await adapter.collect(plan, collected(plan, resultsWith(summary)))).status).toBe("incomplete");
  });
});

describe("interpret", () => {
  const record = (state: "clean" | "buggy" | "fixed", status: "complete" | "invalid" | "incomplete", checks: "pass" | "fail" | "error" | "incomplete") => ({
    copy_id: `f3q2-synthetic-${state}-1`,
    state,
    status,
    original_suite: { observed: checks === "fail" ? ("pass" as const) : checks, runs_valid: 3, runs_total: 3, failure_codes: [], detail: "", executed: 579, expected: 579, failing_test_ids: [], suite_sha256: baseline.suite.tree_sha256 },
    verification: { observed: checks, runs_valid: 3, runs_total: 3, failure_codes: checks === "fail" ? [FAILURE_CODE] : [], detail: "" },
    image_digest: kit.digest,
    architecture: "arm64" as const,
    started_at: "2030-01-01T00:00:00.000Z",
    finished_at: "2030-01-01T00:01:30.000Z",
    evidence_sha256: "e".repeat(64),
  });
  const protocol = adapter.protocol(entry);

  it("combines a state's copy records under the declared protocol", () => {
    const cells = adapter.interpret([record("buggy", "complete", "fail")], protocol);
    expect(cells.original_suite).toMatchObject({ observed: "pass", runs_valid: 3, runs_total: 3 });
    expect(cells.verification).toMatchObject({ observed: "fail", failure_codes: [FAILURE_CODE] });
    expect(errors("CellObservation", cells.verification)).toEqual([]);
  });

  it("keeps invalid and incomplete apart", () => {
    expect(adapter.interpret([record("buggy", "invalid", "error")], protocol).verification.observed).toBe("error");
    expect(adapter.interpret([record("buggy", "incomplete", "incomplete")], protocol).verification.observed).toBe("incomplete");
    expect(adapter.interpret([], protocol).verification.observed).toBe("incomplete");
  });

  it("is incomplete under another protocol", () => {
    const cells = adapter.interpret([record("buggy", "complete", "fail")], { ...protocol, sha256: "1".repeat(64) });
    expect(cells.original_suite.observed).toBe("incomplete");
    expect(cells.verification.observed).toBe("incomplete");
    const counts = adapter.interpret([record("buggy", "complete", "fail")], { ...protocol, per_state: { ...protocol.per_state, buggy: { copies: 1, rounds_per_copy: 1, min_valid_runs: 1 } } });
    expect(counts.verification.observed).toBe("incomplete");
  });
});

describe("work directory", () => {
  it("creates its default work directory only when a bug case is written", () => {
    const lazy = createTaskReportAdapter({ workDir: join(work, "lazy", "nested") });
    lazy.catalog();
    expect(existsSync(join(work, "lazy", "nested"))).toBe(false);
    mkdirSync(join(work, "lazy"), { recursive: true });
  });
});
