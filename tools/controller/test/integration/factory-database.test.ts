// The factory database (openFactoryDatabase) on the Postgres in DATABASE_URL: its pools, its first
// connect, and its start lock, which serializes starts of one ID across connections with the
// ledger's advisory lock. PGlite has a single connection, so only this suite proves that lock. Each
// test gets its own randomly named schema with every spend migration, dropped afterwards. Errors
// name only the variable and a driver error code.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRateSheet } from "@rbw/envelope";
import type { Rates } from "@rbw/envelope";
import { budgetKey } from "@rbw/factory";
import { canonicalDigest } from "@rbw/schema";
import { fromPg, migrate } from "@rbw/spend";
import { LedgerError } from "../../src/database-ledger.ts";
import { startFactoryValidation } from "../../src/factory-launch.ts";
import type { FactoryLaunchDeps, ValidationStartArgs } from "../../src/factory-launch.ts";
import { FACTORY_EVENTS, FACTORY_IDENTITY, ROUTE_ACTOR, validationOperation } from "../../src/factory-ledger.ts";
import type { FactoryRequestRecord } from "../../src/factory-ports.ts";
import { FACTORY_PROFILE } from "../../src/factory-profile.ts";
import { openFactoryDatabase } from "../../src/factory-spend.ts";
import type { FactoryDatabase } from "../../src/factory-spend.ts";
import { RATE_SHEET_PATH } from "../../src/rate-sheet.ts";
import { CASE_ID, CREDENTIALS, Clock, FakeWorkerSandbox, PROTOCOL, WORKER_IMAGE, syntheticInterpretation } from "../unit/factory-fakes.ts";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") throw new Error("DATABASE_URL is not set");
  return url;
}

function sanitized(error: unknown): Error {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "UNKNOWN";
  return new Error(`DATABASE_URL failed (driver error code ${code})`);
}

async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw sanitized(error);
  }
}

