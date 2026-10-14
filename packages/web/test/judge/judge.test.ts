import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { importRecordSet } from "@rbw/admission";
import * as judge from "@rbw/controller/judge-web";
import type { JudgeControllerCreateParams, JudgeSandboxInstance, JudgeSandboxSdk, ReplayProgress } from "@rbw/controller/judge-web";
import { LocalPrivateStore } from "@rbw/publisher/private-store";
import type { PrivateStore } from "@rbw/publisher/private-store";
import { encodeCanonical, parseRecord, sha256Hex } from "@rbw/schema";
import type { ReserveRequest, Spend } from "@rbw/spend";
import { allowedReleases, judgeEnabled, loadJudgeConfig, MAX_ALLOWED_RELEASES, parseReleaseList } from "../../src/config.ts";
import { REPLAY_UNAVAILABLE_TEXT } from "../../src/model.ts";
import { getSession, getStatus, postJudge, postSession, SESSION_COOKIE } from "../../src/judge/handlers.ts";
import type { FrozenJudge, JudgeServer } from "../../src/judge/handlers.ts";
import { pgliteLedger } from "../../../../tools/controller/test/support/harness.ts";
import { FakeClock } from "../../../../tools/local-runner/test/support/fakes.ts";
import { cleanupRecordSets, recordSet, testOutcome, TEST_IDS } from "../../../../packages/admission/test/support/record-set.ts";
import { cleanup, RACE_RELEASE_ID, RELEASE, RELEASE_ID, releaseDir, releaseTemplate, tempDir } from "../support/results.ts";

const PASSCODE = "synthetic-passcode-7f3a";
const RELEASE_TEXT = readFileSync(join(releaseDir(RELEASE), "release.json"), "utf8");
const RELEASE_SHA = sha256Hex(Buffer.from(RELEASE_TEXT));
const RATE_SHEET = readFileSync(fileURLToPath(new URL("../../../envelope/rate-sheets/v1.json", import.meta.url)), "utf8");
const START = Date.parse("2026-12-03T10:00:00Z");
const SECRETS = {
  VERCEL_TOKEN: "synthetic-vercel-token-91",
  VERCEL_TEAM_ID: "synthetic-team-92",
  VERCEL_PROJECT_ID: "synthetic-project-93",
  DATABASE_URL: "postgres://synthetic-user:synthetic-db-password-94@db.example.invalid/synthetic",
  BLOB_PRIVATE_STORE_ID: "synthetic-store-95",
};
const REQUEST = "00000000-0000-4000-8000-00000000d001";
const OTHER = "00000000-0000-4000-8000-00000000d002";

/** An unsigned token with the given expiry, standing in for the function's OIDC token. */
function oidc(expiresMs: number): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: Math.floor(expiresMs / 1000), sub: "synthetic" })}.synthetic-signature`;
}

class FakeSdk implements JudgeSandboxSdk {
  readonly creates: JudgeControllerCreateParams[] = [];
  readonly commands: unknown[] = [];
  fail = false;
  private readonly events: string[];
  constructor(events: string[]) {
    this.events = events;
  }
  create(params: JudgeControllerCreateParams): Promise<JudgeSandboxInstance> {
    this.events.push("sdk:create");
    this.creates.push(params);
    if (this.fail) return Promise.reject(new Error("synthetic: the create failed"));
    return Promise.resolve({
      name: params.name,
      writeFiles: () => Promise.resolve(),
      runCommand: (command) => {
        this.commands.push(command);
        return Promise.resolve({});
      },
    });
  }
}

interface World {
  server: JudgeServer;
  events: string[];
  logs: string[];
  spend: Spend;
  store: PrivateStore;
  sdk: FakeSdk;
  clock: FakeClock;
  touched: string[];
  reserves: ReserveRequest[];
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  cleanup();
  cleanupRecordSets();
});

async function world(env: Record<string, string> = {}, frozen: FrozenJudge = { release: RELEASE_TEXT, rateSheet: RATE_SHEET }): Promise<World> {
  const clock = new FakeClock({ start: START });
  const ledger = await pgliteLedger(clock);
  closers.push(ledger.close);
  const events: string[] = [];
  const logs: string[] = [];
  const touched: string[] = [];
  const reserves: ReserveRequest[] = [];
  const spend: Spend = { ...ledger.spend };
  for (const [name, fn] of Object.entries(ledger.spend) as [string, (request: { to_state?: string } & ReserveRequest) => Promise<unknown>][]) {
    (spend as unknown as Record<string, unknown>)[name] = (request: { to_state?: string } & ReserveRequest) => {
      if (name === "reserve") reserves.push(request);
      if (!name.endsWith("Status")) events.push(`ledger:${name}${request.to_state === undefined ? "" : `:${request.to_state}`}`);
      return fn(request);
    };
  }
  const inner = new LocalPrivateStore(tempDir());
  const store: PrivateStore = {
    putNew: (key, bytes, type) => {
      events.push(`putNew:${key.split("/").at(-1) ?? ""}`);
      return inner.putNew(key, bytes, type);
    },
    put: (key, bytes, type) => {
      events.push(`put:${key.split("/").at(-1) ?? ""}`);
      return inner.put(key, bytes, type);
    },
    get: (key, max) => inner.get(key, max),
    list: (prefix) => inner.list(prefix),
  };
  const sdk = new FakeSdk(events);
  const server: JudgeServer = {
    config: loadJudgeConfig({ RBW_JUDGE_PASSCODE: PASSCODE, RBW_JUDGE_RELEASE_ID: RELEASE_ID, RBW_JUDGE_RELEASE_SHA256: RELEASE_SHA, ...SECRETS, ...env }),
    frozen,
    judge: () => {
      touched.push("judge");
      return Promise.resolve(judge);
    },
    ledger: () => {
      touched.push("ledger");
      return Promise.resolve({ spend, close: () => Promise.resolve() });
    },
    oidcToken: () => {
      touched.push("oidc");
      return Promise.resolve(oidc(clock.now() + 2 * 3_600_000));
    },
    store: () => {
      touched.push("store");
      return Promise.resolve(store);
    },
    sandbox: () => {
      touched.push("sandbox");
      return sdk;
    },
    now: () => clock.now(),
    log: (line) => logs.push(line),
  };
  return { server, events, logs, spend, store, sdk, clock, touched, reserves };
}

function post(path: string, body: unknown, cookie: string | null = null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie !== null) headers.cookie = cookie;
  return new Request(`https://example.invalid${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function session(w: World, body: unknown = { passcode: PASSCODE }): Promise<{ response: Response; cookie: string | null }> {
  const response = await postSession(post("/api/judge/session", body), w.server);
  const header = response.headers.get("set-cookie");
  return { response, cookie: header === null ? null : (header.split(";")[0] ?? null) };
}

