import { closeSync, fchmodSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { audit, type AuditOutcome } from "./audit.ts";
import { InputError, canonicalJson, sha256Hex } from "./input.ts";
import { UnsupportedEntry, buildManifest, manifestBytes } from "./manifest.ts";
import { commitNeutral } from "./neutral.ts";
import { parsePolicy } from "./policy.ts";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const USAGE = `usage:
  node src/cli.ts manifest --repo <git dir> --commit <sha> --out <file>
  node src/cli.ts commit-neutral --dir <copy> --policy <file>
  node src/cli.ts audit --manifest <file> --policy <file> --mutation <file> --terms <file> --copy <dir> --report <file>
exit codes: 0 done or pass, 1 audit refused, 2 usage error, malformed input or unavailable
`;

const OPTIONS = {
  manifest: ["repo", "commit", "out"],
  "commit-neutral": ["dir", "policy"],
  audit: ["manifest", "policy", "mutation", "terms", "copy", "report"],
} as const;

type Command = keyof typeof OPTIONS;

class UsageError extends Error {}

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && Object.hasOwn(OPTIONS, value);
}

/** Parses `--name value` options; every listed option is required exactly once and nothing else is accepted. */
function options(command: Command, args: readonly string[]): Record<string, string> {
  const names = OPTIONS[command];
  let values: Record<string, string | undefined>;
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: Object.fromEntries(names.map((name) => [name, { type: "string" as const }])),
    });
    values = parsed.values;
  } catch {
    throw new UsageError();
  }
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = values[name];
    if (value === undefined || value === "") throw new UsageError();
    result[name] = value;
  }
  return result;
}

/** Writes the report with mode 0600, also when the file already exists with a wider mode. */
function writeReport(path: string, report: Record<string, unknown>): void {
  const descriptor = openSync(path, "w", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, canonicalJson(report));
  } finally {
    closeSync(descriptor);
  }
}

function runManifest(values: Record<string, string>, io: Io): number {
  try {
    const bytes = manifestBytes(buildManifest(values.repo ?? "", values.commit ?? ""));
    const manifest = JSON.parse(bytes.toString("utf8")) as { files: { mode: string }[] };
    try {
      writeFileSync(values.out ?? "", bytes);
    } catch {
      throw new InputError("write_failed");
    }
    const executable = manifest.files.filter((file) => file.mode === "100755").length;
    io.stdout(`manifest_sha256=${sha256Hex(bytes)} files=${String(manifest.files.length)} executable=${String(executable)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UnsupportedEntry) io.stderr(`manifest: ${error.code} ${error.path}\n`);
    else if (error instanceof InputError) io.stderr(`manifest: ${error.code}\n`);
    else io.stderr("manifest: internal_error\n");
    return 2;
  }
}

function runCommitNeutral(values: Record<string, string>, io: Io): number {
  try {
    let text: string;
    try {
      text = readFileSync(values.policy ?? "", "utf8");
    } catch {
      throw new InputError("malformed_policy");
    }
    const sha = commitNeutral(values.dir ?? "", parsePolicy(text));
    io.stdout(`commit=${sha}\n`);
    return 0;
  } catch (error) {
    io.stderr(`commit-neutral: ${error instanceof InputError ? error.code : "internal_error"}\n`);
    return 2;
  }
}

function runAudit(values: Record<string, string>, io: Io): number {
  const paths = {
    manifest: values.manifest ?? "",
    policy: values.policy ?? "",
    mutation: values.mutation ?? "",
    terms: values.terms ?? "",
    copy: values.copy ?? "",
    report: values.report ?? "",
  };
  let outcome: AuditOutcome;
  try {
    outcome = audit(paths);
  } catch {
    outcome = { verdict: "unavailable", exitCode: 2, report: { error: "internal_error", exit_code: 2, verdict: "unavailable" }, lines: ["verdict=unavailable error=internal_error"] };
  }
  if (outcome.report !== null) {
    try {
      writeReport(paths.report, outcome.report);
    } catch {
      io.stdout("verdict=unavailable error=report_unwritable\n");
      return 2;
    }
  }
  io.stdout(`${outcome.lines.join("\n")}\n`);
  return outcome.exitCode;
}

export function runCli(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!isCommand(command)) throw new UsageError();
    const values = options(command, rest);
    if (command === "manifest") return Promise.resolve(runManifest(values, io));
    if (command === "commit-neutral") return Promise.resolve(runCommitNeutral(values, io));
    return Promise.resolve(runAudit(values, io));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(USAGE);
    return Promise.resolve(2);
  }
}
