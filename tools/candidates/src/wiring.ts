// The real implementations the command line binds: the site finder from @rbw/shapes and the static
// screen from @rbw/screen. The pipeline and its tests do not import this file; they take the
// functions as arguments, so tests pass fakes.
import pg from "pg";
import { createSpend, fromPg } from "@rbw/spend";
import { readFileSync } from "node:fs";
import type { ScreenConfig } from "./command.ts";
import { findClassSites } from "./shapes-finder.ts";
import { makeStaticScreen, type Connect } from "./static-screen.ts";
import type { FindSites, Screen } from "./types.ts";

export const findSites: FindSites = findClassSites;

/** The real fetch, as @rbw/writer's fetch function. */
const liveFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => fetch(input, init);

/** Opens the spend ledger in the Postgres named by DATABASE_URL (the migrations must already be applied). */
const connect: Connect = async (databaseUrl) => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  return {
    spend: createSpend({ client: fromPg(client) }),
    close: () => client.end(),
  };
};

/** The real screen, built from the run's options. */
export function makeScreen(config: ScreenConfig): Screen {
  return makeStaticScreen({
    fetch: liveFetch,
    connect,
    env: config.env,
    rateSheet: readFileSync(config.rateSheetPath),
    slotKey: config.slotKey,
    pool: config.pool,
    provenance: "live",
  });
}
