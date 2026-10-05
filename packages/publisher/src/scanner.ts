import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "./log.ts";
import { baseEnvironment, type ProcessRunner } from "./process.ts";

export interface ScannerSettings {
  /** Command prefix, for example `node tools/publication/src/cli.ts`. */
  command: string[];
  gitleaks: string | null;
  patternFile: string;
  /** `<owner>/<repo>` from output_repository, for the repository-URL exception. */
  repository: string;
  timeoutMs: number;
}

export type ScanOutcome = { outcome: "clean" } | { outcome: "blocked"; locations: string[] } | { outcome: "unavailable" };

type ScanInput = { files: string[] } | { texts: { name: string; file: string }[] };

/** The one place that maps a scan to C2 scanner flags. No other exception is passed. */
export function scannerArguments(settings: ScannerSettings, input: ScanInput): string[] {
  const args = ["scan", "--patterns", settings.patternFile, "--repository", settings.repository];
  if (settings.gitleaks !== null) args.push("--gitleaks", settings.gitleaks);
  if ("files" in input) args.push("--files", ...input.files);
  else for (const text of input.texts) args.push("--text", `${text.name}=${text.file}`);
  return args;
}

/** Combines scans: any blocked wins, then any unavailable. */
export function combine(outcomes: readonly ScanOutcome[]): ScanOutcome {
  const locations = outcomes.flatMap((item) => (item.outcome === "blocked" ? item.locations : []));
  if (outcomes.some((item) => item.outcome === "blocked")) return { outcome: "blocked", locations };
  if (outcomes.some((item) => item.outcome === "unavailable")) return { outcome: "unavailable" };
  return { outcome: "clean" };
}

/** Runs the C2 scanner CLI as a child process with an environment that holds no credential. */
export class Scanner {
  private readonly settings: ScannerSettings;
  private readonly runner: ProcessRunner;
  private readonly env: Record<string, string>;
  private readonly logger: Logger;

  constructor(settings: ScannerSettings, runner: ProcessRunner, sourceEnv: Readonly<Record<string, string | undefined>>, logger: Logger) {
    this.settings = settings;
    this.runner = runner;
    this.env = baseEnvironment(sourceEnv);
    this.logger = logger;
  }

  private async run(cwd: string, input: ScanInput, label: string): Promise<ScanOutcome> {
    const [program, ...prefix] = this.settings.command;
    if (program === undefined) return { outcome: "unavailable" };
    const result = await this.runner({
      command: program,
      args: [...prefix, ...scannerArguments(this.settings, input)],
      cwd,
      env: { ...this.env },
      timeoutMs: this.settings.timeoutMs,
    });
    const [first = "", ...rest] = result.stdout.toString("utf8").split("\n");
    let outcome: ScanOutcome = { outcome: "unavailable" };
    if (result.code === 0 && first === "clean") outcome = { outcome: "clean" };
    if (result.code === 1 && first === "blocked") outcome = { outcome: "blocked", locations: rest.filter((line) => line.length > 0) };
    this.logger.event("scan", { input: label, outcome: outcome.outcome, exit: result.code, timed_out: result.timedOut ? 1 : 0 });
    return outcome;
  }

  /** Files mode, run from a temporary directory laid out as the repository tree, so names are scanned too. */
  async scanTree(files: ReadonlyMap<string, Uint8Array>): Promise<ScanOutcome> {
    const dir = mkdtempSync(join(tmpdir(), "rbw-publisher-scan-"));
    try {
      for (const [path, bytes] of files) {
        mkdirSync(dirname(join(dir, path)), { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, path), bytes, { mode: 0o600, flag: "wx" });
      }
      return await this.run(dir, { files: [...files.keys()] }, "files");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Text mode, for the commit message and the status object. */
  async scanText(name: string, bytes: Uint8Array): Promise<ScanOutcome> {
    const dir = mkdtempSync(join(tmpdir(), "rbw-publisher-scan-"));
    try {
      const file = join(dir, `${name}.txt`);
      writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
      return await this.run(dir, { texts: [{ name, file }] }, name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
