// The builder-facing OTF routes, driven through their handlers with signed requests, a fake clock
// and the in-memory store (one end-to-end pass runs on PGlite with the migration). Every value is
// synthetic: invented models, lanes, builder ids, spec text and bundle bytes.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOtfConfig, otfConfigured, type OtfConfig } from "../../src/config.ts";
import { builderHeaders } from "../../src/otf/builder-auth.ts";
import { STOP_GRACE_MS, getBuilderArtifact, handleOtfBuilder, postClaim, postEvents, postResult, postStopIntent, postValidationResult, type OtfBuilderDeps } from "../../src/otf/builder-handlers.ts";
import {
  AGENT_LABEL,
  CERTIFICATE_FORMAT,
  CERTIFICATE_RUNNER,
  COPY_LIMITS,
  EXPECTED_CELLS,
  OTF_DEFAULTS,
  TOKEN_FACTORY_PROVIDER,
  type BuilderEventIn,
  type OtfCertificate,
  type OtfNewJob,
  type OtfSpecCard,
  type OtfStore,
  type ResultPost,
} from "../../src/otf/contract.ts";
import { isOtf } from "../../src/otf/schemas.ts";
import { createMemoryOtfStore, createPgOtfStore, type MemoryOtfStore, type OtfSql, type OtfSqlPool } from "../../src/otf/store.ts";

const SECRET = "synthetic-builder-secret-0123456789abcdef";
const T0 = Date.parse("2026-10-29T12:00:00.000Z");
const BUILDER = "builder-a";
const LANES = [
  { model: "synthetic/model-a", model_label: "Synthetic A", price_in_usd_per_m: "0.10", price_out_usd_per_m: "0.40" },
  { model: "synthetic/model-b", model_label: "Synthetic B", price_in_usd_per_m: "0.05", price_out_usd_per_m: "0.20" },
  { model: "synthetic/model-c", model_label: "Synthetic C", price_in_usd_per_m: "0.07", price_out_usd_per_m: "0.30" },
];
const SPEC: OtfSpecCard = {
  title: "Synthetic lost update",
  where: "A synthetic save path",
  change: "A synthetic change",
  why_tests_miss: "Synthetic reason",
  checks_to_add: ["A synthetic check"],
  fix: "A synthetic fix",
};
const SPEC_SHA = "b".repeat(64);

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function testConfig(env: Record<string, string> = {}): OtfConfig {
  return loadOtfConfig({ RBW_OTF_BUILDER_SECRET: SECRET, DATABASE_URL: "postgres://synthetic.invalid/otf", RBW_OTF_LANES: JSON.stringify(LANES), ...env });
}

interface World {
  store: OtfStore;
  deps: OtfBuilderDeps;
  advance(ms: number): void;
  /** Runs once on each sleep of a held claim, after the clock moved. */
  onSleep: (() => Promise<void>) | null;
  logs: string[];
}

function world(store: OtfStore = createMemoryOtfStore({ now: () => new Date(T0) }), config: OtfConfig = testConfig()): World {
  let clock = T0;
  const logs: string[] = [];
  const self: World = {
    store,
    logs,
    onSleep: null,
    advance(ms) {
      clock += ms;
    },
    deps: {
      store,
      config,
      now: () => new Date(clock),
      async sleep(ms) {
        clock += ms;
        if (self.onSleep !== null) await self.onSleep();
      },
      log: (line) => logs.push(line),
    },
  };
  return self;
}

function newJob(n: number, state: OtfNewJob["state"] = "queued", createdAt = iso(n * 1000)): OtfNewJob {
  return {
    job_id: uuid(n),
    client_key: uuid(1000 + n),
    create_sha256: "a".repeat(64),
    created_at: createdAt,
    criterion_id: "concurrency.lost-acknowledged-change",
    sentence: "A synthetic sentence",
    spec: SPEC,
    spec_sha256: SPEC_SHA,
    state,
    catalog_request_id: null,
  };
}

/** A request to `path` signed at the world's clock, with `body` as JSON (or no body for GET). */
function signed(w: World, path: string, body: unknown, options: { method?: string; builder?: string; secret?: string } = {}): Request {
  const method = options.method ?? "POST";
  const text = method === "GET" ? "" : JSON.stringify(body);
  const headers = builderHeaders(options.secret ?? SECRET, options.builder ?? BUILDER, w.deps.now().getTime(), method, path, text);
  return new Request(`https://otf.test${path}`, { method, headers: { ...headers, "content-type": "application/json" }, ...(method === "GET" ? {} : { body: text }) });
}

function claimBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { builder_id: BUILDER, builder_revision: "rev-1", boot_id: "boot-1", booted_at: iso(-60_000), images_ok: true, free: { build: 1, validate: 1 }, ...overrides };
}

