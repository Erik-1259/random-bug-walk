// The command line, as a function the tests can call with fake implementations.
// Exit codes: 0 the run finished and the record was written; 1 the pipeline could not run or
// finish (the finder or a setup step failed, the run failed after screening began, or a screen
// stopped the run), and once screening has begun the record of the spend so far is still kept and
// its path printed; 2 a usage or input error found before anything ran (including a real screen
// that would refuse every run: a missing key or DATABASE_URL, or a budget the attempts cannot fit),
// nothing written.
// The --out file is claimed before the pipeline runs, so a bad --out never costs a screen.
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { encodeCanonical } from "@rbw/schema";
import { API_KEY_VARIABLE, budgetRefusal, isScreenModelName, MAX_ATTEMPTS, SCREEN_PROFILES, worstCasePerCall } from "@rbw/screen";
import { implementationName } from "./not-wired.ts";
import { formatUsd, PipelineError, runPipeline, type RunRecord } from "./pipeline.ts";
import { SYMPTOM_SOURCE, symptomFor } from "./symptom.ts";
import type { FindSites, Screen, ScreenBudget, ScreenModel } from "./types.ts";

export const USAGE = `usage: cli.ts --rule <class rule file> --host <host tree> --out <new record file>
  [--rule-id <id>] [--host-commit <sha>] [--dry-run] [--model super|kimi]
  [--max-candidates <n>] (default 10)
  [--max-spend-usd <usd>] (total screen spend cap, default 2.00)
  [--screen-budget-usd <usd>] (per screen, default 0.25)
  [--screen-attempts <n>] (per screen, 1 to 8, default 3)
  [--slot-key <key>] [--pool <key>] (spend ledger slot and pool, default "development")
  [--rate-sheet <path>] (default packages/screen/rates.json)
  [--scratch <dir>] (default the system temporary directory) [--keep-scratch]
A real run reads DATABASE_URL and ${API_KEY_VARIABLE} from the environment and never prints either.
`;

/** The repository root; a record lists candidate sites in the host and must stay out of it. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The default rate sheet: @rbw/screen's committed prices. */
export const DEFAULT_RATE_SHEET = join(REPO_ROOT, "packages", "screen", "rates.json");

/** Builds the real screen from the options a run supplies; cli.ts passes @rbw/screen's. */
export interface ScreenConfig {
  env: Record<string, string | undefined>;
  slotKey: string;
  pool: string;
  rateSheetPath: string;
  /** Where the screen makes its own scratch output directory (the run's --scratch). */
  scratchBase: string;
  /** Keeps the screen's scratch output too (the run's --keep-scratch). */
  keepScratch: boolean;
}

