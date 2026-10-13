// The parsing and comparison behind bin/rbw-proxy, shipped in the race image as
// /opt/rbw/verifier/rbw-proxy-check.ts and run by the verifier's Node 24, which strips the types.
// It imports only Node built-ins, because the image holds this one file and not the kit sources.
//
//   latency <race.environment> <override file>   prints the latency in effect: the override's
//                                                 when that file exists, else the image default
//   valid-latency <ms>                            exits 0 when <ms> is an allowed latency
//   check <proxy> <listen> <upstream> <toxic> <latency ms>
//                                                 reads Toxiproxy's GET /proxies JSON on stdin and
//                                                 exits 0 only when it is exactly as configured
//   mark <log> <from byte>                        prints the byte offset just after the first
//                                                 "GET /version" request by rbw-proxy-mark logged
//                                                 at or after <from>; exits 3 while there is none
//   audit <log> <mark byte> <cap bytes>           exits 0 when every API request logged after the
//                                                 mark is a GET and rbw-proxy-check's own
//                                                 GET /proxies is among them, 1 when a request
//                                                 could have changed the proxy, 3 while the
//                                                 check's own request is not logged yet
import { readFileSync } from "node:fs";

export const MAX_LATENCY_MS = 10000;
export const LATENCY_KEY = "RBW_RACE_LATENCY_MS";
/** The user agents rbw-proxy sends, so its own requests can be found in Toxiproxy's log. */
export const MARK_AGENT = "rbw-proxy-mark";
export const CHECK_AGENT = "rbw-proxy-check";

/** A latency as written in a file or on a command line: a whole number of ms, no leading zero. */
export function parseLatencyValue(value: string): number {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > MAX_LATENCY_MS) {
    throw new Error(`${LATENCY_KEY} must be a whole number of milliseconds from 0 to ${String(MAX_LATENCY_MS)}`);
  }
  return Number(value);
}

/** Reads a race.environment-style file: comments, blank lines and exactly one RBW_RACE_LATENCY_MS line. */
export function readLatencyFile(text: string): number {
  const lines = text.split("\n").filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  const values = lines.filter((line) => line.startsWith(`${LATENCY_KEY}=`));
  if (values.length !== lines.length || values.length > 1) {
    throw new Error(`race.environment holds only ${LATENCY_KEY}`);
  }
  return parseLatencyValue(values[0]?.slice(LATENCY_KEY.length + 1) ?? "");
}

/** The latency in effect: a root-written override for this container when there is one, else the image default. */
export function effectiveLatency(config: string, override: string | undefined): number {
  const fallback = readLatencyFile(config);
  return override === undefined ? fallback : readLatencyFile(override);
}

export interface ExpectedProxy {
  name: string;
  listen: string;
  upstream: string;
  toxic: string;
  latencyMs: number;
}

/** Compares Toxiproxy's GET /proxies answer with the configuration; returns the differences. */
export function checkProxies(proxies: unknown, expected: ExpectedProxy): string[] {
  const problems: string[] = [];
  if (typeof proxies !== "object" || proxies === null || Array.isArray(proxies)) {
    return ["the API's /proxies answer is not an object"];
  }
  const all = proxies as Record<string, unknown>;
  const names = Object.keys(all);
  if (names.length !== 1 || names[0] !== expected.name) {
    problems.push(`proxies are ${JSON.stringify(names)}, expected only ${expected.name}`);
  }
  const proxy = (all[expected.name] ?? {}) as Record<string, unknown>;
  if (proxy.listen !== expected.listen) problems.push(`listen is ${String(proxy.listen)}, expected ${expected.listen}`);
  if (proxy.upstream !== expected.upstream) problems.push(`upstream is ${String(proxy.upstream)}, expected ${expected.upstream}`);
  if (proxy.enabled !== true) problems.push("the proxy is disabled");
  const toxics = Array.isArray(proxy.toxics) ? (proxy.toxics as unknown[]) : [];
  const want = {
    name: expected.toxic,
    type: "latency",
    stream: "downstream",
    toxicity: 1,
    attributes: { latency: expected.latencyMs, jitter: 0 },
  };
  const actual = toxics.length === 1 ? (toxics[0] as Record<string, unknown>) : undefined;
  const sorted = (value: unknown) =>
    JSON.stringify(typeof value === "object" && value !== null ? Object.entries(value).sort(([a], [b]) => a.localeCompare(b)) : value);
  const same =
    actual?.name === want.name &&
    actual.type === want.type &&
    actual.stream === want.stream &&
    actual.toxicity === want.toxicity &&
    sorted(actual.attributes) === sorted(want.attributes);
  if (!same) problems.push(`toxics are ${JSON.stringify(toxics)}, expected [${JSON.stringify(want)}]`);
  return problems;
}

interface Request {
  method: string;
  url: string;
  agent: string;
  client: string;
}

