// Local synthetic configuration is injected through the existing loaders. No process variables,
// network service or real provider are used; the route and factory session check remain real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/factory/otf/classify/route.ts";
import { RateLimiter } from "../../src/assist/limits.ts";
import * as assistServer from "../../src/assist/server.ts";
import * as config from "../../src/config.ts";
import * as factoryServer from "../../src/factory-server/server.ts";
import { factorySessionCookie } from "../../src/factory-server/session.ts";
import { testOtfCustomerDependencies } from "../../src/otf/compose.ts";
import { OTF_CLASSIFY_PATH, OTF_OPEN_CRITERION_ID, type OtfClassifyRequest } from "../../src/otf/contract.ts";
import { createCustomerHandlers } from "../../src/otf/handlers.ts";
import * as open from "../../src/otf/open.ts";
import { parseOtf } from "../../src/otf/schemas.ts";

const PASSCODE = "synthetic-classify-mode-passcode";
const LOCAL = {
  VERCEL_ENV: "development", RBW_FACTORY_TEST_MODE: "1", RBW_JUDGE_PASSCODE: PASSCODE,
  RBW_OTF_BUILDER_SECRET: "synthetic-otf-test-mode-builder-secret-only", RBW_OTF_OPEN_BEHAVIORS: "1",
};
const INPUT: OtfClassifyRequest = {
  sentence: "A saved note comes back altered.", host_id: "task-report",
  spec: { title: "Synthetic note round trip", where: "The task read path", change: "A note changes after saving.",
    why_tests_miss: "The suite uses plain notes.", checks_to_add: ["Read the saved note."], fix: "Preserve the note." },
};
function request(signedIn = true): Request {
  return new Request(`https://synthetic.invalid${OTF_CLASSIFY_PATH}`, { method: "POST",
    headers: { "content-type": "application/json", ...(signedIn ? { cookie: factorySessionCookie(PASSCODE) } : {}) },
    body: JSON.stringify(INPUT) });
}
function setup(env: Readonly<Record<string, string | undefined>>) {
  const factory = config.loadFactoryConfig(env);
  const otf = config.loadOtfConfig(env);
  const enabled = open.openBehaviorsEnabled(env);
  vi.spyOn(config, "loadFactoryConfig").mockReturnValue(factory);
  vi.spyOn(config, "loadOtfConfig").mockReturnValue(otf);
  vi.spyOn(open, "openBehaviorsEnabled").mockReturnValue(enabled);
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json({ choices: [{
    finish_reason: "stop", message: { content: JSON.stringify({ decision: "open", proven_criterion_id: "none", family: "data_handling",
      observable_failure: "POST /api/tasks saves a note, but GET /api/tasks/{id} returns that note with its commas removed.",
      failure_code: "synthetic_note_mismatch", reason: "The saved note can be checked through task writes and reads." }) },
  }] })));
  vi.spyOn(assistServer, "assistDeps").mockReturnValue({
    config: { tokenFactoryKey: "synthetic-token-factory-key", tavilyKey: null, model: config.DEFAULT_ASSIST_MODEL },
    fetch, limiter: new RateLimiter(), now: () => new Date("2026-10-29T12:00:00Z"),
  });
  return { factory, otf, fetch };
}
// The live gate needs the session port only. Keep live storage and build-time rate configuration
// outside this test while exercising the route's actual configuration checks.
async function liveSessionOnly(factory: config.FactoryConfig): Promise<void> {
  const sessionServer = await factoryServer.factoryServer({ ...factory, mode: "test" });
  vi.spyOn(factoryServer, "factoryServer").mockResolvedValue(sessionServer);
}
async function errorCode(response: Response): Promise<string> {
  const parsed = parseOtf("OtfErrorBody", await response.json());
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value.error.code;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("the classifier route's factory mode gate", () => {
  it("classifies when local test mode offers open builds without a database or configured lanes", async () => {
    const s = setup(LOCAL);
    expect(s.otf.databaseUrl).toBeNull(); expect(s.otf.hosts["task-report"].enabled).toBe(false);
    const customer = createCustomerHandlers(testOtfCustomerDependencies(LOCAL));
    const available = parseOtf("OtfAvailability", await (await customer.availability(request())).json());
    if (!available.ok) throw new Error(available.errors.join("; "));
    expect(available.value.enabled).toBe(true);
    expect(available.value.behaviors.some((entry) => entry.criterion_id === OTF_OPEN_CRITERION_ID)).toBe(true);
    const response = await POST(request());
    expect(response.status).toBe(200);
    const classified = parseOtf("OtfClassification", await response.json());
    if (!classified.ok) throw new Error(classified.errors.join("; "));
    expect(classified.value.buildable).toEqual([{ host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID }]);
    expect(s.fetch).toHaveBeenCalledOnce();
  });
  it("stays unavailable with test mode off and no live OTF configuration", async () => {
    const s = setup({ ...LOCAL, RBW_FACTORY_TEST_MODE: "0" });
    await liveSessionOnly(s.factory);
    const response = await POST(request());
    expect(response.status).toBe(503); expect(await errorCode(response)).toBe("unavailable");
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it("keeps the open flag required in local test mode", async () => {
    const env = { ...LOCAL, RBW_OTF_OPEN_BEHAVIORS: "0" }; const s = setup(env);
    const customer = createCustomerHandlers(testOtfCustomerDependencies(env));
    const available = parseOtf("OtfAvailability", await (await customer.availability(request())).json());
    if (!available.ok) throw new Error(available.errors.join("; "));
    expect(available.value.behaviors.some((entry) => entry.criterion_id === OTF_OPEN_CRITERION_ID)).toBe(false);
    expect(await errorCode(await POST(request()))).toBe("unavailable"); expect(s.fetch).not.toHaveBeenCalled();
  });
  it("still requires a session in local test mode", async () => {
    const s = setup(LOCAL);
    expect(await errorCode(await POST(request(false)))).toBe("signed_out"); expect(s.fetch).not.toHaveBeenCalled();
  });
  it.each(["preview", "production"])("still refuses test mode on a %s deployment", async (environment) => {
    const env = { ...LOCAL, VERCEL_ENV: environment }; const s = setup(env);
    expect(s.factory.mode).toBe("refused");
    expect(() => testOtfCustomerDependencies(env)).toThrow();
    expect(await errorCode(await POST(request()))).toBe("signed_out"); expect(s.fetch).not.toHaveBeenCalled();
  });
  it("keeps a configured live classifier available without invoking database or worker ports", async () => {
    const s = setup({ ...LOCAL, RBW_FACTORY_TEST_MODE: "0", DATABASE_URL: "postgres://synthetic.invalid/otf",
      RBW_OTF_LANES: JSON.stringify([{ model: "synthetic/model", model_label: "Synthetic model", price_in_usd_per_m: "0.10", price_out_usd_per_m: "0.20" }]) });
    expect(s.factory.mode).toBe("live"); expect(config.otfConfigured(s.otf)).toBe(true);
    await liveSessionOnly(s.factory);
    expect((await POST(request())).status).toBe(200); expect(s.fetch).toHaveBeenCalledOnce();
  });
});
