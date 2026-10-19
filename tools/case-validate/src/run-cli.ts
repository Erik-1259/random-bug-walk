// rbw-validate <bug-case> <validator> [--out dir]: runs validatePair on two local archive files, prints the
// matrix and the result, and exits 0 (passed), 1 (failed), 2 (error) or 64 (usage).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { CopyRunner, HostAdapter, HostId } from "@rbw/factory-contract";
import { CHECK_SET_VALUES, COPY_STATE_VALUES } from "@rbw/factory-contract";
import { validatePair, type ValidatePairResult } from "./validate.ts";
import { HARNESS_IDENTITY } from "./version.ts";

export const EXIT_CODES = { passed: 0, failed: 1, error: 2, usage: 64 } as const;

export const USAGE = "usage: rbw-validate <bug-case.tar.gz> <validator.tar.gz> [--out <dir>]\n";

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CliDependencies {
  adapters: Partial<Record<HostId, HostAdapter>>;
  /** Called only when a copy is about to run; each copy's results go into a fresh directory under resultsDir. */
  runner: (resultsDir: string) => CopyRunner;
  now: () => Date;
  workdir?: string;
}

function table(outcome: ValidatePairResult): string {
  const { matrix } = outcome;
  if (matrix === null) return "matrix: none (no cell ran)\n";
  const lines = [`${"".padEnd(16)}${COPY_STATE_VALUES.map((state) => state.padEnd(22)).join("")}`];
  for (const check of CHECK_SET_VALUES) {
    const cells = COPY_STATE_VALUES.map((state) => {
      const cell = matrix[check][state];
      return `${cell.observed} ${String(cell.runs_valid)}/${String(cell.runs_total)}`.padEnd(22);
    });
    lines.push(`${check.padEnd(16)}${cells.join("")}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runValidateCli(argv: readonly string[], io: Io, deps: CliDependencies): Promise<number> {
  let paths: string[];
  let out: string | undefined;
  try {
    const parsed = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: { out: { type: "string" } } });
    paths = parsed.positionals;
    out = parsed.values.out;
    if (paths.length !== 2) throw new Error("usage");
  } catch {
    io.stderr(USAGE);
    return EXIT_CODES.usage;
  }
  const [bugCasePath = "", validatorPath = ""] = paths;
  const parts: Uint8Array[] = [];
  for (const path of [bugCasePath, validatorPath]) {
    try {
      parts.push(new Uint8Array(await readFile(path)));
    } catch {
      io.stderr(`rbw-validate: cannot read ${path}\n`);
      return EXIT_CODES.error;
    }
  }
  const [bugCase = new Uint8Array(0), validator = new Uint8Array(0)] = parts;
  // With --out, each copy's results are kept under <out>/copies; otherwise under a temporary directory.
  const resultsDir = out === undefined ? await mkdtemp(join(deps.workdir ?? tmpdir(), "rbw-validate-copies-")) : join(out, "copies");
  const runner: CopyRunner = { run: (plan, roots) => deps.runner(resultsDir).run(plan, roots) };
  let outcome: ValidatePairResult;
  try {
    outcome = await validatePair({
      bug_case: bugCase,
      validator,
      adapters: deps.adapters,
      runner,
      now: deps.now,
      ...(deps.workdir === undefined ? {} : { workdir: deps.workdir }),
    });
  } catch (error) {
    io.stderr(`rbw-validate: ${error instanceof Error ? error.message : String(error)}\n`);
    io.stdout("result: error\n");
    return EXIT_CODES.error;
  } finally {
    if (out === undefined) await rm(resultsDir, { recursive: true, force: true });
  }
  io.stdout(`harness   ${HARNESS_IDENTITY.name} ${HARNESS_IDENTITY.version}\n`);
  io.stdout(`bug case  ${outcome.package_sha256.bug_case}\n`);
  io.stdout(`validator ${outcome.package_sha256.validator}\n`);
  io.stdout(`pair      ${outcome.pair_sha256 ?? "none"}\n`);
  io.stdout(table(outcome));
  io.stdout(`result: ${outcome.result}\n`);
  if (outcome.message !== null) io.stdout(`message: ${outcome.message}\n`);
  if (outcome.diagnostic !== null) io.stdout(`detail: ${outcome.diagnostic}\n`);
  if (out !== undefined) {
    await mkdir(out, { recursive: true });
    const report = {
      harness: HARNESS_IDENTITY,
      result: outcome.result,
      error_code: outcome.error_code,
      message: outcome.message,
      diagnostic: outcome.diagnostic,
      stopped: outcome.stopped,
      package_sha256: outcome.package_sha256,
      pair_sha256: outcome.pair_sha256,
      matrix: outcome.matrix,
      records: outcome.records,
    };
    await writeFile(join(out, "validation.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  return EXIT_CODES[outcome.result];
}
