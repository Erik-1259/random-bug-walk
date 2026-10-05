import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PUBLICATION_STATUS_VALUES, RecordError, buildPolicy } from "@rbw/schema";
import { loadPolicyConfig, loadPublishConfig, loadStatusConfig } from "./config.ts";
import { InvalidInput } from "./errors.ts";
import { Logger } from "./log.ts";
import { runProcess, type ProcessRunner } from "./process.ts";
import { EXIT, publishCommand } from "./publish.ts";
import { StateDir } from "./state.ts";
import type { BlobClient, FetchFunction } from "./store.ts";

export interface CliDeps {
  env: Readonly<Record<string, string | undefined>>;
  runner: ProcessRunner;
  blobClient?: BlobClient;
  fetch?: FetchFunction;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const USAGE = "usage: cli.ts policy|publish|status [options]; see packages/publisher/README.md\n";

/** Writes a frozen policy file. An existing file is never overwritten; identical bytes are accepted. */
function policyCommand(argv: readonly string[], out: (text: string) => void): number {
  const config = loadPolicyConfig(argv);
  let built;
  try {
    built = buildPolicy({ projectId: config.projectId, outputRepository: config.outputRepository, publicArtifactBaseUri: config.artifactBaseUri, policyVersion: config.policyVersion });
  } catch (error) {
    if (error instanceof RecordError) throw new InvalidInput("policy_invalid");
    throw error;
  }
  mkdirSync(dirname(config.out), { recursive: true });
  try {
    writeFileSync(config.out, built.bytes, { flag: "wx", mode: 0o644 });
  } catch (error) {
    const exists = error instanceof Error && "code" in error && error.code === "EEXIST";
    if (!exists) throw new InvalidInput("policy_unwritable");
    if (!readFileSync(config.out).equals(built.bytes)) throw new InvalidInput("policy_file_exists");
  }
  out(`${built.sha256}\n`);
  return 0;
}

/** Read-only: each root's publication status and the count per status. */
function statusCommand(argv: readonly string[], out: (text: string) => void): number {
  const state = new StateDir(loadStatusConfig(argv).stateDir);
  const counts = new Map<string, number>(PUBLICATION_STATUS_VALUES.map((status) => [status, 0]));
  for (const root of state.roots()) {
    const id = state.currentPublicationId(root);
    if (id === null) continue;
    const record = state.loadRecord(root, id);
    counts.set(record.status, (counts.get(record.status) ?? 0) + 1);
    out(`root ${root} ${record.status}\n`);
  }
  for (const [status, count] of counts) out(`count ${status} ${String(count)}\n`);
  return 0;
}

export async function runCli(argv: readonly string[], deps: Partial<CliDeps> = {}): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const out = (text: string): void => {
    stdout += text;
  };
  const err = (text: string): void => {
    stderr += text;
  };
  const [command, ...rest] = argv;
  try {
    if (command === "policy") return { code: policyCommand(rest, out), stdout, stderr };
    if (command === "status") return { code: statusCommand(rest, out), stdout, stderr };
    if (command !== "publish") throw new InvalidInput("usage");
    const code = await publishCommand(loadPublishConfig(rest), {
      env: deps.env ?? process.env,
      runner: deps.runner ?? runProcess,
      ...(deps.blobClient === undefined ? {} : { blobClient: deps.blobClient }),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      logger: new Logger(err),
      stdout: out,
      stderr: err,
    });
    return { code, stdout, stderr };
  } catch (error) {
    if (error instanceof InvalidInput) {
      return { code: EXIT.invalid, stdout: "", stderr: `${stderr}invalid input: ${error.code}\n${error.code === "usage" ? USAGE : ""}` };
    }
    // A crash records nothing further; the next call resumes from the stored state.
    return { code: EXIT.failed, stdout: "", stderr: `${stderr}internal error\n` };
  }
}

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2), { env: process.env });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