function claim(w: World, overrides: Record<string, unknown> = {}, builder = BUILDER): Promise<Response> {
  return postClaim(signed(w, "/api/factory/otf/builder/claim", claimBody({ builder_id: builder, ...overrides }), { builder }), w.deps);
}

function events(w: World, job: string, list: BuilderEventIn[], builder = BUILDER): Promise<Response> {
  return postEvents(signed(w, `/api/factory/otf/builder/jobs/${job}/events`, { builder_id: builder, events: list }, { builder }), w.deps, { job_id: job });
}

function result(w: World, job: string, body: ResultPost): Promise<Response> {
  return postResult(signed(w, `/api/factory/otf/builder/jobs/${job}/result`, body, { builder: body.builder_id }), w.deps, { job_id: job });
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

/** Creates job n and claims it for BUILDER; returns its id. */
async function claimedJob(w: World, n = 1): Promise<string> {
  await w.store.createJob(newJob(n));
  const response = await claim(w);
  expect(response.status).toBe(200);
  return uuid(n);
}

function stage(builder_seq: number): BuilderEventIn {
  return { type: "lane_stage", lane_id: "lane-1", data: { stage: "writing", iteration: 1 }, builder_seq, at: iso(builder_seq) };
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A synthetic delivery for job: gzip bundles, a certificate bound to them, and the result post. */
function delivery(job: string, overrides: { certificate?: Partial<OtfCertificate>; certificateBytes?: Uint8Array } = {}): { post: ResultPost; agent: Uint8Array; certificate: OtfCertificate } {
  const agent = new Uint8Array(gzipSync("synthetic agent bundle"));
  const grader = new Uint8Array(gzipSync("synthetic grader bundle"));
  const certificate: OtfCertificate = {
    format: CERTIFICATE_FORMAT,
    job_id: job,
    host_id: "task-report",
    app_base_commit: "c".repeat(40),
    criterion: { criterion_id: "concurrency.lost-acknowledged-change", version: "1", failure_code: "synthetic-failure" },
    spec_sha256: SPEC_SHA,
    designer: { model: "synthetic/designer", route: "bug-spec" },
    implementer: { lane_id: "lane-2", agent: AGENT_LABEL, provider: TOKEN_FACTORY_PROVIDER, model: "synthetic/model-b", rounds_used: 2 },
    qualification: { cells: EXPECTED_CELLS, confirmation_cells: EXPECTED_CELLS, result: "qualified" },
    harness: { tier: "B", kit_image_id: "sha256:synthetic", copy_limits: COPY_LIMITS, instances: { clean: 1, buggy: 3, fixed: 3 }, runner: CERTIFICATE_RUNNER, harness_sha256: "d".repeat(64) },
    bundles: { agent_sha256: sha(agent), grader_sha256: sha(grader) },
    spend: { model_microusd: 900_000, tokens_in: 10, tokens_out: 20, lanes: 3 },
    timings: { started_at: iso(0), qualified_at: iso(600_000), wall_ms: 600_000 },
    issued_at: iso(610_000),
    builder_revision: "rev-1",
    received: null,
    ...overrides.certificate,
  };
  const certificateBytes = overrides.certificateBytes ?? new TextEncoder().encode(JSON.stringify(certificate));
  const job8 = job.slice(0, 8);
  const part = (name: "agent" | "grader" | "certificate", filename: string, bytes: Uint8Array) => ({ part: name, filename, sha256: sha(bytes), size: bytes.byteLength, base64: Buffer.from(bytes).toString("base64") });
  return {
    agent,
    certificate,
    post: {
      builder_id: BUILDER,
      outcome: "delivered",
      reason: null,
      certificate,
      parts: [part("agent", `rbw-otf-agent-${job8}.tar.gz`, agent), part("grader", `rbw-otf-grader-${job8}.tar.gz`, grader), part("certificate", `rbw-otf-certificate-${job8}.json`, certificateBytes)],
    },
  };
}

async function pgliteStore(): Promise<OtfStore> {
  const db = await PGlite.create();
  await db.exec(readFileSync(new URL("../../otf-migrations/0001_otf.sql", import.meta.url), "utf8"));
  const inTx = new AsyncLocalStorage<OtfSql>();
  const direct: OtfSql = { query: async (text, params) => ({ rows: (await db.query<Record<string, unknown>>(text, params)).rows }) };
  const pool: OtfSqlPool = {
    query: (text, params) => (inTx.getStore() ?? direct).query(text, params),
    transaction(fn) {
      const open = inTx.getStore();
      if (open !== undefined) return fn(open);
      return db.transaction((tx) => {
        const sql: OtfSql = { query: async (text, params) => ({ rows: (await tx.query<Record<string, unknown>>(text, params)).rows }) };
        return inTx.run(sql, () => fn(sql));
      });
    },
  };
  return createPgOtfStore(pool);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("builder claim", () => {
  it("moves waiting jobs to queued with builder_ready, then hands out the oldest build job with its lanes and limits", async () => {
    const w = world();
    await w.store.withPowerLock(() => Promise.resolve({ patch: { state: "starting", last_start_at: iso(5_000) }, log: [], result: null }));
    await w.store.createJob(newJob(1, "starting_builder", iso(1_000)));
    await w.store.createJob(newJob(2, "starting_builder", iso(9_000)));
    w.advance(60_000);
    const response = await claim(w);
    expect(response.status).toBe(200);
    const reply: unknown = await response.json();
    expect(isOtf("ClaimReply", reply)).toBe(true);
    expect(reply).toEqual({
      job: {
        kind: "build",
        job_id: uuid(1),
        host_id: "task-report",
        criterion_id: "concurrency.lost-acknowledged-change",
        spec: SPEC,
        spec_sha256: SPEC_SHA,
        sentence: "A synthetic sentence",
        lanes: LANES.map((lane, index) => ({ lane_id: `lane-${String(index + 1)}`, ...lane })),
        limits: { max_rounds: 3, max_usd_lane: "3.00", max_usd_job: "8.00", goose_max_tokens: 32768, deadline_at: iso(60_000 + 45 * 60_000), confirm_rounds: 1 },
      },
    });
    // cold_start_ms runs from the later of the last start request and the job's creation.
    const first = await w.store.listEvents(uuid(1), 0);
    expect(first.map((event) => event.type)).toEqual(["builder_ready", "job_claimed"]);
    expect(first[0]).toMatchObject({ data: { cold_start_ms: 55_000 } });
    expect(first[1]).toMatchObject({ data: { builder_revision: "rev-1" } });
    expect(await w.store.listEvents(uuid(2), 0)).toMatchObject([{ type: "builder_ready", data: { cold_start_ms: 51_000 } }]);
    expect(await w.store.getJob(uuid(2))).toMatchObject({ state: "queued" });
    expect(await w.store.getPower()).toMatchObject({ state: "running", since: iso(60_000) });
    expect(await w.store.lastBuilderSeen()).toMatchObject({ builder_id: BUILDER, boot_id: "boot-1", last_seen_at: iso(60_000) });
  });

  it("promotes nothing and hands out nothing after a pinned-image mismatch, answering 204 after the hold", async () => {
    const w = world();
    await w.store.createJob(newJob(1, "starting_builder"));
    await w.store.createJob(newJob(2));
    const response = await claim(w, { images_ok: false });
    expect(response.status).toBe(204);
    expect(w.deps.now().getTime() - T0).toBe(20_000);
    expect(await w.store.getJob(uuid(1))).toMatchObject({ state: "starting_builder" });
    expect(await w.store.getJob(uuid(2))).toMatchObject({ state: "queued" });
    expect((await w.store.getPower()).state).toBe("unknown");
  });

  it("holds the long poll and hands out a job that is queued while it waits", async () => {
    const w = world();
    let sleeps = 0;
    w.onSleep = async () => {
      sleeps += 1;
      if (sleeps === 3) await w.store.createJob(newJob(1));
    };
    const response = await claim(w);
    expect(response.status).toBe(200);
    expect(sleeps).toBe(3);
    expect(w.deps.now().getTime() - T0).toBe(6_000);
    expect(await w.store.getJob(uuid(1))).toMatchObject({ state: "building", claimed_by: BUILDER });
  });

  it("hands out a validation first, no build when the builder has no free build slot, and at most max_active builds", async () => {
    const w = world(undefined, testConfig({ RBW_OTF_MAX_ACTIVE: "1" }));
    for (const n of [1, 2, 3]) await w.store.createJob(newJob(n));
    expect((await claim(w)).status).toBe(200);
    expect((await claim(w)).status).toBe(204);
    expect((await w.store.listJobs(["building"])).map((job) => job.job_id)).toEqual([uuid(1)]);
    await result(w, uuid(1), delivery(uuid(1)).post);
    await w.store.createValidation(uuid(1), uuid(500), iso(2));
    expect(await claim(w).then((response) => response.json())).toMatchObject({ job: { kind: "validate", validation_id: uuid(500) } });
    expect(await claim(w, { free: { build: 0, validate: 1 } }).then((response) => response.status)).toBe(204);
    expect((await w.store.listJobs(["queued"])).length).toBe(2);
  });

  it("ends a validation as error, and hands out nothing for it, when its job holds no bundles", async () => {
    const w = world();
    await w.store.createJob(newJob(1));
    await w.store.updateJob(uuid(1), ["queued"], { state: "finished", outcome: "delivered", reason: null, finished_at: iso(1) });
    await w.store.createValidation(uuid(1), uuid(500), iso(2));
    expect((await claim(w, { free: { build: 0, validate: 1 } })).status).toBe(204);
    expect(await w.store.getValidation(uuid(500))).toMatchObject({ state: "error", finished_at: iso(0) });
    expect(w.logs).toEqual(["otf: a validation's job has no stored agent and grader bundles; the validation ends as error"]);
  });

  it("refuses an unsigned or mis-signed claim, a body naming another builder, a malformed body, and every claim without a secret", async () => {
    const w = world();
    const path = "/api/factory/otf/builder/claim";
    expect(await errorCode(await postClaim(new Request(`https://otf.test${path}`, { method: "POST", body: JSON.stringify(claimBody()) }), w.deps))).toBe("unauthorized");
    expect(await errorCode(await postClaim(signed(w, path, claimBody(), { secret: `${SECRET}-other` }), w.deps))).toBe("unauthorized");
    expect(await errorCode(await postClaim(signed(w, path, claimBody({ builder_id: "builder-b" })), w.deps))).toBe("unauthorized");
    const bad = await postClaim(signed(w, path, claimBody({ free: { build: -1, validate: 0 } })), w.deps);
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("invalid_request");
    const closed = world(undefined, { ...testConfig(), builderSecret: null });
    const refused = await postClaim(signed(closed, path, claimBody()), closed.deps);
    expect(refused.status).toBe(503);
    expect(await errorCode(refused)).toBe("unavailable");
  });
});

describe("builder events", () => {
  it("stores events and answers accepted_through with no stop while nothing asks for one", async () => {
    const w = world();
    const job = await claimedJob(w);
    const response = await events(w, job, [stage(1), stage(2)]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted_through: 2, control: { stop: false, reason: null } });
    expect(await events(w, job, []).then((r) => r.json())).toEqual({ accepted_through: 2, control: { stop: false, reason: null } });
  });

  it("answers stop for a customer stop, the deadline, the job's spend cap and the total spend cap", async () => {
    const w = world();
    const job = await claimedJob(w);
    await w.store.updateJob(job, ["building"], { stop_requested_at: iso(1), stop_reason: "customer" });
    expect(await events(w, job, []).then((r) => r.json())).toMatchObject({ control: { stop: true, reason: "customer" } });

    const late = world();
    const lateJob = await claimedJob(late);
    late.advance(OTF_DEFAULTS.deadline_ms);
    expect(await events(late, lateJob, []).then((r) => r.json())).toMatchObject({ control: { stop: true, reason: "deadline" } });

    const spent = world();
    const spentJob = await claimedJob(spent);
    const meter: BuilderEventIn = { type: "lane_meter", lane_id: "lane-1", data: { tokens_in: 1, tokens_out: 1, requests: 1, cost_microusd: 8_000_000 }, builder_seq: 1, at: iso(1) };
    expect(await events(spent, spentJob, [meter]).then((r) => r.json())).toMatchObject({ control: { stop: true, reason: "spend_cap" } });

    const capped = world(undefined, testConfig({ RBW_OTF_SPEND_CAP_MICROUSD: "1000" }));
    await capped.store.createJob(newJob(9));
    await capped.store.updateJob(uuid(9), ["queued"], { model_microusd: 1000 });
    await capped.store.updateJob(uuid(9), ["queued"], { state: "finished", outcome: "not_qualified", reason: null, finished_at: iso(0) });
    const cappedJob = await claimedJob(capped, 2);
    expect(await events(capped, cappedJob, []).then((r) => r.json())).toMatchObject({ control: { stop: true, reason: "spend_cap" } });
  });

  it("refuses a changed repeat, a gap, a finished job, another builder, an unknown job and a production event type", async () => {
    const w = world();
    const job = await claimedJob(w);
    await events(w, job, [stage(1)]);
    const changed = await events(w, job, [{ ...stage(1), at: iso(99) }]);
    expect([changed.status, await errorCode(changed)]).toEqual([409, "event_conflict"]);
    expect(await errorCode(await events(w, job, [stage(3)]))).toBe("event_conflict");
    expect(await errorCode(await events(w, job, [], "builder-b"))).toBe("unauthorized");
    expect(await errorCode(await events(w, uuid(77), []))).toBe("not_found");
    const production = { type: "job_finished", lane_id: null, data: { outcome: "delivered", reason: null }, builder_seq: 2, at: iso(2) } as unknown as BuilderEventIn;
    expect(await errorCode(await events(w, job, [production]))).toBe("invalid_request");
    await w.store.updateJob(job, ["building"], { state: "finished", outcome: "builder_lost", reason: null, finished_at: iso(5) });
    const finished = await events(w, job, [stage(2)]);
    expect([finished.status, await errorCode(finished)]).toEqual([409, "job_finished"]);
  });

  it("records the winner lane and its model when winner_selected arrives", async () => {
    const w = world();
    const job = await claimedJob(w);
    const started: BuilderEventIn = { type: "lane_started", lane_id: "lane-2", data: { model: "synthetic/model-b", model_label: "Synthetic B", agent: AGENT_LABEL }, builder_seq: 1, at: iso(1) };
    const winner: BuilderEventIn = { type: "winner_selected", lane_id: null, data: { lane_id: "lane-2", candidate_id: "candidate-1", qualified_at_iteration: 2 }, builder_seq: 2, at: iso(2) };
    expect((await events(w, job, [started, winner])).status).toBe(200);
    expect(await w.store.getJob(job)).toMatchObject({ winner_lane: "lane-2", winner_model: "synthetic/model-b" });
  });
});

describe("builder result", () => {
  it("stores a checked delivery with the certificate countersigned, finishes the job, and replays the same post", async () => {
    const w = world();
    const job = await claimedJob(w);
    w.advance(600_000);
    const { post, agent } = delivery(job);
    const response = await result(w, job, post);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ job_id: job, state: "finished", outcome: "delivered" });
    const stored = await w.store.getJob(job);
    expect(stored).toMatchObject({ state: "finished", outcome: "delivered", winner_lane: "lane-2", winner_model: "synthetic/model-b", model_microusd: 900_000, finished_at: iso(600_000) });
    expect(stored?.certificate?.received).toEqual({ at: iso(600_000), sha256_verified: true });
    expect((await w.store.listArtifacts(job)).map((item) => [item.part, item.media_type])).toEqual([
      ["agent", "application/gzip"],
      ["certificate", "application/json"],
      ["grader", "application/gzip"],
    ]);
    expect(Array.from((await w.store.getArtifact(job, "agent"))?.bytes ?? [])).toEqual(Array.from(agent));
    expect((await w.store.listEvents(job, 0)).at(-1)).toMatchObject({ type: "job_finished", data: { outcome: "delivered", reason: null } });
    expect((await w.store.getPower()).last_job_finished_at).toBe(iso(600_000));
    expect((await result(w, job, post)).status).toBe(200);
  });

  it("refuses a delivery that fails any check, and stores nothing", async () => {
    const w = world();
    const job = await claimedJob(w);
    const good = delivery(job);
    const withPart = (index: number, change: Partial<NonNullable<ResultPost["parts"]>[number]>): ResultPost => ({ ...good.post, parts: (good.post.parts ?? []).map((part, at) => (at === index ? { ...part, ...change } : part)) });
    const notGzip = new TextEncoder().encode("plain text, not gzip");
    const cases: [string, ResultPost][] = [
      ["not gzip", withPart(0, { base64: Buffer.from(notGzip).toString("base64"), sha256: sha(notGzip), size: notGzip.byteLength })],
      ["sha256", withPart(1, { sha256: "e".repeat(64) })],
      ["size", withPart(1, { size: 5 })],
      ["base64", withPart(0, { base64: `${good.post.parts?.[0]?.base64.slice(0, -4) ?? ""}AA==` })],
      ["bundle hashes", { ...good.post, certificate: { ...good.certificate, bundles: { agent_sha256: "e".repeat(64), grader_sha256: good.certificate.bundles.grader_sha256 } } }],
      ["spec", delivery(job, { certificate: { spec_sha256: "f".repeat(64) } }).post],
      ["certificate part", delivery(job, { certificateBytes: new TextEncoder().encode(JSON.stringify({ ...good.certificate, issued_at: iso(1) })) }).post],
      ["received", delivery(job, { certificate: { received: { at: iso(1), sha256_verified: true } } }).post],
      ["other job", delivery(job, { certificate: { job_id: uuid(5) } }).post],
    ];
    for (const [name, post] of cases) {
      const response = await result(w, job, post);
      expect([name, response.status, await errorCode(response)]).toEqual([name, 400, "invalid_request"]);
    }
    expect(await w.store.listArtifacts(job)).toEqual([]);
    expect(await w.store.getJob(job)).toMatchObject({ state: "building" });
  });

  it("answers job_finished to a delivery after a status read finished the job, and stores nothing", async () => {
    const w = world();
    const job = await claimedJob(w);
    await w.store.updateJob(job, ["building"], { state: "finished", outcome: "builder_lost", reason: null, finished_at: iso(1) });
    const response = await result(w, job, delivery(job).post);
    expect([response.status, await errorCode(response)]).toEqual([409, "job_finished"]);
    expect(await w.store.listArtifacts(job)).toEqual([]);
    expect(await w.store.getJob(job)).toMatchObject({ outcome: "builder_lost" });
  });

  it("finishes a job with another outcome once, accepts a retry of it, and refuses other builders, other outcomes and production's outcomes", async () => {
    const w = world();
    const job = await claimedJob(w);
    const post: ResultPost = { builder_id: BUILDER, outcome: "not_qualified", reason: "no lane qualified in 3 rounds" };
    expect(await errorCode(await result(w, job, { ...post, builder_id: "builder-b" }))).toBe("unauthorized");
    expect(await errorCode(await result(w, job, { ...post, outcome: "builder_lost" }))).toBe("invalid_request");
    expect(await result(w, job, post).then((r) => r.json())).toEqual({ job_id: job, state: "finished", outcome: "not_qualified" });
    expect(await w.store.getJob(job)).toMatchObject({ state: "finished", outcome: "not_qualified", reason: "no lane qualified in 3 rounds" });
    expect((await w.store.listEvents(job, 0)).filter((event) => event.type === "job_finished")).toHaveLength(1);
    expect((await result(w, job, post)).status).toBe(200);
    expect(await errorCode(await result(w, job, { ...post, outcome: "error" }))).toBe("job_finished");
    expect(await errorCode(await result(w, uuid(77), post))).toBe("not_found");
  });
});