async function login(w: World): Promise<string> {
  const { cookie } = await session(w);
  if (cookie === null) throw new Error("synthetic: no session cookie");
  return cookie;
}

function status(w: World, requestId: string, cookie: string | null) {
  const headers: Record<string, string> = cookie === null ? {} : { cookie };
  return getStatus(new Request(`https://example.invalid/api/judge/status?request_id=${requestId}`, { headers }), w.server);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function slotHolder(w: World): Promise<string | null> {
  const slot = await w.spend.slotStatus({ slot_key: "judge" });
  if (!slot.ok) throw new Error("synthetic: no slot status");
  return slot.holder;
}

describe("the passcode session", () => {
  it("sets an HttpOnly, Secure, SameSite=Strict cookie for the right passcode", async () => {
    const w = await world();
    const { response, cookie } = await session(w);
    expect(response.status).toBe(200);
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/Secure/);
    expect(header).toMatch(/SameSite=Strict/);
    expect(cookie?.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(header).not.toContain(PASSCODE);
  });

  it("refuses a wrong or missing passcode with no cookie and no ledger, Blob or Sandbox call", async () => {
    const w = await world();
    for (const body of [{ passcode: "synthetic-wrong" }, {}, { passcode: 7 }, "not json"]) {
      const { response, cookie } = await session(w, body);
      expect(response.status).toBe(401);
      expect(cookie).toBeNull();
    }
    expect(w.touched).toEqual([]);
  });

  it("makes the judge and status routes refuse a missing or bad cookie before any call", async () => {
    const w = await world();
    for (const cookie of [null, `${SESSION_COOKIE}=synthetic-forged`, `${SESSION_COOKIE}=${PASSCODE}`]) {
      expect((await postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server)).status).toBe(401);
      expect((await status(w, REQUEST, cookie)).status).toBe(401);
    }
    const rotated = await world({ RBW_JUDGE_PASSCODE: "synthetic-rotated-passcode" });
    expect((await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), rotated.server)).status).toBe(401);
    expect([...w.touched, ...rotated.touched]).toEqual([]);
  });

  it("answers a session check with 200, ready for a valid cookie and signed_out otherwise, before any call", async () => {
    const w = await world();
    const check = (cookie: string | null) => getSession(new Request("https://example.invalid/api/judge/session", { headers: cookie === null ? {} : { cookie } }), w.server);
    const valid = check(await login(w));
    expect(valid.status).toBe(200);
    expect(await json(valid)).toEqual({ state: "ready" });
    expect(valid.headers.get("set-cookie")).toBeNull();
    for (const cookie of [null, `${SESSION_COOKIE}=synthetic-forged`]) {
      // A public page checks on every load, so a missing session is an answer, not an error.
      const signedOut = check(cookie);
      expect(signedOut.status).toBe(200);
      expect(await json(signedOut)).toEqual({ state: "signed_out" });
      expect(signedOut.headers.get("set-cookie")).toBeNull();
    }
    expect(w.touched).toEqual([]);
  });

  it("puts the passcode in no response or log", async () => {
    const w = await world();
    const cookie = await login(w);
    const bodies = [await (await session(w, { passcode: "synthetic-wrong" })).response.text(), await (await postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server)).text(), await (await status(w, REQUEST, cookie)).text()];
    for (const text of [...bodies, ...w.logs]) expect(text).not.toContain(PASSCODE);
  });
});

