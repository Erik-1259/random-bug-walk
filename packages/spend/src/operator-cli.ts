// Operator entry: one connection, no retries, and no connection details in output.
import pg from "pg";
import { errorCode, fromPg } from "./client.ts";
import { runOperator } from "./operator.ts";
import { redactor } from "./redact.ts";

function fail(message: string): never {
  process.stderr.write(`operator: ${message}\n`);
  process.exit(2);
}
const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") fail("DATABASE_URL is not set");
let redact: (text: string) => string;
try { redact = redactor(connectionString); }
catch { fail("DATABASE_URL is not a valid connection URL"); }
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
let connectionError: unknown;
client.on("error", (error) => { connectionError = error; });
try { await client.connect(); }
catch (error) { fail(redact(`could not connect to DATABASE_URL (error code ${errorCode(error)}); the command can be run again`)); }
const code = await runOperator(fromPg(client), process.argv.slice(2), {
  write: (line, kind) => { (kind === "error" ? process.stderr : process.stdout).write(`${line}\n`); },
  redact,
});
try { await client.end(); }
catch (error) { fail(redact(`closing the DATABASE_URL connection failed (error code ${errorCode(error)}); the command can be run again`)); }
if (connectionError !== undefined) fail(redact(`DATABASE_URL connection failed (error code ${errorCode(connectionError)}); the command can be run again`));
process.exitCode = code;
