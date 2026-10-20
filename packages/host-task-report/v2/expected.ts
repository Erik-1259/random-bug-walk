// The source tree each code state of a catalog entry must run, as tree hashes (the same canonical
// tree hash the baseline manifest pins): clean is the baseline tree, buggy the baseline with the
// target file at its planted SHA-256, and fixed the baseline with the target file at the reference
// repair's result. The copy driver records the tree for its state; the evaluation recomputes it
// from its own baseline manifest and catalog. Pure apart from its imports of node: built-ins.
import { treeSha256 } from "../src/hash.ts";
import type { Baseline } from "../src/baseline.ts";
import type { CodeState } from "../src/f3/data.ts";
import { entryPins } from "./entry.ts";
import type { CatalogPins, EntryPins } from "./entry.ts";

export interface StateExpectation {
  entry_id: string;
  catalog_sha256: string;
  baseline_id: string;
  /** The original suite's tree hash in the baseline manifest. */
  suite_sha256: string;
  trees: Record<CodeState, string>;
}

export class ExpectationError extends Error {
  override name = "ExpectationError";
}

export function expectedTrees(baselineFiles: Readonly<Record<string, string>>, pins: EntryPins): Record<CodeState, string> {
  if (baselineFiles[pins.target_path] === undefined) throw new ExpectationError(`the baseline has no ${pins.target_path}`);
  if (baselineFiles[pins.target_path] !== pins.baseline_sha256) throw new ExpectationError(`the entry's base for ${pins.target_path} is not the baseline's file`);
  const withTarget = (sha256: string): string => treeSha256({ ...baselineFiles, [pins.target_path]: sha256 });
  return { clean: treeSha256(baselineFiles), buggy: withTarget(pins.buggy_sha256), fixed: withTarget(pins.repair_result_sha256) };
}

export function stateExpectation(baseline: Baseline, catalog: CatalogPins, entryId: string): StateExpectation {
  if (catalog.baseline_id !== baseline.baseline_id) throw new ExpectationError("the catalog names another baseline");
  const pins = entryPins(catalog, entryId);
  return {
    entry_id: pins.entry_id,
    catalog_sha256: catalog.sha256,
    baseline_id: baseline.baseline_id,
    suite_sha256: baseline.suite.tree_sha256,
    trees: expectedTrees(baseline.source.files, pins),
  };
}
