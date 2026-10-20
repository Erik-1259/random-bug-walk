// The factory server's modes: test mode refused in production, the live wiring that is still held
// (each held port answers unavailable), the shared test-mode world, and the money isolation guard.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFactoryConfig, type FactoryConfig } from "../../src/config.ts";
import { getCapabilities, getExample, getRequestStatus, getSession, getTestEvidence, postSession, postTestReset } from "../../src/factory-server/handlers.ts";
import { FactoryNotWiredError, HELD_PORTS, liveServer } from "../../src/factory-server/integration.ts";
import type { FactoryServerPorts } from "../../src/factory-server/ports.ts";
import { factoryServer, handle } from "../../src/factory-server/server.ts";
import { contractBody, FIXTURES, PASSCODE, request, REQUEST_ID } from "./support.ts";

const SOURCE = fileURLToPath(new URL("../../src/factory-server/", import.meta.url));
const ROUTES = fileURLToPath(new URL("../../app/api/factory/", import.meta.url));

function config(mode: FactoryConfig["mode"]): FactoryConfig {
  return { mode, passcode: PASSCODE, testFixturesDir: FIXTURES };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("selects test mode with RBW_FACTORY_TEST_MODE=1 and refuses it when VERCEL_ENV is production", () => {
    expect(loadFactoryConfig({ RBW_FACTORY_TEST_MODE: "1" }, "/synthetic/app").mode).toBe("test");
    expect(loadFactoryConfig({ RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV: "preview" }, "/synthetic/app").mode).toBe("test");
    expect(loadFactoryConfig({ RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV: "production" }, "/synthetic/app").mode).toBe("refused");
    expect(loadFactoryConfig({ RBW_FACTORY_TEST_MODE: "0" }, "/synthetic/app").mode).toBe("live");
    expect(loadFactoryConfig({}, "/synthetic/repo/packages/web")).toEqual({ mode: "live", passcode: null, testFixturesDir: "/synthetic/repo/docs/product/fixtures/bug-request-v1" });
    expect(loadFactoryConfig({ RBW_JUDGE_PASSCODE: PASSCODE, RBW_FACTORY_TEST_FIXTURES: "fixtures" }, "/synthetic/app")).toMatchObject({ passcode: PASSCODE, testFixturesDir: "/synthetic/app/fixtures" });
  });

  it("answers unavailable for every port in a production deployment that asks for test mode, signs nobody in, and has no test endpoints", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await factoryServer(config("refused"));
    expect((await getCapabilities(request("/api/factory/capabilities", { session: false }), server)).status).toBe(503);
    expect((await getExample(request("/api/factory/example", { session: false }), server)).status).toBe(503);
    expect((await postSession(request("/api/factory/session", { body: { passcode: PASSCODE }, session: false }), server)).status).toBe(503);
    expect(await contractBody("SessionStatus", getSession(request("/api/factory/session"), server))).toEqual({ contract_version: "bug-request/1", signed_in: false });
    expect((await getRequestStatus(request(`/api/factory/requests/${REQUEST_ID}`), server, { request_id: REQUEST_ID })).status).toBe(401);
    expect((await postTestReset(request("/api/factory/test/reset", { body: { scenario: "zero-result" }, session: false }), server)).status).toBe(404);
  });

  it("logs the production refusal once per server process, not on every call", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    // A fresh copy of the module, so an earlier test's refusal does not count.
    vi.resetModules();
    const fresh = await import("../../src/factory-server/server.ts");
    await fresh.factoryServer(config("refused"));
    await fresh.factoryServer(config("refused"));
    expect(lines.filter((line) => line.includes("RBW_FACTORY_TEST_MODE is refused"))).toHaveLength(1);
  });

  it("answers unavailable through the route wrapper when the server cannot be built", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("RBW_FACTORY_TEST_MODE", "1");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("RBW_FACTORY_TEST_FIXTURES", "/synthetic/missing-fixtures");
    const saved = (globalThis as { __rbwFactoryTestWorld?: unknown }).__rbwFactoryTestWorld;
    delete (globalThis as { __rbwFactoryTestWorld?: unknown }).__rbwFactoryTestWorld;
    try {
      const response = await handle((server) => getCapabilities(request("/api/factory/capabilities", { session: false }), server));
      expect(response.status).toBe(503);
    } finally {
      vi.unstubAllEnvs();
      (globalThis as { __rbwFactoryTestWorld?: unknown }).__rbwFactoryTestWorld = saved;
    }
  });
});

