// Frozen GitHub exchanges. A live run records each request once, with its times, its rate-limited
// attempts and the projected response body, under `responses/` in the run directory. A replay reads
// the same files and answers from them alone: a request that was not frozen is an error, never a
// network call. Both transports hand the funnel the same projected bodies.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "@rbw/shapes";
import { z } from "zod";
import { projectBody } from "./github-api.ts";
import type { GitHubClient } from "./github.ts";

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface Transport {
  get(url: string): Promise<ApiResponse>;
}

export class NotFrozen extends Error {
  override name = "NotFrozen";
}

export class RunDirectoryError extends Error {
  override name = "RunDirectoryError";
}

const RATE_HEADERS = ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource"] as const;

const exchangeSchema = z.object({
  schema_version: z.literal(1),
  request: z.object({ method: z.literal("GET"), url: z.string() }),
  requested_at: z.string(),
  completed_at: z.string(),
  attempts: z.array(z.object({ status: z.number(), waited_ms: z.number() })),
  response: z.object({ status: z.number(), rate_limit: z.record(z.string(), z.string()), body: z.unknown() }),
});

export type Exchange = z.infer<typeof exchangeSchema>;

const querySchema = z.object({ kind: z.enum(["commits", "pulls"]), api: z.string(), q: z.string() });

/** Version 2 added the license endpoint, de-duplication and the round-robin harvest; a version 1 run cannot be replayed. */
const MANIFEST_VERSION = 2;

const manifestSchema = z.object({
  schema_version: z.literal(MANIFEST_VERSION),
  tool: z.literal("@rbw/harvest"),
  api_base_url: z.string(),
  authenticated: z.boolean(),
  max: z.number().int().positive(),
  queries: z.array(querySchema),
  started_at: z.string(),
  completed_at: z.string().nullable(),
});

export type Manifest = z.infer<typeof manifestSchema>;

export const RESPONSES = "responses";
export const MANIFEST = "manifest.json";
export const FUNNEL = "funnel.json";

export function exchangeFile(url: string): string {
  return `${createHash("sha256").update(`GET ${url}`).digest("hex").slice(0, 24)}.json`;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${canonicalJson(value)}\n`);
}

export function writeManifest(dir: string, manifest: Manifest): void {
  writeJson(join(dir, MANIFEST), manifest);
}

export function writeFunnel(dir: string, funnel: unknown): void {
  writeJson(join(dir, FUNNEL), funnel);
}

export function readManifest(dir: string): Manifest {
  let text: string;
  try {
    text = readFileSync(join(dir, MANIFEST), "utf8");
  } catch (error) {
    throw new RunDirectoryError(`cannot read ${MANIFEST} in ${dir}`, { cause: error });
  }
  const json: unknown = JSON.parse(text);
  const version = typeof json === "object" && json !== null && "schema_version" in json ? json.schema_version : undefined;
  if (typeof version === "number" && version < MANIFEST_VERSION) {
    throw new RunDirectoryError(`${MANIFEST} in ${dir} was written by an earlier version of the harvest, whose funnel this version cannot rebuild; run a new harvest`);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new RunDirectoryError(`${MANIFEST} in ${dir} is malformed`, { cause: parsed.error });
  }
  return parsed.data;
}

/** Records every live response under `<dir>/responses/` and returns the projected body. */
export function recordingTransport(client: GitHubClient, dir: string, clock: () => Date): Transport {
  const responses = join(dir, RESPONSES);
  mkdirSync(responses, { recursive: true });
  const seen = new Map<string, ApiResponse>();
  return {
    async get(url) {
      const known = seen.get(url);
      if (known !== undefined) {
        return known;
      }
      const requestedAt = clock().toISOString();
      const live = await client.get(url);
      const completedAt = clock().toISOString();
      const body = projectBody(url, live.status, live.body);
      const rateLimit: Record<string, string> = {};
      for (const name of RATE_HEADERS) {
        const value = live.headers[name];
        if (value !== undefined) {
          rateLimit[name] = value;
        }
      }
      const exchange: Exchange = {
        schema_version: 1,
        request: { method: "GET", url },
        requested_at: requestedAt,
        completed_at: completedAt,
        attempts: [...live.attempts],
        response: { status: live.status, rate_limit: rateLimit, body },
      };
      writeJson(join(responses, exchangeFile(url)), exchange);
      const response = { status: live.status, body };
      seen.set(url, response);
      return response;
    },
  };
}

/** Answers from the frozen exchanges in `<dir>/responses/` only. */
export function replayTransport(dir: string): Transport {
  const responses = join(dir, RESPONSES);
  const frozen = new Map<string, ApiResponse>();
  let files: string[];
  try {
    files = readdirSync(responses).filter((name) => name.endsWith(".json"));
  } catch (error) {
    throw new RunDirectoryError(`cannot read ${RESPONSES}/ in ${dir}`, { cause: error });
  }
  for (const file of files) {
    const parsed = exchangeSchema.safeParse(JSON.parse(readFileSync(join(responses, file), "utf8")));
    if (!parsed.success || exchangeFile(parsed.data.request.url) !== file) {
      throw new RunDirectoryError(`${RESPONSES}/${file} is not a frozen exchange`);
    }
    frozen.set(parsed.data.request.url, { status: parsed.data.response.status, body: parsed.data.response.body });
  }
  return {
    get(url) {
      const response = frozen.get(url);
      if (response === undefined) {
        return Promise.reject(new NotFrozen(`no frozen response for GET ${url}`));
      }
      return Promise.resolve(response);
    },
  };
}