describe("builder artifacts and validations", () => {
  it("serves a delivered bundle's bytes to the builder, and refuses the certificate part, an undelivered job and an unsigned fetch", async () => {
    const w = world();
    const job = await claimedJob(w);
    const { post, agent } = delivery(job);
    await result(w, job, post);
    const path = (part: string): string => `/api/factory/otf/builder/jobs/${job}/artifacts/${part}`;
    const fetched = await getBuilderArtifact(signed(w, path("agent"), null, { method: "GET" }), w.deps, { job_id: job, part: "agent" });
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("application/gzip");
    expect(fetched.headers.get("x-rbw-otf-sha256")).toBe(sha(agent));
    expect(Array.from(new Uint8Array(await fetched.arrayBuffer()))).toEqual(Array.from(agent));
    expect(await errorCode(await getBuilderArtifact(signed(w, path("certificate"), null, { method: "GET" }), w.deps, { job_id: job, part: "certificate" }))).toBe("not_found");
    expect(await errorCode(await getBuilderArtifact(new Request(`https://otf.test${path("agent")}`), w.deps, { job_id: job, part: "agent" }))).toBe("unauthorized");
    await w.store.createJob(newJob(2));
    const other = `/api/factory/otf/builder/jobs/${uuid(2)}/artifacts/agent`;
    expect(await errorCode(await getBuilderArtifact(signed(w, other, null, { method: "GET" }), w.deps, { job_id: uuid(2), part: "agent" }))).toBe("not_delivered");
  });

  it("hands a validation out with both bundles' hashes and takes its result once", async () => {
    const w = world();
    const job = await claimedJob(w);
    await result(w, job, delivery(job).post);
    await w.store.createValidation(job, uuid(500), iso(10));
    const claimed = (await claim(w, { free: { build: 0, validate: 1 } }).then((r) => r.json())) as { job: { kind: string; artifacts: { part: string }[] } };
    expect(claimed.job.kind).toBe("validate");
    expect(claimed.job.artifacts.map((item) => item.part).sort()).toEqual(["agent", "grader"]);
    const path = `/api/factory/otf/builder/validations/${uuid(500)}/result`;
    const post = (body: Record<string, unknown>, builder = BUILDER): Promise<Response> =>
      postValidationResult(signed(w, path, { builder_id: builder, finished_at: iso(20), ...body }, { builder }), w.deps, { validation_id: uuid(500) });
    const failedCells = { ...EXPECTED_CELLS, buggy: { original_suite: "pass", added_checks: "pass" } };
    expect(await errorCode(await post({ state: "passed", cells: failedCells }))).toBe("invalid_request");
    expect(await errorCode(await post({ state: "failed", cells: EXPECTED_CELLS }))).toBe("invalid_request");
    expect(await errorCode(await post({ state: "passed", cells: EXPECTED_CELLS }, "builder-b"))).toBe("unauthorized");
    const passed = await post({ state: "passed", cells: EXPECTED_CELLS });
    expect(passed.status).toBe(200);
    expect(await passed.json()).toEqual({ validation_id: uuid(500), state: "passed", cells: EXPECTED_CELLS, started_at: iso(10), finished_at: iso(20), where: "RBW builder (Nebius VM)" });
    expect((await post({ state: "passed", cells: EXPECTED_CELLS })).status).toBe(200);
    expect(await errorCode(await post({ state: "error", cells: null }))).toBe("job_finished");
  });
});

