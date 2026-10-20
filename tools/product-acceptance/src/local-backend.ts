import { execFile, spawn } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { Agent, createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { contractRevision, type IsolatedBackend, type Reply } from "./runner.ts";

export const pinnedBackendRevision = "f803962dcaf3b51b8881a7c4db99aeded33c7e1d";
const PASSCODE = "synthetic-factory-passcode";
const exec = promisify(execFile);
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const commandEnv = { PATH: `${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`, LANG: "C.UTF-8" };

function code(error: unknown): string {
  const value = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]+$/.test(value) ? value : "UNKNOWN";
}

/** Inspect names and git metadata only; dotenv contents and inherited credentials are never read. */
export async function inspectLocalBackend(directory: string): Promise<{ directory: string; webDirectory: string; nextBin: string }> {
  let root: string;
  let webDirectory: string;
  let names: string[];
  try {
    root = await realpath(directory);
    webDirectory = join(root, "packages/web");
    names = [...await readdir(root), ...await readdir(webDirectory)];
  } catch {
    throw new Error("Backend checkout directory is unavailable");
  }
  if (names.some(name => name === ".env" || name.startsWith(".env."))) throw new Error("Backend checkout contains a dotenv file");
  const git = async (...args: string[]) => {
    try {
      return (await exec("git", ["-C", root, ...args], { env: commandEnv, encoding: "utf8" })).stdout.trim();
    } catch {
      throw new Error("Backend checkout git metadata is unavailable");
    }
  };
  if (await git("rev-parse", "--show-toplevel") !== root) throw new Error("Backend path must be the checkout root");
  if (await git("status", "--porcelain=v1", "--untracked-files=normal") !== "") throw new Error("Backend checkout has uncommitted files");
  if (await git("rev-parse", "HEAD") !== pinnedBackendRevision) throw new Error("Backend revision does not match the pinned test service");
  let nextBin: string;
  try {
    nextBin = createRequire(join(webDirectory, "package.json")).resolve("next/dist/bin/next");
  } catch {
    throw new Error("Locked backend dependencies are unavailable; install them before starting test mode");
  }
  return { directory: root, webDirectory, nextBin };
}

/** One loopback HTTP client, also tested independently of any acceptance scenario. */
export class LocalHttpClient {
  private readonly origin: string;
  private readonly timeoutMs: number;
  private agent = new Agent({ keepAlive: true });
  private cookie: string | null = null;
  private closed = false;

  constructor(port: number, timeoutMs = 30_000) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Local HTTP port is invalid");
    this.origin = `http://127.0.0.1:${String(port)}`;
    this.timeoutMs = timeoutMs;
  }

  hasSession(): boolean { return this.cookie !== null; }

  close(): void {
    this.closed = true;
    this.agent.destroy();
  }

  reconnect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Local HTTP client is closed"));
    this.agent.destroy();
    this.agent = new Agent({ keepAlive: true });
    return Promise.resolve();
  }

  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
    if (this.closed) throw new Error("Local HTTP client is closed");
    if (!path.startsWith("/api/factory/")) throw new Error("Only local factory API paths are allowed");
    const target = new URL(path, this.origin);
    if (target.origin !== this.origin || !target.pathname.startsWith("/api/factory/") || target.hash !== "") throw new Error("Only local factory API paths are allowed");
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return await new Promise<Reply>((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.cookie !== null) headers.cookie = this.cookie;
      if (payload !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(payload));
      }
      let timedOut = false;
      const outgoing = httpRequest(target, { method, agent: this.agent, headers }, incoming => {
        const status = incoming.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          incoming.resume();
          reject(new Error("Local HTTP redirects are refused"));
          return;
        }
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("error", error => { reject(new Error(`Local HTTP response failed (${code(error)})`)); });
        incoming.on("end", () => {
          if (path === "/api/factory/session" && method === "POST" && status === 204) {
            const cookie = incoming.headers["set-cookie"]?.find(value => value.startsWith("rbw_factory_session="));
            const pair = cookie?.split(";")[0];
            if (pair !== undefined && pair.length > "rbw_factory_session=".length) this.cookie = pair;
          }
          const bytes = Buffer.concat(chunks);
          if (status === 204) { resolve({ status, body: null }); return; }
          if (!(incoming.headers["content-type"] ?? "").split(";")[0]?.trim().endsWith("/json")) {
            resolve({ status, body: new Uint8Array(bytes) });
            return;
          }
          try {
            const value: unknown = JSON.parse(bytes.toString("utf8"));
            resolve({ status, body: value });
          } catch {
            reject(new Error("Local HTTP response is not valid JSON"));
          }
        });
      });
      const timeout = setTimeout(() => { timedOut = true; outgoing.destroy(); }, this.timeoutMs);
      outgoing.on("close", () => { clearTimeout(timeout); });
      outgoing.on("error", error => { reject(new Error(timedOut ? "Local HTTP request timed out" : `Local HTTP request failed (${code(error)})`)); });
      outgoing.end(payload);
    });
  }
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => { reject(new Error("Could not allocate a loopback port")); });
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(new Error("Could not release the loopback port")); else resolve(); }));
  if (address === null || typeof address === "string") throw new Error("Could not allocate a loopback port");
  return address.port;
}

