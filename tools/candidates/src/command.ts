// The command line, as a function the tests can call with fake implementations.
// Exit codes: 0 the run finished and the record was written; 1 the pipeline could not run or
// finish (an implementation is not wired, the finder or a setup step failed, or the run failed
// after screening began), and once screening has begun the record of the spend so far is still
// kept and its path printed; 2 a usage or input error found before anything ran, nothing written.
// The --out file is claimed before the pipeline runs, so a bad --out never costs a screen.
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { encodeCanonical } from "@rbw/schema";
import { implementationName, isWired } from "./not-wired.ts";
import { formatUsd, PipelineError, runPipeline, type RunRecord } from "./pipeline.ts";
import type { FindSites, Screen } from "./types.ts";

export const USAGE = `usage: cli.ts --rule <class rule file> --host <host tree> --symptom <symptom file> --out <new record file>
  [--rule-id <id>] [--host-commit <sha>] [--dry-run]
  [--max-candidates <n>] (default 10)
  [--max-spend-usd <usd>] (total screen spend cap, default 2.00)
  [--screen-budget-usd <usd>] (per screen, default 0.25)
  [--screen-attempts <n>] (per screen, default 3)
  [--scratch <dir>] (default the system temporary directory) [--keep-scratch]
`;

/** The repository root; a record lists candidate sites in the host and must stay out of it. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface CommandDeps {
  findSites: FindSites;
  screen: Screen;
  now?: () => Date;
  runId?: () => string;
  repoRoot?: string;
}

export interface CommandIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

class UsageError extends Error {}

/** Parses a decimal USD amount with at most six decimals into integer micro-USD. */
export function parseUsd(text: string, flag: string): number {
  const match = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(text);
  if (match === null) {
    throw new UsageError(`${flag} must be a USD amount such as 2 or 0.25`);
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(6, "0"));
  return whole * 1_000_000 + fraction;
}

function parseCount(text: string, flag: string): number {
  if (!/^[1-9]\d{0,5}$/.test(text)) {
    throw new UsageError(`${flag} must be a positive integer`);
  }
  return Number(text);
}

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new UsageError(`cannot read the ${what} file`);
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}


function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Writes the record into the claimed file. A record that is not canonical JSON is kept as plain
 * JSON; if the claimed file cannot be written, the record goes to a new file in the scratch base.
 * Either way the record of the spend is kept and the result says where.
 */
function saveRecord(fd: number, outPath: string, record: RunRecord, scratchBase: string, runId: string): { ok: boolean; note: string } {
  const spent = `spent ${formatUsd(record.totals.spend_microusd)}`;
  let bytes: Uint8Array | string;
  let canonical = true;
  let problem = "";
  try {
    bytes = encodeCanonical(record);
  } catch (error) {
    canonical = false;
    problem = error instanceof Error ? error.message : "encoding failed";
    bytes = `${JSON.stringify(record)}\n`;
  }
  try {
    writeFileSync(fd, bytes);
    closeSync(fd);
  } catch {
    try {
      closeSync(fd);
    } catch {
      // Already closed or never usable; the fallback below still keeps the record.
    }
    const fallback = join(scratchBase, `rbw-candidates-record-${runId}.json`);
    try {
      writeFileSync(fallback, bytes, { flag: "wx" });
      return { ok: false, note: `could not write --out; ${spent}; record kept at ${fallback}\n` };
    } catch {
      return { ok: false, note: `could not write --out or a fallback record; ${spent}; record follows\n${JSON.stringify(record)}\n` };
    }
  }
  if (!canonical) {
    return { ok: false, note: `the record is not canonical JSON (${problem}); ${spent}; kept as plain JSON at ${outPath}\n` };
  }
  return { ok: true, note: `${spent}; record: ${outPath}\n` };
}

