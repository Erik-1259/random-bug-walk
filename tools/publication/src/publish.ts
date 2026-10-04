import { randomBytes } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  MAX_REQUEST_BYTES,
  OPERATIONS,
  parseResponse,
  validBody,
  validTitle,
  type Operation,
  type PublicationRequest,
  type PublicationResponse,
} from "./protocol.ts";
import { runProcess } from "./run.ts";

const DEFAULT_INBOX = "/inbox";
const DEFAULT_CLAIM_TIMEOUT_SECONDS = 60;
const DEFAULT_RESULT_TIMEOUT_SECONDS = 900;
const POLL_MS = 200;

const EXIT = { published: 0, blocked: 1, unavailable: 2, stale: 3, unknown: 4 } as const;
const REFUSED_LINE = "The request, its registration or the branch state was refused; the conductor can see why in the host log.";

const USAGE = `usage: rbw-publish push [--sha <sha>]
       rbw-publish pr-create --title <text> --body-file <file> [--sha <sha>]
       rbw-publish pr-comment --body-file <file> [--sha <sha>]
options: --claim-timeout <seconds> (default ${String(DEFAULT_CLAIM_TIMEOUT_SECONDS)})
         --result-timeout <seconds> (default ${String(DEFAULT_RESULT_TIMEOUT_SECONDS)})
         --inbox <dir> (default ${DEFAULT_INBOX})`;

class LocalCheckFailed extends Error {}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function git(args: readonly string[]): Promise<string | null> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  const result = await runProcess("git", args, { cwd: process.cwd(), env });
  return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
}

function seconds(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback * 1000;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new LocalCheckFailed("timeouts must be positive numbers of seconds");
  return parsed * 1000;
}

function newRequestId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(6).toString("hex")}`;
}

async function readBody(path: string | undefined): Promise<string> {
  if (path === undefined) throw new LocalCheckFailed("--body-file is required");
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new LocalCheckFailed("the body file cannot be read");
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new LocalCheckFailed("the body file is not valid UTF-8");
  }
  if (!validBody(body)) throw new LocalCheckFailed("the body must have at most 65536 characters and no NUL");
  return body;
}

interface Invocation {
  request: PublicationRequest;
  requestsDir: string;
  responsesDir: string;
  claimTimeoutMs: number;
  resultTimeoutMs: number;
}

async function prepare(argv: readonly string[]): Promise<Invocation> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        sha: { type: "string" },
        title: { type: "string" },
        "body-file": { type: "string" },
        "claim-timeout": { type: "string" },
        "result-timeout": { type: "string" },
        inbox: { type: "string" },
      },
    });
  } catch {
    throw new LocalCheckFailed(USAGE);
  }
  const { values, positionals } = parsed;
  const [operation, ...extra] = positionals;
  if (!OPERATIONS.includes(operation as Operation) || extra.length > 0) throw new LocalCheckFailed(USAGE);
  const op = operation as Operation;
  if (op !== "pr-create" && values.title !== undefined) throw new LocalCheckFailed("--title applies to pr-create only");
  if (op === "push" && values["body-file"] !== undefined) throw new LocalCheckFailed("--body-file applies to PR operations only");

  const worktreeId = await git(["config", "--local", "--get", "rbw.worktreeId"]);
  if (worktreeId === null || worktreeId === "") throw new LocalCheckFailed("rbw.worktreeId is not set in this clone's git config");
  // The token is sent in the request only; it is never printed.
  const token = await git(["config", "--local", "--get", "rbw.worktreeToken"]);
  if (token === null || !/^[0-9a-f]{64}$/.test(token)) throw new LocalCheckFailed("rbw.worktreeToken is missing or malformed in this clone's git config");
  const revision = values.sha ?? "HEAD";
  if (revision.startsWith("-")) throw new LocalCheckFailed("the SHA does not name a commit");
  const sha = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`]);
  if (sha === null || !/^[0-9a-f]{40}$/.test(sha)) throw new LocalCheckFailed("the SHA does not name a commit");

  const request: PublicationRequest = { version: 1, requestId: newRequestId(), worktreeId, token, operation: op, sha };
  if (op === "pr-create") {
    if (values.title === undefined || !validTitle(values.title)) throw new LocalCheckFailed("the title must be one line of 1 to 256 characters");
    request.title = values.title;
  }
  if (op !== "push") request.body = await readBody(values["body-file"]);

  const claimTimeoutMs = seconds(values["claim-timeout"], DEFAULT_CLAIM_TIMEOUT_SECONDS);
  const resultTimeoutMs = Math.max(claimTimeoutMs, seconds(values["result-timeout"], DEFAULT_RESULT_TIMEOUT_SECONDS));
  const publication = join(values.inbox ?? DEFAULT_INBOX, "publication");
  return { request, requestsDir: join(publication, "requests"), responsesDir: join(publication, "responses"), claimTimeoutMs, resultTimeoutMs };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** Writes the request under a dot-prefixed name, then renames it into place. */
async function submit(invocation: Invocation): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(invocation.request));
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new LocalCheckFailed("the request is larger than 1 MiB");
  let ready = false;
  try {
    ready = (await lstat(invocation.requestsDir)).isDirectory();
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw error;
  }
  if (!ready) throw new LocalCheckFailed("the publication inbox is not available");
  const id = invocation.request.requestId;
  const temporary = join(invocation.requestsDir, `.${id}.json.tmp`);
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  const target = join(invocation.requestsDir, `${id}.json`);
  await rename(temporary, target);
  return target;
}

function report(response: PublicationResponse): number {
  const lines: string[] = [response.outcome];
  if (response.outcome === "published" && response.publishedSha !== undefined) lines.push(response.publishedSha);
  if (response.outcome === "blocked") lines.push(...((response.locations ?? []).length > 0 ? (response.locations ?? []) : [REFUSED_LINE]));
  process.stdout.write(`${lines.join("\n")}\n`);
  return EXIT[response.outcome];
}

async function wait(invocation: Invocation, requestPath: string): Promise<number> {
  const id = invocation.request.requestId;
  const responsePath = join(invocation.responsesDir, `${id}.json`);
  const start = Date.now();
  let claimed = false;
  for (;;) {
    if (await exists(responsePath)) {
      const response = parseResponse(await readFile(responsePath), id);
      if (response === null) {
        process.stdout.write("unavailable\n");
        process.stderr.write("rbw-publish: the response could not be read\n");
        return EXIT.unavailable;
      }
      return report(response);
    }
    const elapsed = Date.now() - start;
    if (!claimed && !(await exists(requestPath))) claimed = true;
    if (!claimed && elapsed > invocation.claimTimeoutMs) {
      try {
        await unlink(requestPath);
        process.stdout.write("unavailable\n");
        process.stderr.write("rbw-publish: no helper claimed the request; it was withdrawn\n");
        return EXIT.unavailable;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        claimed = true;
      }
    }
    if (claimed && elapsed > invocation.resultTimeoutMs) {
      process.stdout.write(`unknown\n${id}\n`);
      process.stderr.write(`rbw-publish: the helper claimed request ${id} but no response arrived; the host log has its outcome\n`);
      return EXIT.unknown;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function main(argv: readonly string[]): Promise<number> {
  let invocation: Invocation;
  let requestPath: string;
  try {
    invocation = await prepare(argv);
    requestPath = await submit(invocation);
  } catch (error) {
    if (!(error instanceof LocalCheckFailed)) throw error;
    process.stderr.write(`rbw-publish: ${error.message}\n`);
    return EXIT.unavailable;
  }
  return wait(invocation, requestPath);
}

process.exitCode = await main(process.argv.slice(2));
