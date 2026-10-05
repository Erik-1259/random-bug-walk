// Command line for shape DT-1.tz-arg confirmation. Records are canonical JSON (sorted keys).
// Exit codes: 0 confirmed; 1 not_applicable, unsupported_source_match or refused (the reason is
// printed to stderr); 2 the command cannot run (bad usage, unreadable input, malformed rule or
// probe data, a failing git command).
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { canonicalJson } from "./json.ts";
import { checkProbes, loadProbeSet } from "./probes.ts";
import { PROBE_DIR, RULE_FILE, SHAPE_ID, SOURCE_RULE_FILE } from "./shape.ts";
import { confirmSource, type SourceChange } from "./source.ts";
import { confirmTarget } from "./target.ts";

const USAGE = `usage:
  cli.ts confirm-target --file <file> --path <repository path> --route <route file> [--mode <git mode>]
                        [--rule <rule file>] [--record <out>] [--declared-mutation <out>]
  cli.ts confirm-source --git-dir <dir> --commit <sha> --parent <sha> [--rule <rule file>] [--record <out>]
  cli.ts check-probes --planted <file> [--record <out>]`;

class CannotRun extends Error {}

function read(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new CannotRun(`cannot read ${path}`, { cause: error });
  }
}

/** The git mode of a file on disk: 100755 when any execute bit is set, otherwise 100644. */
function gitMode(path: string): string {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return "120000";
    }
    return (stat.mode & 0o111) === 0 ? "100644" : "100755";
  } catch (error) {
    throw new CannotRun(`cannot read ${path}`, { cause: error });
  }
}

function git(gitDir: string, args: string[]): Buffer {
  const result = spawnSync("git", ["--git-dir", gitDir, ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    throw new CannotRun(`git ${args[0] ?? ""} failed in ${gitDir}`, { cause: result.error });
  }
  return result.stdout;
}

/** Parses `git diff-tree -z --name-status` output. */
function nameStatus(output: string): SourceChange[] {
  const fields = output.split("\0").filter((field) => field !== "");
  const changes: SourceChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      changes.push({ status, oldPath: fields[index + 1] ?? "", path: fields[index + 2] ?? "" });
      index += 3;
    } else {
      changes.push({ status, path: fields[index + 1] ?? "" });
      index += 2;
    }
  }
  return changes;
}

function emit(json: string, out: string | undefined): void {
  if (out === undefined) {
    process.stdout.write(`${json}\n`);
    return;
  }
  try {
    writeFileSync(out, json);
  } catch (error) {
    throw new CannotRun(`cannot write ${out}`, { cause: error });
  }
}

function required(values: Record<string, string | undefined>, names: string[]): string[] {
  return names.map((name) => {
    const value = values[name];
    if (value === undefined || value === "") {
      throw new CannotRun(`--${name} is required\n${USAGE}`);
    }
    return value;
  });
}

function finish(
  outcome: { status: string; reason?: string; detail?: string },
  record: unknown,
  out: string | undefined,
): number {
  if (outcome.status === "confirmed") {
    emit(canonicalJson(record), out);
    return 0;
  }
  emit(canonicalJson({ detail: outcome.detail, reason: outcome.reason, shape_id: SHAPE_ID, status: outcome.status }), out);
  process.stderr.write(`${outcome.status}: ${outcome.reason ?? ""}: ${outcome.detail ?? ""}\n`);
  return 1;
}

const OPTIONS = {
  file: { type: "string" },
  path: { type: "string" },
  route: { type: "string" },
  mode: { type: "string" },
  rule: { type: "string" },
  record: { type: "string" },
  "declared-mutation": { type: "string" },
  "git-dir": { type: "string" },
  commit: { type: "string" },
  parent: { type: "string" },
  planted: { type: "string" },
} as const;

function run(argv: string[]): number {
  const [command, ...rest] = argv;
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({ args: rest, options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw new CannotRun(`${error instanceof Error ? error.message : "invalid arguments"}\n${USAGE}`, { cause: error });
  }

  if (command === "confirm-target") {
    const [file, path, route] = required(values, ["file", "path", "route"]) as [string, string, string];
    const outcome = confirmTarget({
      path,
      mode: values.mode ?? gitMode(file),
      bytes: read(file),
      routeBytes: read(route),
      ruleBytes: read(values.rule ?? RULE_FILE),
    });
    if (outcome.status === "confirmed" && values["declared-mutation"] !== undefined) {
      try {
        writeFileSync(values["declared-mutation"], canonicalJson(outcome.declaredMutation));
      } catch (error) {
        throw new CannotRun(`cannot write ${values["declared-mutation"]}`, { cause: error });
      }
    }
    return finish(outcome, outcome.status === "confirmed" ? outcome.record : undefined, values.record);
  }

  if (command === "confirm-source") {
    const [gitDir, commitArg, parent] = required(values, ["git-dir", "commit", "parent"]) as [string, string, string];
    const commit = git(gitDir, ["rev-parse", "--verify", `${commitArg}^{commit}`]).toString("utf8").trim();
    const parents = git(gitDir, ["rev-list", "--parents", "-n", "1", commit]).toString("utf8").trim().split(" ").slice(1);
    const changes = nameStatus(git(gitDir, ["diff-tree", "-r", "-M", "-z", "--name-status", parent, commit]).toString("utf8"));
    const [change] = changes;
    const single = changes.length === 1 && change?.status === "M";
    const outcome = confirmSource({
      commit,
      parent,
      parents,
      changes,
      ...(single ? { before: git(gitDir, ["cat-file", "blob", `${parent}:${change.path}`]) } : {}),
      ...(single ? { after: git(gitDir, ["cat-file", "blob", `${commit}:${change.path}`]) } : {}),
      ruleBytes: read(values.rule ?? SOURCE_RULE_FILE),
    });
    return finish(outcome, outcome.status === "confirmed" ? outcome.record : undefined, values.record);
  }

  if (command === "check-probes") {
    const [planted] = required(values, ["planted"]) as [string];
    const outcome = checkProbes(loadProbeSet(PROBE_DIR), read(planted));
    return finish(outcome, outcome.status === "confirmed" ? outcome.record : undefined, values.record);
  }

  throw new CannotRun(USAGE);
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`shapes: ${message}\n`);
  process.exitCode = 2;
}
