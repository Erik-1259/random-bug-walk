// The check package of evaluator v2: the files a copy runs from the validator, placed under the
// copy's evaluator directory with the same relative paths as in this package. They are the copy
// driver v2/copy.ts with every module it imports, the F3 data file, the version 2 protocol, the
// baseline manifest and catalog version 2, each with its pin where it has one. The kit image
// supplies only the runtime (Node, PostgreSQL, the baseline's dependencies, the original suite and
// a package.json that marks the directory as ES modules), so the check that runs is the one in the
// validator. A unit test checks this list against the driver's imports.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex, treeSha256 } from "../src/hash.ts";
import type { FileDigest } from "./contract.ts";

export const CHECK_PACKAGE_FILES: readonly string[] = [
  "baseline/task-report-ca4a71f.json",
  "catalog/v2.json",
  "data/f3.v1.json",
  "data/f3.v1.json.sha256",
  "src/baseline.ts",
  "src/copy/instance.ts",
  "src/copy/layout.ts",
  "src/copy/proc.ts",
  "src/f3/applog.ts",
  "src/f3/block.ts",
  "src/f3/check.ts",
  "src/f3/classify.ts",
  "src/f3/data.ts",
  "src/f3/gate.ts",
  "src/f3/http.ts",
  "src/f3/monitor.ts",
  "src/f3/trial.ts",
  "src/hash.ts",
  "src/protocol.ts",
  "src/suite/report.ts",
  "src/suite/run-suite.ts",
  "v2/args.ts",
  "v2/copy.ts",
  "v2/entry.ts",
  "v2/expected.ts",
  "v2/protocol.ts",
  "v2/protocol/f3-repeatability.v2.json",
  "v2/protocol/f3-repeatability.v2.json.sha256",
  "v2/record.ts",
];

/** The copy driver's path inside the check package. */
export const CHECK_PACKAGE_ENTRY = "v2/copy.ts";

/** Every check package file with its SHA-256, sorted by path, read from a package directory. */
export function checkPackageListing(packageDir: string): FileDigest[] {
  return [...CHECK_PACKAGE_FILES].sort().map((path) => ({ path, sha256: sha256Hex(readFileSync(join(packageDir, path))) }));
}

/** The check set's SHA-256: the tree hash of the listing (the canonical JSON of every file's SHA-256 by path). */
export function checkSetSha256(listing: readonly FileDigest[]): string {
  return treeSha256(Object.fromEntries(listing.map((file) => [file.path, file.sha256])));
}
