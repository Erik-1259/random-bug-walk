// `pnpm --filter @rbw/writer run record -- ...`: see record.ts and the README. Reads DATABASE_URL
// and TOKEN_FACTORY_WRITER_KEY; never prints either value or any request header.
import pg from "pg";
import { createSpend, fromPg } from "@rbw/spend";
import { runRecord } from "./record.ts";

const connectionErrors: unknown[] = [];

process.exitCode = await runRecord({
  argv: process.argv.slice(2),
  env: process.env,
  fetch: globalThis.fetch,
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
