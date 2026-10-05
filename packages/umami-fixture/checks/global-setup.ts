import { request } from "@playwright/test";
import { loadFixture, readFixtureEnv, runSetup } from "../src/index.ts";
import { encodeSetupResult, SETUP_RESULT_VARIABLE } from "./setup-result.ts";

/**
 * The round's setup, run exactly once before the four checks: login, website creation and the
 * twelve sends. A setup failure does not stop the round; each check then records setup_fail.
 */
export default async function globalSetup(): Promise<void> {
  const env = readFixtureEnv();
  const context = await request.newContext({ baseURL: env.baseUrl, timeout: 20_000 });
  try {
    const result = await runSetup(context, loadFixture(), env.credentials);
    process.env[SETUP_RESULT_VARIABLE] = encodeSetupResult(result);
    if (!result.ok) {
      process.stderr.write(`umami-fixture: setup failed (${result.failure_code}): ${result.reason}\n`);
    }
  } finally {
    await context.dispose();
  }
}
