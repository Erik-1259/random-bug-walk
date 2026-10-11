// publish-replays: the conductor's command for judge replays (design note section 7). For each
// judge/<root>/ in the private store whose root-run.json is terminal, it downloads the root to a
// fresh directory, stages it and publishes it, one root at a time in root order. A root that is not
// terminal is skipped; a later run publishes it. The publisher is idempotent by root and content
// hash, so an already-published root prints published again; there are no retries beyond its own.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "@rbw/publisher";
import type { CliResult } from "@rbw/publisher";
import { CanonicalError, RecordError, parseCanonical, parseRecord } from "@rbw/schema";
import type { RootRun } from "@rbw/schema";
import { ReleaseInputError } from "./errors.ts";
import { LocalPrivateStore } from "@rbw/publisher/private-store";
import type { PrivateStore } from "@rbw/publisher/private-store";
import { stage } from "./stage.ts";

/** The largest object a replay holds that is read back; the driver's per-trial artifact limit. */
export const REPLAY_OBJECT_LIMIT_BYTES = 64 * 1024 * 1024;
const ROOT_RUN_KEY = /^judge\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/root-run\.json$/;

export interface ReplayOptions {
  policy: string;
  state: string;
  patterns: string;
  /** Local mode: the private store is this directory. Null: the real store from the environment. */
  localRuns: string | null;
  /** The publisher's destination flags, scanner flags and limits, passed to publish unchanged. */
  publishArgs: readonly string[];
}

export interface ReplayDeps {
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  /** Receives the publisher's stderr: event lines, and only path:line locations for a blocked root. */
  err?: (text: string) => void;
  privateStoreFromEnv: (env: Readonly<Record<string, string | undefined>>) => PrivateStore;
  publisher?: (argv: readonly string[], env: Readonly<Record<string, string | undefined>>) => Promise<CliResult>;
}

async function getObject(store: PrivateStore, key: string): Promise<Uint8Array> {
  const bytes = await store.get(key, REPLAY_OBJECT_LIMIT_BYTES);
  if (bytes === null) throw new ReleaseInputError("replay_object_missing", key);
  return bytes;
}

function rootRunOf(bytes: Uint8Array, key: string): RootRun {
  try {
    return parseRecord("RootRun", bytes);
  } catch (error) {
    if (error instanceof RecordError || error instanceof CanonicalError) throw new ReleaseInputError("root_run_invalid", key);
    throw error;
  }
}

/** The publisher's outcome for one root, read from its printed record. */
function outcomeOf(result: CliResult): string {
  try {
    const record = parseCanonical(Buffer.from(result.stdout.trim())) as { status?: unknown; failure_reason?: unknown };
    return [record.status, record.failure_reason].filter((part): part is string => typeof part === "string").join(" ");
  } catch (error) {
    if (error instanceof CanonicalError) return `exit ${String(result.code)}`;
    throw error;
  }
}

/** Publishes every terminal judge replay. Returns 0 when each one was published, otherwise the highest publisher exit code. */
export async function publishReplays(options: ReplayOptions, deps: ReplayDeps): Promise<number> {
  const store = options.localRuns === null ? deps.privateStoreFromEnv({ ...deps.env }) : new LocalPrivateStore(options.localRuns);
  const publisher = deps.publisher ?? ((argv, env) => runCli(argv, { env }));
  const keys = await store.list("judge/");
  const roots = keys.flatMap((key) => ROOT_RUN_KEY.exec(key)?.[1] ?? []).sort();
  let code = 0;
  for (const root of roots) {
    const prefix = `judge/${root}/`;
    const rootRun = rootRunOf(await getObject(store, `${prefix}root-run.json`), `${prefix}root-run.json`);
    if (rootRun.status !== "terminal") {
      deps.out(`root ${root} skipped not_terminal`);
      continue;
    }
    const work = mkdtempSync(join(tmpdir(), "rbw-replay-"));
    try {
      for (const key of keys.filter((item) => item.startsWith(prefix))) {
        const path = join(work, "root", ...key.slice(prefix.length).split("/"));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, await getObject(store, key));
      }
      const rootRunFile = join(work, "root", "root-run.json");
      const staging = join(work, "staging");
      const redactions = join(work, "private", "redactions.txt");
      const staged = stage({ run: join(work, "root", "run"), rootRun: rootRunFile, out: staging, redactionsOut: redactions });
      if (!staged.ok) throw new ReleaseInputError("replay_not_terminal", root);
      const result = await publisher(
        ["publish", "--policy", options.policy, "--root-run", rootRunFile, "--staging", staging, "--state", options.state, "--patterns", options.patterns, "--redaction-values", redactions, ...options.publishArgs],
        deps.env,
      );
      if (result.stderr.length > 0) deps.err?.(result.stderr);
      deps.out(`root ${root} ${outcomeOf(result)}`);
      code = Math.max(code, result.code);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return code;
}
