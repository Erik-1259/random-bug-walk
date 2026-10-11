// `node packages/harvest-review/src/cli.ts <command> ...`: see commands.ts and the README. Reads
// DATABASE_URL and TOKEN_FACTORY_REVIEW_KEY for `review` and `acceptance`; never prints either value.
import pg from "pg";
import { createSpend, fromPg } from "@rbw/spend";
import { runCommand } from "./commands.ts";
import { liveFetch } from "./live-fetch.ts";

const connectionErrors: unknown[] = [];

process.exitCode = await runCommand({
  argv: process.argv.slice(2),
  env: process.env,
  fetch: liveFetch(),
  provenance: "live",
  connect: async (databaseUrl) => {
    const client = new pg.Client({ connectionString: databaseUrl });
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
  },
  write: (text) => process.stdout.write(text),
  now: () => new Date(),
});
