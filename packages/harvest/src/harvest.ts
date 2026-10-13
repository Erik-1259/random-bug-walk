// A harvest run and its replay. `harvest` makes live GitHub calls through the recording transport
// and writes the manifest, the frozen responses and the funnel to a new run directory. `replay`
// rebuilds the funnel from that directory alone, with the shape, queries and cap the manifest recorded.
import { mkdirSync, readdirSync } from "node:fs";
import { FUNNEL, readManifest, recordingTransport, replayTransport, RunDirectoryError, writeFunnel, writeManifest, type Manifest } from "./frozen.ts";
import { runFunnel, type FunnelCore } from "./funnel.ts";
import { API_BASE_URL, type GitHubClient } from "./github.ts";
import { loadQueries, type Query } from "./queries.ts";
import { DT1_HARVEST_SHAPE, harvestShape, type HarvestShape } from "./shapes.ts";

export type Funnel = Omit<FunnelCore, "queries"> & {
  readonly harvest: Omit<Manifest, "schema_version" | "tool" | "queries" | "shape_id"> & { readonly queries: FunnelCore["queries"] };
};

export interface HarvestOptions {
  readonly client: GitHubClient;
  readonly out: string;
  readonly max: number;
  /** The shape's own query file when absent. */
  readonly queries?: readonly Query[];
  /** DT-1.tz-arg when absent. */
  readonly shape?: HarvestShape;
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
  const shape = options.shape ?? DT1_HARVEST_SHAPE;
  const manifest: Manifest = {
    schema_version: 2,
    tool: "@rbw/harvest",
    // The default shape is left implicit, so its manifest is the one written before shapes could be chosen.
    ...(shape.id === DT1_HARVEST_SHAPE.id ? {} : { shape_id: shape.id }),
    api_base_url: API_BASE_URL,
    authenticated: options.authenticated,
    max: options.max,
    queries: (options.queries ?? loadQueries(shape.query_file)).map((query) => ({ kind: query.kind, api: query.api, q: query.q })),
    started_at: options.clock().toISOString(),
    completed_at: null,
  };
  writeManifest(options.out, manifest);
  const core = await runFunnel(recordingTransport(options.client, options.out, options.clock), { ...manifest, shape });
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
  const shape = harvestShape(manifest.shape_id ?? DT1_HARVEST_SHAPE.id);
  return assemble(manifest, await runFunnel(replayTransport(dir), { ...manifest, shape }));
}
