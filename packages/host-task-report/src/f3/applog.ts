// The app's contract-declared request log, read from the evaluator-owned file the launcher
// writes: one JSON line per request with `ts` (when the line was written, after the response),
// `duration_ms` (from the handler's start) and `request_id`, the response's x-request-id. A
// request's start in the app's clock is ts - duration_ms and its end is ts.
import { readFileSync } from "node:fs";
import type { LogTiming } from "./classify.ts";
import { sleep } from "./http.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Request timings by request ID from log text; lines that are not request events are skipped. */
export function parseRequestLog(text: string, event: string): Map<string, LogTiming> {
  const out = new Map<string, LogTiming>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.event !== event) continue;
    const { ts, duration_ms: duration, request_id: id, status } = value;
    if (typeof ts !== "string" || typeof id !== "string" || typeof duration !== "number" || typeof status !== "number") continue;
    const end = Date.parse(ts);
    if (!Number.isFinite(end) || !Number.isFinite(duration)) continue;
    out.set(id, { start_ms: end - duration, end_ms: end, status });
  }
  return out;
}

/** Waits up to `waitMs` for every ID to appear in the log file, then returns what was found. */
export async function readTimings(path: string, event: string, ids: readonly string[], waitMs: number): Promise<Record<string, LogTiming>> {
  const deadline = performance.now() + waitMs;
  for (;;) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = "";
    }
    const timings = parseRequestLog(text, event);
    const found: Record<string, LogTiming> = {};
    for (const id of ids) {
      const timing = timings.get(id);
      if (timing !== undefined) found[id] = timing;
    }
    if (Object.keys(found).length === ids.length || performance.now() >= deadline) return found;
    await sleep(50);
  }
}
