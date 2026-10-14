// `migrate`: applies pending migrations to the database named by DATABASE_URL.
// Usage: node src/cli.ts [--schema <name>]
// Never prints the connection string or any part of it.
import pg from "pg";
import { errorCode, fromPg } from "./client.ts";
import { runMigrate } from "./migrate.ts";
import { redactor } from "./redact.ts";

function fail(message: string): never {
  process.stderr.write(`migrate: ${message}\n`);
  process.exit(1);
}

function schemaArgument(args: string[]): string | undefined {
  if (args.length === 0) {
    return undefined;
  }
  if (args.length === 2 && args[0] === "--schema" && args[1] !== undefined) {
    return args[1];
  }
  return fail("usage: migrate [--schema <name>]");
}

const schema = schemaArgument(process.argv.slice(2));
const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  fail("DATABASE_URL is not set");
}

let redact: (text: string) => string;
try {
  redact = redactor(connectionString);
} catch {
  fail("DATABASE_URL is not a valid connection URL");
}

const client = new pg.Client({ connectionString });
let connectionError: unknown;
client.on("error", (error) => {
  connectionError = error;
});
try {
  await client.connect();
} catch (error) {
  fail(`could not connect to the database named by DATABASE_URL (error code ${errorCode(error)})`);
}

const exitCode = await runMigrate(fromPg(client), {
  ...(schema === undefined ? {} : { schema }),
  write: (line, kind) => {
    (kind === "error" ? process.stderr : process.stdout).write(`${line}\n`);
  },
  redact,
});
await client.end();
if (connectionError !== undefined) {
  fail(`the database connection failed (error code ${errorCode(connectionError)})`);
}
process.exitCode = exitCode;
