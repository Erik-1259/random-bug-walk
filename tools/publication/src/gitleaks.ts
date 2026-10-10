import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runProcess, splitCommand } from "./run.ts";

/** The one pinned gitleaks release; the README names the same version. */
export const PINNED_GITLEAKS_VERSION = "8.30.1";

/** Exit status requested for "leaks found", kept apart from gitleaks' error status 1. */
const LEAKS_FOUND_STATUS = 42;

/**
 * A generic-api-key match that is only a SHA-256 digest keyed by a file path, the way suite
 * manifests record each file (`"playwright.api.config.ts": "<64 hex>"`). Without it, every file
 * whose name contains "api" or "key" is reported next to its digest. Any other key, and any value
 * that is not exactly 64 lowercase hex characters, is still reported. The key must end in one of
 * these source, configuration or lock-file extensions, so a dotted key such as `api.token` or
 * `auth.secret` is still reported.
 */
const FILE_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "yaml", "yml", "lock", "sql", "prisma", "md", "txt", "css", "html", "sh", "py"];

export const FILE_HASH_ALLOWLIST = String.raw`^[\w./-]+\.(?:${FILE_EXTENSIONS.join("|")})["']?\s*:\s*["']?[a-f0-9]{64}["']?$`;

/** Extends the built-in rules. Passed explicitly so that no configuration in the content applies. */
export const GITLEAKS_CONFIG = `[extend]
useDefault = true

[[allowlists]]
targetRules = ["generic-api-key"]
regexTarget = "match"
regexes = ['''${FILE_HASH_ALLOWLIST}''']
`;

export interface GitleaksBlob {
  /** Repository path for files, or a fixed file name for messages and text. */
  path: string;
  content: Uint8Array;
}

export interface GitleaksFinding {
  blob: number;
  line: number;
}

export class ScanUnavailable extends Error {
  readonly category: string;

  constructor(category: string) {
    super(category);
    this.category = category;
  }
}

/** True for a relative path with no empty, "." or ".." component. */
export function isSafeRelativePath(path: string): boolean {
  if (path === "" || isAbsolute(path) || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Replaces every `{dir}`, including inside a token such as Docker's `{dir}:{dir}`. */
function substitute(tokens: readonly string[], dir: string): string[] {
  return tokens.map((token) => token.replaceAll("{dir}", dir));
}

/** Name of each blob's second copy, which no built-in path allowlist matches. */
const NEUTRAL_NAME = "blob";

/**
 * Runs gitleaks over the blobs. Each blob is written as a new regular file at
 * `{dir}/content/<n>/<path>`, so no two blobs share a file even on file systems that
 * ignore case or Unicode normalisation, and path-based rules see the repository path.
 * A second copy at `{dir}/content/<count + n>/blob` keeps content rules applied when
 * gitleaks' built-in path allowlist matches the repository path. Findings map back by
 * number. Any failure throws ScanUnavailable; nothing from gitleaks' own output is kept.
 */
export async function runGitleaks(
  command: string,
  blobs: readonly GitleaksBlob[],
  runner: { env: Record<string, string>; timeoutMs: number },
): Promise<GitleaksFinding[]> {
  const { env, timeoutMs } = runner;
  const tokens = splitCommand(command);
  if (tokens.length === 0) throw new ScanUnavailable("gitleaks");
  for (const blob of blobs) if (!isSafeRelativePath(blob.path)) throw new ScanUnavailable("input");
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rbw-scan-")));
  try {
    const contentDir = join(dir, "content");
    const configPath = join(dir, "gitleaks.toml");
    const ignorePath = join(dir, "gitleaksignore");
    const reportPath = join(dir, "report.json");
    await mkdir(contentDir);
    await writeFile(configPath, GITLEAKS_CONFIG, { flag: "wx" });
    await writeFile(ignorePath, "", { flag: "wx" });
    const copies = [...blobs.map((blob) => blob.path), ...blobs.map(() => NEUTRAL_NAME)];
    for (const [index, path] of copies.entries()) {
      const blob = blobs[index % blobs.length];
      if (blob === undefined) throw new ScanUnavailable("gitleaks-input");
      const blobDir = join(contentDir, String(index));
      await mkdir(blobDir);
      const target = join(blobDir, ...path.split("/"));
      const parent = resolve(target, "..");
      if (parent !== blobDir) await mkdir(parent, { recursive: true });
      try {
        const handle = await open(target, "wx", 0o600);
        try {
          await handle.writeFile(blob.content);
        } finally {
          await handle.close();
        }
      } catch {
        throw new ScanUnavailable("gitleaks-input");
      }
    }

    const [program = "", ...args] = substitute(tokens, dir);
    const version = await runProcess(program, [...args, "version"], { cwd: dir, env, timeoutMs });
    if (version.timedOut) throw new ScanUnavailable("timeout");
    const reported = version.stdout.toString("utf8").trim().replace(/^v/, "");
    if (version.code !== 0 || reported !== PINNED_GITLEAKS_VERSION) throw new ScanUnavailable("gitleaks");

    const result = await runProcess(
      program,
      [
        ...args,
        "dir",
        contentDir,
        "--config",
        configPath,
        "--gitleaks-ignore-path",
        ignorePath,
        "--ignore-gitleaks-allow",
        "--report-format",
        "json",
        "--report-path",
        reportPath,
        "--exit-code",
        String(LEAKS_FOUND_STATUS),
        "--redact",
        "--no-banner",
        "--no-color",
        "--log-level",
        "error",
      ],
      { cwd: dir, env, timeoutMs },
    );
    if (result.timedOut) throw new ScanUnavailable("timeout");
    if (result.code !== 0 && result.code !== LEAKS_FOUND_STATUS) throw new ScanUnavailable("gitleaks");
    let report: unknown;
    try {
      report = JSON.parse(await readFile(reportPath, "utf8"));
    } catch {
      throw new ScanUnavailable("gitleaks-report");
    }
    if (!Array.isArray(report)) throw new ScanUnavailable("gitleaks-report");
    const findings = report.map((entry: unknown) => mapFinding(entry, contentDir, blobs.length));
    if ((findings.length > 0) !== (result.code === LEAKS_FOUND_STATUS)) throw new ScanUnavailable("gitleaks-report");
    return findings;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function mapFinding(entry: unknown, contentDir: string, blobCount: number): GitleaksFinding {
  if (typeof entry !== "object" || entry === null) throw new ScanUnavailable("gitleaks-report");
  const { File: file, StartLine: line } = entry as { File?: unknown; StartLine?: unknown };
  if (typeof file !== "string" || typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    throw new ScanUnavailable("gitleaks-report");
  }
  const inside = relative(contentDir, resolve(contentDir, file));
  const [first] = inside.split(sep);
  const blob = Number(first);
  if (inside.startsWith("..") || first === undefined || !/^\d+$/.test(first) || blob >= 2 * blobCount) {
    throw new ScanUnavailable("gitleaks-report");
  }
  return { blob: blob % blobCount, line };
}
