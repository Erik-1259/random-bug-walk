// The real implementations the command line binds: the site finder from @rbw/shapes and the static
// screen from @rbw/screen. The pipeline and its tests do not import this file; they take the
// functions as arguments, so tests pass fakes.
import pg from "pg";
import { liveFetch } from "@rbw/screen";
import { createSpend, fromPg } from "@rbw/spend";
import type { FetchFunction } from "@rbw/writer";
import { readFileSync } from "node:fs";
import type { ScreenConfig } from "./command.ts";
import { findClassSites } from "./shapes-finder.ts";
import { makeStaticScreen, type Connect } from "./static-screen.ts";
import type { FindSites, Screen } from "./types.ts";

export const findSites: FindSites = findClassSites;

/**
 * The fetch a live screen uses: @rbw/screen's, whose header and body timeouts match the longest
 * screen profile. Node's own fetch gives up after 300 s without response headers, and a
 * non-streaming completion sends none until it finishes, so a long call would fail after it may
 * already have been billed.
 */
export function screenFetch(): FetchFunction {
  return liveFetch();
}

/**
 * Opens the spend ledger in the Postgres named by DATABASE_URL (the migrations must already be
 * applied). A connection error event (for example the server closing an idle connection during a
 * long model call) is collected instead of ending the process, and reported by close(), so the
 * screen fails with a reason instead of the whole run crashing.
 */
export function makeConnect(newClient: (databaseUrl: string) => pg.Client = (url) => new pg.Client({ connectionString: url })): Connect {
  return async (databaseUrl) => {
    const client = newClient(databaseUrl);
    const connectionErrors: unknown[] = [];
    client.on("error", (error) => connectionErrors.push(error));
    await client.connect();
    return {
      spend: createSpend({ client: fromPg(client) }),
      close: async () => {
        await client.end();
        if (connectionErrors.length > 0) {
          throw new Error(`${String(connectionErrors.length)} connection error(s) on the database named by DATABASE_URL`);
        }
      },
    };
  };
}

/** The real screen, built from the run's options. */
export function makeScreen(config: ScreenConfig): Screen {
  return makeStaticScreen({
    fetch: screenFetch(),
    connect: makeConnect(),
    env: config.env,
    rateSheet: readFileSync(config.rateSheetPath),
    slotKey: config.slotKey,
    pool: config.pool,
    provenance: "live",
    outBase: config.scratchBase,
    keepOutput: config.keepScratch,
  });
}
