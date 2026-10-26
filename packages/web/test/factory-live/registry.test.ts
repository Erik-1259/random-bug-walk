// Live mode when the host registry cannot be loaded, as on a deployment whose files do not hold the
// modules live mode loads by name: the session and the example still answer, and no host is offered.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryConfig } from "../../src/config.ts";
import { getCapabilities, getExample, postSession } from "../../src/factory-server/handlers.ts";
import { liveServerFor } from "../../src/factory-server/live/runtime.ts";
import { contractBody, PASSCODE, request } from "../factory-server/support.ts";

vi.mock("@rbw/case-validate/registry", () => {
  throw new Error("synthetic: the host registry is not installed");
});

const RATE_SHEET = readFileSync(new URL("../../../envelope/rate-sheets/v1.json", import.meta.url), "utf8");

const CONFIG: FactoryConfig = {
  mode: "live",
  passcode: PASSCODE,
  testFixturesDir: "/synthetic/fixtures",
  databaseUrl: null,
  sandbox: null,
  workerImage: null,
  packagesDir: null,
  workerBackend: "sandbox",
  repoRoot: "/synthetic/repo",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a host registry that cannot be loaded", () => {
  it("still serves the session and the example, offers no host, and logs the failed load", async () => {
    vi.stubEnv("RBW_FACTORY_RATE_SHEET", RATE_SHEET);
    const logs: string[] = [];
    const server = await liveServerFor(CONFIG, (line) => logs.push(line));
    expect((await postSession(request("/api/factory/session", { body: { passcode: PASSCODE }, session: false }), server)).status).toBe(204);
    const capabilities = await contractBody("Capabilities", await getCapabilities(request("/api/factory/capabilities", { session: false }), server));
    expect(capabilities.service.code).toBe("not_configured");
    expect(capabilities.combinations.filter((item) => item.status === "supported")).toEqual([]);
    expect((await getExample(request("/api/factory/example", { session: false }), server)).status).toBe(404);
    expect(logs.join("\n")).toContain("the host registry could not be loaded");
  });
});
