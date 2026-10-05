import type { LoginResult, SetupFailureCode } from "../src/index.ts";

/**
 * Global setup runs once per round in the runner process and hands its outcome to the workers
 * through this variable, which workers inherit. It carries a status and a reason, never a token:
 * Playwright replaces a worker after a failed test, so each worker logs in again for itself.
 */
export const SETUP_RESULT_VARIABLE = "RBW_FIXTURE_SETUP_RESULT";

export type SetupResult = { status: "ok" } | { status: SetupFailureCode; reason: string };

export function encodeSetupResult(result: LoginResult): string {
  const value: SetupResult = result.ok ? { status: "ok" } : { status: result.failure_code, reason: result.reason };
  return JSON.stringify(value);
}

export function decodeSetupResult(text: string | undefined): SetupResult {
  const value = JSON.parse(text ?? "null") as unknown;
  if (typeof value === "object" && value !== null && "status" in value) {
    if (value.status === "ok") {
      return { status: "ok" };
    }
    if ((value.status === "auth_failed" || value.status === "seed_failed") && "reason" in value && typeof value.reason === "string") {
      return { status: value.status, reason: value.reason };
    }
  }
  throw new Error(`${SETUP_RESULT_VARIABLE} is not set by global setup`);
}