function ok(result: { ok: boolean; code?: string }): void {
  if (!result.ok) throw new Error(`synthetic: refused (${result.code ?? "no code"})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let admin: pg.Client;
let schema: string;
let db: FactoryDatabase;
let clock: Clock;
let rates: Rates;
const logs: string[] = [];

beforeEach(async () => {
  schema = `synthetic_factory_${randomBytes(8).toString("hex")}`;
  admin = new pg.Client({ connectionString: databaseUrl() });
  admin.on("error", () => undefined);
  await guarded(() => admin.connect());
  await guarded(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(fromPg(admin), { schema });
  });
  clock = new Clock();
  rates = await loadRateSheet(RATE_SHEET_PATH);
  db = await openFactoryDatabase({ databaseUrl: databaseUrl(), now: clock.now, log: (line) => logs.push(line), schema });
  ok(await db.spend.createPool({ pool_key: "factory", cap_microusd: 40_000_000, allocations: [], actor_role: "owner", reason: "synthetic factory pool" }));
  ok(await db.spend.createSlotKey({ slot_key: "factory", actor_role: "owner", reason: "synthetic factory slot" }));
});

afterEach(async () => {
  await db.close();
  try {
    await guarded(() => admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
  } finally {
    await guarded(() => admin.end());
  }
});

/** Runs `count` starts at once; each holds its lock while it reads the ledger twice with a pause between. */
async function overlapping(count: number, idOf: (n: number) => { scope: "request" | "validation"; id: string }, pauseMs = 40): Promise<{ results: number[]; most: number }> {
  let active = 0;
  let most = 0;
  const results = await Promise.all(
    Array.from({ length: count }, (_, n) => {
      const { scope, id } = idOf(n);
      return db.withStartLock(scope, id, async () => {
        active += 1;
        most = Math.max(most, active);
        ok(await db.spend.slotStatus({ slot_key: "factory" }));
        await sleep(pauseMs);
        ok(await db.spend.haltStatus());
        active -= 1;
        return n;
      });
    }),
  );
  return { results, most };
}

describe("the factory database's start lock on Postgres", () => {
  it("runs starts of one ID one at a time, more of them than either pool has connections", async () => {
    const id = randomUUID();
    const { results, most } = await overlapping(14, () => ({ scope: "validation", id }));
    expect(results).toEqual(Array.from({ length: 14 }, (_, n) => n));
    expect(most).toBe(1);
  });

  it("runs starts of other IDs, and of the other scope with the same ID, at once", async () => {
    const id = randomUUID();
    const distinct = await overlapping(6, () => ({ scope: "request", id: randomUUID() }), 400);
    expect(distinct.most).toBeGreaterThan(1);
    const scopes = await overlapping(2, (n) => ({ scope: n === 0 ? "request" : "validation", id }), 400);
    expect(scopes.most).toBe(2);
  });

  it("releases the lock and its connection when a start rejects, every time", async () => {
    const id = randomUUID();
    for (let n = 0; n < 14; n += 1) {
      await expect(db.withStartLock("request", id, () => Promise.reject(new Error("synthetic: the start failed")))).rejects.toThrow("synthetic: the start failed");
    }
    expect(await db.withStartLock("request", id, () => Promise.resolve("next"))).toBe("next");
  });

  it("starts one validation run once when two starts of its ID overlap under the lock", async () => {
    const requestId = randomUUID();
    const root = FACTORY_IDENTITY.requestRoot(requestId);
    const interpretationSha = canonicalDigest({ synthetic_interpretation: requestId }).sha256;
    ok(
      await db.records.acceptRequest({
        budget: { budget_key: budgetKey(requestId), root_execution_id: root, pool_key: "factory", cap_microusd: 1_500_000, pool_required_microusd: FACTORY_PROFILE.prices.worker_worst_case_microusd, actor_role: ROUTE_ACTOR },
        request: { request_id: requestId, request_sha256: canonicalDigest({ synthetic_start: requestId }).sha256, interpretation: syntheticInterpretation(interpretationSha), interpretation_sha256: interpretationSha, budget_key: budgetKey(requestId), root_execution_id: root, factory_profile_sha256: FACTORY_PROFILE.profile_sha256 },
        accepted_message: "Request accepted.",
      }),
    );
    ok(await db.ledger.budgets.close(budgetKey(requestId), "fulfilled"));
    expect((await db.factoryRecords.appendEvent(requestId, FACTORY_EVENTS.finished("fulfilled", clock.now()), clock.now())).kind).toBe("appended");
    const request: FactoryRequestRecord | null = await db.factoryRecords.request(requestId);
    expect(request?.root).toBe(root);

    const sandbox = new FakeWorkerSandbox();
    const deps: FactoryLaunchDeps = { ledger: db.ledger, records: db.factoryRecords, identity: FACTORY_IDENTITY, sandbox, rates, now: clock.now, launch: { image: WORKER_IMAGE, env: CREDENTIALS }, log: (line) => logs.push(line) };
    const args: ValidationStartArgs = { request_id: requestId, case_id: CASE_ID, validation_id: randomUUID(), host_id: "task-report", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1.0.0" }, protocol: PROTOCOL };
    const starts = await Promise.all([0, 1].map(() => db.withStartLock("validation", args.validation_id, () => startFactoryValidation(deps, args))));
    expect(starts.map((start) => start.kind)).toEqual(["accepted", "accepted"]);
    expect(sandbox.count("create")).toBe(1);
    const op = validationOperation({ identity: FACTORY_IDENTITY, rates }, { root: FACTORY_IDENTITY.validationRoot(args.validation_id), case_id: CASE_ID, host_id: "task-report", copies: 3 });
    const operations = await db.spend.budgetOperations({ budget_key: budgetKey(requestId) });
    expect(operations.ok && operations.operations.map((operation) => operation.operation_id)).toEqual([op.operation_id]);
    const events = await db.factoryRecords.events(requestId);
    expect(events.filter((event) => event.event_key === `validation:${args.validation_id}:started`)).toHaveLength(1);
    expect((await db.factoryRecords.validation(args.validation_id))?.harness).toEqual({ name: "rbw-validate", version: "1.0.0" });
  });
});

describe("the factory database's first connect", () => {
  it("refuses a database it cannot reach with LedgerError naming only DATABASE_URL and a driver error code", async () => {
    const opened = openFactoryDatabase({ databaseUrl: "postgres://synthetic@127.0.0.1:1/synthetic", now: clock.now, log: (line) => logs.push(line) });
    await expect(opened).rejects.toBeInstanceOf(LedgerError);
    await expect(opened).rejects.toThrow(/^could not connect to the database named by DATABASE_URL \(driver error code [A-Z0-9_]+\)$/);
  });
});
