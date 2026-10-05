// Local replay server for tests. It serves recorded Tavily responses on 127.0.0.1, matched by
// endpoint plus the SHA-256 of the canonical request body. A request that matches no recording
// gets an error response and is listed in `unmatched`; nothing is ever forwarded.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recording {
  schema_version: 1;
  provenance: "synthetic" | "live";
  endpoint: "search" | "extract";
  recorded_at: string;
  request_body: unknown;
  response: { status: number; body: unknown };
}

export interface LoggedRequest {
  endpoint: string;
  body: Record<string, unknown>;
  bodyHash: string;
  hadAuthorization: boolean;
}

export type Fault = "hang" | "reset";

export interface ReplayServer {
  baseURL: string;
  requests: LoggedRequest[];
  unmatched: LoggedRequest[];
  close(): Promise<void>;
}

export interface ReplayOptions {
  recordings: Recording[];
  /** Called for every request before matching, in arrival order. */
  onRequest?: (request: LoggedRequest) => void;
  fault?: (request: LoggedRequest) => Fault | undefined;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function bodyHash(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startReplayServer(options: ReplayOptions): Promise<ReplayServer> {
  const table = new Map<string, Recording>();
  for (const recording of options.recordings) {
    const key = `${recording.endpoint}:${bodyHash(recording.request_body)}`;
    if (table.has(key)) {
      throw new Error(`two recordings match the same request (${recording.endpoint})`);
    }
    table.set(key, recording);
  }
  const requests: LoggedRequest[] = [];
  const unmatched: LoggedRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const text = await readBody(req);
    const parsed: unknown = text === "" ? {} : JSON.parse(text);
    const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
    const logged: LoggedRequest = {
      endpoint: (req.url ?? "").replace(/^\//, ""),
      body,
      bodyHash: bodyHash(body),
      hadAuthorization: req.headers.authorization !== undefined,
    };
    requests.push(logged);
    options.onRequest?.(logged);
    const fault = options.fault?.(logged);
    if (fault === "reset") {
      req.socket.destroy();
      return;
    }
    if (fault === "hang") {
      return;
    }
    const recording = table.get(`${logged.endpoint}:${logged.bodyHash}`);
    if (recording === undefined) {
      unmatched.push(logged);
      res.writeHead(599, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: { error: "replay: no recording matches this request" } }));
      return;
    }
    res.writeHead(recording.response.status, { "content-type": "application/json" });
    res.end(JSON.stringify(recording.response.body));
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => {
      resolve();
    }));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${String(port)}`,
    requests,
    unmatched,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => {
          resolve();
        });
      }),
  };
}