describe("live wiring (held)", () => {
  it("throws FactoryNotWiredError from every held port, so each endpoint that needs one answers unavailable", async () => {
    const logs: string[] = [];
    const server = liveServer(config("live"), (line) => logs.push(line));
    const ports = server.ports as unknown as Record<string, unknown>;
    for (const port of HELD_PORTS) {
      const attempt = () => (port === "requestRoot" ? server.requestRoot(REQUEST_ID) : port === "profile" ? ports.profile : (ports[port] as () => unknown)());
      expect(attempt, port).toThrow(FactoryNotWiredError);
    }
    const capabilities = await getCapabilities(request("/api/factory/capabilities", { session: false }), server);
    expect(capabilities.status).toBe(503);
    expect(logs.join("\n")).toContain("FactoryNotWiredError");
    const signedIn = await getRequestStatus(request(`/api/factory/requests/${REQUEST_ID}`), server, { request_id: REQUEST_ID });
    expect(signedIn.status).toBe(503);
  });

  it("serves the session and answers the example 404 while none is published", async () => {
    const server = liveServer(config("live"), () => undefined);
    expect((await postSession(request("/api/factory/session", { body: { passcode: PASSCODE }, session: false }), server)).status).toBe(204);
    expect((await getExample(request("/api/factory/example", { session: false }), server)).status).toBe(404);
    expect((await getTestEvidence(request(`/api/factory/test/evidence?request_id=${REQUEST_ID}`, { session: false }), server)).status).toBe(404);
  });

  it("lists exactly the ports that are not wired", () => {
    const wired: (keyof FactoryServerPorts)[] = ["now", "passcode", "example"];
    const all = Object.keys(liveServer(config("live"), () => undefined).ports).sort();
    expect([...HELD_PORTS.filter((port) => port !== "requestRoot"), ...wired].sort()).toEqual(all);
  });
});

describe("test mode", () => {
  it("shares one world across server instances, as separate route bundles of one process do", async () => {
    const first = await factoryServer(config("test"));
    const second = await factoryServer(config("test"));
    expect(first.ports).toBe(second.ports);
    expect(first.test).not.toBeNull();
    const reset = await postTestReset(request("/api/factory/test/reset", { body: { scenario: "zero-result" }, session: false }), first);
    expect(await contractBody("TestResetResponse", reset)).toEqual({ contract_version: "bug-request/1", scenario: "zero-result" });
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/**
 * What a static scan can see that would point a factory module at a ledger target other than the
 * factory pool and slot: the controller's judge and development targets (the judge one also under its
 * judge-web name), the judge modules, those targets' key values as string literals, and any literal
 * slot or pool key but "factory" or an allocation key (the factory pool has no allocations), with a
 * quoted or unquoted key. The runtime proof needs the ledger's budget calls, which are not wired yet.
 */
const FORBIDDEN: readonly RegExp[] = [
  /judge-demo/,
  /\bJUDGE(?:_POOL)?\b/,
  /\bDEVELOPMENT\b/,
  /@rbw\/controller\/judge/,
  /src\/judge\//,
  /["'`](?:judge|development)["'`]/,
  /["']?\b(?:slot_key|pool_key)["']?\s*:\s*(?!"factory"|'factory'|`factory`)["'`]/,
  /["']?\ballocation_key["']?\s*:\s*["'`]/,
];

function forbidden(text: string): RegExp | undefined {
  return FORBIDDEN.find((pattern) => pattern.test(text));
}

describe("money isolation", () => {
  it("refuses each way a static scan can see to name the judge or development target, and nothing a factory module needs", () => {
    const refused = [
      '{ "slot_key": "judge-x" }',
      "const key = 'judge';",
      'const pool = "development";',
      "{ pool_key: `judge-x` }",
      '{ "allocation_key": "factory" }',
      'import { JUDGE } from "@rbw/controller";',
      "await spend.acquireSlot({ slot_key: JUDGE.slot_key, root_execution_id: root });",
      "const pool = await spend.poolStatus({ pool_key: JUDGE.pool_key });",
      'import { DEVELOPMENT } from "@rbw/controller";',
      'import { JUDGE_POOL } from "@rbw/controller/judge-web";',
      'import type { JudgeDeps } from "@rbw/controller/judge-types";',
      'import { judgeHandlers } from "../../src/judge/handlers.ts";',
      'const target = { pool_key: "judge-demo", allocation_key: null, slot_key: "factory" };',
      '{ pool_key: "factory", allocation_key: "judge", slot_key: "factory" }',
      '{ slot_key: "judge" }',
      "{ slot_key: 'development' }",
      '{ pool_key: "development" }',
    ];
    for (const sample of refused) expect(forbidden(sample), sample).toBeDefined();
    const allowed = ['{ slot_key: "factory" }', '{ "pool_key": "factory" }', "{ slot_key: `factory` }", "{ pool_key: 'factory', allocation_key: null }", "the judges' passcode", "RBW_JUDGE_PASSCODE", "// the pattern of the judge routes"];
    for (const sample of allowed) expect(forbidden(sample), sample).toBeUndefined();
  });

  it("no factory server module or route names the judge or development target, the judge-demo pool or the judge modules", () => {
    const sources = [...files(SOURCE), ...files(ROUTES)];
    expect(sources.length).toBeGreaterThan(15);
    for (const path of sources) expect(forbidden(readFileSync(path, "utf8")), path).toBeUndefined();
  });
});
