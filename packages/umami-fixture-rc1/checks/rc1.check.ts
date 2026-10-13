import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  classify,
  encodeEvidence,
  loadFixture,
  readFixtureEnv,
  runDoubleSpend,
  runSerialReuse,
  writeObservation,
  type Classification,
  type Evidence,
  type FixtureCheck,
  type RoundResult,
} from "../src/index.ts";

// The two checks of fixture rc-1-backup-code-001, in the data file's order: the serial reuse
// control, then the concurrent double spend. The two-factor state is baked into the template
// database, so a round has no setup step; each check signs in for itself and spends its own code.

const fixture = loadFixture();
const env = readFixtureEnv();

async function withContexts<T>(count: 1 | 2, newContext: () => Promise<APIRequestContext>, run: (contexts: APIRequestContext[]) => Promise<T>): Promise<T> {
  const contexts: APIRequestContext[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      contexts.push(await newContext());
    }
    return await run(contexts);
  } finally {
    await Promise.all(contexts.map((context) => context.dispose()));
  }
}

function run(check: FixtureCheck, contexts: APIRequestContext[]): Promise<RoundResult<Evidence>> {
  const now = (): number => performance.now();
  const [first, second] = contexts;
  if (first === undefined) {
    throw new Error("no request context");
  }
  if (check.kind === "serial_reuse") {
    return runSerialReuse(first, fixture, check, env.credentials, now);
  }
  if (second === undefined) {
    throw new Error("the race needs two request contexts");
  }
  return runDoubleSpend([first, second], fixture, check, env.credentials, now);
}

for (const check of fixture.checks) {
  test(check.check_id, async ({ playwright }) => {
    const started = performance.now();
    const newContext = (): Promise<APIRequestContext> => playwright.request.newContext({ baseURL: env.baseUrl, timeout: 30_000 });
    const result = await withContexts(check.kind === "serial_reuse" ? 1 : 2, newContext, (contexts) => run(check, contexts));
    const classification: Classification = result.ok ? classify(result.evidence) : { observed: "setup_fail", failure_code: result.failure_code, detail: result.reason };
    writeObservation(env.outputDir, {
      check_id: check.check_id,
      repeat_index: env.repeatIndex,
      observed: classification.observed,
      failure_code: classification.failure_code,
      duration_ms: performance.now() - started,
      response_body: result.evidence === undefined ? null : encodeEvidence(result.evidence),
    });
    expect({ observed: classification.observed, failure_code: classification.failure_code }, `${check.check_id}: ${classification.detail}`).toEqual({
      observed: "pass",
      failure_code: null,
    });
  });
}
