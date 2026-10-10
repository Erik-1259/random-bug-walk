// The release tool's command line. See README.md for the conductor's commands.
//
//   stage --run <controller run dir> --root-run <file> --out <new staging dir> --redactions-out <private file>
//         [--symptom <file>] [--card <file>] [--novelty <file>]
//   build --release-id <uuid> --run <published run dir> --publication <file> --policy <file> --root-run <file>
//         --issue <file> --issue-check <file> --recordings <dir> --approval <file> --registry <file>
//         --held-out <file> --image <local kit image> --controller-image <repo@sha256:...> --kit-stage <dir>
//         --manifest <file> --terms <file> --audit-policy <file> --original-suite <file>
//         [--local-store <dir>] --out <new release dir>
//   publish-replays --policy <file> --state <dir> --patterns <file> [--local-runs <dir>] [publisher options]
//
// In real mode build and publish-replays read the private store's variables through
// privateStoreFromEnv, here and nowhere else, and never print them.
//
// Exit codes: 0 done; 1 refused (a root that is not terminal, failing release checks, or a replay
// the publisher did not publish), with nothing written; 2 a usage or input error, with nothing written.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { RATE_SHEET_PATH } from "@rbw/controller";
import { loadRateSheet } from "@rbw/envelope";
import { createDocker, realClock } from "@rbw/local-runner";
import { buildRelease } from "./build.ts";
import { ReleaseInputError } from "./errors.ts";
import { InvalidInput, StoreError, privateStoreFromEnv } from "@rbw/publisher/private-store";
import { publishReplays } from "./replays.ts";
import { stage } from "./stage.ts";

const USAGE = `usage:
  node src/cli.ts stage --run <dir> --root-run <file> --out <new dir> --redactions-out <private file> [--symptom <file>] [--card <file>] [--novelty <file>]
  node src/cli.ts build --release-id <uuid> --run <dir> --publication <file> --policy <file> --root-run <file> --issue <file> --issue-check <file>
                        --recordings <dir> --approval <file> --registry <file> --held-out <file> --image <tag|digest> --controller-image <repo@sha256:...>
                        --kit-stage <dir> --manifest <file> --terms <file> --audit-policy <file> --original-suite <file> [--local-store <dir>] --out <new dir>
  node src/cli.ts publish-replays --policy <file> --state <dir> --patterns <file> [--local-runs <dir>] [publisher destination options and limits]
`;

class UsageError extends Error {}

function log(line: string): void {
  process.stderr.write(`release: ${line}\n`);
}

type Values = Record<string, string | undefined>;

function required(values: Values, name: string): string {
  const value = values[name];
  if (value === undefined || value === "") throw new UsageError(`--${name} is required`);
  return value;
}

function file(values: Values, name: string): string {
  return resolve(required(values, name));
}

function optional(values: Values, name: string): string | undefined {
  const value = values[name];
  return value === undefined || value === "" ? undefined : resolve(value);
}

function strings<const T extends readonly string[]>(names: T): Record<T[number], { type: "string" }> {
  return Object.fromEntries(names.map((name) => [name, { type: "string" }])) as Record<T[number], { type: "string" }>;
}

function stageCommand(args: string[]): number {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: strings(["run", "root-run", "out", "redactions-out", "symptom", "card", "novelty"]) });
  const symptom = optional(values, "symptom");
  const card = optional(values, "card");
  const novelty = optional(values, "novelty");
  const outcome = stage({
    run: file(values, "run"),
    rootRun: file(values, "root-run"),
    out: file(values, "out"),
    redactionsOut: file(values, "redactions-out"),
    ...(symptom === undefined ? {} : { symptom }),
    ...(card === undefined ? {} : { card }),
    ...(novelty === undefined ? {} : { novelty }),
  });
  if (!outcome.ok) {
    process.stdout.write(`refused ${outcome.code}\n`);
    return 1;
  }
  process.stdout.write(`staged files=${String(outcome.files)} redactions=${String(outcome.redactions)} not_produced=${String(outcome.omissions.entries.filter((entry) => entry.outcome === "not_produced").length)}\n`);
  return 0;
}

const BUILD_OPTIONS = strings([
  "release-id", "run", "publication", "policy", "root-run", "issue", "issue-check", "recordings", "approval", "registry", "held-out",
  "image", "controller-image", "kit-stage", "manifest", "terms", "audit-policy", "original-suite", "local-store", "out",
]);

async function buildCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: BUILD_OPTIONS });
  const outcome = await buildRelease(
    {
      releaseId: required(values, "release-id"),
      run: file(values, "run"),
      publication: file(values, "publication"),
      policy: file(values, "policy"),
      rootRun: file(values, "root-run"),
      issue: file(values, "issue"),
      issueCheck: file(values, "issue-check"),
      recordings: file(values, "recordings"),
      approval: file(values, "approval"),
      registry: file(values, "registry"),
      heldOut: file(values, "held-out"),
      sources: {
        image: required(values, "image"),
        manifest: file(values, "manifest"),
        terms: file(values, "terms"),
        auditPolicy: file(values, "audit-policy"),
        kitStage: file(values, "kit-stage"),
        originalSuite: file(values, "original-suite"),
      },
      controllerImage: required(values, "controller-image"),
      localStore: optional(values, "local-store") ?? null,
      out: file(values, "out"),
    },
    { docker: createDocker(), clock: realClock, rates: await loadRateSheet(RATE_SHEET_PATH), env: process.env, privateStoreFromEnv, log },
  );
  if (!outcome.ok) {
    process.stdout.write(`refused codes=${outcome.codes.join(",")} issue_sha256=${outcome.issueSha256 ?? "-"}\n`);
    return 1;
  }
  const { release } = outcome;
  process.stdout.write(
    `release=${release.release_id} release_sha256=${outcome.releaseSha256} issue_sha256=${outcome.issueSha256} judge_job=${release.judge_job.index_key} judge_job_sha256=${release.judge_job.index_sha256}\n`,
  );
  return 0;
}

const REPLAY_OPTIONS = ["policy", "state", "patterns", "local-runs"] as const;

async function publishReplaysCommand(args: string[]): Promise<number> {
  // The release tool's own options are taken out; everything else goes to the publisher unchanged, which checks it.
  const own: Values = {};
  const publishArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const name = arg.startsWith("--") ? arg.slice(2) : "";
    if ((REPLAY_OPTIONS as readonly string[]).includes(name)) {
      own[name] = args[index + 1];
      index += 1;
    } else {
      publishArgs.push(arg);
    }
  }
  return publishReplays(
    { policy: file(own, "policy"), state: file(own, "state"), patterns: file(own, "patterns"), localRuns: optional(own, "local-runs") ?? null, publishArgs },
    { env: process.env, out: (line) => process.stdout.write(`${line}\n`), err: (text) => process.stderr.write(text), privateStoreFromEnv },
  );
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "stage") return stageCommand(rest);
    if (command === "build") return await buildCommand(rest);
    if (command === "publish-replays") return await publishReplaysCommand(rest);
    throw new UsageError("unknown command");
  } catch (error) {
    if (error instanceof UsageError || (error instanceof TypeError && "code" in error)) {
      process.stderr.write(`release: ${error.message}\n${USAGE}`);
      return 2;
    }
    if (error instanceof ReleaseInputError || error instanceof InvalidInput || error instanceof StoreError) {
      process.stderr.write(`release: invalid input: ${error.code}\n`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
