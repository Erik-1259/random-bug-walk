// The original-suite run for one fresh instance, inside the copy image. Ported from the custom
// host harness at baseline 2: the evaluator's pristine suite copy must equal the
// baseline's frozen files and Playwright version first, then the copy runs once with the recorded
// arguments in an environment built from nothing, and the report is compared with the baseline's
// test IDs. The run never sees a database URL. Imports only node: built-ins.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { suiteDifferences } from "../baseline.ts";
import type { Baseline } from "../baseline.ts";
import { isRecord } from "../hash.ts";
import { ReportError, compareSuiteRun, parseReportValue, stripReport } from "./report.ts";
import type { ParsedReport, SuiteComparison } from "./report.ts";

export const RESULT_FORMAT = "rbw.task-report.original-result.v1";
/** Hard kill limit for the runner process, beyond Playwright's own global timeout. */
export const RUN_KILL_AFTER_MS = 660_000;

export interface SuiteRunOptions {
  baseline: Baseline;
  /** The evaluator's pristine suite copy; checked, never written. */
  suiteDir: string;
  /** A directory that does not exist yet; the copy the run uses is made here. */
  workDir: string;
  /** An existing, empty directory for result.json and report.json. */
  outDir: string;
  baseUrl: string;
  /** The `@playwright/test` package directory whose cli.js runs the suite. */
  playwrightDir: string;
}

export interface SuiteRunResult {
  verdict: "passed" | "failed" | "invalid" | "refused";
  /** Why the run was refused before it started, or null. */
  refusal: string | null;
  comparison: SuiteComparison | null;
  duration_ms: number;
  runner_exit: number | null;
  killed: boolean;
}

/** The runner's whole environment, built from nothing. */
export function runnerEnv(baseUrl: string, reportFile: string, home: string): Record<string, string> {
  return {
    BASE_URL: baseUrl,
    CI: "1",
    FORCE_COLOR: "0",
    HOME: home,
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
    TZ: "UTC",
  };
}

function playwrightVersion(playwrightDir: string): string | null {
  try {
    const data: unknown = JSON.parse(readFileSync(join(playwrightDir, "package.json"), "utf8"));
    return isRecord(data) && typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runCli(cli: string, args: readonly string[], cwd: string, env: Record<string, string>): Promise<{ code: number | null; killed: boolean; duration_ms: number }> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: "ignore", detached: true });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, RUN_KILL_AFTER_MS);
    const finish = (code: number | null): void => {
      clearTimeout(timer);
      resolve({ code, killed, duration_ms: Math.round(performance.now() - started) });
    };
    child.once("error", () => {
      finish(null);
    });
    child.once("exit", (code) => {
      finish(code);
    });
  });
}

/** Reads the run's report, rewriting it in stripped form; null when absent or unusable. */
export function collectReport(reportFile: string, suiteDir: string): ParsedReport | null {
  if (!existsSync(reportFile)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(reportFile, "utf8"));
  } catch {
    writeJson(reportFile, { unparseable: true });
    return null;
  }
  let parsed: ParsedReport | null = null;
  try {
    parsed = parseReportValue(data, suiteDir);
  } catch (error) {
    if (!(error instanceof ReportError)) throw error;
  }
  writeJson(reportFile, stripReport(data));
  return parsed;
}

export async function runOriginalSuite(options: SuiteRunOptions): Promise<SuiteRunResult> {
  const { baseline } = options;
  const refuse = (refusal: string): SuiteRunResult => {
    writeJson(join(options.outDir, "result.json"), { format: RESULT_FORMAT, verdict: "refused", refusal });
    return { verdict: "refused", refusal, comparison: null, duration_ms: 0, runner_exit: null, killed: false };
  };
  const problems = suiteDifferences(options.suiteDir, baseline);
  if (problems.length > 0) return refuse(`the suite differs from the baseline: ${problems.join("; ")}`);
  const version = playwrightVersion(options.playwrightDir);
  if (version !== baseline.suite.playwright_version) return refuse(`Playwright ${String(version)} differs from the baseline's ${baseline.suite.playwright_version}`);
  if (existsSync(options.workDir)) return refuse("the work directory already exists");
  const suiteCopy = join(options.workDir, "suite");
  for (const rel of Object.keys(baseline.suite.files)) {
    mkdirSync(dirname(join(suiteCopy, rel)), { recursive: true });
    copyFileSync(join(options.suiteDir, rel), join(suiteCopy, rel));
  }
  const home = join(options.workDir, "home");
  mkdirSync(home);
  const reportFile = join(options.outDir, "report.json");
  const run = await runCli(
    join(options.playwrightDir, "cli.js"),
    ["test", "--config", join(suiteCopy, baseline.suite.config_path), ...baseline.suite.cli_args],
    suiteCopy,
    runnerEnv(options.baseUrl, reportFile, home),
  );
  const report = collectReport(reportFile, suiteCopy);
  const comparison = compareSuiteRun(baseline.suite.tests, report);
  writeJson(join(options.outDir, "result.json"), {
    format: RESULT_FORMAT,
    baseline_id: baseline.baseline_id,
    suite_revision: baseline.suite.revision,
    suite_tree_sha256: baseline.suite.tree_sha256,
    tests_expected: comparison.tests_expected,
    passed: comparison.passed,
    failed: comparison.failed,
    skipped: comparison.skipped,
    missing: comparison.missing,
    unlisted: comparison.unlisted,
    error_count: comparison.error_count,
    outcomes: comparison.outcomes,
    verdict: comparison.verdict,
    invalid_code: comparison.invalid_code,
    runner_exit: run.code,
    killed: run.killed,
    duration_ms: run.duration_ms,
  });
  return { verdict: comparison.verdict, refusal: null, comparison, duration_ms: run.duration_ms, runner_exit: run.code, killed: run.killed };
}
