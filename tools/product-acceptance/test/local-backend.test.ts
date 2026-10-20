import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { LocalHttpClient, inspectLocalBackend, startLocalBackend } from "../src/local-backend.ts";

const directories: string[] = [];
const clients: LocalHttpClient[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); }));
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function checkout(): string {
  const directory = mkdtempSync(join(tmpdir(), "rbw-synthetic-backend-"));
  directories.push(directory);
  mkdirSync(join(directory, "packages/web"), { recursive: true });
  writeFileSync(join(directory, "synthetic.txt"), "synthetic original\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { stdio: "ignore" });
  git("init", "--quiet");
  git("add", "synthetic.txt");
  git("-c", "user.name=synthetic-user", "-c", "user.email=synthetic-user@example.invalid", "commit", "--quiet", "-m", "test: synthetic checkout");
  return directory;
}

it("refuses an unpinned checkout before starting any backend process", async () => {
  await expect(startLocalBackend(checkout())).rejects.toThrow("Backend revision does not match the pinned test service");
});

it("refuses tracked backend edits", async () => {
  const directory = checkout();
  writeFileSync(join(directory, "synthetic.txt"), "synthetic changed\n");
  await expect(inspectLocalBackend(directory)).rejects.toThrow("Backend checkout has uncommitted files");
});

it.each([".env", "packages/web/.env.development.local"])("refuses dotenv names without reading %s", async name => {
  const directory = checkout();
  writeFileSync(join(directory, name), "");
  await expect(inspectLocalBackend(directory)).rejects.toThrow("Backend checkout contains a dotenv file");
});

it("accepts a checkout path, never an external target URL", async () => {
  await expect(inspectLocalBackend("https://synthetic.invalid")).rejects.toThrow("Backend checkout directory is unavailable");
});

// This small server checks transport behavior only. It does not implement scenarios or serve as
// evidence that the request service, its worker, or any acceptance scenario passes.
async function transport(timeoutMs = 1000) {
  let connections = 0;
  let hits = 0;
  const socketIds = new WeakMap<Socket, number>();
  const server = createServer((request, response) => {
    hits++;
    const json = (value: unknown) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    };
    switch (request.url) {
      case "/api/factory/session":
        response.statusCode = 204;
        response.setHeader("set-cookie", "rbw_factory_session=synthetic-session; Path=/api/factory; HttpOnly; Secure; SameSite=Strict");
        response.end();
        break;
      case "/api/factory/archive":
        response.setHeader("content-type", "application/gzip");
        response.end(Buffer.from([0, 255, 31, 139, 8]));
        break;
      case "/api/factory/redirect":
        response.writeHead(302, { location: "/api/factory/echo" });
        response.end();
        break;
      case "/api/factory/invalid-json":
        response.setHeader("content-type", "application/json");
        response.end("synthetic-invalid-json");
        break;
      case "/api/factory/wait":
        break;
      default:
        json({ cookie: request.headers.cookie ?? null, connection: socketIds.get(request.socket) });
    }
  });
  server.on("connection", socket => socketIds.set(socket, ++connections));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Synthetic transport server has no port");
  const client = new LocalHttpClient(address.port, timeoutMs);
  clients.push(client);
  return { client, hits: () => hits };
}

it("preserves the session cookie while reconnecting on a new HTTP connection", async () => {
  const { client } = await transport();
  expect(await client.request("POST", "/api/factory/session", { passcode: "synthetic-passcode" })).toEqual({ status: 204, body: null });
  expect(client.hasSession()).toBe(true);
  const first = await client.request("GET", "/api/factory/echo");
  expect(first.body).toEqual({ cookie: "rbw_factory_session=synthetic-session", connection: 1 });
  await client.reconnect();
  const second = await client.request("GET", "/api/factory/echo");
  expect(second.body).toEqual({ cookie: "rbw_factory_session=synthetic-session", connection: 2 });
});

it("returns archive bytes unchanged", async () => {
  const { client } = await transport();
  const response = await client.request("GET", "/api/factory/archive");
  expect(response.status).toBe(200);
  expect(response.body).toEqual(new Uint8Array([0, 255, 31, 139, 8]));
});

it("rejects redirects instead of following them", async () => {
  const { client, hits } = await transport();
  await expect(client.request("GET", "/api/factory/redirect")).rejects.toThrow("Local HTTP redirects are refused");
  expect(hits()).toBe(1);
});

it.each(["https://synthetic.invalid/api/factory/session", "/api/judge/session", "/api/factory/../judge/session"])("refuses an out-of-scope path %s before sending", async path => {
  const { client, hits } = await transport();
  await expect(client.request("GET", path)).rejects.toThrow("Only local factory API paths are allowed");
  expect(hits()).toBe(0);
});

it("bounds an unresponsive local HTTP request", async () => {
  const { client } = await transport(30);
  await expect(client.request("GET", "/api/factory/wait")).rejects.toThrow("Local HTTP request timed out");
});

it("reports invalid JSON without returning response contents", async () => {
  const { client } = await transport();
  await expect(client.request("GET", "/api/factory/invalid-json")).rejects.toThrow(/^Local HTTP response is not valid JSON$/);
});

it("refuses requests after the transport is closed", async () => {
  const { client, hits } = await transport();
  client.close();
  await expect(client.request("GET", "/api/factory/echo")).rejects.toThrow("Local HTTP client is closed");
  expect(hits()).toBe(0);
});
