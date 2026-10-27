// The factory server's modes: test mode refused on any Vercel deployment, live mode without a database
// (not configured, the session still served), the shared test-mode world, and the money isolation guard.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFactoryConfig, type FactoryConfig } from "../../src/config.ts";
import { getCapabilities, getExample, getRequestStatus, getSession, getTestEvidence, postSession, postTestReset } from "../../src/factory-server/handlers.ts";
import { liveServer } from "../../src/factory-server/integration.ts";
import { factoryServer, handle } from "../../src/factory-server/server.ts";
import { contractBody, FIXTURES, PASSCODE, request, REQUEST_ID } from "./support.ts";

const SOURCE = fileURLToPath(new URL("../../src/factory-server/", import.meta.url));
const ROUTES = fileURLToPath(new URL("../../app/api/factory/", import.meta.url));

function config(mode: FactoryConfig["mode"]): FactoryConfig {
  return { mode, passcode: PASSCODE, testFixturesDir: FIXTURES, databaseUrl: null, sandbox: null, workerImage: null, packagesDir: null, workerBackend: "sandbox", repoRoot: "/synthetic/repo" };
}

const RATE_SHEET = readFileSync(new URL("../../../envelope/rate-sheets/v1.json", import.meta.url), "utf8");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("selects test mode with RBW_FACTORY_TEST_MODE=1 in a local server and refuses it on any Vercel deployment", () => {
    expect(loadFactoryConfig({ RBW_FACTORY_TEST_MODE: "1" }, "/synthetic/app").mode).toBe("test");
    expect(loadFactoryConfig({ RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV: "" }, "/synthetic/app").mode).toBe("test");
    expect(loadFactoryConfig({ RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV: "development" }, "/synthetic/app").mode).toBe("test");
    expect(loadFactoryConfig({ RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV: "preview" }, "/synthetic/app").mode).toBe("refused");
    expect(loadFactoryConfig({ RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV: "production" }, "/synthetic/app").mode).toBe("refused");
    expect(loadFactoryConfig({ RBW_FACTORY_TEST_MODE: "0", VERCEL_ENV: "preview" }, "/synthetic/app").mode).toBe("live");
    expect(loadFactoryConfig({ RBW_FACTORY_TEST_MODE: "0" }, "/synthetic/app").mode).toBe("live");
    expect(loadFactoryConfig({}, "/synthetic/repo/packages/web")).toEqual({
      mode: "live",
      passcode: null,
      testFixturesDir: "/synthetic/repo/docs/product/fixtures/bug-request-v1",
      databaseUrl: null,
      sandbox: null,
      workerImage: null,
      packagesDir: null,
      workerBackend: "sandbox",
      repoRoot: "/synthetic/repo",
    });
    expect(loadFactoryConfig({ RBW_JUDGE_PASSCODE: PASSCODE, RBW_FACTORY_TEST_FIXTURES: "fixtures" }, "/synthetic/app")).toMatchObject({ passcode: PASSCODE, testFixturesDir: "/synthetic/app/fixtures" });
  });

  it("reads live mode's ledger, Sandbox credentials, worker image, packages directory and worker backend", () => {
    const live = { DATABASE_URL: "postgres://synthetic.invalid/factory", VERCEL_TOKEN: "synthetic-token", VERCEL_TEAM_ID: "synthetic-team", VERCEL_PROJECT_ID: "synthetic-project", RBW_FACTORY_WORKER_IMAGE: "synthetic.invalid/worker@sha256:" + "a".repeat(64), RBW_FACTORY_PACKAGES_DIR: "packages" };
    expect(loadFactoryConfig(live, "/synthetic/repo/packages/web")).toMatchObject({
      databaseUrl: live.DATABASE_URL,
      sandbox: { token: "synthetic-token", teamId: "synthetic-team", projectId: "synthetic-project" },
      workerImage: live.RBW_FACTORY_WORKER_IMAGE,
      packagesDir: "/synthetic/repo/packages/web/packages",
      workerBackend: "sandbox",
    });
    expect(loadFactoryConfig({ ...live, VERCEL_PROJECT_ID: "" }, "/synthetic/app").sandbox).toBeNull();
    expect(loadFactoryConfig({ RBW_FACTORY_WORKER_BACKEND: "local" }, "/synthetic/app").workerBackend).toBe("local");
    expect(loadFactoryConfig({ RBW_FACTORY_WORKER_BACKEND: "local", VERCEL_ENV: "development" }, "/synthetic/app").workerBackend).toBeNull();
    expect(loadFactoryConfig({ RBW_FACTORY_WORKER_BACKEND: "local", VERCEL_ENV: "preview" }, "/synthetic/app").workerBackend).toBeNull();
    expect(loadFactoryConfig({ RBW_FACTORY_WORKER_BACKEND: "docker" }, "/synthetic/app").workerBackend).toBeNull();
  });

  it("answers unavailable for every port on a Vercel deployment that asks for test mode, signs nobody in, and has no test endpoints", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await factoryServer(config("refused"));
    expect((await getCapabilities(request("/api/factory/capabilities", { session: false }), server)).status).toBe(503);
    expect((await getExample(request("/api/factory/example", { session: false }), server)).status).toBe(503);
    expect((await postSession(request("/api/factory/session", { body: { passcode: PASSCODE }, session: false }), server)).status).toBe(503);
    expect(await contractBody("SessionStatus", getSession(request("/api/factory/session"), server))).toEqual({ contract_version: "bug-request/1", signed_in: false });
    expect((await getRequestStatus(request(`/api/factory/requests/${REQUEST_ID}`), server, { request_id: REQUEST_ID })).status).toBe(401);
    expect((await postTestReset(request("/api/factory/test/reset", { body: { scenario: "zero-result" }, session: false }), server)).status).toBe(404);
  });

  it.each(["preview", "production"])("refuses test mode through the route wrapper when VERCEL_ENV is %s: ports unavailable, nobody signed in, test endpoints 404", async (environment) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("RBW_FACTORY_TEST_MODE", "1");
    vi.stubEnv("VERCEL_ENV", environment);
    vi.stubEnv("RBW_JUDGE_PASSCODE", PASSCODE);
    vi.stubEnv("RBW_FACTORY_TEST_FIXTURES", FIXTURES);
    try {
      expect((await handle((server) => getCapabilities(request("/api/factory/capabilities", { session: false }), server))).status).toBe(503);
      expect((await handle((server) => postSession(request("/api/factory/session", { body: { passcode: PASSCODE }, session: false }), server))).status).toBe(503);
      expect((await handle((server) => getRequestStatus(request(`/api/factory/requests/${REQUEST_ID}`), server, { request_id: REQUEST_ID }))).status).toBe(401);
      expect((await handle((server) => postTestReset(request("/api/factory/test/reset", { body: { scenario: "zero-result" }, session: false }), server))).status).toBe(404);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["", "development"])("keeps test mode through the route wrapper when VERCEL_ENV is '%s', as in next dev and vercel dev", async (environment) => {
    vi.stubEnv("RBW_FACTORY_TEST_MODE", "1");
    vi.stubEnv("VERCEL_ENV", environment);
    vi.stubEnv("RBW_FACTORY_TEST_FIXTURES", FIXTURES);
    try {
      expect((await handle((server) => getCapabilities(request("/api/factory/capabilities", { session: false }), server))).status).toBe(200);
      const reset = await handle((server) => postTestReset(request("/api/factory/test/reset", { body: { scenario: "zero-result" }, session: false }), server));
      expect(await contractBody("TestResetResponse", reset)).toEqual({ contract_version: "bug-request/1", scenario: "zero-result" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("logs the refusal once per server process, not on every call", async () => {
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

describe("live mode without a database", () => {
  it("serves the session, answers capabilities not_configured, the example and the test endpoints 404, and every ledger call unavailable", async () => {
    vi.stubEnv("RBW_FACTORY_RATE_SHEET", RATE_SHEET);
    try {
      const logs: string[] = [];
      const server = await liveServer(config("live"), (line) => logs.push(line));
      expect((await postSession(request("/api/factory/session", { body: { passcode: PASSCODE }, session: false }), server)).status).toBe(204);
      const capabilities = await contractBody("Capabilities", await getCapabilities(request("/api/factory/capabilities", { session: false }), server));
      expect(capabilities.service).toEqual({ state: "unavailable", code: "not_configured", message: "The factory service is not configured." });
      expect((await getExample(request("/api/factory/example", { session: false }), server)).status).toBe(404);
      expect((await getTestEvidence(request(`/api/factory/test/evidence?request_id=${REQUEST_ID}`, { session: false }), server)).status).toBe(404);
      expect((await getRequestStatus(request(`/api/factory/requests/${REQUEST_ID}`), server, { request_id: REQUEST_ID })).status).toBe(503);
      expect(logs.join("\n")).toContain("FactoryNotConfigured");
      expect(await liveServer(config("live"), () => undefined)).toBe(server);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("answers capabilities not_configured with a database but an incomplete launch configuration", async () => {
    vi.stubEnv("RBW_FACTORY_RATE_SHEET", RATE_SHEET);
    try {
      const unpinned = { ...config("live"), databaseUrl: "postgres://synthetic.invalid/factory", sandbox: { token: "t", teamId: "team", projectId: "project" }, workerImage: "synthetic.invalid/worker:latest" };
      for (const incomplete of [unpinned, { ...unpinned, workerImage: null }, { ...unpinned, sandbox: null }, { ...unpinned, workerBackend: null }, { ...unpinned, workerBackend: "local" as const }]) {
        const server = await liveServer(incomplete, () => undefined);
        const capabilities = await contractBody("Capabilities", await getCapabilities(request("/api/factory/capabilities", { session: false }), server));
        expect(capabilities.service.code, JSON.stringify(incomplete)).toBe("not_configured");
      }
    } finally {
      vi.unstubAllEnvs();
    }
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
 * quoted or unquoted key. live.test.ts runs the live ports on the factory pool and slot of a real ledger.
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