describe("the judge POST", () => {
  it("accepts only { request_id }", async () => {
    const w = await world();
    const cookie = await login(w);
    for (const body of [{ request_id: REQUEST, release_id: RELEASE_ID }, { request_id: REQUEST, extra: 1 }, {}, { request_id: "synthetic" }, "not json", [REQUEST]]) {
      expect((await postJudge(post("/api/judge", body, cookie), w.server)).status).toBe(400);
    }
    expect(w.touched).toEqual([]);
  });

  it("takes the slot, reserves, writes root-run.json and progress.json, records launching, creates once and answers starting", async () => {
    const w = await world();
    const response = await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server);
    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({ state: "starting", request_id: REQUEST });
    expect(w.events).toEqual([
      "ledger:acquireSlot",
      "ledger:reserve",
      "putNew:root-run.json",
      "putNew:progress.json",
      "ledger:transition:launching",
      "sdk:create",
      "ledger:transition:running",
    ]);
    const ids = judge.judgeIds(REQUEST);
    const root = parseRecord("RootRun", (await w.store.get(`judge/${ids.root}/root-run.json`, 65_536)) ?? new Uint8Array());
    expect(root).toMatchObject({ kind: "judge_replay", status: "prepared", child_execution_ids: [ids.execution], root_execution_id: ids.root, declared_stages: ["judge_verify"] });
    const record = parseRecord("Release", Buffer.from(RELEASE_TEXT));
    expect(root.project_id).toBe(record.project_id);
    expect(root.project_policy_sha256).toBe(record.project_policy_sha256);
    const progress = judge.parseProgress((await w.store.get(`judge/${ids.root}/progress.json`, 65_536)) ?? new Uint8Array());
    expect(progress.created_at).toBe("2026-12-03T10:00:00Z");
    expect(progress.deadline_at).toBe("2026-12-03T10:33:00Z");
    expect(w.sdk.creates).toHaveLength(1);
    expect(w.sdk.creates[0]).toMatchObject({ name: judge.controllerSandboxName(ids.root), persistent: false, resources: { vcpus: 2 }, networkPolicy: "allow-all", timeout: 2_100_000, image: record.images.controller_image });
    expect(w.reserves).toHaveLength(1);
    expect(w.reserves[0]).toMatchObject({ pool_key: "judge-demo", allocation_key: "judge", root_execution_id: ids.root });
    const rates = judge.parseRateSheet(RATE_SHEET);
    const envelope = judge.controllerEnvelope(rates);
    expect(envelope.ok && w.reserves[0]?.envelope).toEqual(envelope.ok ? envelope.lines : null);
    expect(await slotHolder(w)).toBe(ids.root);
  });

  it("makes one create for two POSTs with one request ID", async () => {
    const w = await world();
    const cookie = await login(w);
    const [a, b] = await Promise.all([postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server), postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server)]);
    expect(w.sdk.creates).toHaveLength(1);
    const states = [(await json(a)).state, (await json(b)).state];
    expect(states.every((state) => state === "starting")).toBe(true);
    expect(w.reserves).toHaveLength(1);
  });

  it("answers a repeated POST with one request ID with that replay's status, and writes, reserves and creates nothing more", async () => {
    const w = await world();
    const cookie = await login(w);
    expect((await postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server)).status).toBe(202);
    w.events.length = 0;
    const again = await postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server);
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ state: "starting", request_id: REQUEST, release_id: RELEASE_ID });
    expect(w.events).toEqual([]);
    expect(w.reserves).toHaveLength(1);
    expect(w.sdk.creates).toHaveLength(1);
  });

  it("refuses a second start with another request ID as busy, with its text, while the first replay runs", async () => {
    const w = await world();
    const cookie = await login(w);
    await postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server);
    w.events.length = 0;
    const body = await json(await postJudge(post("/api/judge", { request_id: OTHER }, cookie), w.server));
    expect(body).toEqual({ state: "unavailable", request_id: OTHER, reason: "busy", message: "Busy: another replay is running. Try again shortly." });
    expect(w.events).toEqual(["ledger:acquireSlot"]);
    expect(w.reserves).toHaveLength(1);
    expect(w.sdk.creates).toHaveLength(1);
    expect(await w.store.list(`judge/${judge.judgeIds(OTHER).root}/`)).toEqual([]);
  });

  it("starts one of two POSTs with different request IDs; the other is busy and writes, reserves and creates nothing", async () => {
    const w = await world();
    const cookie = await login(w);
    const [a, b] = await Promise.all([postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server), postJudge(post("/api/judge", { request_id: OTHER }, cookie), w.server)]);
    const bodies = [await json(a), await json(b)];
    expect(bodies.map((body) => body.state).sort()).toEqual(["starting", "unavailable"]);
    const busy = bodies.find((body) => body.state === "unavailable");
    expect(busy?.reason).toBe("busy");
    expect(busy?.message).toBe("Busy: another replay is running. Try again shortly.");
    expect(w.sdk.creates).toHaveLength(1);
    expect(w.reserves).toHaveLength(1);
    const busyRoot = judge.judgeIds(busy?.request_id === REQUEST ? REQUEST : OTHER).root;
    expect(await w.store.list(`judge/${busyRoot}/`)).toEqual([]);
  });

  it("answers busy while another root holds the slot", async () => {
    const w = await world();
    await w.spend.acquireSlot({ slot_key: "judge", root_execution_id: "00000000-0000-4000-8000-00000000e001", actor_role: "synthetic" });
    const body = await json(await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server));
    expect(body).toMatchObject({ state: "unavailable", reason: "busy" });
    expect(w.reserves).toEqual([]);
    expect(w.sdk.creates).toEqual([]);
    expect(await w.store.list("judge/")).toEqual([]);
  });

  it("is unavailable, without taking the slot, when the judge budget cannot cover the whole job", async () => {
    const w = await world();
    const pool = await w.spend.poolStatus({ pool_key: "judge-demo" });
    if (!pool.ok) throw new Error("synthetic: no pool");
    const available = pool.allocations.find((item) => item.allocation_key === "judge")?.available_microusd ?? 0n;
    await drain(w.spend, Number(available) - 600_000);
    w.events.length = 0;
    const body = await json(await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server));
    expect(body).toMatchObject({ state: "unavailable", reason: "budget", message: "Unavailable: the judge budget cannot cover a replay." });
    expect(w.events).toEqual([]);
    expect(w.touched).not.toContain("sandbox");
    expect(await slotHolder(w)).toBeNull();
    expect(w.sdk.creates).toEqual([]);
    expect(await w.store.list("judge/")).toEqual([]);
  });

  it("releases the slot and is unavailable when the reservation is refused for insufficient funds", async () => {
    const w = await world();
    const reserve = w.server.ledger;
    w.server.ledger = async () => {
      const ledger = await reserve();
      return {
        ...ledger,
        spend: {
          ...ledger.spend,
          reserve: async (request) => {
            const pool = await w.spend.poolStatus({ pool_key: "judge-demo" });
            if (!pool.ok) throw new Error("synthetic: no pool");
            await drain(w.spend, Number(pool.allocations.find((item) => item.allocation_key === "judge")?.available_microusd ?? 0n) - 1_000);
            return ledger.spend.reserve(request);
          },
        },
      };
    };
    const body = await json(await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server));
    expect(body).toMatchObject({ state: "unavailable", reason: "budget" });
    expect(w.events).toContain("ledger:releaseSlot");
    expect(await slotHolder(w)).toBeNull();
    expect(w.sdk.creates).toEqual([]);
  });

  it("is unavailable as halted, with no ledger write, slot or sandbox, while an over-envelope settlement has halted all spend", async () => {
    const w = await world();
    await halt(w.spend);
    w.events.length = 0;
    w.reserves.length = 0;
    w.touched.length = 0;
    const body = await json(await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server));
    expect(body).toMatchObject({ state: "unavailable", reason: "halted", message: "Paused: spending is halted for an operator check. Try again later." });
    expect(w.events).toEqual([]);
    expect(w.reserves).toEqual([]);
    expect(w.touched).not.toContain("sandbox");
    expect(await slotHolder(w)).toBeNull();
    expect(w.sdk.creates).toEqual([]);
    expect(await w.store.list("judge/")).toEqual([]);
  });

  it("releases the slot and answers halted when spend halts between the check and the reservation", async () => {
    const w = await world();
    const open = w.server.ledger;
    w.server.ledger = async () => {
      const ledger = await open();
      return {
        ...ledger,
        spend: {
          ...ledger.spend,
          reserve: async (request) => {
            await halt(w.spend);
            return ledger.spend.reserve(request);
          },
        },
      };
    };
    const body = await json(await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server));
    expect(body).toMatchObject({ state: "unavailable", reason: "halted", message: REPLAY_UNAVAILABLE_TEXT.halted });
    expect(w.events).toContain("ledger:releaseSlot");
    expect(await slotHolder(w)).toBeNull();
    expect(w.sdk.creates).toEqual([]);
  });

  it("is unavailable when the configured release ID or hash differs from the frozen release", async () => {
    const envs: Record<string, string>[] = [{ RBW_JUDGE_RELEASE_ID: "00000000-0000-4000-8000-000000000699" }, { RBW_JUDGE_RELEASE_SHA256: "0".repeat(64) }, { RBW_JUDGE_RELEASE_ID: "" }];
    for (const env of envs) {
      const w = await world(env);
      const body = await json(await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server));
      expect(body).toMatchObject({ state: "unavailable", reason: "release" });
      expect(w.touched.filter((item) => item !== "judge")).toEqual([]);
    }
  });

  it("is unavailable when the OIDC token would expire before the controller's timeout", async () => {
    const w = await world();
    w.server.oidcToken = () => Promise.resolve(oidc(w.clock.now() + 30 * 60_000));
    const body = await json(await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server));
    expect(body).toMatchObject({ state: "unavailable", reason: "token" });
    expect(await slotHolder(w)).toBeNull();
  });

  it("answers an existing replay's status even when the token would no longer cover a new one", async () => {
    const w = await world();
    const cookie = await login(w);
    await postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server);
    w.server.oidcToken = () => Promise.resolve(oidc(w.clock.now() + 30 * 60_000));
    expect(await json(await postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server))).toMatchObject({ state: "starting", request_id: REQUEST });
  });

  it("never touches the public allocation", async () => {
    const w = await world();
    await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server);
    expect(w.reserves.every((request) => request.allocation_key === "judge")).toBe(true);
    const pool = await w.spend.poolStatus({ pool_key: "judge-demo" });
    if (!pool.ok) throw new Error("synthetic: no pool");
    expect(pool.allocations.find((item) => item.allocation_key === "public")?.committed_microusd).toBe(0n);
  });

  it("starts a replay when the public allocation is used up", async () => {
    const w = await world();
    await drain(w.spend, 50_000_000, "public");
    const pool = await w.spend.poolStatus({ pool_key: "judge-demo" });
    if (!pool.ok) throw new Error("synthetic: no pool");
    expect(pool.allocations.find((item) => item.allocation_key === "public")?.available_microusd).toBe(0n);
    const response = await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server);
    expect(response.status).toBe(202);
    expect(w.sdk.creates).toHaveLength(1);
    expect(w.reserves.at(-1)).toMatchObject({ allocation_key: "judge" });
  });

  it("is unavailable for budget, with no ledger write, when the pool as a whole cannot cover the job though the judge allocation could", async () => {
    // Possible only after a public operation settled over its envelope: the pool cap then binds first.
    const w = await world();
    const open = w.server.ledger;
    w.server.ledger = async () => {
      const ledger = await open();
      return {
        ...ledger,
        spend: {
          ...ledger.spend,
          poolStatus: async (request) => {
            const pool = await ledger.spend.poolStatus(request);
            return pool.ok ? { ...pool, available_microusd: 1_000n } : pool;
          },
        },
      };
    };
    const body = await json(await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server));
    expect(body).toMatchObject({ state: "unavailable", reason: "budget" });
    expect(w.events).toEqual([]);
    expect(await slotHolder(w)).toBeNull();
    expect(w.sdk.creates).toEqual([]);
  });

  it("answers unavailable, not a server error, when the ledger can't be reached for a start, and writes nothing", async () => {
    const w = await world();
    const cookie = await login(w);
    w.server.ledger = () => Promise.reject(new Error("synthetic: the database is unreachable"));
    const response = await postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ state: "unavailable", reason: "ledger" });
    expect(await w.store.list("judge/")).toEqual([]);
    expect(w.sdk.creates).toEqual([]);
  });

  it("records a failed create as uncertain, shows needs_reconciliation and does not retry", async () => {
    const w = await world();
    w.sdk.fail = true;
    const cookie = await login(w);
    const body = await json(await postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server));
    expect(body.state).toBe("needs_reconciliation");
    expect(w.sdk.creates).toHaveLength(1);
    expect(w.events).toContain("ledger:transition:uncertain");
    expect((await json(await status(w, REQUEST, cookie))).state).toBe("needs_reconciliation");
    expect((await json(await postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server))).state).toBe("needs_reconciliation");
    expect(w.sdk.creates).toHaveLength(1);
  });

  it("records needs_reconciliation, not starting, when a store write throws after the reservation", async () => {
    const w = await world();
    const putNew = w.store.putNew.bind(w.store);
    w.store.putNew = (key, bytes, type) => (key.endsWith("/progress.json") ? Promise.reject(new Error("synthetic: the write failed")) : putNew(key, bytes, type));
    const cookie = await login(w);
    const body = await json(await postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server));
    expect(body.state).toBe("needs_reconciliation");
    const root = parseRecord("RootRun", (await w.store.get(`judge/${judge.judgeIds(REQUEST).root}/root-run.json`, 65_536)) ?? new Uint8Array());
    expect(root.status).toBe("needs_reconciliation");
    expect((await json(await postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server))).state).toBe("needs_reconciliation");
    expect(w.sdk.creates).toEqual([]);
    expect(w.logs.join("\n")).not.toContain("synthetic: the write failed");
  });

  it("answers unavailable, not a server error, when the ledger can't be reached for a status read", async () => {
    const w = await world();
    const cookie = await login(w);
    w.server.ledger = () => Promise.reject(new Error("synthetic: the database is unreachable"));
    const response = await status(w, REQUEST, cookie);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ state: "unavailable", reason: "ledger" });
  });

  it("releases the slot and is unavailable when the reservation throws", async () => {
    const w = await world();
    const reserve = w.server.ledger;
    w.server.ledger = async () => {
      const ledger = await reserve();
      return { ...ledger, spend: { ...ledger.spend, reserve: () => Promise.reject(new Error("synthetic: the ledger failed")) } };
    };
    const body = await json(await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server));
    expect(body).toMatchObject({ state: "unavailable", reason: "error", message: "Unavailable: the replay could not start. Try again shortly." });
    expect(await slotHolder(w)).toBeNull();
    expect(w.sdk.creates).toEqual([]);
  });

  it("passes the credentials only in the sandbox's environment, never in its arguments, the response or a log", async () => {
    const w = await world();
    const response = await (await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server)).text();
    const params = w.sdk.creates[0];
    for (const [name, value] of Object.entries(SECRETS)) expect(params?.env[name]).toBe(value);
    expect(params?.env.VERCEL_OIDC_TOKEN).toMatch(/^ey/);
    const outside = [response, ...w.logs, JSON.stringify(w.sdk.commands), params?.name ?? "", params?.image ?? ""].join("\n");
    for (const value of [...Object.values(SECRETS), params?.env.VERCEL_OIDC_TOKEN ?? "x"]) expect(outside).not.toContain(value);
  });
});

