// The OtfStore port, against both implementations: the in-memory store and the Postgres store on
// PGlite with otf-migrations/0001_otf.sql applied. Every value is synthetic (invented spec text,
// builder ids and bytes); nothing comes from a real job or model output.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { builderEventBytes } from "../../src/otf/canonical.ts";
import type { BuilderEventIn, OtfNewJob, OtfSpecCard, OtfStore } from "../../src/otf/contract.ts";
import { createMemoryOtfStore, createPgOtfStore, type OtfSql, type OtfSqlPool } from "../../src/otf/store.ts";

const MIGRATION = readFileSync(new URL("../../otf-migrations/0001_otf.sql", import.meta.url), "utf8");
const T0 = "2026-10-29T12:00:00.000Z";
const SPEC: OtfSpecCard = {
  title: "Synthetic lost update",
  where: "A synthetic save path",
  change: "A synthetic change",
  why_tests_miss: "Synthetic reason",
  checks_to_add: ["A synthetic check"],
  fix: "A synthetic fix",
};

function at(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function newJob(n: number, overrides: Partial<OtfNewJob> = {}): OtfNewJob {
  return {
    job_id: uuid(n),
    client_key: uuid(1000 + n),
    create_sha256: "a".repeat(64),
    created_at: at(n * 1000),
    criterion_id: "concurrency.lost-acknowledged-change",
    sentence: "A synthetic sentence",
    spec: SPEC,
    spec_sha256: "b".repeat(64),
    state: "queued",
    catalog_request_id: null,
    ...overrides,
  };
}

function stage(builder_seq: number, name: "writing" | "revising" = "writing", iteration = 1): BuilderEventIn {
  return { type: "lane_stage", lane_id: "lane-1", data: { stage: name, iteration }, builder_seq, at: at(builder_seq) };
}

function meter(builder_seq: number, lane: "lane-1" | "lane-2", cost: number): BuilderEventIn {
  return { type: "lane_meter", lane_id: lane, data: { tokens_in: 1, tokens_out: 1, requests: 1, cost_microusd: cost }, builder_seq, at: at(builder_seq) };
}

/** PGlite as an OtfSqlPool. Queries made inside a transaction's callback (directly or through other store calls) run in it, as PGlite has one connection. */
async function pgliteStore(): Promise<OtfStore> {
  const db = await PGlite.create();
  await db.exec(MIGRATION);
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

const STORES: [string, () => Promise<OtfStore>][] = [
  ["memory", () => Promise.resolve(createMemoryOtfStore({ now: () => new Date(T0) }))],
  ["postgres (PGlite)", pgliteStore],
];

const CLAIM = { maxActiveBuilds: 2, deadlineMs: 45 * 60_000, build: true, validate: true };

async function claimed(store: OtfStore, n: number, builder = "builder-a"): Promise<string> {
  await store.createJob(newJob(n));
  const claim = await store.claimNext(builder, at(100_000), { ...CLAIM, validate: false });
  if (claim?.kind !== "build") throw new Error("expected a build claim");
  return claim.job.job_id;
}

describe.each(STORES)("OtfStore (%s)", (_name, open) => {
  it("creates a job once per client_key: a replay returns it unchanged, another body conflicts", async () => {
    const store = await open();
    const created = await store.createJob(newJob(1));
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    expect(created.job).toMatchObject({ job_id: uuid(1), state: "queued", outcome: null, model_microusd: 0, deadline_at: null, spec: SPEC, created_at: at(1000) });
    const replayed = await store.createJob({ ...newJob(1), job_id: uuid(99) });
    expect(replayed).toEqual({ kind: "replayed", job: created.job });
    expect(await store.createJob({ ...newJob(1), job_id: uuid(98), create_sha256: "c".repeat(64) })).toEqual({ kind: "conflict" });
    expect(await store.getJob(uuid(99))).toBeNull();
    expect(await store.getJob("not-a-uuid")).toBeNull();
  });

  it("lists jobs oldest first by state, counts the day's jobs and sums their spend", async () => {
    const store = await open();
    await store.createJob(newJob(3, { state: "starting_builder" }));
    await store.createJob(newJob(1));
    await store.createJob(newJob(2));
    expect((await store.listJobs(["queued"])).map((job) => job.job_id)).toEqual([uuid(1), uuid(2)]);
    expect((await store.listJobs(["queued", "starting_builder"])).map((job) => job.job_id)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(await store.countJobsCreatedSince(at(2000))).toBe(2);
    await store.updateJob(uuid(1), ["queued"], { model_microusd: 1_500_000 });
    await store.updateJob(uuid(2), ["queued"], { model_microusd: 250_000 });
    expect(await store.totalModelMicrousd()).toBe(1_750_000);
  });

  it("updates a job only from the named states, so two finishes cannot both win", async () => {
    const store = await open();
    await store.createJob(newJob(1));
    const finish = { state: "finished", outcome: "builder_lost", reason: "synthetic", finished_at: at(5000) } as const;
    const [first, second] = await Promise.all([store.updateJob(uuid(1), ["queued", "building"], finish), store.updateJob(uuid(1), ["queued", "building"], { ...finish, outcome: "time_limit" })]);
    expect([first, second].filter((result) => result !== null)).toHaveLength(1);
    expect((await store.getJob(uuid(1)))?.state).toBe("finished");
    expect(await store.updateJob(uuid(1), ["queued"], { reason: "late" })).toBeNull();
    await store.createJob(newJob(2));
    await expect(store.updateJob(uuid(2), ["queued"], { state: "finished" })).rejects.toThrow();
    expect((await store.getJob(uuid(2)))?.state).toBe("queued");
  });

  it("gives production and builder events one gap-free seq stream", async () => {
    const store = await open();
    const job = await claimed(store, 1);
    const queued = await store.appendJobEvent(job, { type: "job_queued", lane_id: null, data: { position: 1 } }, at(1));
    expect(queued).toEqual({ seq: 1, at: at(1), type: "job_queued", lane_id: null, data: { position: 1 } });
    expect(await store.appendBuilderEvents(job, "builder-a", [stage(1), stage(2)], at(10))).toEqual({ kind: "ok", accepted_through: 2 });
    await store.appendJobEvent(job, { type: "job_claimed", lane_id: null, data: { builder_revision: "rev-1" } }, at(11));
    expect(await store.appendBuilderEvents(job, "builder-a", [stage(3)], at(12))).toEqual({ kind: "ok", accepted_through: 3 });
    const events = await store.listEvents(job, 0);
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [1, "job_queued"],
      [2, "lane_stage"],
      [3, "lane_stage"],
      [4, "job_claimed"],
      [5, "lane_stage"],
    ]);
    expect(events[1]).toEqual({ seq: 2, at: at(1), type: "lane_stage", lane_id: "lane-1", data: { stage: "writing", iteration: 1 } });
    expect((await store.listEvents(job, 3)).map((event) => event.seq)).toEqual([4, 5]);
  });

  it("ignores a byte-identical repeat, and refuses a changed repeat or a gap without storing any of the post", async () => {
    const store = await open();
    const job = await claimed(store, 1);
    await store.appendBuilderEvents(job, "builder-a", [stage(1), stage(2)], at(10));
    expect(await store.appendBuilderEvents(job, "builder-a", [stage(2), stage(3)], at(20))).toEqual({ kind: "ok", accepted_through: 3 });
    expect(await store.appendBuilderEvents(job, "builder-a", [stage(4), stage(2, "revising", 2)], at(30))).toEqual({ kind: "conflict", accepted_through: 3, builder_seq: 2 });
    expect(await store.appendBuilderEvents(job, "builder-a", [stage(5)], at(40))).toEqual({ kind: "conflict", accepted_through: 3, builder_seq: 5 });
    expect((await store.listEvents(job, 0)).length).toBe(3);
    expect(builderEventBytes(stage(2))).toBe(builderEventBytes(stage(2)));
    // A conflict does not extend the lease; the last good post did.
    expect((await store.getJob(job))?.lease_until).toBe(at(20 + 90_000));
  });

  it("refuses events for a finished job, another builder's job and an unknown job, and extends the lease on an empty post", async () => {
    const store = await open();
    const job = await claimed(store, 1);
    expect(await store.appendBuilderEvents(job, "builder-b", [], at(10))).toEqual({ kind: "wrong_builder" });
    expect(await store.appendBuilderEvents(uuid(77), "builder-a", [], at(10))).toEqual({ kind: "not_found" });
    expect(await store.appendBuilderEvents(job, "builder-a", [], at(60_000))).toEqual({ kind: "ok", accepted_through: 0 });
    expect(await store.getJob(job)).toMatchObject({ lease_until: at(150_000), last_builder_post_at: at(60_000) });
    await store.updateJob(job, ["building"], { state: "finished", outcome: "builder_lost", reason: null, finished_at: at(70_000) });
    expect(await store.appendBuilderEvents(job, "builder-a", [stage(1)], at(80_000))).toEqual({ kind: "finished" });
  });

  it("sets the job's spend to the sum of each lane's latest meter", async () => {
    const store = await open();
    const job = await claimed(store, 1);
    await store.appendBuilderEvents(job, "builder-a", [meter(1, "lane-1", 100), meter(2, "lane-2", 50), meter(3, "lane-1", 400)], at(10));
    expect((await store.getJob(job))?.model_microusd).toBe(450);
    await store.appendBuilderEvents(job, "builder-a", [meter(4, "lane-2", 70)], at(20));
    expect((await store.getJob(job))?.model_microusd).toBe(470);
    expect(await store.totalModelMicrousd()).toBe(470);
  });

  it("records the builder heartbeat, with first_of_boot once per boot", async () => {
    const store = await open();
    expect(await store.lastBuilderSeen()).toBeNull();
    const info = { builder_id: "builder-a", builder_revision: "rev-1", boot_id: "boot-1", booted_at: at(0) };
    expect(await store.recordBuilderSeen(info, at(1000))).toEqual({ first_of_boot: true });
    expect(await store.recordBuilderSeen(info, at(2000))).toEqual({ first_of_boot: false });
    expect(await store.recordBuilderSeen({ ...info, boot_id: "boot-2" }, at(3000))).toEqual({ first_of_boot: true });
    expect(await store.lastBuilderSeen()).toEqual({ ...info, boot_id: "boot-2", last_seen_at: at(3000) });
  });

  it("claims validations first, then the oldest queued build while fewer than the limit are building", async () => {
    const store = await open();
    for (const n of [1, 2, 3]) await store.createJob(newJob(n));
    await store.createJob(newJob(4, { state: "starting_builder" }));
    const first = await store.claimNext("builder-a", at(10_000), CLAIM);
    expect(first?.kind).toBe("build");
    if (first?.kind !== "build") return;
    expect(first.job).toMatchObject({ job_id: uuid(1), state: "building", claimed_by: "builder-a", claimed_at: at(10_000), deadline_at: at(10_000 + 45 * 60_000), lease_until: at(100_000) });
    await store.updateJob(uuid(1), ["building"], { state: "finished", outcome: "delivered", reason: null, finished_at: at(11_000) });
    await store.createValidation(uuid(1), uuid(500), at(12_000));
    const validation = await store.claimNext("builder-a", at(13_000), CLAIM);
    expect(validation).toEqual({ kind: "validate", validation: { validation_id: uuid(500), job_id: uuid(1), state: "running", cells: null, started_at: at(12_000), finished_at: null, claimed_by: "builder-a" } });
    expect(await store.claimNext("builder-a", at(14_000), { ...CLAIM, maxActiveBuilds: 1, build: true })).toMatchObject({ kind: "build", job: { job_id: uuid(2) } });
    expect(await store.claimNext("builder-a", at(15_000), { ...CLAIM, maxActiveBuilds: 1 })).toBeNull();
    expect(await store.claimNext("builder-a", at(15_000), { ...CLAIM, build: false })).toBeNull();
  });

  it("never hands out more builds than the limit to concurrent claims", async () => {
    const store = await open();
    for (const n of [1, 2, 3, 4, 5]) await store.createJob(newJob(n));
    const claims = await Promise.all([1, 2, 3, 4, 5].map((n) => store.claimNext(`builder-${String(n)}`, at(10_000), CLAIM)));
    const builds = claims.filter((claim) => claim?.kind === "build");
    expect(builds).toHaveLength(2);
    expect(new Set(builds.map((claim) => claim.job.job_id))).toEqual(new Set([uuid(1), uuid(2)]));
  });

  it("stores a delivery once with its job_finished event, replays the same hashes and refuses others", async () => {
    const store = await open();
    const job = await claimed(store, 1);
    const parts = (["agent", "grader", "certificate"] as const).map((part, index) => ({
      job_id: job,
      part,
      filename: `synthetic-${part}.bin`,
      media_type: part === "certificate" ? ("application/json" as const) : ("application/gzip" as const),
      size: 3,
      sha256: String(index).repeat(64),
      bytes: new Uint8Array([index, 1, 2]),
    }));
    const patch = { state: "finished", outcome: "delivered", reason: null, finished_at: at(200_000), winner_lane: "lane-2", winner_model: "synthetic/model" } as const;
    expect(await store.storeDelivery(job, "builder-b", parts, patch)).toBe("wrong_builder");
    expect(await store.storeDelivery(job, "builder-a", parts, patch)).toBe("stored");
    expect(await store.getJob(job)).toMatchObject({ state: "finished", outcome: "delivered", winner_lane: "lane-2", finished_at: at(200_000) });
    expect((await store.listEvents(job, 0)).at(-1)).toMatchObject({ type: "job_finished", at: at(200_000), data: { outcome: "delivered", reason: null } });
    expect(await store.storeDelivery(job, "builder-a", parts, patch)).toBe("replayed");
    expect(await store.storeDelivery(job, "builder-a", parts.map((part) => ({ ...part, sha256: "f".repeat(64) })), patch)).toBe("conflict");
    expect((await store.listArtifacts(job)).map((item) => item.part)).toEqual(["agent", "certificate", "grader"]);
    const agent = await store.getArtifact(job, "agent");
    expect(agent).toMatchObject({ part: "agent", size: 3, sha256: "0".repeat(64), media_type: "application/gzip" });
    expect(Array.from(agent?.bytes ?? [])).toEqual([0, 1, 2]);
    expect(await store.storeDelivery(uuid(77), "builder-a", parts, patch)).toBe("not_found");
  });

  it("does not let a late delivery overwrite a job that a status read already finished", async () => {
    const store = await open();
    const job = await claimed(store, 1);
    await store.updateJob(job, ["building"], { state: "finished", outcome: "time_limit", reason: null, finished_at: at(150_000) });
    const part = { job_id: job, part: "agent" as const, filename: "a.tar.gz", media_type: "application/gzip" as const, size: 1, sha256: "0".repeat(64), bytes: new Uint8Array([1]) };
    expect(await store.storeDelivery(job, "builder-a", [part], { state: "finished", outcome: "delivered", reason: null, finished_at: at(160_000) })).toBe("finished");
    expect(await store.getJob(job)).toMatchObject({ outcome: "time_limit" });
    expect(await store.listArtifacts(job)).toEqual([]);
    // With no parts the same call finishes a claimed job with another outcome.
    const other = await claimed(store, 2);
    expect(await store.storeDelivery(other, "builder-a", [], { state: "finished", outcome: "not_qualified", reason: "synthetic", finished_at: at(170_000) })).toBe("stored");
    expect((await store.listEvents(other, 0)).at(-1)).toMatchObject({ type: "job_finished", data: { outcome: "not_qualified", reason: "synthetic" } });
  });

  it("keeps validations with a compare-and-set update and finds the latest per job", async () => {
    const store = await open();
    await store.createJob(newJob(1));
    await store.createValidation(uuid(1), uuid(500), at(1000));
    await store.createValidation(uuid(1), uuid(501), at(2000));
    expect((await store.latestValidation(uuid(1)))?.validation_id).toBe(uuid(501));
    expect(await store.latestValidation(uuid(2))).toBeNull();
    expect(await store.updateValidation(uuid(501), ["running"], { state: "passed" })).toBeNull();
    const cells = { clean: { original_suite: "pass", added_checks: "pass" }, buggy: { original_suite: "pass", added_checks: "fail" }, fixed: { original_suite: "pass", added_checks: "pass" } } as const;
    expect(await store.updateValidation(uuid(501), ["queued"], { state: "passed", cells, finished_at: at(3000) })).toMatchObject({ state: "passed", cells, finished_at: at(3000) });
    expect(await store.getValidation(uuid(501))).toMatchObject({ state: "passed", cells });
    expect(await store.getValidation(uuid(999))).toBeNull();
  });

  it("runs power changes one at a time under the lock, logs them, and keeps the operator hold out of reach", async () => {
    const store = await open();
    expect(await store.getPower()).toMatchObject({ state: "unknown", start_failures: 0, hold_until: null, vm_seconds_today: 0 });
    const bump = (n: number): Promise<number> =>
      store.withPowerLock(async (power) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          patch: { start_failures: power.start_failures + 1, state: "starting", since: at(n), last_start_at: at(n), vm_day: "2026-10-29" },
          log: [{ at: at(n), actor: "create", action: "start", before: power.state, after: "starting", operation_id: `op-${String(n)}` }],
          result: power.start_failures,
        };
      });
    expect((await Promise.all([bump(1), bump(2), bump(3)])).sort()).toEqual([0, 1, 2]);
    expect(await store.getPower()).toMatchObject({ state: "starting", start_failures: 3, vm_day: "2026-10-29" });
    await expect(store.withPowerLock(() => Promise.resolve({ patch: { hold_until: at(5) }, log: [], result: null }))).rejects.toThrow(/operator/);
    await expect(
      store.withPowerLock(() => {
        throw new Error("synthetic failure");
      }),
    ).rejects.toThrow("synthetic failure");
    expect((await store.getPower()).start_failures).toBe(3);
    // The lock still works after a failure inside it.
    expect(await store.withPowerLock((power) => Promise.resolve({ patch: null, log: [], result: power.state }))).toBe("starting");
  });
});