function summary(record: RunRecord, out: string, scratchDir: string | null): string {
  const { totals } = record;
  const lines = [
    `${record.dry_run ? "dry run" : "run"} ${record.run_id}: ${String(totals.sites_found)} sites, ${String(totals.duplicates)} duplicates, ${String(totals.planted)} planted`,
    record.dry_run
      ? `would screen ${String(totals.planted)} candidates; most the screens could spend under the caps: ${formatUsd(totals.max_spend_microusd)}`
      : `screened ${String(totals.screened)}: ${String(totals.survivors)} survived, ${String(totals.located)} located, ${String(totals.inconclusive)} inconclusive; spent ${formatUsd(totals.spend_microusd)}`,
  ];
  if (record.stop_reason !== null) {
    lines.push(`stopped screening: ${record.stop_reason}`);
  }
  lines.push(`record: ${out}`);
  if (scratchDir !== null) {
    lines.push(`scratch kept: ${scratchDir}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runCommand(argv: readonly string[], deps: CommandDeps, io: CommandIo): Promise<number> {
  try {
    const { values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        rule: { type: "string" },
        "rule-id": { type: "string" },
        host: { type: "string" },
        "host-commit": { type: "string" },
        symptom: { type: "string" },
        out: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "max-candidates": { type: "string", default: "10" },
        "max-spend-usd": { type: "string", default: "2.00" },
        "screen-budget-usd": { type: "string", default: "0.25" },
        "screen-attempts": { type: "string", default: "3" },
        scratch: { type: "string" },
        "keep-scratch": { type: "boolean", default: false },
      },
    });
    const { rule: rulePath, host, symptom: symptomPath, out } = values;
    if (rulePath === undefined || host === undefined || symptomPath === undefined || out === undefined) {
      throw new UsageError("--rule, --host, --symptom and --out are required");
    }
    const outPath = resolve(out);
    if (isInside(resolve(deps.repoRoot ?? REPO_ROOT), outPath)) {
      throw new UsageError("--out must be outside the repository: the record lists candidate sites in the host");
    }
    if (!isDirectory(host)) {
      throw new UsageError("--host must be a directory");
    }
    const hostCommit = values["host-commit"];
    if (hostCommit !== undefined && !/^[0-9a-f]{40}$/.test(hostCommit)) {
      throw new UsageError("--host-commit must be a 40-character lowercase hex commit");
    }
    const ruleText = readText(rulePath, "rule");
    const symptomText = readText(symptomPath, "symptom");
    const ruleId = values["rule-id"] ?? basename(rulePath).replace(/\.ya?ml$/, "");
    const caps = {
      maxCandidates: parseCount(values["max-candidates"], "--max-candidates"),
      maxScreenSpendMicrousd: parseUsd(values["max-spend-usd"], "--max-spend-usd"),
      screenBudget: {
        maxAttempts: parseCount(values["screen-attempts"], "--screen-attempts"),
        maxCostMicrousd: parseUsd(values["screen-budget-usd"], "--screen-budget-usd"),
      },
    };
    if (caps.screenBudget.maxCostMicrousd < 1) {
      throw new UsageError("--screen-budget-usd must be more than zero");
    }
    const dryRun = values["dry-run"];
    if (!dryRun && !isWired(deps.screen)) {
      throw new PipelineError("screen is not wired yet: use --dry-run, or bind the screen in tools/candidates/src/wiring.ts");
    }
    const scratchBase = values.scratch ?? tmpdir();
    if (!dryRun && !isDirectory(scratchBase)) {
      throw new UsageError("--scratch must be a directory");
    }
    // Each copy is made under --scratch; a copy inside the tree being copied cannot be made.
    if (!dryRun && isInside(realpathSync(host), realpathSync(scratchBase))) {
      throw new UsageError("--scratch must be outside --host");
    }
    // Claim the record file before anything runs, so a bad --out fails before any screen spends.
    let fd: number;
    try {
      fd = openSync(outPath, "wx");
    } catch {
      throw new UsageError("cannot write --out: it must be a new file in an existing directory");
    }
    const runId = (deps.runId ?? randomUUID)();
    let record: RunRecord;
    let scratchDir: string | null;
    try {
      ({ record, scratchDir } = await runPipeline({
        rule: { id: ruleId, path: rulePath, text: ruleText },
        hostDir: resolve(host),
        symptom: { text: symptomText },
        findSites: deps.findSites,
        screen: deps.screen,
        caps,
        dryRun,
        scratchBase,
        keepScratch: values["keep-scratch"],
        hostCommit: hostCommit ?? null,
        runId,
        now: deps.now ?? (() => new Date()),
        implementations: { findSites: implementationName(deps.findSites), screen: dryRun ? "none" : implementationName(deps.screen) },
      }));
    } catch (error) {
      if (error instanceof PipelineError && error.record !== null) {
        const where = saveRecord(fd, outPath, error.record, scratchBase, runId);
        io.err(`candidates: ${error.message}\n${where.note}`);
        return 1;
      }
      // Nothing ran that spent: release the claimed (still empty) record file.
      closeSync(fd);
      unlinkSync(outPath);
      throw error;
    }
    const where = saveRecord(fd, outPath, record, scratchBase, runId);
    if (!where.ok) {
      io.err(`candidates: ${where.note}`);
      return 1;
    }
    io.out(summary(record, outPath, scratchDir));
    return 0;
  } catch (error) {
    if (error instanceof UsageError || (error instanceof TypeError && "code" in error)) {
      io.err(`candidates: ${error.message}\n${USAGE}`);
      return 2;
    }
    if (error instanceof PipelineError) {
      io.err(`candidates: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