describe("builder stop intent", () => {
  const path = "/api/factory/otf/builder/stop-intent";
  const intent = (w: World, reason: string, boot = "boot-1"): Promise<Response> =>
    postStopIntent(signed(w, path, { builder_id: BUILDER, boot_id: boot, reason, idle_since: reason === "idle" ? iso(0) : null }), w.deps);

  it("refuses an idle stop while a job waits or a validation is open, and allows it once nothing does", async () => {
    const w = world();
    await w.store.createJob(newJob(1, "starting_builder"));
    expect(await intent(w, "idle").then((r) => r.json())).toEqual({ allow: false, reason: "jobs_waiting" });
    await w.store.updateJob(uuid(1), ["starting_builder"], { state: "finished", outcome: "delivered", reason: null, finished_at: iso(1) });
    await w.store.createValidation(uuid(1), uuid(500), iso(2));
    expect(await intent(w, "idle").then((r) => r.json())).toEqual({ allow: false, reason: "jobs_waiting" });
    await w.store.updateValidation(uuid(500), ["queued"], { state: "error", finished_at: iso(3) });
    expect(await intent(w, "idle").then((r) => r.json())).toEqual({ allow: true, reason: "ok" });
    expect(await w.store.getPower()).toMatchObject({ state: "stopping", since: iso(0) });
    expect((w.store as MemoryOtfStore).powerLog()).toEqual([{ at: iso(0), actor: "builder", action: "stop", before: "unknown", after: "stopping", operation_id: null }]);
  });

  it("refuses every stop during an operator hold", async () => {
    const w = world();
    (w.store as MemoryOtfStore).setHold(iso(3_600_000));
    expect(await intent(w, "idle").then((r) => r.json())).toEqual({ allow: false, reason: "operator_hold" });
    expect(await intent(w, "max_uptime").then((r) => r.json())).toEqual({ allow: false, reason: "operator_hold" });
    expect((await w.store.getPower()).state).toBe("unknown");
  });

  it("allows an uptime stop with a job building, finishes that job as builder_lost, and gives the stopping boot no more work", async () => {
    const w = world();
    const job = await claimedJob(w);
    await w.store.createJob(newJob(2));
    expect(await intent(w, "max_uptime").then((r) => r.json())).toEqual({ allow: true, reason: "ok" });
    expect(await w.store.getJob(job)).toMatchObject({ state: "finished", outcome: "builder_lost", reason: "the builder machine reached its uptime limit" });
    expect((await w.store.listEvents(job, 0)).at(-1)).toMatchObject({ type: "job_finished", data: { outcome: "builder_lost" } });
    expect((await claim(w)).status).toBe(204);
    expect(await w.store.getJob(uuid(2))).toMatchObject({ state: "queued" });
    // A new boot is a running builder again and takes the waiting job.
    expect((await claim(w, { boot_id: "boot-2" })).status).toBe(200);
    expect((await w.store.getPower()).state).toBe("running");
  });

  it("ends a held claim without work once a stop is allowed during its hold", async () => {
    const w = world();
    expect((await claim(w)).status).toBe(204);
    let sleeps = 0;
    w.onSleep = async () => {
      sleeps += 1;
      if (sleeps !== 1) return;
      expect(await intent(w, "max_uptime").then((r) => r.json())).toEqual({ allow: true, reason: "ok" });
      await w.store.createJob(newJob(1, "starting_builder"));
      await w.store.createJob(newJob(2));
    };
    expect((await claim(w)).status).toBe(204);
    expect(sleeps).toBe(1);
    expect(await w.store.getJob(uuid(1))).toMatchObject({ state: "starting_builder" });
    expect(await w.store.getJob(uuid(2))).toMatchObject({ state: "queued" });
  });

  it("gives a boot whose allowed stop never happened work again after the grace period", async () => {
    const w = world();
    expect((await claim(w)).status).toBe(204);
    expect(await intent(w, "idle").then((r) => r.json())).toEqual({ allow: true, reason: "ok" });
    await w.store.createJob(newJob(1));
    expect((await claim(w)).status).toBe(204);
    w.advance(STOP_GRACE_MS);
    expect((await claim(w)).status).toBe(200);
    expect((await w.store.getPower()).state).toBe("running");
  });

  it("takes an idle stop back when a job arrives between the work check and the lock", async () => {
    const memory = createMemoryOtfStore({ now: () => new Date(T0) });
    let lists = 0;
    const store: OtfStore = {
      ...memory,
      async listJobs(states) {
        lists += 1;
        // The job is created right after the first check looked.
        if (lists === 2) await memory.createJob(newJob(1));
        return memory.listJobs(states);
      },
    };
    const w = world(store);
    await memory.withPowerLock(() => Promise.resolve({ patch: { state: "running", since: iso(-1) }, log: [], result: null }));
    expect(await intent(w, "idle").then((r) => r.json())).toEqual({ allow: false, reason: "jobs_waiting" });
    expect(await memory.getPower()).toMatchObject({ state: "running" });
    expect(memory.powerLog().map((entry) => [entry.before, entry.after])).toEqual([
      ["running", "stopping"],
      ["stopping", "running"],
    ]);
  });
});

