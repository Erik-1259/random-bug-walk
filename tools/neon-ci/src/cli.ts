import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { listBranches, realDeps } from "./api.ts";
import { loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { runCreate } from "./create.ts";
import { deleteAndConfirm, exitCodeFor, formatResult } from "./delete.ts";
import { branchName, isCiBranchName } from "./naming.ts";
import { runSweep } from "./sweep.ts";

const USAGE = `usage: cli.ts <command> [options]
  branch-name --pr <n> --run-id <n> --run-attempt <n>
  create --name <ci branch name>   (writes created and db_url to $GITHUB_OUTPUT)
  delete --name <ci branch name>
  sweep --min-age-minutes <n> [--dry-run]
  list
Environment: NEON_API_KEY, NEON_PROJECT_ID. Test-only option: --api-base <url>.`;

class UsageError extends Error {}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

function appendSummary(text: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path !== undefined && path !== "") appendFileSync(path, `${text}\n`);
}

function requireConfig(apiBase: string | undefined): Config {
  const loaded = loadConfig(process.env, apiBase);
  if ("error" in loaded) throw new UsageError(loaded.error);
  return loaded.config;
}

function parseOptions(args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        pr: { type: "string" },
        "run-id": { type: "string" },
        "run-attempt": { type: "string" },
        name: { type: "string" },
        "min-age-minutes": { type: "string" },
        "dry-run": { type: "boolean" },
        "api-base": { type: "string" },
      },
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "invalid options");
  }
}

async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const values = parseOptions(rest);

  switch (command) {
    case "branch-name": {
      out(branchName(values.pr ?? "", values["run-id"] ?? "", values["run-attempt"] ?? ""));
      return 0;
    }
    case "create": {
      const config = requireConfig(values["api-base"]);
      const name = values.name ?? "";
      if (!isCiBranchName(name)) throw new UsageError("invalid --name: expected ci-pr-<pr>-<run id>-<attempt>");
      const outputPath = process.env.GITHUB_OUTPUT ?? "";
      if (outputPath === "") throw new UsageError("missing GITHUB_OUTPUT");
      return runCreate(realDeps, config, name, {
        stdout: out,
        stderr: err,
        output: (key, value) => { appendFileSync(outputPath, `${key}=${value}\n`); },
        summary: appendSummary,
      });
    }
    case "delete": {
      const config = requireConfig(values["api-base"]);
      const name = values.name ?? "";
      if (!isCiBranchName(name)) throw new UsageError("invalid --name: expected ci-pr-<pr>-<run id>-<attempt>");
      const result = await deleteAndConfirm(realDeps, config, name);
      const line = formatResult(result);
      out(line);
      appendSummary(line);
      return exitCodeFor(result.outcome);
    }
    case "sweep": {
      const config = requireConfig(values["api-base"]);
      const minAge = values["min-age-minutes"] ?? "";
      if (!/^(0|[1-9][0-9]{0,8})$/.test(minAge)) throw new UsageError("invalid --min-age-minutes: expected an integer of at least 0");
      const report = await runSweep(realDeps, config, Number(minAge), values["dry-run"] === true);
      for (const line of report.lines) out(line);
      out(report.summary);
      appendSummary([...report.lines, report.summary].join("\n"));
      return report.exitCode;
    }
    case "list": {
      const config = requireConfig(values["api-base"]);
      const listed = await listBranches(realDeps, config);
      if ("unreadable" in listed) {
        err(`list: ${listed.unreadable}`);
        return 2;
      }
      for (const branch of listed.branches.filter((entry) => isCiBranchName(entry.name))) {
        out(`${branch.name}\t${branch.id}\t${branch.createdAt ?? "-"}\t${branch.expiresAt ?? "-"}`);
      }
      return 0;
    }
    default:
      throw new UsageError(command === undefined ? "missing command" : `unknown command: ${command}`);
  }
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : "unexpected error";
  err(`neon-ci: ${message}`);
  if (error instanceof UsageError) err(USAGE);
  process.exitCode = 2;
}
