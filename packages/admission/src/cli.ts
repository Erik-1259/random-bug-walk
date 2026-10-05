import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { canonicalDigest } from "@rbw/schema";
import { decide } from "./decide.ts";
import { ImportRefusal, importRecordSet } from "./importer.ts";
import type { Decision, Evidence } from "./output.ts";

export type WriteFile = (path: string, bytes: Uint8Array) => void;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 0: a decision was written, whatever it is; 1: the request-level checks refused the import; 2: usage; 3: no decision written (an output could not be written, or an internal error). */
export const EXIT = { decided: 0, refused: 1, usage: 2, failed: 3 } as const;

const USAGE = "usage: cli.ts import --records <dir> --out <dir>; see packages/admission/README.md\n";
const OUTPUT_FILES = ["decision.json", "evidence.sha256", "evidence.json"];

function usage(argv: readonly string[]): { records: string; out: string } | null {
  const [command, ...rest] = argv;
  if (command !== "import") return null;
  try {
    const { values } = parseArgs({ args: rest, options: { records: { type: "string" }, out: { type: "string" } }, strict: true, allowPositionals: false });
    if (values.records === undefined || values.out === undefined || values.records === "" || values.out === "") return null;
    return { records: values.records, out: values.out };
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function summary(decision: Decision, decisionSha256: string, evidenceSha256: string): string {
  const lines = [
    `evidence_sha256 ${evidenceSha256}`,
    `decision_sha256 ${decisionSha256}`,
    `kind ${decision.kind}`,
    ...Object.entries(decision.decisions ?? {}).map(([rule, value]) => `rule ${rule} ${value.decision}`),
    `comparison ${decision.comparison?.classification ?? "-"}`,
    `outcome_verdict ${decision.outcome_verdict ?? "-"}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * import: reads one record set, writes evidence.json and evidence.sha256, and only then derives
 * and writes decision.json. Outputs from an earlier run are removed first, so a failed run never
 * leaves a decision behind.
 */
export function runCli(argv: readonly string[], deps: { writeFile?: WriteFile } = {}): CliResult {
  const writeFile = deps.writeFile ?? ((path: string, bytes: Uint8Array): void => {
    writeFileSync(path, bytes);
  });
  const options = usage(argv);
  if (options === null) return { code: EXIT.usage, stdout: "", stderr: USAGE };
  for (const name of OUTPUT_FILES) rmSync(join(options.out, name), { force: true });
  let evidence: Evidence;
  try {
    evidence = importRecordSet(options.records);
  } catch (error) {
    if (error instanceof ImportRefusal) return { code: EXIT.refused, stdout: "", stderr: `refused ${error.code}\n` };
    return { code: EXIT.failed, stdout: "", stderr: `import failed: ${error instanceof Error ? error.message : "unknown error"}\n` };
  }
  const evidenceDigest = canonicalDigest(evidence);
  try {
    mkdirSync(options.out, { recursive: true });
    writeFile(join(options.out, "evidence.json"), evidenceDigest.bytes);
    writeFile(join(options.out, "evidence.sha256"), Buffer.from(`${evidenceDigest.sha256}\n`));
  } catch (error) {
    return { code: EXIT.failed, stdout: "", stderr: `evidence not written: ${error instanceof Error ? error.message : "unknown error"}\n` };
  }
  const decision = decide(evidence);
  const decisionDigest = canonicalDigest(decision);
  try {
    writeFile(join(options.out, "decision.json"), decisionDigest.bytes);
  } catch (error) {
    return { code: EXIT.failed, stdout: "", stderr: `decision not written: ${error instanceof Error ? error.message : "unknown error"}\n` };
  }
  return { code: EXIT.decided, stdout: summary(decision, decisionDigest.sha256, evidenceDigest.sha256), stderr: "" };
}

if (import.meta.main) {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