describe("OTF config and wiring", () => {
  it("reads the OTF variables with defaults, refuses a short secret and malformed lanes, and needs all four power variables", () => {
    const config = testConfig();
    expect(config).toMatchObject({ builderSecret: SECRET, maxActive: 2, maxQueued: 4, maxPerDay: 30, maxUsdLane: "3.00", maxUsdJob: "8.00", deadlineMs: 45 * 60_000, vmHoursPerDay: 12, nebius: null, cronSecret: null });
    expect(config.lanes).toEqual(LANES);
    expect(otfConfigured(config)).toBe(true);
    expect(loadOtfConfig({ RBW_OTF_BUILDER_SECRET: "short" }).builderSecret).toBeNull();
    const badLanes = loadOtfConfig({ RBW_OTF_LANES: JSON.stringify([{ ...LANES[0], extra: 1 }]) });
    expect([badLanes.lanes, badLanes.lanesError]).toEqual([null, "RBW_OTF_LANES lane 1 is not {model, model_label, price_in_usd_per_m, price_out_usd_per_m}"]);
    expect(loadOtfConfig({ RBW_OTF_LANES: "[]" }).lanesError).toMatch(/1 to 4/);
    expect(otfConfigured(loadOtfConfig({ RBW_OTF_BUILDER_SECRET: SECRET, DATABASE_URL: "postgres://synthetic.invalid/otf" }))).toBe(false);
    expect(testConfig({ RBW_OTF_MAX_ACTIVE: "0", RBW_OTF_MAX_QUEUED: "x", RBW_OTF_MAX_USD_JOB: "3.5", RBW_OTF_DEADLINE_MIN: "30" })).toMatchObject({ maxActive: 2, maxQueued: 4, maxUsdJob: "3.5", deadlineMs: 30 * 60_000 });
    const power = { RBW_NEBIUS_SA_ID: "synthetic-sa", RBW_NEBIUS_SA_KEY_ID: "synthetic-key", RBW_NEBIUS_SA_PRIVATE_KEY: "synthetic-private", RBW_NEBIUS_VM_ID: "synthetic-vm" };
    expect(testConfig(power).nebius).toEqual({ serviceAccountId: "synthetic-sa", keyId: "synthetic-key", privateKey: "synthetic-private", instanceId: "synthetic-vm" });
    expect(testConfig({ ...power, RBW_NEBIUS_VM_ID: "" }).nebius).toBeNull();
  });

  it("answers unavailable from every builder route while OTF is not configured or has no database driver", async () => {
    vi.stubEnv("RBW_OTF_BUILDER_SECRET", "");
    const run = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    const closed = await handleOtfBuilder(run);
    expect([closed.status, await errorCode(closed)]).toEqual([503, "unavailable"]);
    vi.stubEnv("RBW_OTF_BUILDER_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", "postgres://synthetic.invalid/otf");
    vi.stubEnv("RBW_OTF_LANES", JSON.stringify(LANES));
    const noDriver = await handleOtfBuilder(run);
    expect([noDriver.status, await errorCode(noDriver)]).toEqual([503, "unavailable"]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("builder routes on Postgres (PGlite)", () => {
  it("runs a job from a waiting create through claim, events and delivery to the bundle fetch", async () => {
    const w = world(await pgliteStore());
    await w.store.withPowerLock(() => Promise.resolve({ patch: { state: "starting", last_start_at: iso(0) }, log: [], result: null }));
    await w.store.createJob(newJob(1, "starting_builder", iso(0)));
    w.advance(90_000);
    const claimed = await claim(w);
    expect(claimed.status).toBe(200);
    const job = uuid(1);
    expect((await w.store.listEvents(job, 0)).map((event) => [event.seq, event.type])).toEqual([
      [1, "builder_ready"],
      [2, "job_claimed"],
    ]);
    expect(await events(w, job, [stage(1), stage(2)]).then((r) => r.json())).toEqual({ accepted_through: 2, control: { stop: false, reason: null } });
    expect(await events(w, job, [stage(2)]).then((r) => r.json())).toMatchObject({ accepted_through: 2 });
    w.advance(600_000);
    const { post, agent } = delivery(job);
    expect(await result(w, job, post).then((r) => r.json())).toEqual({ job_id: job, state: "finished", outcome: "delivered" });
    expect((await result(w, job, post)).status).toBe(200);
    const stored = await w.store.getJob(job);
    expect(stored).toMatchObject({ state: "finished", outcome: "delivered", winner_lane: "lane-2" });
    expect(stored?.certificate?.received).toEqual({ at: iso(690_000), sha256_verified: true });
    expect((await w.store.listEvents(job, 0)).map((event) => event.type)).toEqual(["builder_ready", "job_claimed", "lane_stage", "lane_stage", "job_finished"]);
    const path = `/api/factory/otf/builder/jobs/${job}/artifacts/agent`;
    const fetched = await getBuilderArtifact(signed(w, path, null, { method: "GET" }), w.deps, { job_id: job, part: "agent" });
    expect(Array.from(new Uint8Array(await fetched.arrayBuffer()))).toEqual(Array.from(agent));
  });
});
