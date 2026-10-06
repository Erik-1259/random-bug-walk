// A harvest run and its replay. `harvest` makes live GitHub calls through the recording transport
// and writes the manifest, the frozen responses and the funnel to a new run directory. `replay`
// rebuilds the funnel from that directory alone, with the queries and cap the manifest recorded.
import { mkdirSync, readdirSync } from "node:fs";
import { FUNNEL, readManifest, recordingTransport, replayTransport, RunDirectoryError, writeFunnel, writeManifest, type Manifest } from "./frozen.ts";
import { runFunnel, type FunnelCore } from "./funnel.ts";
import { API_BASE_URL, type GitHubClient } from "./github.ts";
import { QUERIES, type Query } from "./queries.ts";

export type Funnel = Omit<FunnelCore, "queries"> & {
  readonly harvest: Omit<Manifest, "schema_version" | "tool" | "queries"> & { readonly queries: FunnelCore["queries"] };
};

export interface HarvestOptions {
  readonly client: GitHubClient;
  readonly out: string;
  readonly max: number;
  readonly queries?: readonly Query[];
  readonly clock: () => Date;
  /** Whether the client sends a token; recorded so a reader knows which rate limits applied. */
  readonly authenticated: boolean;
}

function assemble(manifest: Manifest, core: FunnelCore): Funnel {
  const { queries, ...rest } = core;
  return {
    ...rest,
    harvest: {
      api_base_url: manifest.api_base_url,
      authenticated: manifest.authenticated,
      max: manifest.max,
      started_at: manifest.started_at,
      completed_at: manifest.completed_at,
      queries,
    },
  };
}

function prepare(out: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(out);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new RunDirectoryError(`cannot read ${out}`, { cause: error });
    }
  }
  if (entries.length > 0) {
    throw new RunDirectoryError(`${out} is not empty; each harvest needs a new directory`);
  }
  mkdirSync(out, { recursive: true });
}

export async function harvest(options: HarvestOptions): Promise<Funnel> {
  prepare(options.out);
  const manifest: Manifest = {
    schema_version: 2,
    tool: "@rbw/harvest",
    api_base_url: API_BASE_URL,
    authenticated: options.authenticated,
    max: options.max,
    queries: (options.queries ?? QUERIES).map((query) => ({ kind: query.kind, api: query.api, q: query.q })),
    started_at: options.clock().toISOString(),
    completed_at: null,
  };
  writeManifest(options.out, manifest);
  const core = await runFunnel(recordingTransport(options.client, options.out, options.clock), manifest);
  const completed = { ...manifest, completed_at: options.clock().toISOString() };
  writeManifest(options.out, completed);
  const funnel = assemble(completed, core);
  writeFunnel(options.out, funnel);
  return funnel;
}

export async function replay(dir: string): Promise<Funnel> {
  const manifest = readManifest(dir);
  if (manifest.completed_at === null) {
    throw new RunDirectoryError(`the harvest in ${dir} did not complete, so its ${FUNNEL} cannot be rebuilt`);
  }
  return assemble(manifest, await runFunnel(replayTransport(dir), manifest));
}