export interface CommandDeps {
  findSites: FindSites;
  /** A ready screen (tests pass a fake). When absent and the run is not a dry run, buildScreen is used. */
  screen?: Screen;
  /** Builds the real screen from the parsed options; used when `screen` is absent. */
  buildScreen?: (config: ScreenConfig) => Screen;
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

/** The real path of a file that may not exist yet: its parent's real path plus its name. */
function realTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
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
        out: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        model: { type: "string", default: "super" },
        "max-candidates": { type: "string", default: "10" },
        "max-spend-usd": { type: "string", default: "2.00" },
        "screen-budget-usd": { type: "string", default: "0.25" },
        "screen-attempts": { type: "string", default: "3" },
        "slot-key": { type: "string", default: "development" },
        pool: { type: "string", default: "development" },
        "rate-sheet": { type: "string" },
        scratch: { type: "string" },
        "keep-scratch": { type: "boolean", default: false },
      },
    });
    const { rule: rulePath, host, out } = values;
    if (rulePath === undefined || host === undefined || out === undefined) {
      throw new UsageError("--rule, --host and --out are required");
    }
    const outPath = resolve(out);
    const realOut = realTarget(outPath);
    if (isInside(resolve(deps.repoRoot ?? REPO_ROOT), outPath) || isInside(realTarget(resolve(deps.repoRoot ?? REPO_ROOT)), realOut)) {
      throw new UsageError("--out must be outside the repository: the record lists candidate sites in the host");
    }
    if (!isDirectory(host)) {
      throw new UsageError("--host must be a directory");
    }
    // Nothing this command writes (the record, a fallback record, scratch copies) may land in the host.
    const realHost = realpathSync(host);
    if (isInside(realHost, realOut)) {
      throw new UsageError("--out must be outside --host");
    }
    const model = values.model;
    if (!isScreenModelName(model)) {
      throw new UsageError("--model must be super or kimi");
    }
    const hostCommit = values["host-commit"];
    if (hostCommit !== undefined && !/^[0-9a-f]{40}$/.test(hostCommit)) {
      throw new UsageError("--host-commit must be a 40-character lowercase hex commit");
    }
    const ruleText = readText(rulePath, "rule");
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
    if (caps.screenBudget.maxAttempts > MAX_ATTEMPTS) {
      throw new UsageError(`--screen-attempts must be from 1 to ${String(MAX_ATTEMPTS)}`);
    }
    const dryRun = values["dry-run"];
    const scratchBase = values.scratch ?? tmpdir();
    if (!dryRun && !isDirectory(scratchBase)) {
      throw new UsageError("--scratch must be a directory");
    }
    // Each copy (and a fallback record) is made under --scratch; a copy inside the tree being
    // copied cannot be made.
    if (isDirectory(scratchBase) && isInside(realHost, realpathSync(scratchBase))) {
      throw new UsageError("--scratch must be outside --host");
    }

    // The screen: a fake when one is given (tests), otherwise the real one built from the options.
    // A dry run never screens, so it needs none.
    const config: ScreenConfig = {
      env: process.env,
      slotKey: values["slot-key"],
      pool: values.pool,
      rateSheetPath: values["rate-sheet"] ?? DEFAULT_RATE_SHEET,
      scratchBase,
      keepScratch: values["keep-scratch"],
    };
    const screen = buildRunScreen(deps, dryRun, config);
    if (deps.screen === undefined) {
      // The real screen refuses a run for these reasons before it spends; checking them here makes a
      // misconfigured run fail before anything runs, instead of once per candidate.
      checkRealScreen(config, model, caps.screenBudget, dryRun);
    }
    const screenName = dryRun ? "none" : implementationName(screen);

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
        symptomFor: (site) => ({ text: symptomFor(site) }),
        symptomSource: SYMPTOM_SOURCE,
        screenModel: model,
        findSites: deps.findSites,
        screen,
        caps,
        dryRun,
        scratchBase,
        keepScratch: values["keep-scratch"],
        hostCommit: hostCommit ?? null,
        runId,
        now: deps.now ?? (() => new Date()),
        implementations: { findSites: implementationName(deps.findSites), screen: screenName },
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
    if (record.stop_reason === "screen_stopped") {
      // A screen stopped the run, possibly with spend to reconcile: say why on stderr and exit 1.
      const stopper = record.candidates.find((entry) => entry.status === "screen_error" && entry.reason?.startsWith("ScreenStopError") === true);
      io.err(`${summary(record, outPath, scratchDir)}candidates: ${stopper?.reason ?? "a screen stopped the run"}\n`);
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

/**
 * The real screen's own start checks, run once up front: the rate sheet prices the model, the planned
 * attempts at the worst case fit the per-screen budget (on a dry run too, so its projection is
 * honest) and, for a real run, the key and DATABASE_URL are set. Neither value is printed.
 */
function checkRealScreen(config: ScreenConfig, model: ScreenModel, budget: ScreenBudget, dryRun: boolean): void {
  let sheet: Uint8Array;
  try {
    sheet = readFileSync(config.rateSheetPath);
  } catch {
    throw new UsageError("cannot read the --rate-sheet file");
  }
  const worst = worstCasePerCall(sheet, SCREEN_PROFILES[model]);
  if (!worst.ok) {
    throw new UsageError(`--rate-sheet does not price the ${model} profile: ${worst.detail}`);
  }
  const refusal = budgetRefusal(budget.maxAttempts, worst.per_call_microusd, budget.maxCostMicrousd);
  if (refusal !== null) {
    throw new UsageError(`--screen-budget-usd is too small for ${String(budget.maxAttempts)} attempts on ${model}: ${refusal}`);
  }
  if (dryRun) {
    return;
  }
  for (const name of [API_KEY_VARIABLE, "DATABASE_URL"]) {
    const value = config.env[name];
    if (value === undefined || value === "") {
      throw new UsageError(`${name} is not set; a real run needs it`);
    }
  }
}

/** The screen the run uses; a given fake, the built real one, or a never-called stub for a dry run. */
function buildRunScreen(deps: CommandDeps, dryRun: boolean, config: ScreenConfig): Screen {
  if (deps.screen !== undefined) {
    return deps.screen;
  }
  if (dryRun) {
    return () => {
      throw new PipelineError("a dry run does not screen");
    };
  }
  if (deps.buildScreen === undefined) {
    throw new PipelineError("no screen is configured");
  }
  return deps.buildScreen(config);
}
