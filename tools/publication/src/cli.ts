import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolveGitleaksCommand } from "./config.ts";
import { PINNED_GITLEAKS_VERSION } from "./gitleaks.ts";
import { scanDetailed, type ScanRequest, type ScanResult, type TextScanItem } from "./scan.ts";

const EXIT_CODES: Record<ScanResult["outcome"], number> = { clean: 0, blocked: 1, unavailable: 2 };

class UsageError extends Error {}

async function buildRequest(argv: readonly string[]): Promise<ScanRequest> {
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
  if (values.patterns === undefined) throw new UsageError();
  if (values.range !== undefined && values.files === true) throw new UsageError();
  if (positionals.length > 0 && values.files !== true) throw new UsageError();
  if (values.files === true && positionals.length === 0) throw new UsageError();

  const request: ScanRequest = {
    patternFile: values.patterns,
    gitleaksCommand: resolveGitleaksCommand(values.gitleaks, process.env),
  };
  if (values.repository !== undefined) request.repository = values.repository;
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
  return request;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "gitleaks-version" && rest.length === 0) {
    process.stdout.write(`${PINNED_GITLEAKS_VERSION}\n`);
    return 0;
  }
  if (command !== "scan") {
    process.stdout.write("unavailable\n");
    process.stderr.write("usage: cli.ts scan --patterns <file> [...] | cli.ts gitleaks-version\n");
    return EXIT_CODES.unavailable;
  }
  let request: ScanRequest;
  try {
    request = await buildRequest(rest);
  } catch {
    process.stdout.write("unavailable\n");
    process.stderr.write("scan unavailable: usage\n");
    return EXIT_CODES.unavailable;
  }
  // PUB-02: the scanner is the check every public push and text passes through.
  const { result, category } = await scanDetailed(request);
  process.stdout.write(`${result.outcome}\n`);
  if (result.outcome === "blocked") process.stdout.write(result.locations.map((location) => `${location}\n`).join(""));
  if (result.outcome === "unavailable") process.stderr.write(`scan unavailable: ${category ?? "internal"}\n`);
  return EXIT_CODES[result.outcome];
}

process.exitCode = await main(process.argv.slice(2));