/** Reserves `amount` on a judge-demo allocation for another root, leaving less for a replay. */
async function drain(spend: Spend, amount: number, allocation = "judge"): Promise<void> {
  const op = sha256Hex(Buffer.from(`synthetic-drain-${String(amount)}-${String(Math.random())}`));
  const result = await spend.reserve({
    operation_id: op,
    payload_hash: op,
    attempt_ordinal: 1,
    previous_operation_id: null,
    project_id: "00000000-0000-4000-8000-000000000001",
    project_policy_sha256: "1".repeat(64),
    batch_id: null,
    task_revision: "2".repeat(64),
    root_execution_id: "00000000-0000-4000-8000-00000000e101",
    execution_id: "00000000-0000-4000-8000-00000000e101",
    parent_execution_id: null,
    kind: "synthetic.drain",
    call_name: "synthetic.drain:1",
    provider: "synthetic",
    provider_replay_key: null,
    pool_key: "judge-demo",
    allocation_key: allocation,
    runtime_profile_sha256: "3".repeat(64),
    rate_sheet_sha256: "4".repeat(64),
    envelope: [{ service: "synthetic", unit: "allowance", limit: amount, enforced_by: "fixed_allowance", price: { microusd: 1, per_units: 1 } }],
  });
  if (!result.ok) throw new Error(`synthetic: the drain was refused (${result.code})`);
}