function isSession(reply: Reply, signedIn: boolean): boolean {
  if (reply.status !== 200 || reply.body === null || typeof reply.body !== "object") return false;
  const value = reply.body as Record<string, unknown>;
  return value.contract_version === "bug-request/1" && value.signed_in === signedIn;
}

/** Launch only the pinned, existing Next service in its documented disposable test mode. */
export async function startLocalBackend(backendDirectory: string): Promise<{ backend: IsolatedBackend; close: () => Promise<void> }> {
  const checkout = await inspectLocalBackend(backendDirectory);
  if (process.platform === "win32") throw new Error("Owned process-group cleanup requires the cloud Unix runtime");
  const port = await unusedLoopbackPort();
  const client = new LocalHttpClient(port);
  const child = spawn(process.execPath, [checkout.nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: checkout.webDirectory,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...commandEnv, NODE_ENV: "development", VERCEL_ENV: "development", RBW_FACTORY_TEST_MODE: "1", RBW_JUDGE_PASSCODE: PASSCODE, NEXT_TELEMETRY_DISABLED: "1", CI: "1", NO_COLOR: "1" },
  });
  const startup = { ready: false };
  let spawnError: string | null = null;
  let output = "";
  let diagnostic = "none";
  child.stdout.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-2048);
    if (output.includes("Ready in")) startup.ready = true;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const known = /\b(?:EADDRINUSE|ENOENT|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/.exec(chunk.toString("utf8"));
    if (known !== null) diagnostic = known[0];
  });
  const exited = new Promise<void>(resolve => {
    child.once("exit", () => { resolve(); });
    child.once("error", error => { spawnError = code(error); resolve(); });
  });
  const assertOwned = () => {
    if (spawnError !== null || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Owned local backend exited (code ${String(child.exitCode)}, diagnostic ${spawnError ?? diagnostic})`);
    }
  };
  const signal = (value: NodeJS.Signals | 0): boolean => {
    if (child.pid === undefined) return false;
    try { process.kill(-child.pid, value); return true; }
    catch (error) {
      if (code(error) === "ESRCH") return false;
      throw new Error(`Owned backend process cleanup failed (${code(error)})`, { cause: error });
    }
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    client.close();
    if (!signal("SIGTERM")) return;
    await Promise.race([exited, wait(3000)]);
    if (signal(0)) signal("SIGKILL");
    await Promise.race([exited, wait(3000)]);
  })();
  try {
    const deadline = Date.now() + 120_000;
    while (!startup.ready && Date.now() < deadline) { assertOwned(); await wait(100); }
    assertOwned();
    if (!startup.ready) throw new Error("Local backend startup timed out");
    if (!isSession(await client.request("GET", "/api/factory/session"), false)) throw new Error("Fresh local backend session could not be verified");
    const reset = await client.request("POST", "/api/factory/test/reset", { scenario: "two-host-fulfilled" });
    const response = reset.body as Record<string, unknown> | null;
    if (reset.status !== 200 || response?.contract_version !== "bug-request/1" || response.scenario !== "two-host-fulfilled") throw new Error("Local backend test-mode reset could not be verified");
    if ((await client.request("POST", "/api/factory/session", { passcode: PASSCODE })).status !== 204 || !client.hasSession()) throw new Error("Local backend session cookie could not be verified");
    const verifyIsolation = async () => {
      assertOwned();
      if (!isSession(await client.request("GET", "/api/factory/session"), true)) throw new Error("Local backend signed-in session could not be verified");
      assertOwned();
      return { backendRevision: pinnedBackendRevision, contractRevision };
    };
    await verifyIsolation();
    return {
      backend: {
        verifyIsolation,
        request: (method, path, body) => { assertOwned(); return client.request(method, path, body); },
        reconnect: () => client.reconnect(),
        wait,
      },
      close,
    };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Local backend startup and cleanup failed", { cause: cleanup }); }
    throw error;
  }
}
