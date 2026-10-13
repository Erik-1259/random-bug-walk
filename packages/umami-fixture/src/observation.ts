import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FailureCode, Observed } from "./fixture.ts";

/**
 * The written outcome of one executed check. Field names follow the shared check-observation
 * record; when the shared schema package gains that record (item W1-1), this type switches to it.
 */
export interface Observation {
  check_id: string;
  repeat_index: number;
  observed: Observed;
  failure_code: FailureCode | null;
  duration_ms: number;
  response_artifact_key: string | null;
  response_artifact_sha256: string | null;
}

export const OBSERVATION_FIELDS = [
  "check_id",
  "repeat_index",
  "observed",
  "failure_code",
  "duration_ms",
  "response_artifact_key",
  "response_artifact_sha256",
] as const satisfies readonly (keyof Observation)[];

export interface ObservationInput {
  check_id: string;
  repeat_index: number;
  observed: Observed;
  failure_code: FailureCode | null;
  duration_ms: number;
  /** The exact response body bytes, or null when no response was received. */
  response_body: Uint8Array | null;
}

/**
 * Writes responses/<check_id>.json (the exact body bytes, when there is a response) and
 * observations/<check_id>.json. Refuses to overwrite either file, so a check is recorded once
 * per round.
 */
export function writeObservation(outputDir: string, input: ObservationInput): Observation {
  if ((input.observed === "pass") !== (input.failure_code === null)) {
    throw new Error(`${input.check_id}: a pass has no failure code and every other outcome has one`);
  }
  let key: string | null = null;
  let sha256: string | null = null;
  if (input.response_body !== null) {
    key = `responses/${input.check_id}.json`;
    sha256 = createHash("sha256").update(input.response_body).digest("hex");
    mkdirSync(join(outputDir, "responses"), { recursive: true });
    writeFileSync(join(outputDir, key), input.response_body, { flag: "wx" });
  }
  const observation: Observation = {
    check_id: input.check_id,
    repeat_index: input.repeat_index,
    observed: input.observed,
    failure_code: input.failure_code,
    duration_ms: Math.round(input.duration_ms),
    response_artifact_key: key,
    response_artifact_sha256: sha256,
  };
  mkdirSync(join(outputDir, "observations"), { recursive: true });
  writeFileSync(join(outputDir, "observations", `${input.check_id}.json`), `${JSON.stringify(observation, null, 2)}\n`, { flag: "wx" });
  return observation;
}
