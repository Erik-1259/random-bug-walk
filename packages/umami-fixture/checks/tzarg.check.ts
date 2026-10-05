import { expect, test as base, type APIRequestContext } from "@playwright/test";
import {
  classify,
  errorSummary,
  execute,
  loadFixture,
  login,
  queryRequests,
  readFixtureEnv,
  writeObservation,
  type Classification,
  type LoginResult,
} from "../src/index.ts";
import { decodeSetupResult, SETUP_RESULT_VARIABLE } from "./setup-result.ts";

// The four tzarg checks of fixture umami-tz-arg-001, one independent test each, in the data
// file's order (the UTC control first). The default, non-serial mode means a failure in one zone
// never stops another zone from executing.

const fixture = loadFixture();
const env = readFixtureEnv();

const test = base.extend<object, { api: APIRequestContext; session: LoginResult }>({
  api: [
    async ({ playwright }, use) => {
      const context = await playwright.request.newContext({ baseURL: env.baseUrl, timeout: 20_000 });
      await use(context);
      await context.dispose();
    },
    { scope: "worker" },
  ],
  session: [
    async ({ api }, use) => {
      const setup = decodeSetupResult(process.env[SETUP_RESULT_VARIABLE]);
      if (setup.status === "ok") {
        await use(await login(api, env.credentials));
      } else {
        await use({ ok: false, failure_code: setup.status, reason: setup.reason });
      }
    },
    { scope: "worker" },
  ],
});

for (const check of fixture.checks) {
  test(check.check_id, async ({ api, session }) => {
    const started = performance.now();
    let classification: Classification;
    let responseBody: Uint8Array | null = null;
    if (!session.ok) {
      classification = { observed: "setup_fail", failure_code: session.failure_code, detail: session.reason };
    } else {
      const query = queryRequests(fixture, session.token).find((candidate) => candidate.check.check_id === check.check_id);
      if (query === undefined) {
        throw new Error(`no query for ${check.check_id}`);
      }
      try {
        const response = await execute(api, query.request);
        responseBody = response.body;
        classification = classify(response, check, fixture.bucket_labels);
      } catch (error) {
        classification = { observed: "setup_fail", failure_code: "unrelated_failure", detail: `request failed (${errorSummary(error, [session.token])})` };
      }
    }
    writeObservation(env.outputDir, {
      check_id: check.check_id,
      repeat_index: env.repeatIndex,
      observed: classification.observed,
      failure_code: classification.failure_code,
      duration_ms: performance.now() - started,
      response_body: responseBody,
    });
    expect({ observed: classification.observed, failure_code: classification.failure_code }, `${check.check_id} (${check.timezone}): ${classification.detail}`).toEqual({
      observed: "pass",
      failure_code: null,
    });
  });
}
