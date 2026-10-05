import { statSync } from "node:fs";
import type { Credentials } from "./requests.ts";

/** Synthetic credentials that the pinned migration creates in a disposable install. */
export const DEFAULT_ADMIN_CREDENTIALS: Credentials = { username: "admin", password: "umami" };

export interface FixtureEnv {
  baseUrl: string;
  repeatIndex: number;
  outputDir: string;
  credentials: Credentials;
}

function fail(message: string): never {
  throw new Error(`umami-fixture: ${message}`);
}

/**
 * The package's one config loader. Reads RBW_FIXTURE_BASE_URL, RBW_FIXTURE_REPEAT_INDEX,
 * RBW_FIXTURE_OUTPUT_DIR, RBW_FIXTURE_ADMIN_USERNAME and RBW_FIXTURE_ADMIN_PASSWORD. Errors name
 * the variable, never a credential value.
 */
export function readFixtureEnv(env: Record<string, string | undefined> = process.env): FixtureEnv {
  const baseUrl = env.RBW_FIXTURE_BASE_URL ?? "";
  let protocol = "";
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    fail("RBW_FIXTURE_BASE_URL must be an http or https URL");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    fail("RBW_FIXTURE_BASE_URL must be an http or https URL");
  }
  const repeat = env.RBW_FIXTURE_REPEAT_INDEX ?? "";
  if (!/^[1-9][0-9]*$/.test(repeat) || !Number.isSafeInteger(Number(repeat))) {
    fail("RBW_FIXTURE_REPEAT_INDEX must be a positive integer");
  }
  const outputDir = env.RBW_FIXTURE_OUTPUT_DIR ?? "";
  if (outputDir === "" || !statSync(outputDir, { throwIfNoEntry: false })?.isDirectory()) {
    fail("RBW_FIXTURE_OUTPUT_DIR must name an existing directory");
  }
  return {
    baseUrl,
    repeatIndex: Number(repeat),
    outputDir,
    credentials: {
      username: env.RBW_FIXTURE_ADMIN_USERNAME ?? DEFAULT_ADMIN_CREDENTIALS.username,
      password: env.RBW_FIXTURE_ADMIN_PASSWORD ?? DEFAULT_ADMIN_CREDENTIALS.password,
    },
  };
}
