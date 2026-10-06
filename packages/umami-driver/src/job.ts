// The driver's input: one job's request and its expected-trial manifest, read with the shared
// schema, and the one trial this copy runs. The two files are written into the record set
// unchanged, so they must already be canonical bytes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RecordError, encodeCanonical, parseRecord } from "@rbw/schema";
import type { ExpectedTrial, ExpectedTrials, JobRequest } from "@rbw/schema";

/** The input cannot be run against this verifier; nothing is written. */
export class RefusedInput extends Error {}

export const REQUEST_KEY = "request.json";

export interface JobInput {
  request: JobRequest;
  requestBytes: Uint8Array;
  expectedTrials: ExpectedTrials;
  expectedTrialsBytes: Uint8Array;
  trial: ExpectedTrial;
}

function sameBytes(value: unknown, bytes: Uint8Array): boolean {
  return Buffer.from(encodeCanonical(value)).equals(Buffer.from(bytes));
}

function parse<K extends "JobRequest" | "ExpectedTrials">(type: K, bytes: Uint8Array, name: string, request?: JobRequest) {
  try {
    const value = parseRecord(type, bytes, request === undefined ? {} : { request });
    if (!sameBytes(value, bytes)) throw new RefusedInput(`${name} is not canonical bytes`);
    return value;
  } catch (error) {
    if (error instanceof RecordError) throw new RefusedInput(`${name} is not a valid ${type} (${error.errors.join(", ")})`);
    throw error;
  }
}

/** Reads the request, then the expected trials at its key (checked against its hash), then selects the trial. */
export function readJob(requestBytes: Uint8Array, readKey: (key: string) => Uint8Array | null, trialId: string): JobInput {
  const request = parse("JobRequest", requestBytes, REQUEST_KEY);
  const expectedTrialsBytes = readKey(request.expected_trials_key);
  if (expectedTrialsBytes === null) throw new RefusedInput(`the expected-trials file ${request.expected_trials_key} is missing`);
  const expectedTrials = parse("ExpectedTrials", expectedTrialsBytes, request.expected_trials_key, request);
  const trial = expectedTrials.trials.find((item) => item.trial_id === trialId);
  if (trial === undefined) throw new RefusedInput(`the expected trials list no trial ${trialId}`);
  return { request, requestBytes, expectedTrials, expectedTrialsBytes, trial };
}

/** Reads a job directory laid out as a record set: request.json, and the expected trials at the request's key. */
export function loadJob(dir: string, trialId: string): JobInput {
  const readKey = (key: string): Uint8Array | null => {
    try {
      return readFileSync(join(dir, ...key.split("/")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const requestBytes = readKey(REQUEST_KEY);
  if (requestBytes === null) throw new RefusedInput(`the job directory has no ${REQUEST_KEY}`);
  return readJob(requestBytes, readKey, trialId);
}
