// Configuration is injected, never installed into process.env. Provider responses are synthetic;
// local and refused-mode cases retain the real factory session port.
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../../src/assist/limits.ts";
import * as assistServer from "../../src/assist/server.ts";
import { DEFAULT_ASSIST_MODEL, loadFactoryConfig } from "../../src/config.ts";
import * as factory from "../../src/factory-server/server.ts";
import { factorySessionCookie } from "../../src/factory-server/session.ts";
import { handleOtfClassifyShapes } from "../../src/otf/classify-shapes.ts";
import { parseOtf } from "../../src/otf/schemas.ts";
import { OTF_CLASSIFY_SHAPES_PATH, OTF_SHAPE_BADGES_FLAG } from "../../src/otf/shape-badges-contract.ts";
import { parseShapeBadges } from "../../src/otf/shape-badges-schemas.ts";

const PASSCODE = "synthetic-shape-mode-passcode";
const LOCAL = { VERCEL_ENV: "development", RBW_FACTORY_TEST_MODE: "1", RBW_JUDGE_PASSCODE: PASSCODE,
  RBW_OTF_OPEN_BEHAVIORS: "1", [OTF_SHAPE_BADGES_FLAG]: "1",
  RBW_FACTORY_TEST_FIXTURES: fileURLToPath(new URL("../../../../docs/product/fixtures/bug-request-v1/", import.meta.url)) };
const INPUT = { query: "Synthetic note round trip", host_id: "task-report" as const,
  shapes: [{ title: "Synthetic note change", summary: "A saved note comes back altered." }] };
function request(): Request {
  return new Request(`https://synthetic.invalid${OTF_CLASSIFY_SHAPES_PATH}`, { method: "POST",
    headers: { "content-type": "application/json", cookie: factorySessionCookie(PASSCODE) }, body: JSON.stringify(INPUT) });
}
function provider() {
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ badges: [{ index: 0, outcome: "open", proven_criterion_id: "none", family: "data_handling",
      translated_failure: "A saved task note comes back with its commas removed.", refusal_kind: "none", reason: "" }] }),
  } }] })));
  vi.spyOn(assistServer, "assistDeps").mockReturnValue({ fetch,
    config: { tokenFactoryKey: "synthetic-token-factory-key", tavilyKey: null, model: DEFAULT_ASSIST_MODEL },
    now: () => new Date("2026-10-30T00:00:00Z"), limiter: new RateLimiter() });
  return fetch;
}
async function code(response: Response): Promise<string> {
  const parsed = parseOtf("OtfErrorBody", await response.json());
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value.error.code;
}
afterEach(() => { vi.restoreAllMocks(); });

describe("shape badge runtime session and flag wiring", () => {
  it("uses the local factory session without live database or lane configuration", async () => {
    const fetch = provider();
    const response = await handleOtfClassifyShapes(request(), LOCAL);
    expect(response.status).toBe(200);
    expect(parseShapeBadges(await response.json(), INPUT).ok).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["RBW_OTF_OPEN_BEHAVIORS", OTF_SHAPE_BADGES_FLAG])("keeps %s required at the runtime boundary", async flag => {
    const fetch = provider();
    expect(await code(await handleOtfClassifyShapes(request(), { ...LOCAL, [flag]: "0" }))).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["preview", "production"])("cannot sign into test mode on %s", async environment => {
    const fetch = provider();
    expect(await code(await handleOtfClassifyShapes(request(), { ...LOCAL, VERCEL_ENV: environment }))).toBe("signed_out");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the live session port without imposing builder configuration on advisory badges", async () => {
    const fetch = provider();
    const session = await factory.factoryServer(loadFactoryConfig(LOCAL));
    const server = vi.spyOn(factory, "factoryServer").mockResolvedValue(session);
    expect((await handleOtfClassifyShapes(request(), { ...LOCAL, RBW_FACTORY_TEST_MODE: "0" })).status).toBe(200);
    expect(server.mock.calls[0]?.[0]?.mode).toBe("live");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("answers unavailable when the factory server cannot supply the session port", async () => {
    const fetch = provider();
    vi.spyOn(factory, "factoryServer").mockRejectedValue(new Error("Synthetic server failure"));
    expect(await code(await handleOtfClassifyShapes(request(), LOCAL))).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
});