/** Toxiproxy's log, one JSON object per line; returns each complete line with its end offset. */
function logLines(log: Buffer, from: number): { line: string; end: number }[] {
  const lines: { line: string; end: number }[] = [];
  let start = from;
  for (let index = log.indexOf(10, start); index !== -1; index = log.indexOf(10, start)) {
    lines.push({ line: log.subarray(start, index).toString("utf8"), end: index + 1 });
    start = index + 1;
  }
  return lines;
}

/** An API request record: Toxiproxy logs every request with its method, URL and user agent. */
function asRequest(record: Record<string, unknown>): Request | undefined {
  if (typeof record.handler !== "string" || typeof record.url !== "string" || typeof record.method !== "string") return undefined;
  return {
    method: record.method,
    url: record.url,
    agent: typeof record.user_agent === "string" ? record.user_agent : "",
    client: typeof record.client === "string" ? record.client : "",
  };
}

/** The offset just after rbw-proxy's mark request, or undefined while it is not logged. */
export function findMark(log: Buffer, from: number): number | undefined {
  for (const { line, end } of logLines(log, from)) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const request = typeof record === "object" && record !== null ? asRequest(record as Record<string, unknown>) : undefined;
    if (request?.method === "GET" && request.url === "/version" && request.agent === MARK_AGENT) return end;
  }
  return undefined;
}

export interface Audit {
  /** 0 clean, 1 a request could have changed the proxy or the log cannot be trusted, 3 not logged yet. */
  status: 0 | 1 | 3;
  problems: string[];
}

/**
 * Audits the API requests logged after the mark. Toxiproxy changes state only on POST and DELETE,
 * so any other method than GET fails the audit, whoever sent it and whatever it changed, even if
 * the state was put back afterwards. The check's own GET /proxies must be logged too, so a log
 * that stopped recording cannot pass; so must a log under its cap, since rbw-launch drops what
 * comes after it.
 */
export function auditLog(log: Buffer, mark: number, capBytes: number): Audit {
  const problems: string[] = [];
  if (mark > log.length) problems.push(`the mark ${String(mark)} is past the log's end`);
  if (log.length >= capBytes) problems.push("the Toxiproxy log reached its cap, so later API requests are not recorded");
  let sawCheck = false;
  for (const { line } of logLines(log, Math.min(mark, log.length))) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      problems.push(`unreadable Toxiproxy log line: ${line.slice(0, 200)}`);
      continue;
    }
    if (typeof record !== "object" || record === null) {
      problems.push(`unreadable Toxiproxy log line: ${line.slice(0, 200)}`);
      continue;
    }
    const request = asRequest(record as Record<string, unknown>);
    if (request === undefined) continue;
    if (request.method !== "GET") {
      problems.push(`${request.method} ${request.url} from ${request.client} (${request.agent}) after the proxy was set`);
    } else if (request.url === "/proxies" && request.agent === CHECK_AGENT) {
      sawCheck = true;
    }
  }
  if (problems.length > 0) return { status: 1, problems };
  return sawCheck ? { status: 0, problems } : { status: 3, problems: ["the check's own GET /proxies is not logged yet"] };
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function offset(value: string | undefined): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`not a byte offset: ${String(value)}`);
  return Number(value);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "latency": {
      const [config, override] = args;
      if (config === undefined || override === undefined) throw new Error("usage: latency <race.environment> <override>");
      process.stdout.write(`${String(effectiveLatency(readFileSync(config, "utf8"), readOptional(override)))}\n`);
      return 0;
    }
    case "valid-latency":
      parseLatencyValue(args[0] ?? "");
      return 0;
    case "check": {
      const [name, listen, upstream, toxic, latency] = args;
      if (name === undefined || listen === undefined || upstream === undefined || toxic === undefined) {
        throw new Error("usage: check <proxy> <listen> <upstream> <toxic> <latency ms>");
      }
      let text = "";
      for await (const chunk of process.stdin) text += String(chunk);
      const problems = checkProxies(JSON.parse(text), { name, listen, upstream, toxic, latencyMs: parseLatencyValue(latency ?? "") });
      for (const problem of problems) process.stderr.write(`rbw-proxy: ${problem}\n`);
      return problems.length === 0 ? 0 : 1;
    }
    case "mark": {
      const [log, from] = args;
      if (log === undefined) throw new Error("usage: mark <log> <from byte>");
      const end = findMark(readFileSync(log), offset(from));
      if (end === undefined) return 3;
      process.stdout.write(`${String(end)}\n`);
      return 0;
    }
    case "audit": {
      const [log, mark, cap] = args;
      if (log === undefined) throw new Error("usage: audit <log> <mark byte> <cap bytes>");
      const result = auditLog(readFileSync(log), offset(mark), offset(cap));
      if (result.status === 1) for (const problem of result.problems) process.stderr.write(`rbw-proxy: ${problem}\n`);
      return result.status;
    }
    default:
      throw new Error("usage: rbw-proxy-check latency|valid-latency|check|mark|audit ...");
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`rbw-proxy: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
