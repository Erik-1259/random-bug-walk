// The harvest commands. `harvest` makes live public GitHub calls and writes a run directory;
// `funnel` rebuilds the funnel from a run directory's frozen responses with no network.
// Exit codes: 0 done; 2 the command cannot run (bad usage, an unreadable or incomplete run
// directory, a rate limit beyond the wait cap, a request that fails without a response).
// GITHUB_TOKEN is read from the environment only, and is never printed or recorded.
import { parseArgs } from "node:util";
import { canonicalJson } from "@rbw/shapes";
import { createGitHubClient } from "./github.ts";
import { harvest, replay, type Funnel } from "./harvest.ts";

const USAGE = `usage:
  cli.ts harvest --out <new directory> [--max <n>]
  cli.ts funnel --in <run directory>`;

const DEFAULT_MAX = 50;

export interface CommandDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

class UsageError extends Error {}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new UsageError(`--max must be a positive integer, not ${value}`);
  }
  return Number(value);
}

/** The drop reasons shown per query in the summary; funnel.json lists them all. */
const TOP_DROPS = 3;

function summary(funnel: Funnel): string {
  const stages = funnel.stages
    .map((stage) => {
      const drops = Object.entries(stage.drops)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([reason, count]) => `${reason} ${String(count)}`);
      return `${stage.stage} ${String(stage.count)}${drops.length === 0 ? "" : ` (dropped: ${drops.join(", ")})`}\n`;
    })
    .join("");
  const queries = funnel.harvest.queries
    .map((query, index) => {
      const top = query.drops.slice(0, TOP_DROPS).map((drop) => `${drop.reason} ${String(drop.count)}`);
      const head = `query ${String(index + 1)} (${query.kind}): status ${String(query.status)}, added ${String(query.added)}, confirmed ${String(query.stages.structurally_confirmed)}`;
      return `${head}${top.length === 0 ? "" : `; top drops: ${top.join(", ")}`}\n`;
    })
    .join("");
  return `${stages}${queries}`;
}

async function run(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const [command, ...rest] = args;
  let values: { out?: string | undefined; max?: string | undefined; in?: string | undefined };
  try {
    values = parseArgs({
      args: rest,
      options: { out: { type: "string" }, max: { type: "string" }, in: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments", { cause: error });
  }
  if (command === "harvest" && values.out !== undefined && values.in === undefined) {
    const max = positiveInteger(values.max, DEFAULT_MAX);
    const token = deps.env.GITHUB_TOKEN;
    const authenticated = token !== undefined && token.trim() !== "";
    const now = deps.now ?? Date.now;
    const client = createGitHubClient({
      ...(authenticated ? { token: token.trim() } : {}),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      now,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });
    const funnel = await harvest({ client, out: values.out, max, clock: () => new Date(now()), authenticated });
    deps.stdout(`harvest: wrote ${values.out} (${authenticated ? "authenticated" : "unauthenticated"})\n${summary(funnel)}`);
    return 0;
  }
  if (command === "funnel" && values.in !== undefined && values.out === undefined && values.max === undefined) {
    deps.stdout(`${canonicalJson(await replay(values.in))}\n`);
    return 0;
  }
  throw new UsageError("missing or unexpected arguments");
}

export async function runCommand(argv: readonly string[], deps: CommandDeps): Promise<number> {
  try {
    return await run(argv, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.stderr(`harvest: ${message}\n${error instanceof UsageError ? `${USAGE}\n` : ""}`);
    return 2;
  }
}
