// Recorded responses and the replay fetch. A recording holds the request body (never headers),
// the response status and body, the reported usage, the model ID, the time and its provenance.
// The replay fetch answers only requests to the configured URL whose canonical body matches a
// recording; anything else throws and is never forwarded to the network.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CHAT_COMPLETIONS_URL, MODEL_ID } from "./config.ts";
import { RequestNotSentError, requestBody, requestUrl } from "./http.ts";
import type { FetchFunction } from "./http.ts";
import { canonicalJson, sha256Hex } from "./identity.ts";

const UsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().nullable(),
    completion_tokens: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type ReportedUsage = z.infer<typeof UsageSchema>;

export const RecordingSchema = z
  .object({
    format_version: z.literal(1),
    provenance: z.enum(["synthetic", "live"]),
    model_id: z.string().min(1),
    recorded_at: z.iso.datetime(),
    request: z.object({ body: z.record(z.string(), z.unknown()) }).strict(),
    request_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    response: z.object({ status: z.number().int().min(100).max(599), body: z.string() }).strict(),
    usage: UsageSchema,
  })
  .strict();
export type Recording = z.infer<typeof RecordingSchema>;

/** The match key of a request: SHA-256 of its body as canonical JSON. */
export function requestKey(body: string): string {
  return sha256Hex(canonicalJson(JSON.parse(body)));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Prompt and completion tokens as the provider reported them; null where the response has none. */
export function reportedUsage(status: number, responseBody: string): ReportedUsage {
  const none = { prompt_tokens: null, completion_tokens: null };
  if (status < 200 || status > 299) {
    return none;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return none;
  }
  if (typeof parsed !== "object" || parsed === null || !("usage" in parsed)) {
    return none;
  }
  const usage = parsed.usage;
  if (typeof usage !== "object" || usage === null) {
    return none;
  }
  const prompt = "prompt_tokens" in usage ? usage.prompt_tokens : undefined;
  const completion = "completion_tokens" in usage ? usage.completion_tokens : undefined;
  return {
    prompt_tokens: isCount(prompt) ? prompt : null,
    completion_tokens: isCount(completion) ? completion : null,
  };
}

export interface RecordingInput {
  requestBody: string;
  status: number;
  responseBody: string;
  provenance: "synthetic" | "live";
  recordedAt: string;
}

export function makeRecording(input: RecordingInput): Recording {
  return RecordingSchema.parse({
    format_version: 1,
    provenance: input.provenance,
    model_id: MODEL_ID,
    recorded_at: input.recordedAt,
    request: { body: JSON.parse(input.requestBody) as unknown },
    request_sha256: requestKey(input.requestBody),
    response: { status: input.status, body: input.responseBody },
    usage: reportedUsage(input.status, input.responseBody),
  });
}

export function serializeRecording(recording: Recording): string {
  return `${JSON.stringify(recording, null, 2)}\n`;
}

/** Loads every `.json` recording in `dir`. A file that does not match the format names itself in the error. */
export async function loadRecordings(dir: string): Promise<Recording[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  const recordings: Recording[] = [];
  for (const file of files) {
    const parsed = RecordingSchema.safeParse(JSON.parse(await readFile(join(dir, file), "utf8")));
    if (!parsed.success) {
      throw new Error(`${file} is not a valid recording`);
    }
    if (parsed.data.request_sha256 !== sha256Hex(canonicalJson(parsed.data.request.body))) {
      throw new Error(`${file} has a request_sha256 that does not match its request body`);
    }
    recordings.push(parsed.data);
  }
  return recordings;
}

/** A fetch that answers from recordings only. */
export function createReplayFetch(recordings: readonly Recording[]): FetchFunction {
  const byKey = new Map(recordings.map((recording) => [recording.request_sha256, recording]));
  const answer = (input: string | URL | Request, init: RequestInit | undefined): Response => {
    if (requestUrl(input) !== CHAT_COMPLETIONS_URL) {
      throw new RequestNotSentError("unexpected_url", "replay answers the configured base URL only");
    }
    const recording = byKey.get(requestKey(requestBody(init)));
    if (recording === undefined) {
      throw new RequestNotSentError("no_recording", "no recording matches this request");
    }
    return new Response(recording.response.body, {
      status: recording.response.status,
      headers: { "content-type": "application/json" },
    });
  };
  return (input, init) =>
    new Promise((resolve) => {
      resolve(answer(input, init));
    });
}
