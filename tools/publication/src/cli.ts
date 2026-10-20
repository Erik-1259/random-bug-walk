import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolveGitleaksCommand } from "./config.ts";
import { PINNED_GITLEAKS_VERSION } from "./gitleaks.ts";
import {
  scanDetailed,
  scanPublicDetailed,
  type DetailedScanResult,
  type PublicScanRequest,
  type ScanRequest,
  type ScanResult,
  type TextScanItem,
} from "./scan.ts";

const EXIT_CODES: Record<ScanResult["outcome"], number> = { clean: 0, blocked: 1, unavailable: 2 };

/** The public-source route's last line, printed for every outcome: that route never checks the pattern list. */
const PATTERNS_NOT_RUN = "private-pattern scan: not run on this route (required in CI before merge)";

type Route = "scan" | "scan-public";

class UsageError extends Error {}

/**
 * Builds a full scan request (`scan`, which requires --patterns) or a public-source request
 * (`scan-public`, which refuses --patterns and the options only the pattern check uses).
 */
async function buildRequest(argv: readonly string[], route: Route): Promise<ScanRequest | PublicScanRequest> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        patterns: { type: "string" },
        repository: { type: "string" },
        gitleaks: { type: "string" },
        license: { type: "string" },
        range: { type: "string" },
        files: { type: "boolean" },
        text: { type: "string", multiple: true },
      },
    });
  } catch {
    throw new UsageError();
  }
  const { values, positionals } = parsed;
  if (route === "scan" && values.patterns === undefined) throw new UsageError();
  if (route === "scan-public" && (values.patterns !== undefined || values.repository !== undefined || values.license !== undefined)) {
    throw new UsageError();
  }
  if (values.range !== undefined && values.files === true) throw new UsageError();
  if (positionals.length > 0 && values.files !== true) throw new UsageError();
  if (values.files === true && positionals.length === 0) throw new UsageError();

  const request: PublicScanRequest = { gitleaksCommand: resolveGitleaksCommand(values.gitleaks, process.env) };
  const cwd = process.cwd();
  if (values.range !== undefined) {
    const parts = values.range.split("..");
    const [base, head] = parts;
    if (parts.length !== 2 || base === undefined || head === undefined || base === "" || head === "" || head.startsWith(".")) {
      throw new UsageError();
    }
    request.git = { repository: cwd, head, exclude: [base], licenseRevision: base };
  }
  if (values.files === true) {
    request.files = { root: cwd, paths: positionals };
    if (values.license !== undefined) request.files.licenseFile = values.license;
  }
  const texts: TextScanItem[] = [];
  for (const item of values.text ?? []) {
    const split = item.indexOf("=");
    if (split <= 0) throw new UsageError();
    const name = item.slice(0, split);
    const file = item.slice(split + 1);
    let content: Uint8Array;
    try {
      content = await readFile(file);
    } catch {
      throw new UsageError();
    }
    texts.push({ name, content });
  }
  if (texts.length > 0) request.texts = texts;
  if (values.patterns === undefined) return request;
  const full: ScanRequest = { patternFile: values.patterns, ...request };
  if (values.repository !== undefined) full.repository = values.repository;
  return full;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "gitleaks-version" && rest.length === 0) {
    process.stdout.write(`${PINNED_GITLEAKS_VERSION}\n`);
    return 0;
  }
  if (command !== "scan" && command !== "scan-public") {
    process.stdout.write("unavailable\n");
    process.stderr.write("usage: cli.ts scan --patterns <file> [...] | cli.ts scan-public [...] | cli.ts gitleaks-version\n");
    return EXIT_CODES.unavailable;
  }
  // PUB-02: the scanner is the check every public push and text passes through.
  const { result, category } = await runScan(command, rest);
  // The public route names the checks that ran, so its outcome is never read as a full scan's.
  const label = command === "scan-public" ? "credential and attribution checks: " : "";
  process.stdout.write(`${label}${result.outcome}\n`);
  if (result.outcome === "blocked") process.stdout.write(result.locations.map((location) => `${location}\n`).join(""));
  if (command === "scan-public") process.stdout.write(`${PATTERNS_NOT_RUN}\n`);
  if (result.outcome === "unavailable") process.stderr.write(`scan unavailable: ${category ?? "internal"}\n`);
  return EXIT_CODES[result.outcome];
}

async function runScan(route: Route, argv: readonly string[]): Promise<DetailedScanResult> {
  let request: ScanRequest | PublicScanRequest;
  try {
    request = await buildRequest(argv, route);
  } catch {
    return { result: { outcome: "unavailable" }, category: "usage" };
  }
  return route === "scan" ? scanDetailed(request) : scanPublicDetailed(request);
}

process.exitCode = await main(process.argv.slice(2));