/** Settles a public operation above its envelope, which halts new spend in every pool until an operator resumes it. */
async function halt(spend: Spend): Promise<void> {
  const op = sha256Hex(Buffer.from(`synthetic-overrun-${String(Math.random())}`));
  const root = "00000000-0000-4000-8000-00000000e201";
  const steps = [
    () => spend.createSlotKey({ slot_key: "synthetic-overrun", actor_role: "owner", reason: "synthetic overrun" }),
    () => spend.acquireSlot({ slot_key: "synthetic-overrun", root_execution_id: root, actor_role: "workflow" }),
    () =>
      spend.reserve({
        operation_id: op,
        payload_hash: op,
        attempt_ordinal: 1,
        previous_operation_id: null,
        project_id: "00000000-0000-4000-8000-000000000001",
        project_policy_sha256: "1".repeat(64),
        batch_id: null,
        task_revision: "2".repeat(64),
        root_execution_id: root,
        execution_id: root,
        parent_execution_id: null,
        kind: "synthetic.overrun",
        call_name: "synthetic.overrun:1",
        provider: "synthetic",
        provider_replay_key: null,
        pool_key: "judge-demo",
        allocation_key: "public",
        runtime_profile_sha256: "3".repeat(64),
        rate_sheet_sha256: "4".repeat(64),
        envelope: [{ service: "synthetic", unit: "input_token", limit: 1000, enforced_by: "request_parameter", price: { microusd: 1, per_units: 1 } }],
      }),
    () => spend.transition({ operation_id: op, from_state: "prepared", to_state: "launching", actor_role: "workflow", slot_key: "synthetic-overrun" }),
    () => spend.transition({ operation_id: op, from_state: "launching", to_state: "terminal", actor_role: "workflow", terminal_status: "completed" }),
    () =>
      spend.settle({
        schema_version: 1,
        operation_id: op,
        runtime_profile_sha256: "3".repeat(64),
        rate_sheet_sha256: "4".repeat(64),
        reserved_microusd: 1000,
        service_lines: [{ service: "synthetic", unit: "input_token", actual_quantity: 1000, actual_microusd: 1001, retained_microusd: 0 }],
        usage_state: "known",
        terminal_evidence_key: null,
        terminal_evidence_sha256: null,
      }),
  ];
  for (const [index, step] of steps.entries()) {
    const result = await step();
    if (!result.ok) throw new Error(`synthetic: overrun step ${String(index)} was refused (${JSON.stringify(result)})`);
  }
  const status = await spend.haltStatus();
  if (!status.ok || !status.halted) throw new Error("synthetic: spend did not halt");
}

