// Live mode's database open (runtime.ts): it opens on the first port that needs it, concurrent calls
// share one open, a failed open is retried by the next call, and the session and the example answer
// while the database is down. openFactoryDatabase is replaced, so nothing here connects anywhere.
import { readFileSync } from "node:fs";
import type * as FactoryWeb from "@rbw/controller/factory-web";
import type { FactoryDatabase } from "@rbw/controller/factory-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryConfig } from "../../src/config.ts";
import { getCapabilities, getExample, getRequestStatus, postSession } from "../../src/factory-server/handlers.ts";
import { liveServerFor } from "../../src/factory-server/live/runtime.ts";
import type { FactoryServer } from "../../src/factory-server/ports.ts";
import { contractBody, PASSCODE, request, REQUEST_ID, VALIDATION_ID } from "../factory-server/support.ts";

/** What each open was called with, and what the next opens answer. */
const opens = vi.hoisted(() => ({ calls: [] as unknown[], next: [] as (() => Promise<unknown>)[] }));

vi.mock("@rbw/controller/factory-web", async (importOriginal) => {
  const actual = await importOriginal<typeof FactoryWeb>();
  const openFactoryDatabase: typeof actual.openFactoryDatabase = (input) => {
    opens.calls.push(input);
    const answer = opens.next.shift();
    if (answer === undefined) return Promise.reject(new Error("synthetic: no open was expected"));
    return answer() as Promise<FactoryDatabase>;
  };
  return { ...actual, openFactoryDatabase };
});

const RATE_SHEET = readFileSync(new URL("../../../envelope/rate-sheets/v1.json", import.meta.url), "utf8");

/** Live mode with a database and no worker launch, so the capabilities need no ledger read. */
const CONFIG: FactoryConfig = {
  mode: "live",
  passcode: PASSCODE,
  testFixturesDir: "/synthetic/fixtures",
  databaseUrl: "postgres://synthetic.invalid/factory",
  sandbox: null,
  workerImage: null,
  packagesDir: null,
  workerBackend: null,
  repoRoot: "/synthetic/repo",
};

/** A database whose only read is the validation lookup, which finds nothing. */
function fakeDatabase(): FactoryDatabase {
  return { factoryRecords: { validation: () => Promise.resolve(null) } } as unknown as FactoryDatabase;
}

class SyntheticConnectError extends Error {
  override name = "SyntheticConnectError";
}

function down(): Promise<never> {
  return Promise.reject(new SyntheticConnectError("synthetic: connection refused"));
}

const shared = globalThis as { __rbwFactoryLive?: Map<string, Promise<FactoryServer>> };

async function server(): Promise<FactoryServer> {
  return liveServerFor(CONFIG, () => undefined);
}

async function sessionAndExample(live: FactoryServer): Promise<void> {
  expect((await postSession(request("/api/factory/session", { body: { passcode: PASSCODE }, session: false }), live)).status).toBe(204);
  expect((await getExample(request("/api/factory/example", { session: false }), live)).status).toBe(404);
  const capabilities = await contractBody("Capabilities", await getCapabilities(request("/api/factory/capabilities", { session: false }), live));
  expect(capabilities.service.code).toBe("not_configured");
}

beforeEach(() => {
  vi.stubEnv("RBW_FACTORY_RATE_SHEET", RATE_SHEET);
  shared.__rbwFactoryLive = undefined;
  opens.calls.length = 0;
  opens.next.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  shared.__rbwFactoryLive = undefined;
});

describe("the live database open", () => {
  it("opens nothing for the server, the session, the example and the capabilities, then opens once on the first port that needs it", async () => {
    const live = await server();
    await sessionAndExample(live);
    expect(opens.calls).toHaveLength(0);
    opens.next.push(() => Promise.resolve(fakeDatabase()));
    expect(await live.ports.findValidation(VALIDATION_ID)).toBeNull();
    expect(await live.ports.findValidation(VALIDATION_ID)).toBeNull();
    expect(opens.calls).toEqual([expect.objectContaining({ databaseUrl: CONFIG.databaseUrl })]);
  });

  it("shares one open among concurrent calls", async () => {
    const live = await server();
    let resolve: (db: FactoryDatabase) => void = () => undefined;
    opens.next.push(
      () =>
        new Promise<FactoryDatabase>((done) => {
          resolve = done;
        }),
    );
    const calls = [live.ports.findValidation(VALIDATION_ID), live.ports.findValidation(VALIDATION_ID), live.ports.findValidation(VALIDATION_ID)];
    await vi.waitFor(() => {
      expect(opens.calls).toHaveLength(1);
    });
    resolve(fakeDatabase());
    expect(await Promise.all(calls)).toEqual([null, null, null]);
    expect(opens.calls).toHaveLength(1);
  });

  it("opens again on the call after a rejected open, and answers the session and the example while the database is down", async () => {
    const live = await server();
    opens.next.push(down, down);
    await expect(live.ports.findValidation(VALIDATION_ID)).rejects.toThrow(SyntheticConnectError);
    expect((await getRequestStatus(request(`/api/factory/requests/${REQUEST_ID}`), live, { request_id: REQUEST_ID })).status).toBe(503);
    expect(opens.calls).toHaveLength(2);
    await sessionAndExample(live);
    opens.next.push(() => Promise.resolve(fakeDatabase()));
    expect(await live.ports.findValidation(VALIDATION_ID)).toBeNull();
    expect(await live.ports.findValidation(VALIDATION_ID)).toBeNull();
    expect(opens.calls).toHaveLength(3);
  });
});
