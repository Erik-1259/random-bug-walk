// `record`: runs the six-call plan live and saves the recordings and records. The owner runs it
// from a private workflow; nothing here runs in public CI.
// Usage: node src/record-cli.ts --context <file> --rate-sheet <file> --input <file> --out <dir>
//          --slot-key <key> --pool <pool-key> [--allocation <key>] [--settings <file>]
//          [--excluded-identifiers <file>] [--api-base-url <url>]
// Reads DATABASE_URL and TAVILY_API_KEY. It never prints either value, nor any header.
import { readFileSync } from "node:fs";
import { createSpend, fromPg } from "@rbw/spend";
import pg from "pg";
import { z } from "zod";
import { createTavilyClient } from "./client.ts";
import { SearchError } from "./errors.ts";
import { DEFAULT_SETTINGS, settingsSchema } from "./plan.ts";
import { loadRateSheet } from "./rates.ts";
import { runRecord } from "./record.ts";
import { createDirectoryRecordStore } from "./records.ts";
import { createSearcher } from "./searcher.ts";
import { installWireTap } from "./wire-tap.ts";

const USAGE =
  "usage: record --context <file> --rate-sheet <file> --input <file> --out <dir> --slot-key <key> --pool <pool-key>" +
  " [--allocation <key>] [--settings <file>] [--excluded-identifiers <file>] [--api-base-url <url>]";
const REQUIRED = ["context", "rate-sheet", "input", "out", "slot-key", "pool"] as const;
const OPTIONAL = ["allocation", "settings", "excluded-identifiers", "api-base-url"] as const;
const LIVE_BASE_URL = "https://api.tavily.com";

function fail(message: string): never {
  process.stderr.write(`record: ${message}\n`);
  process.exit(1);
}

function parseArgs(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  const known = new Set<string>([...REQUIRED, ...OPTIONAL]);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === undefined || !flag.startsWith("--") || !known.has(flag.slice(2)) || value === undefined) {
      return fail(USAGE);
    }
    values.set(flag.slice(2), value);
  }
  if (REQUIRED.some((name) => !values.has(name))) {
    return fail(USAGE);
  }
  return values;
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fail(`the ${what} file cannot be read as JSON`);
  }
}

function argument(args: Map<string, string>, name: string): string {
  return args.get(name) ?? fail(USAGE);
}

// `pnpm run record -- ...` passes the `--` through; skip it, as the README's command relies on it.
const argv = process.argv.slice(2);
const args = parseArgs(argv[0] === "--" ? argv.slice(1) : argv);
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  fail("DATABASE_URL is not set");
}
const apiKey = process.env.TAVILY_API_KEY;
if (apiKey === undefined || apiKey.trim() === "") {
  fail("TAVILY_API_KEY is not set");
}

const context = readJson(argument(args, "context"), "context");
const input = readJson(argument(args, "input"), "input");
const settingsPath = args.get("settings");
const settings =
  settingsPath === undefined
    ? DEFAULT_SETTINGS
    : settingsSchema.parse({ ...DEFAULT_SETTINGS, ...(readJson(settingsPath, "settings") as object) });
const excludedPath = args.get("excluded-identifiers");
const excluded =
  excludedPath === undefined ? [] : z.array(z.string().min(1)).parse(readJson(excludedPath, "excluded-identifiers"));
const outDir = argument(args, "out");

const database = new pg.Client({ connectionString: databaseUrl });
const connection = { failed: false };
database.on("error", () => {
  connection.failed = true;
});
try {
  await database.connect();
} catch {
  fail("could not connect to the database named by DATABASE_URL");
}

const tap = installWireTap();
let exitCode = 1;
try {
  const spend = createSpend({ client: fromPg(database) });
  const searcher = createSearcher({
    client: createTavilyClient({
      apiKey,
      apiBaseURL: args.get("api-base-url") ?? LIVE_BASE_URL,
      allowLive: true,
    }),
    spend,
    context,
    rates: loadRateSheet(argument(args, "rate-sheet")),
    poolKey: argument(args, "pool"),
    slotKey: argument(args, "slot-key"),
    allocationKey: args.get("allocation") ?? null,
    settings,
    excludedIdentifiers: excluded,
    store: createDirectoryRecordStore(outDir),
  });
  const result = await runRecord({
    searcher,
    spend,
    context,
    input,
    slotKey: argument(args, "slot-key"),
    outDir,
    tap,
    write: (line) => process.stdout.write(`${line}\n`),
  });
  exitCode = result.exitCode;
} catch (error) {
  // Messages from the driver or the SDK can name hosts or carry request details: print only a code.
  process.stderr.write(`record: failed (${error instanceof SearchError ? error.code : "internal_error"})\n`);
} finally {
  tap.remove();
  await database.end();
}
if (connection.failed) {
  fail("the database connection failed");
}
process.exitCode = exitCode;