async function put(w: World, key: string, value: unknown): Promise<void> {
  await w.store.put(key, value instanceof Uint8Array ? value : encodeCanonical(value), "application/json");
}

async function started(w: World, cookie: string): Promise<{ root: string; progress: ReplayProgress }> {
  await postJudge(post("/api/judge", { request_id: REQUEST }, cookie), w.server);
  const root = judge.judgeIds(REQUEST).root;
  const progress = judge.parseProgress((await w.store.get(`judge/${root}/progress.json`, 65_536)) ?? new Uint8Array());
  return { root, progress };
}

async function finish(w: World, root: string, progress: ReplayProgress, state: ReplayProgress["state"], known: boolean, failing: readonly string[]): Promise<void> {
  const evidence = importRecordSet(
    recordSet(
      (draft) => {
        for (const trialId of ["clean-01", "planted-01", "fixed-01"]) for (const id of failing) testOutcome(draft, trialId, id, "failed");
      },
      () => undefined,
      "judge_verify",
    ),
  );
  await put(w, `judge/${root}/run/jobs/judge/evidence.json`, evidence);
  await put(w, `judge/${root}/progress.json`, judge.progressBytes({ ...progress, state, known_condition: known, ended_at: "2026-12-03T10:21:00Z", copies: progress.copies.map((copy) => ({ ...copy, status: "done", started_at: "2026-12-03T10:02:00Z" })) }));
  const rootRun = parseRecord("RootRun", (await w.store.get(`judge/${root}/root-run.json`, 65_536)) ?? new Uint8Array());
  await put(w, `judge/${root}/root-run.json`, { ...rootRun, status: "terminal", outcome: "completed" });
}

describe("the status route", () => {
  it("is starting after the POST, then running once a copy runs", async () => {
    const w = await world();
    const cookie = await login(w);
    const { root, progress } = await started(w, cookie);
    expect(await json(await status(w, REQUEST, cookie))).toMatchObject({ state: "starting", request_id: REQUEST, hard_cap_seconds: 2100 });
    await put(w, `judge/${root}/progress.json`, judge.progressBytes({ ...progress, state: "running", copies: progress.copies.map((copy, index) => (index === 0 ? { ...copy, status: "running", started_at: "2026-12-03T10:01:00Z" } : copy)) }));
    w.clock.current = START + 125_000;
    const body = await json(await status(w, REQUEST, cookie));
    expect(body).toMatchObject({ state: "running", elapsed_seconds: 125 });
    expect(body.copies).toEqual([
      { trial_id: "clean-01", status: "running", started_at: "2026-12-03T10:01:00Z" },
      { trial_id: "planted-01", status: "not_started", started_at: null },
      { trial_id: "fixed-01", status: "not_started", started_at: null },
    ]);
  });

  it("shows a verified replay with its known condition, its six cells and their failing tests, and no resource ID, operation ID, key or path", async () => {
    const w = await world();
    const cookie = await login(w);
    const { root, progress } = await started(w, cookie);
    await finish(w, root, progress, "verified", true, [TEST_IDS[0] ?? "", TEST_IDS[1] ?? ""]);
    const response = await status(w, REQUEST, cookie);
    const body = await json(response);
    expect(body).toMatchObject({ state: "verified", known_condition: true, message: judge.KNOWN_CONDITION_MESSAGE, release_id: RELEASE_ID, created_at: "2026-12-03T10:00:00Z", ended_at: "2026-12-03T10:21:00Z", elapsed_seconds: 1260 });
    const cells = body.cells as { suite: string; trial_id: string; state: string; matches_expectation: boolean; failing: { id: string }[] }[];
    expect(cells.map((cell) => `${cell.suite} ${cell.trial_id} ${cell.state}`)).toEqual([
      "original clean-01 fail",
      "added clean-01 pass",
      "original planted-01 fail",
      "added planted-01 fail",
      "original fixed-01 fail",
      "added fixed-01 pass",
    ]);
    expect(cells[0]?.failing.map((item) => item.id)).toEqual([TEST_IDS[0], TEST_IDS[1]]);
    const text = JSON.stringify(body);
    const operation = judge.judgeOperation(REQUEST, judge.judgeRelease(parseRecord("Release", Buffer.from(RELEASE_TEXT))), judge.controllerEnvelope(judge.parseRateSheet(RATE_SHEET)) as never);
    for (const hidden of [root, "judge/", "trials/", "rbw-", operation.operation_id, "/tmp", SECRETS.DATABASE_URL]) expect(text).not.toContain(hidden);
  });

  it("shows a not_reproduced replay", async () => {
    const w = await world();
    const cookie = await login(w);
    const { root, progress } = await started(w, cookie);
    await finish(w, root, progress, "not_reproduced", false, [TEST_IDS[2] ?? ""]);
    expect(await json(await status(w, REQUEST, cookie))).toMatchObject({ state: "not_reproduced", known_condition: false });
  });

  it("is needs_reconciliation with no terminal root-run past the timeout while the slot is held, otherwise incomplete", async () => {
    const w = await world();
    const cookie = await login(w);
    const { root } = await started(w, cookie);
    w.clock.current = START + 2_100_001;
    expect((await json(await status(w, REQUEST, cookie))).state).toBe("needs_reconciliation");
    const operation = judge.judgeOperation(REQUEST, judge.judgeRelease(parseRecord("Release", Buffer.from(RELEASE_TEXT))), judge.controllerEnvelope(judge.parseRateSheet(RATE_SHEET)) as never);
    await w.spend.transition({ operation_id: operation.operation_id, from_state: "running", to_state: "terminal", actor_role: "synthetic", terminal_status: "completed" });
    await w.spend.settle(judge.controllerSettlement(judge.controllerEnvelope(judge.parseRateSheet(RATE_SHEET)) as never, operation.operation_id));
    expect((await json(await status(w, REQUEST, cookie))).state).toBe("needs_reconciliation");
    expect((await w.spend.releaseSlot({ slot_key: "judge", root_execution_id: root, actor_role: "synthetic", evidence: null, reason: null })).ok).toBe(true);
    expect((await json(await status(w, REQUEST, cookie))).state).toBe("incomplete");
  });

  it("answers unknown for a request ID with no replay, and refuses a malformed one", async () => {
    const w = await world();
    const cookie = await login(w);
    expect((await status(w, OTHER, cookie)).status).toBe(404);
    expect((await status(w, "synthetic", cookie)).status).toBe(400);
  });
});

