// HTTP for the F3 check: one TCP connection per request (no agent), so no request waits for another
// on the client side, and a send that is not awaited still records when it settled. A failed or
// timed-out send is recorded as a transport error, never as a status.
import http from "node:http";
import type { RequestView } from "./classify.ts";

export interface InFlight {
  readonly view: RequestView;
  /** The parsed JSON body, or null. */
  json: unknown;
  /** Resolves when the request settles; never rejects. */
  readonly done: Promise<void>;
}

export interface HttpClient {
  send(method: "GET" | "POST" | "PATCH", path: string, body: unknown): InFlight;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** A client for the app at baseUrl; times are milliseconds from `origin()`. */
export function httpClient(baseUrl: string, timeoutMs: number, origin: () => number): HttpClient {
  const base = new URL(baseUrl);
  const port = base.port === "" ? 80 : Number(base.port);
  return {
    send(method, path, body) {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
      const view: RequestView = {
        status: null,
        error_code: null,
        transport_error: false,
        settled: false,
        request_id: null,
        sent_ms: origin(),
        settled_ms: null,
        body: null,
      };
      const handle: { view: RequestView; json: unknown; done: Promise<void> } = { view, json: null, done: Promise.resolve() };
      handle.done = new Promise<void>((resolve) => {
        const finish = (): void => {
          if (view.settled) return;
          view.settled = true;
          view.settled_ms = origin();
          resolve();
        };
        const headers: Record<string, string> = payload === undefined ? {} : { "content-type": "application/json", "content-length": String(payload.length) };
        const request = http.request({ host: base.hostname, port, method, path, agent: false, headers }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            view.status = response.statusCode ?? null;
            const requestId = response.headers["x-request-id"];
            view.request_id = typeof requestId === "string" ? requestId : null;
            let json: unknown;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              json = null;
            }
            handle.json = json;
            if (isRecord(json)) {
              const error = json.error;
              view.error_code = isRecord(error) ? stringField(error, "code") : null;
              if (view.status === 201 && path.endsWith("/completions")) {
                view.body = { id: stringField(json, "id"), task_id: stringField(json, "task_id"), completed_at: stringField(json, "completed_at") };
              }
            }
            finish();
          });
          response.on("error", () => {
            view.status = null;
            view.transport_error = true;
            finish();
          });
        });
        const timer = setTimeout(() => request.destroy(new Error("client_timeout")), timeoutMs);
        request.on("close", () => {
          clearTimeout(timer);
        });
        request.on("error", () => {
          view.status = null;
          view.transport_error = true;
          finish();
        });
        if (payload !== undefined) request.write(payload);
        request.end();
      });
      return handle;
    },
  };
}

/** Waits until every handle settled or `limitMs` passed; returns whether all settled. */
export async function settleWithin(handles: readonly InFlight[], limitMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(handles.map((handle) => handle.done)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, limitMs));
    }),
  ]);
  clearTimeout(timer);
  return handles.every((handle) => handle.view.settled);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
