// A local stand-in for the package harness's state building, for this package's own qualification
// runs: from the adapter's bug case and validator inputs (no archives), each state gets a fresh
// directory. Buggy is the bug case source as given; clean is the clean reconstruction applied to
// that buggy source, and fixed is the reference repair applied to it, with every changed path
// checked against the repair's result hashes. The evaluator directory holds the validator's check
// files. Patches are applied as data with the diff library; nothing in them is run. The package
// harness (planned, in the package tooling) does the same from the two exported archives.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalDigest } from "@rbw/schema";
import { applyPatch, parsePatch } from "diff";
import { sha256Hex } from "../src/hash.ts";
import type { BugCaseInputs, FileDigest, FileSet, UnpackedPair, ValidatorInputs } from "./contract.ts";

export class HarnessError extends Error {
  override name = "HarnessError";
}

function copySet(set: FileSet, into: string): void {
  for (const file of set.files) {
    const bytes = readFileSync(join(set.root, file.path));
    if (sha256Hex(bytes) !== file.sha256) throw new HarnessError(`${file.path} differs from its listed SHA-256`);
    mkdirSync(dirname(join(into, file.path)), { recursive: true });
    copyFileSync(join(set.root, file.path), join(into, file.path));
  }
}

/** Applies a unified diff to files under root; returns the changed paths. Only in-place changes of existing files are allowed. */
export function applyPatchInPlace(root: string, patchText: string): string[] {
  const changed: string[] = [];
  for (const patch of parsePatch(patchText)) {
    const oldName = patch.oldFileName ?? "";
    const newName = patch.newFileName ?? "";
    if (!oldName.startsWith("a/") || newName !== `b/${oldName.slice(2)}` || patch.hunks.length === 0) throw new HarnessError("the patch may only change existing files in place");
    const path = oldName.slice(2);
    const file = join(root, path);
    if (!existsSync(file)) throw new HarnessError(`the patch changes ${path}, which the tree does not have`);
    const result = applyPatch(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file)), patch);
    if (result === false) throw new HarnessError(`the patch does not apply to ${path}`);
    writeFileSync(file, result);
    changed.push(path);
  }
  if (changed.length === 0) throw new HarnessError("the patch changes no file");
  return changed;
}

function listing(root: string, files: readonly FileDigest[], changed: readonly string[]): FileDigest[] {
  return files.map((file) => (changed.includes(file.path) ? { path: file.path, sha256: sha256Hex(readFileSync(join(root, file.path))) } : { ...file }));
}

/** Builds the three states and the evaluator directory under `dir` (which must not exist yet). */
export function buildLocalPair(dir: string, bug: BugCaseInputs, validator: ValidatorInputs): UnpackedPair {
  if (existsSync(dir)) throw new HarnessError(`${dir} already exists`);
  if (bug.host_id !== validator.host_id || bug.entry_id !== validator.entry_id) throw new HarnessError("the bug case and validator inputs are not a pair");
  if (sha256Hex(validator.clean_reconstruction.patch) !== validator.clean_reconstruction.patch_sha256) throw new HarnessError("the clean reconstruction differs from its SHA-256");
  if (sha256Hex(validator.reference_repair.patch) !== validator.reference_repair.patch_sha256) throw new HarnessError("the reference repair differs from its SHA-256");
  const roots = { buggy: join(dir, "buggy"), clean: join(dir, "clean"), fixed: join(dir, "fixed"), evaluator: join(dir, "evaluator") };
  copySet(bug.source, roots.buggy);
  copySet(bug.source, roots.clean);
  copySet(bug.source, roots.fixed);
  copySet(validator.checks, roots.evaluator);
  const clean = applyPatchInPlace(roots.clean, validator.clean_reconstruction.patch);
  const fixed = applyPatchInPlace(roots.fixed, validator.reference_repair.patch);
  for (const result of validator.reference_repair.result_sha256) {
    if (!fixed.includes(result.path) || sha256Hex(readFileSync(join(roots.fixed, result.path))) !== result.sha256) throw new HarnessError(`the reference repair's result for ${result.path} differs from its pinned SHA-256`);
  }
  if (fixed.length !== validator.reference_repair.result_sha256.length) throw new HarnessError("the reference repair changes a path its result hashes do not list");
  const strip = (set: FileSet): unknown => set.files;
  const bugSha = canonicalDigest({ local_inputs: "bug_case", host_id: bug.host_id, entry_id: bug.entry_id, baseline: bug.baseline, source: strip(bug.source), incident: strip(bug.incident), runtime: bug.runtime }).sha256;
  const validatorSha = canonicalDigest({ local_inputs: "validator", host_id: validator.host_id, entry_id: validator.entry_id, checks: strip(validator.checks), expected: validator.expected, clean_reconstruction: validator.clean_reconstruction.patch_sha256, reference_repair: validator.reference_repair, protocol: validator.protocol }).sha256;
  return {
    bug_case_sha256: bugSha,
    validator_sha256: validatorSha,
    pair_sha256: canonicalDigest({ bug_case_sha256: bugSha, validator_sha256: validatorSha }).sha256,
    states: {
      buggy: { root: roots.buggy, files: listing(roots.buggy, bug.source.files, []) },
      clean: { root: roots.clean, files: listing(roots.clean, bug.source.files, clean) },
      fixed: { root: roots.fixed, files: listing(roots.fixed, bug.source.files, fixed) },
    },
    evaluator: { root: roots.evaluator, files: validator.checks.files.map((file) => ({ ...file })) },
    protocol: validator.protocol,
  };
}