describe("the hold, through the POST", () => {
  it("is unavailable after two not_reproduced replays in a row, and a later RBW_JUDGE_HOLD_CLEARED_AT clears it", async () => {
    const w = await world();
    for (const [index, created] of ["2026-12-01T10:00:00Z", "2026-12-02T10:00:00Z"].entries()) {
      const root = `00000000-0000-4000-8000-00000000f00${String(index)}`;
      await put(w, `judge/${root}/progress.json`, judge.progressBytes({ ...judge.newProgress(root, Date.parse(created), Date.parse(created) + 1_980_000), state: "not_reproduced", known_condition: false }));
    }
    const held = await json(await postJudge(post("/api/judge", { request_id: REQUEST }, await login(w)), w.server));
    expect(held).toMatchObject({ state: "unavailable", reason: "held", message: REPLAY_UNAVAILABLE_TEXT.held });
    expect(await slotHolder(w)).toBeNull();
    const cleared = await world({ RBW_JUDGE_HOLD_CLEARED_AT: "2026-12-02T12:00:00Z" });
    cleared.server.store = w.server.store;
    expect((await json(await postJudge(post("/api/judge", { request_id: REQUEST }, await login(cleared)), cleared.server))).state).toBe("starting");
  });
});

// A second synthetic release, frozen beside the release fixture's: another ID, judge job and controller image.
const SECOND = (() => {
  const template = releaseTemplate();
  const record = {
    ...template,
    release_id: RACE_RELEASE_ID,
    created_at: "2026-10-12T09:00:00Z",
    judge_job: { index_key: `judge-jobs/${RACE_RELEASE_ID}/judge-job.json`, index_sha256: template.judge_job.index_sha256 },
    images: { ...template.images, controller_image: template.images.controller_image.replace(/@sha256:.*$/, `@sha256:${"02".repeat(32)}`) },
  };
  const text = Buffer.from(encodeCanonical(record)).toString("utf8");
  parseRecord("Release", Buffer.from(text));
  return { record, text, sha256: sha256Hex(Buffer.from(text)) };
})();
const BOTH_FROZEN: FrozenJudge = { releases: [RELEASE_TEXT, SECOND.text], rateSheet: RATE_SHEET };
const BOTH_ALLOWED = { RBW_JUDGE_RELEASES: `${RELEASE_ID}=${RELEASE_SHA}, ${RACE_RELEASE_ID}=${SECOND.sha256}` };

function statusOf(w: World, requestId: string, releaseId: string, cookie: string) {
  return getStatus(new Request(`https://example.invalid/api/judge/status?request_id=${requestId}&release_id=${releaseId}`, { headers: { cookie } }), w.server);
}

