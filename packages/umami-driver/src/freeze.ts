// `freeze`: on the clean kit, before any mutation, lists the original suite with Playwright's
// `--list` and the JSON reporter, under the same environment as a real run, and writes the
// manifest every later trial is compared with.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@rbw/schema";
import { checkSuiteIsolation, hashFiles, prepareSuiteCopy } from "./closure.ts";
import { listProcessEnv, suiteEnvironmentManifest } from "./environment.ts";
import { harnessFiles, harnessHashes } from "./harness.ts";
import { buildSuiteManifest, encodeSuiteManifest } from "./manifest.ts";
import type { SuiteManifest } from "./manifest.ts";
import { ORIGINAL_SPEC_FILES, UMAMI_COMMIT, closureListProblems } from "./pinned.ts";
import { parsePlaywrightReport } from "./playwright-report.ts";
import type { ProcessRunner } from "./process.ts";

export interface FreezeOptions {
  /** The kit's staged closure, at the original relative paths. */
  closureDir: string;
  /** The kit's closure list: the pinned SHA-256 of every closure file. */
  closureList: Readonly<Record<string, string>>;
  /** The verifier's package.json, which marks the suite's sources as ES modules. */
  markerFile: string;
  verifierNodeModules: string;
  verifierLockFile: string;
  appDir: string;
  /** A new, empty directory outside the app for the listing copy. */
  workDir: string;
  baseUrl: string;
  nodePath: string;
  nodeVersion: string;
  specFiles?: readonly string[];
}

export interface FreezeResult {
  manifest: SuiteManifest;
  bytes: Uint8Array;
  sha256: string;
  /** The `--list` run's exit status. The upstream coverage reporter fails in list mode, so it is not evidence. */
  list_exit_code: number | null;
  /** Whether global setup ran during `--list`: it creates the coverage directory before anything else. */
  list_ran_global_setup: boolean;
}

export class FreezeError extends Error {}

export async function freezeSuite(options: FreezeOptions, runner: ProcessRunner): Promise<FreezeResult> {
  const pinned = options.closureList;
  const specFiles = options.specFiles ?? ORIGINAL_SPEC_FILES;
  const absent = closureListProblems(pinned, specFiles);
  if (absent.length > 0) throw new FreezeError(`the closure list leaves out required files: ${absent.join(", ")}`);
  const source = await hashFiles(options.closureDir, Object.keys(pinned));
  const changed = Object.keys(source.hashes).filter((path) => source.hashes[path] !== pinned[path]);
  if (source.missing.length > 0 || changed.length > 0) {
    throw new FreezeError(`the verifier closure differs from the pinned files: ${[...source.missing, ...changed].sort().join(", ")}`);
  }
  const marker = await readFile(options.markerFile);
  const suiteDir = join(options.workDir, "suite");
  const reportFile = join(options.workDir, "list-report.json");
  await prepareSuiteCopy({
    closureDir: options.closureDir,
    suiteDir,
    verifierNodeModules: options.verifierNodeModules,
    closurePaths: Object.keys(pinned),
    harness: harnessFiles(marker),
  });
  const isolation = checkSuiteIsolation({ suiteDir, appDir: options.appDir, verifierNodeModules: options.verifierNodeModules });
  if (isolation.length > 0) throw new FreezeError(isolation.join("; "));
  const environment = suiteEnvironmentManifest({ baseUrl: options.baseUrl, nodeVersion: options.nodeVersion });
  const result = await runner.run({
    command: options.nodePath,
    args: [join(suiteDir, environment.playwright_cli), ...environment.list_args],
    cwd: suiteDir,
    env: listProcessEnv(environment, { suite_dir: suiteDir, report_file: reportFile }),
  });
  if (!existsSync(reportFile)) {
    throw new FreezeError(`the --list run wrote no JSON report (exit ${String(result.code ?? result.signal)})`);
  }
  const report = parsePlaywrightReport(await readFile(reportFile, "utf8"), "tests/api/");
  const host = new URL(options.baseUrl).host.replace(/[^a-z0-9.-]+/gi, "-");
  const manifest = buildSuiteManifest({
    report,
    closure: { ...pinned },
    harness: harnessHashes(marker),
    verifierLockSha256: sha256Hex(await readFile(options.verifierLockFile)),
    environment,
    specFiles,
    umamiCommit: UMAMI_COMMIT,
  });
  const encoded = encodeSuiteManifest(manifest);
  return {
    manifest,
    bytes: encoded.bytes,
    sha256: encoded.sha256,
    list_exit_code: result.code,
    list_ran_global_setup: existsSync(join(suiteDir, "tests/api/.runtime", host, "coverage")),
  };
}
