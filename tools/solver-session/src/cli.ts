// The solver session's command line: a smoke run of one session with no model, for checking a
// kit image and the session's steps on a host with Docker. See README.md.
//
//   smoke --id <id> --image <tag|digest> --manifest <file> --terms <file> --work <dir>
//         [--digest <sha256:...>] [--policy <file>] [--probes <dir>] [--arm on|off] [--rebuilds <n>]
//
// It opens the session (derive, audit, container, overlay, snapshot, cold build and start), runs
// one command, reads the target file, runs <n> rebuild_restart calls (default 1), reads the
// server logs in the on arm, submits with no change, and closes. It prints one JSON line per step
// to stdout. Exit codes: 0 every step ran and every build started; 1 a step failed; 2 a usage
// error or a refusal before any container.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDocker, realClock } from "@rbw/local-runner";
import { Session, SessionError, SessionRefusal } from "./session.ts";

const USAGE = `usage:
  node src/cli.ts smoke --id <id> --image <tag|digest> --manifest <file> --terms <file> --work <dir> [--digest <sha256:...>] [--policy <file>] [--probes <dir>] [--arm on|off] [--rebuilds <n>]
`;

class UsageError extends Error {}

function print(step: string, value: unknown): void {
  process.stdout.write(`${JSON.stringify({ step, value })}\n`);
}

function path(values: Record<string, string | undefined>, name: string): string {
  const value = values[name];
  if (value === undefined || value === "") throw new UsageError(`--${name} is required`);
  return resolve(value);
}

async function smoke(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      id: { type: "string" },
      image: { type: "string" },
      digest: { type: "string" },
      manifest: { type: "string" },
      terms: { type: "string" },
      work: { type: "string" },
      policy: { type: "string" },
      probes: { type: "string" },
      arm: { type: "string" },
      rebuilds: { type: "string" },
    },
  });
  const arm = values.arm ?? "on";
  if (arm !== "on" && arm !== "off") throw new UsageError("--arm must be on or off");
  const rebuilds = Number(values.rebuilds ?? "1");
  if (!Number.isInteger(rebuilds) || rebuilds < 0 || rebuilds > 8) throw new UsageError("--rebuilds must be 0 to 8");
  if (values.id === undefined || values.image === undefined) throw new UsageError("--id and --image are required");
  const { session, opened } = await Session.open(
    {
      id: values.id,
      image: values.image,
      expectedDigest: values.digest ?? null,
      work: path(values, "work"),
      manifest: path(values, "manifest"),
      terms: path(values, "terms"),
      policy: values.policy === undefined ? null : resolve(values.policy),
      ...(values.probes === undefined ? {} : { probesDir: resolve(values.probes) }),
      serverLogs: arm === "on",
    },
    { docker: createDocker(), clock: realClock },
  );
  let ok = opened.initial.ok;
  try {
    print("opened", opened);
    print("run", await session.run("id && pwd && ls -A | head -n 5"));
    const read = await session.readFile("package.json");
    print("read_file", read.ok ? { ok: true, bytes: read.content.length } : read);
    for (let index = 0; index < rebuilds; index += 1) {
      const result = await session.rebuildRestart();
      print("rebuild_restart", result);
      ok &&= result.ok;
    }
    print("server_logs", await session.serverLogs());
    print("submit", await session.submit());
  } finally {
    await session.close();
  }
  return ok ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "smoke") return await smoke(rest);
    throw new UsageError(`unknown command ${command ?? "(none)"}`);
  } catch (error) {
    if (error instanceof UsageError || error instanceof SessionRefusal) {
      process.stderr.write(`solver-session: ${error.message}\n${error instanceof UsageError ? USAGE : ""}`);
      return 2;
    }
    if (error instanceof SessionError) {
      process.stderr.write(`solver-session: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