describe("the judge allowlist", () => {
  it("parses <release_id>=<sha256> pairs and refuses an empty, oversized, duplicated or malformed list", () => {
    expect(parseReleaseList(`${RELEASE_ID}=${RELEASE_SHA}\n${RACE_RELEASE_ID}=${SECOND.sha256}`)).toEqual({
      ok: true,
      releases: [
        { releaseId: RELEASE_ID, sha256: RELEASE_SHA },
        { releaseId: RACE_RELEASE_ID, sha256: SECOND.sha256 },
      ],
    });
    const many = (count: number) => Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}=${"a".repeat(64)}`).join(",");
    expect(parseReleaseList(many(MAX_ALLOWED_RELEASES)).ok).toBe(true);
    expect(parseReleaseList(many(MAX_ALLOWED_RELEASES + 1))).toEqual({ ok: false, error: "RBW_JUDGE_RELEASES names 100 releases; at most 99 are supported" });
    expect(parseReleaseList(" , ")).toEqual({ ok: false, error: "RBW_JUDGE_RELEASES names no release" });
    expect(parseReleaseList(`${RELEASE_ID}=${RELEASE_SHA},${RELEASE_ID}=${SECOND.sha256}`).ok).toBe(false);
    for (const bad of [RELEASE_ID, `${RELEASE_ID}=${RELEASE_SHA}=x`, `${RELEASE_ID}=${RELEASE_SHA.toUpperCase()}`, `${RELEASE_ID}=${"0".repeat(63)}`]) expect(parseReleaseList(bad).ok).toBe(false);
  });

  it("takes RBW_JUDGE_RELEASES over the single pair, falls back to the pair without it, and accepts nothing from a refused list", () => {
    const pair = { RBW_JUDGE_PASSCODE: PASSCODE, RBW_JUDGE_RELEASE_ID: RELEASE_ID, RBW_JUDGE_RELEASE_SHA256: RELEASE_SHA };
    expect(allowedReleases(loadJudgeConfig(pair))).toEqual([{ releaseId: RELEASE_ID, sha256: RELEASE_SHA }]);
    expect(allowedReleases(loadJudgeConfig({ ...pair, RBW_JUDGE_RELEASES: "" }))).toEqual([{ releaseId: RELEASE_ID, sha256: RELEASE_SHA }]);
    const listed = loadJudgeConfig({ ...pair, RBW_JUDGE_RELEASES: `${RACE_RELEASE_ID}=${SECOND.sha256}` });
    expect(allowedReleases(listed)).toEqual([{ releaseId: RACE_RELEASE_ID, sha256: SECOND.sha256 }]);
    expect(judgeEnabled(listed, RACE_RELEASE_ID)).toBe(true);
    expect(judgeEnabled(listed, RELEASE_ID)).toBe(false);
    expect(allowedReleases(loadJudgeConfig({ ...pair, RBW_JUDGE_RELEASES: "," }))).toEqual([]);
  });
});

describe("the judge POST with several frozen releases", () => {
  it("replays the release the judge picked, with that release's frozen judge job and controller image", async () => {
    const w = await world(BOTH_ALLOWED, BOTH_FROZEN);
    const cookie = await login(w);
    const response = await postJudge(post("/api/judge", { request_id: REQUEST, release_id: RACE_RELEASE_ID }, cookie), w.server);
    expect(response.status).toBe(202);
    expect(w.sdk.creates[0]?.image).toBe(SECOND.record.images.controller_image);
    expect(JSON.stringify(w.sdk.commands[0])).toContain(SECOND.record.judge_job.index_key);
    const operation = judge.judgeOperation(REQUEST, judge.judgeRelease(SECOND.record), judge.controllerEnvelope(judge.parseRateSheet(RATE_SHEET)) as never);
    expect(w.reserves[0]?.operation_id).toBe(operation.operation_id);
    expect(await json(await statusOf(w, REQUEST, RACE_RELEASE_ID, cookie))).toMatchObject({ state: "starting", release_id: RACE_RELEASE_ID });
  });

  it("is unavailable for a release that is frozen but not allowlisted, allowlisted but not frozen, or allowlisted with another hash, and writes nothing", async () => {
    const cases: [Record<string, string>, FrozenJudge, string][] = [
      [{ RBW_JUDGE_RELEASES: `${RELEASE_ID}=${RELEASE_SHA}` }, BOTH_FROZEN, RACE_RELEASE_ID],
      [BOTH_ALLOWED, { releases: [RELEASE_TEXT], rateSheet: RATE_SHEET }, RACE_RELEASE_ID],
      [{ RBW_JUDGE_RELEASES: `${RELEASE_ID}=${RELEASE_SHA},${RACE_RELEASE_ID}=${"0".repeat(64)}` }, BOTH_FROZEN, RACE_RELEASE_ID],
      [BOTH_ALLOWED, BOTH_FROZEN, "00000000-0000-4000-8000-000000000699"],
    ];
    for (const [env, frozen, releaseId] of cases) {
      const w = await world(env, frozen);
      const body = await json(await postJudge(post("/api/judge", { request_id: REQUEST, release_id: releaseId }, await login(w)), w.server));
      expect(body).toMatchObject({ state: "unavailable", reason: "release" });
      expect(w.touched.filter((item) => item !== "judge")).toEqual([]);
    }
  });

  it("needs the judge's pick when more than one release is accepted, and takes { request_id } alone when exactly one is", async () => {
    const two = await world(BOTH_ALLOWED, BOTH_FROZEN);
    expect(await json(await postJudge(post("/api/judge", { request_id: REQUEST }, await login(two)), two.server))).toMatchObject({ state: "unavailable", reason: "release" });
    const one = await world({ RBW_JUDGE_RELEASES: `${RACE_RELEASE_ID}=${SECOND.sha256}` }, BOTH_FROZEN);
    expect((await postJudge(post("/api/judge", { request_id: REQUEST }, await login(one)), one.server)).status).toBe(202);
    expect(one.sdk.creates[0]?.image).toBe(SECOND.record.images.controller_image);
  });

  it("refuses a malformed release_id or other fields as a bad request before any call", async () => {
    const w = await world(BOTH_ALLOWED, BOTH_FROZEN);
    const cookie = await login(w);
    for (const body of [{ request_id: REQUEST, release_id: "synthetic" }, { request_id: REQUEST, release_id: RELEASE_ID, extra: 1 }, { release_id: RELEASE_ID }]) {
      expect((await postJudge(post("/api/judge", body, cookie), w.server)).status).toBe(400);
    }
    expect((await statusOf(w, REQUEST, "synthetic", cookie)).status).toBe(400);
    expect(w.touched).toEqual([]);
  });

  it("keeps one shared slot: a replay of one release makes a start of the other busy", async () => {
    const w = await world(BOTH_ALLOWED, BOTH_FROZEN);
    const cookie = await login(w);
    expect((await postJudge(post("/api/judge", { request_id: REQUEST, release_id: RELEASE_ID }, cookie), w.server)).status).toBe(202);
    expect(await json(await postJudge(post("/api/judge", { request_id: OTHER, release_id: RACE_RELEASE_ID }, cookie), w.server))).toMatchObject({ state: "unavailable", reason: "busy" });
    expect(w.sdk.creates).toHaveLength(1);
  });

  it("keeps one shared hold: two not_reproduced replays hold every release", async () => {
    const w = await world(BOTH_ALLOWED, BOTH_FROZEN);
    for (const [index, created] of ["2026-12-01T10:00:00Z", "2026-12-02T10:00:00Z"].entries()) {
      const root = `00000000-0000-4000-8000-00000000f00${String(index)}`;
      await put(w, `judge/${root}/progress.json`, judge.progressBytes({ ...judge.newProgress(root, Date.parse(created), Date.parse(created) + 1_980_000), state: "not_reproduced", known_condition: false }));
    }
    const cookie = await login(w);
    for (const releaseId of [RELEASE_ID, RACE_RELEASE_ID]) {
      expect(await json(await postJudge(post("/api/judge", { request_id: REQUEST, release_id: releaseId }, cookie), w.server))).toMatchObject({ state: "unavailable", reason: "held" });
    }
  });

  it("takes a release_id with the single pair when the build froze several releases, and only the configured one", async () => {
    const w = await world({}, BOTH_FROZEN);
    const cookie = await login(w);
    expect(await json(await postJudge(post("/api/judge", { request_id: REQUEST, release_id: RACE_RELEASE_ID }, cookie), w.server))).toMatchObject({ state: "unavailable", reason: "release" });
    expect((await postJudge(post("/api/judge", { request_id: REQUEST, release_id: RELEASE_ID }, cookie), w.server)).status).toBe(202);
  });
});
