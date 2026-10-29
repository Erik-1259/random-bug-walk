// The OtfStore port (contract.ts) on Postgres, over the `otf` schema of otf-migrations/0001_otf.sql,
// plus an in-memory implementation with the same behavior for tests and local runs. Nothing here
// reads or writes the spend ledger. Every multi-step change runs in one transaction under a row
// lock (the job row, the power row) or, for the claim, a transaction-scoped advisory lock (plus a
// share of the power row lock), so concurrent function instances cannot hand one job out twice, skip
// an event seq, let a late delivery overwrite a job that already finished or claim work while a stop
// is being decided.
//
// The Postgres implementation takes a connection pool through OtfSqlPool, so this module imports no
// driver: otfPoolFromPg adapts a node-postgres Pool, and the tests adapt PGlite.
import { AsyncLocalStorage } from "node:async_hooks";
import { builderEventBytes } from "./canonical.ts";
import {
  LEASE_MS,
  type AppendBuilderEventsResult,
  type BuilderEventIn,
  type CreateJobResult,
  type JobPatch,
  type OtfArtifactRecord,
  type OtfBuilderInfo,
  type OtfAdmissionResult,
  type OtfEvent,
  type OtfHostId,
  type OtfJobId,
  type OtfJobRecord,
  type OtfJobState,
  type OtfNewJob,
  type OtfPart,
  type OtfPowerLogEntry,
  type OtfPowerRecord,
  type OtfCertificate,
  type OtfSpecCard,
  type SixCells,
  type OtfStore,
  type OtfValidationRecord,
  type OtfValidationState,
  type ProductionEvent,
} from "./contract.ts";

// ---- the SQL port

export interface OtfSql {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** A pool: single statements, and transactions that hold one connection from BEGIN to COMMIT. */
export interface OtfSqlPool extends OtfSql {
  /** Runs fn inside BEGIN ... COMMIT on one connection; a throw rolls back and rethrows. */
  transaction<T>(fn: (tx: OtfSql) => Promise<T>): Promise<T>;
}

/** The part of a node-postgres Pool this module uses. */
export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<{ query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; release(destroy?: boolean): void }>;
}

/**
 * Adapts a node-postgres Pool: each outermost transaction takes a connection of its own. Store calls
 * made inside a transaction's callback (directly or through other store calls, such as a job insert
 * under the power lock) run on that transaction's connection, as on PGlite in the tests; otherwise a
 * few requests waiting on the power row lock could hold every pooled connection while the lock holder
 * waits for one more.
 */
export function otfPoolFromPg(pool: PgPoolLike): OtfSqlPool {
  const inTx = new AsyncLocalStorage<{ sql: OtfSql; open: boolean }>();
  const current = (): OtfSql => {
    const open = inTx.getStore();
    return open?.open === true ? open.sql : pool;
  };
  return {
    query: (text, params) => current().query(text, params),
    async transaction(fn) {
      const outer = inTx.getStore();
      if (outer?.open === true) return fn(outer.sql);
      const client = await pool.connect();
      const scope = { sql: { query: (text: string, params?: unknown[]) => client.query(text, params) }, open: true };
      let healthy = true;
      try {
        await client.query("BEGIN");
        try {
          const result = await inTx.run(scope, () => fn(scope.sql));
          await client.query("COMMIT");
          return result;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            healthy = false;
          }
          throw error;
        }
      } finally {
        // A continuation left running from the callback goes back to the pool, never to a released connection.
        scope.open = false;
        client.release(!healthy);
      }
    },
  };
}

// ---- shared helpers

function addMs(at: string, ms: number): string {
  return new Date(Date.parse(at) + ms).toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** The per-host claim options of OtfStore.claimNext. */
type ClaimHosts = Parameters<OtfStore["claimNext"]>[2]["hosts"];

/** The hosts whose entry passes `test`, in a stable order. */
function hostsWhere(hosts: ClaimHosts, test: (entry: ClaimHosts[OtfHostId]) => boolean): OtfHostId[] {
  return (Object.keys(hosts) as OtfHostId[]).filter((host) => test(hosts[host])).sort();
}

/** The job_finished event a finishing patch implies. */
function finishedEvent(patch: JobPatch): ProductionEvent {
  return { type: "job_finished", lane_id: null, data: { outcome: patch.outcome ?? "delivered", reason: patch.reason ?? null } };
}

function sameParts(stored: readonly { part: OtfPart; sha256: string }[], posted: readonly { part: OtfPart; sha256: string }[]): boolean {
  if (stored.length !== posted.length) return false;
  const byPart = new Map(stored.map((item) => [item.part, item.sha256]));
  return posted.every((item) => byPart.get(item.part) === item.sha256);
}

/** The constraint the table holds: a job is finished exactly when an outcome is set. */
function jobInvariantHolds(job: OtfJobRecord): boolean {
  return (job.state === "finished") === (job.outcome !== null);
}

const INVARIANT = "otf store: a job is finished exactly when it has an outcome";

/**
 * The sum, over lanes, of each lane's latest lane_meter cost (the meters are cumulative per lane).
 * `events` is in seq order.
 */
function meterTotal(events: readonly OtfEvent[]): number {
  const latest = new Map<string, number>();
  for (const event of events) if (event.type === "lane_meter") latest.set(event.lane_id, event.data.cost_microusd);
  let total = 0;
  for (const cost of latest.values()) total += cost;
  return total;
}

type BuilderPlan =
  | { kind: "ok"; fresh: BuilderEventIn[]; through: number }
  | { kind: "conflict"; accepted_through: number; builder_seq: number };

/**
 * Which posted events are new, given the stored maximum builder_seq and a lookup of stored bytes.
 * A repeat must match its stored bytes (or an earlier event of the same post); a gap is a conflict.
 */
function planBuilderEvents(events: readonly BuilderEventIn[], storedMax: number, storedBytes: (seq: number) => string | undefined): BuilderPlan {
  const fresh: BuilderEventIn[] = [];
  const posted = new Map<number, string>();
  let through = storedMax;
  for (const event of events) {
    const bytes = builderEventBytes(event);
    if (event.builder_seq <= through) {
      const known = posted.get(event.builder_seq) ?? storedBytes(event.builder_seq);
      if (known !== bytes) return { kind: "conflict", accepted_through: storedMax, builder_seq: event.builder_seq };
      continue;
    }
    if (event.builder_seq !== through + 1) return { kind: "conflict", accepted_through: storedMax, builder_seq: event.builder_seq };
    fresh.push(event);
    posted.set(event.builder_seq, bytes);
    through = event.builder_seq;
  }
  return { kind: "ok", fresh, through };
}

function publicEvent(event: BuilderEventIn, seq: number): OtfEvent {
  const copy: Record<string, unknown> = { ...event, seq };
  delete copy.builder_seq;
  return copy as unknown as OtfEvent;
}

/** A power patch may not change hold_until: only an operator script sets it. */
function checkPowerPatch(current: OtfPowerRecord, patch: Partial<OtfPowerRecord>): void {
  if ("hold_until" in patch && patch.hold_until !== current.hold_until) throw new Error("otf store: hold_until is set by an operator script, never by a route");
}

// ---- Postgres

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("otf store: unexpected time value");
}

function isoRequired(value: unknown): string {
  const found = iso(value);
  if (found === null) throw new Error("otf store: missing time value");
  return found;
}

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint" || typeof value === "string") return Number(value);
  throw new Error("otf store: unexpected numeric value");
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new Error("otf store: unexpected text value");
  return value;
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}

function json(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw new Error("otf store: unexpected bytes value");
}

function jobFromRow(row: Record<string, unknown>): OtfJobRecord {
  return {
    job_id: str(row.job_id),
    client_key: str(row.client_key),
    create_sha256: str(row.create_sha256),
    created_at: isoRequired(row.created_at),
    host_id: str(row.host_id) as OtfHostId,
    criterion_id: str(row.criterion_id) as OtfJobRecord["criterion_id"],
    sentence: str(row.sentence),
    spec: json(row.spec) as OtfSpecCard,
    spec_sha256: str(row.spec_sha256),
    state: str(row.state) as OtfJobState,
    outcome: strOrNull(row.outcome) as OtfJobRecord["outcome"],
    reason: strOrNull(row.reason),
    claimed_by: strOrNull(row.claimed_by),
    claimed_at: iso(row.claimed_at),
    lease_until: iso(row.lease_until),
    deadline_at: iso(row.deadline_at),
    last_builder_post_at: iso(row.last_builder_post_at),
    stop_requested_at: iso(row.stop_requested_at),
    stop_reason: strOrNull(row.stop_reason) as OtfJobRecord["stop_reason"],
    winner_lane: strOrNull(row.winner_lane) as OtfJobRecord["winner_lane"],
    winner_model: strOrNull(row.winner_model),
    model_microusd: num(row.model_microusd),
    catalog_request_id: strOrNull(row.catalog_request_id),
    certificate: row.certificate === null || row.certificate === undefined ? null : (json(row.certificate) as OtfCertificate),
    finished_at: iso(row.finished_at),
  };
}

function eventFromRow(row: Record<string, unknown>): OtfEvent {
  return { seq: num(row.seq), at: str(row.at), lane_id: strOrNull(row.lane_id), type: str(row.type), data: json(row.data) } as OtfEvent;
}

function artifactFromRow(row: Record<string, unknown>): OtfArtifactRecord {
  return {
    job_id: str(row.job_id),
    part: str(row.part) as OtfPart,
    filename: str(row.filename),
    media_type: str(row.media_type) as OtfArtifactRecord["media_type"],
    size: num(row.size),
    sha256: str(row.sha256),
  };
}

function validationFromRow(row: Record<string, unknown>): OtfValidationRecord {
  return {
    validation_id: str(row.validation_id),
    job_id: str(row.job_id),
    state: str(row.state) as OtfValidationState,
    cells: row.cells === null || row.cells === undefined ? null : (json(row.cells) as SixCells),
    admission: row.admission === null || row.admission === undefined ? null : (json(row.admission) as OtfAdmissionResult),
    started_at: isoRequired(row.started_at),
    finished_at: iso(row.finished_at),
    claimed_by: strOrNull(row.claimed_by),
  };
}

const POWER_SELECT = "SELECT *, vm_day::text AS vm_day_text FROM otf.power WHERE id = 1";

function powerFromRow(row: Record<string, unknown>): OtfPowerRecord {
  return {
    state: str(row.state) as OtfPowerRecord["state"],
    since: isoRequired(row.since),
    preset: strOrNull(row.preset),
    instance_state: strOrNull(row.instance_state) as OtfPowerRecord["instance_state"],
    last_api_call_at: iso(row.last_api_call_at),
    last_start_at: iso(row.last_start_at),
    last_stop_at: iso(row.last_stop_at),
    start_failures: num(row.start_failures),
    running_since: iso(row.running_since),
    last_job_finished_at: iso(row.last_job_finished_at),
    vm_seconds_today: num(row.vm_seconds_today),
    vm_day: str(row.vm_day_text),
    hold_until: iso(row.hold_until),
  };
}

/** The job columns a patch may set, and how each value is written. */
const JOB_PATCH_COLUMNS: Record<keyof JobPatch, "text" | "timestamptz" | "jsonb" | "bigint"> = {
  state: "text",
  outcome: "text",
  reason: "text",
  stop_requested_at: "timestamptz",
  stop_reason: "text",
  winner_lane: "text",
  winner_model: "text",
  model_microusd: "bigint",
  certificate: "jsonb",
  finished_at: "timestamptz",
  lease_until: "timestamptz",
  last_builder_post_at: "timestamptz",
};

const VALIDATION_PATCH_COLUMNS: Record<"state" | "cells" | "admission" | "finished_at", "text" | "jsonb" | "timestamptz"> = {
  state: "text",
  cells: "jsonb",
  admission: "jsonb",
  finished_at: "timestamptz",
};

const POWER_PATCH_COLUMNS: Record<keyof OtfPowerRecord, "text" | "timestamptz" | "integer" | "date"> = {
  state: "text",
  since: "timestamptz",
  preset: "text",
  instance_state: "text",
  last_api_call_at: "timestamptz",
  last_start_at: "timestamptz",
  last_stop_at: "timestamptz",
  start_failures: "integer",
  running_since: "timestamptz",
  last_job_finished_at: "timestamptz",
  vm_seconds_today: "integer",
  vm_day: "date",
  hold_until: "timestamptz",
};

/** SET clauses for the known keys of patch, with parameters numbered from `first`. */
function setClauses(patch: Record<string, unknown>, columns: Record<string, string>, first: number): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  for (const [key, member] of Object.entries(patch)) {
    const type = columns[key];
    if (type === undefined) throw new Error(`otf store: ${key} cannot be patched`);
    if (member === undefined) continue;
    params.push(type === "jsonb" && member !== null ? JSON.stringify(member) : member);
    sql.push(`${key} = $${String(first + params.length - 1)}::${type}`);
  }
  return { sql, params };
}

async function lockedJob(tx: OtfSql, job_id: OtfJobId): Promise<OtfJobRecord | null> {
  const { rows } = await tx.query("SELECT * FROM otf.jobs WHERE job_id = $1::uuid FOR UPDATE", [job_id]);
  const row = rows[0];
  return row === undefined ? null : jobFromRow(row);
}

async function insertJobEvent(tx: OtfSql, job_id: OtfJobId, event: ProductionEvent, at: string): Promise<OtfEvent> {
  const { rows } = await tx.query("UPDATE otf.jobs SET last_seq = last_seq + 1 WHERE job_id = $1::uuid RETURNING last_seq", [job_id]);
  const row = rows[0];
  if (row === undefined) throw new Error("otf store: no job for this event");
  const seq = num(row.last_seq);
  await tx.query("INSERT INTO otf.events (job_id, seq, at, lane_id, type, data) VALUES ($1::uuid, $2, $3, NULL, $4, $5::jsonb)", [job_id, seq, at, event.type, JSON.stringify(event.data)]);
  return { ...event, seq, at };
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The OtfStore on Postgres. The `otf` schema must already be migrated (otf-migrations/0001_otf.sql). */
export function createPgOtfStore(pool: OtfSqlPool): OtfStore {
  return {
    async createJob(job: OtfNewJob): Promise<CreateJobResult> {
      const inserted = await pool.query(
        `INSERT INTO otf.jobs (job_id, client_key, create_sha256, created_at, host_id, criterion_id, sentence, spec, spec_sha256, state, catalog_request_id)
         VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5, $6, $7, $8::jsonb, $9, $10, $11::uuid)
         ON CONFLICT (client_key) DO NOTHING RETURNING *`,
        [job.job_id, job.client_key, job.create_sha256, job.created_at, job.host_id, job.criterion_id, job.sentence, JSON.stringify(job.spec), job.spec_sha256, job.state, job.catalog_request_id],
      );
      const created = inserted.rows[0];
      if (created !== undefined) return { kind: "created", job: jobFromRow(created) };
      const { rows } = await pool.query("SELECT * FROM otf.jobs WHERE client_key = $1::uuid", [job.client_key]);
      const existing = rows[0];
      if (existing === undefined) throw new Error("otf store: a client_key conflict with no stored job");
      const stored = jobFromRow(existing);
      return stored.create_sha256 === job.create_sha256 ? { kind: "replayed", job: stored } : { kind: "conflict" };
    },

    async getJob(job_id) {
      if (!UUID_TEXT.test(job_id)) return null;
      const { rows } = await pool.query("SELECT * FROM otf.jobs WHERE job_id = $1::uuid", [job_id]);
      const row = rows[0];
      return row === undefined ? null : jobFromRow(row);
    },

    async listJobs(states) {
      const { rows } = await pool.query("SELECT * FROM otf.jobs WHERE state = ANY($1::text[]) ORDER BY created_at, job_id", [[...states]]);
      return rows.map(jobFromRow);
    },

    async countJobsCreatedSince(at) {
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM otf.jobs WHERE created_at >= $1::timestamptz", [at]);
      return num(rows[0]?.n ?? 0);
    },

    async totalModelMicrousd() {
      const { rows } = await pool.query("SELECT COALESCE(sum(model_microusd), 0)::text AS total FROM otf.jobs");
      return num(rows[0]?.total ?? 0);
    },

    async updateJob(job_id, whenStates, patch, when) {
      if (!UUID_TEXT.test(job_id)) return null;
      const { sql, params } = setClauses(patch, JOB_PATCH_COLUMNS, 3);
      const sets = sql.length === 0 ? "job_id = job_id" : sql.join(", ");
      let quiet = "";
      if (when !== undefined) {
        params.push(when.quietSince);
        quiet = ` AND COALESCE(last_builder_post_at, claimed_at) <= $${String(2 + params.length)}::timestamptz`;
      }
      const { rows } = await pool.query(`UPDATE otf.jobs SET ${sets} WHERE job_id = $1::uuid AND state = ANY($2::text[])${quiet} RETURNING *`, [job_id, [...whenStates], ...params]);
      const row = rows[0];
      return row === undefined ? null : jobFromRow(row);
    },

    appendJobEvent(job_id, event, at) {
      return pool.transaction((tx) => insertJobEvent(tx, job_id, event, at));
    },

    async appendBuilderEvents(job_id, builder_id, events, at): Promise<AppendBuilderEventsResult> {
      if (!UUID_TEXT.test(job_id)) return { kind: "not_found" };
      return pool.transaction(async (tx) => {
        const { rows } = await tx.query("SELECT state, claimed_by, last_seq, last_builder_seq FROM otf.jobs WHERE job_id = $1::uuid FOR UPDATE", [job_id]);
        const row = rows[0];
        if (row === undefined) return { kind: "not_found" };
        if (row.state === "finished") return { kind: "finished" };
        if (row.state !== "building" || row.claimed_by !== builder_id) return { kind: "wrong_builder" };
        const storedMax = num(row.last_builder_seq);
        const repeats = events.filter((event) => event.builder_seq <= storedMax).map((event) => event.builder_seq);
        const stored = new Map<number, string>();
        if (repeats.length > 0) {
          const found = await tx.query("SELECT builder_seq, builder_bytes FROM otf.events WHERE job_id = $1::uuid AND builder_seq = ANY($2::int[])", [job_id, repeats]);
          for (const item of found.rows) stored.set(num(item.builder_seq), str(item.builder_bytes));
        }
        const plan = planBuilderEvents(events, storedMax, (seq) => stored.get(seq));
        if (plan.kind === "conflict") return plan;
        let seq = num(row.last_seq);
        for (const event of plan.fresh) {
          seq += 1;
          await tx.query(
            "INSERT INTO otf.events (job_id, seq, at, lane_id, type, data, builder_seq, builder_bytes) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8)",
            [job_id, seq, event.at, event.lane_id, event.type, JSON.stringify(event.data), event.builder_seq, builderEventBytes(event)],
          );
        }
        let meter = "";
        const params: unknown[] = [job_id, seq, plan.through, addMs(at, LEASE_MS), at];
        if (plan.fresh.some((event) => event.type === "lane_meter")) {
          meter = `, model_microusd = GREATEST(model_microusd, (SELECT COALESCE(sum((latest.data->>'cost_microusd')::bigint), 0) FROM
            (SELECT DISTINCT ON (lane_id) data FROM otf.events WHERE job_id = $1::uuid AND type = 'lane_meter' ORDER BY lane_id, seq DESC) latest))`;
        }
        await tx.query(`UPDATE otf.jobs SET last_seq = $2, last_builder_seq = $3, lease_until = $4::timestamptz, last_builder_post_at = $5::timestamptz${meter} WHERE job_id = $1::uuid`, params);
        return { kind: "ok", accepted_through: plan.through };
      });
    },

    async listEvents(job_id, after) {
      if (!UUID_TEXT.test(job_id)) return [];
      const { rows } = await pool.query("SELECT seq, at, lane_id, type, data FROM otf.events WHERE job_id = $1::uuid AND seq > $2 ORDER BY seq", [job_id, after]);
      return rows.map(eventFromRow);
    },

    recordBuilderSeen(info: OtfBuilderInfo, at) {
      return pool.transaction(async (tx) => {
        // A placeholder row first, so the row lock below serializes even the very first heartbeats.
        await tx.query(
          "INSERT INTO otf.builders (builder_id, builder_revision, boot_id, booted_at, ready_hosts, last_seen_at) VALUES ($1, $2, '', '', '{}', $3::timestamptz) ON CONFLICT (builder_id) DO NOTHING",
          [info.builder_id, info.builder_revision, at],
        );
        const { rows } = await tx.query("SELECT boot_id FROM otf.builders WHERE builder_id = $1 FOR UPDATE", [info.builder_id]);
        const previous = rows[0]?.boot_id;
        await tx.query("UPDATE otf.builders SET builder_revision = $2, boot_id = $3, booted_at = $4, ready_hosts = $5::text[], last_seen_at = $6::timestamptz WHERE builder_id = $1", [
          info.builder_id,
          info.builder_revision,
          info.boot_id,
          info.booted_at,
          [...info.ready_hosts],
          at,
        ]);
        return { first_of_boot: previous !== info.boot_id };
      });
    },

    async lastBuilderSeen() {
      const { rows } = await pool.query("SELECT * FROM otf.builders WHERE boot_id <> '' ORDER BY last_seen_at DESC, builder_id LIMIT 1");
      const row = rows[0];
      if (row === undefined) return null;
      const ready = Array.isArray(row.ready_hosts) ? (row.ready_hosts as unknown[]).map(str) : [];
      return {
        builder_id: str(row.builder_id),
        builder_revision: str(row.builder_revision),
        boot_id: str(row.boot_id),
        booted_at: str(row.booted_at),
        ready_hosts: ready as OtfHostId[],
        last_seen_at: isoRequired(row.last_seen_at),
      };
    },

    claimNext(builder_id, at, opts) {
      return pool.transaction(async (tx) => {
        // One claim at a time, so the active-build count cannot be read twice before either claim lands.
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('otf'), hashtext('claim'))");
        // Claim admission shares the power row lock, so a stop decided under it (the watchdog holds it
        // through its Stop call) and a claim never overlap: once the row reads stopping, no work goes out.
        const power = await tx.query("SELECT state FROM otf.power WHERE id = 1 FOR SHARE");
        if (power.rows[0]?.state === "stopping") return null;
        const validating = hostsWhere(opts.hosts, (entry) => entry.validate);
        if (validating.length > 0) {
          const { rows } = await tx.query(
            `SELECT v.validation_id FROM otf.validations v JOIN otf.jobs j ON j.job_id = v.job_id
             WHERE v.state = 'queued' AND j.host_id = ANY($1::text[]) ORDER BY v.started_at, v.validation_id LIMIT 1 FOR UPDATE OF v`,
            [validating],
          );
          const found = rows[0];
          if (found !== undefined) {
            const updated = await tx.query("UPDATE otf.validations SET state = 'running', claimed_by = $2 WHERE validation_id = $1 RETURNING *", [found.validation_id, builder_id]);
            const row = updated.rows[0];
            if (row !== undefined) return { kind: "validate" as const, validation: validationFromRow(row) };
          }
        }
        // Each host is checked against its own limit, so a saturated host never blocks another.
        const active = await tx.query("SELECT host_id, count(*)::int AS n FROM otf.jobs WHERE state = 'building' GROUP BY host_id");
        const building = new Map(active.rows.map((row) => [str(row.host_id), num(row.n)]));
        const open = hostsWhere(opts.hosts, (entry) => entry.build).filter((host) => (building.get(host) ?? 0) < opts.hosts[host].maxActiveBuilds);
        if (open.length === 0) return null;
        const { rows } = await tx.query("SELECT job_id, host_id FROM otf.jobs WHERE state = 'queued' AND host_id = ANY($1::text[]) ORDER BY created_at, job_id LIMIT 1 FOR UPDATE", [open]);
        const found = rows[0];
        if (found === undefined) return null;
        const host = str(found.host_id) as OtfHostId;
        const updated = await tx.query(
          `UPDATE otf.jobs SET state = 'building', claimed_by = $2, claimed_at = $3::timestamptz, deadline_at = $4::timestamptz,
             lease_until = $5::timestamptz, last_builder_post_at = $3::timestamptz WHERE job_id = $1 RETURNING *`,
          [found.job_id, builder_id, at, addMs(at, opts.hosts[host].deadlineMs), addMs(at, LEASE_MS)],
        );
        const row = updated.rows[0];
        return row === undefined ? null : { kind: "build" as const, job: jobFromRow(row) };
      });
    },

    async storeDelivery(job_id, builder_id, parts, patch, at) {
      if (!UUID_TEXT.test(job_id)) return "not_found";
      return pool.transaction(async (tx) => {
        const job = await lockedJob(tx, job_id);
        if (job === null) return "not_found";
        if (job.state === "finished") {
          if (job.outcome !== "delivered") return "finished";
          if (job.claimed_by !== builder_id) return "wrong_builder";
          const stored = await tx.query("SELECT part, sha256 FROM otf.artifacts WHERE job_id = $1::uuid", [job_id]);
          return sameParts(
            stored.rows.map((row) => ({ part: str(row.part) as OtfPart, sha256: str(row.sha256) })),
            parts,
          )
            ? "replayed"
            : "conflict";
        }
        if (job.state !== "building" || job.claimed_by !== builder_id) return "wrong_builder";
        if (!jobInvariantHolds({ ...job, ...patch })) throw new Error(INVARIANT);
        for (const part of parts) {
          await tx.query("INSERT INTO otf.artifacts (job_id, part, filename, media_type, size, sha256, bytes) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)", [
            job_id,
            part.part,
            part.filename,
            part.media_type,
            part.size,
            part.sha256,
            Buffer.from(part.bytes),
          ]);
        }
        const { sql, params } = setClauses(patch, JOB_PATCH_COLUMNS, 2);
        if (sql.length > 0) await tx.query(`UPDATE otf.jobs SET ${sql.join(", ")} WHERE job_id = $1::uuid`, [job_id, ...params]);
        if (patch.state === "finished") await insertJobEvent(tx, job_id, finishedEvent(patch), at);
        return "stored";
      });
    },

    async listArtifacts(job_id) {
      if (!UUID_TEXT.test(job_id)) return [];
      const { rows } = await pool.query("SELECT job_id, part, filename, media_type, size, sha256 FROM otf.artifacts WHERE job_id = $1::uuid ORDER BY part", [job_id]);
      return rows.map(artifactFromRow);
    },

    async getArtifact(job_id, part) {
      if (!UUID_TEXT.test(job_id)) return null;
      const { rows } = await pool.query("SELECT * FROM otf.artifacts WHERE job_id = $1::uuid AND part = $2", [job_id, part]);
      const row = rows[0];
      return row === undefined ? null : { ...artifactFromRow(row), bytes: bytesOf(row.bytes) };
    },

    async createValidation(job_id, validation_id, at) {
      const { rows } = await pool.query("INSERT INTO otf.validations (validation_id, job_id, state, started_at) VALUES ($1::uuid, $2::uuid, 'queued', $3::timestamptz) RETURNING *", [
        validation_id,
        job_id,
        at,
      ]);
      const row = rows[0];
      if (row === undefined) throw new Error("otf store: the validation was not inserted");
      return validationFromRow(row);
    },

    async getValidation(validation_id) {
      if (!UUID_TEXT.test(validation_id)) return null;
      const { rows } = await pool.query("SELECT * FROM otf.validations WHERE validation_id = $1::uuid", [validation_id]);
      const row = rows[0];
      return row === undefined ? null : validationFromRow(row);
    },

    async latestValidation(job_id) {
      if (!UUID_TEXT.test(job_id)) return null;
      const { rows } = await pool.query("SELECT * FROM otf.validations WHERE job_id = $1::uuid ORDER BY started_at DESC, validation_id DESC LIMIT 1", [job_id]);
      const row = rows[0];
      return row === undefined ? null : validationFromRow(row);
    },

    async updateValidation(validation_id, whenStates, patch) {
      if (!UUID_TEXT.test(validation_id)) return null;
      const { sql, params } = setClauses(patch, VALIDATION_PATCH_COLUMNS, 3);
      const sets = sql.length === 0 ? "validation_id = validation_id" : sql.join(", ");
      const { rows } = await pool.query(`UPDATE otf.validations SET ${sets} WHERE validation_id = $1::uuid AND state = ANY($2::text[]) RETURNING *`, [validation_id, [...whenStates], ...params]);
      const row = rows[0];
      return row === undefined ? null : validationFromRow(row);
    },

    async getPower() {
      const { rows } = await pool.query(POWER_SELECT);
      const row = rows[0];
      if (row === undefined) throw new Error("otf store: the power row is missing (apply otf-migrations/0001_otf.sql)");
      return powerFromRow(row);
    },

    withPowerLock(fn) {
      return pool.transaction(async (tx) => {
        const { rows } = await tx.query(`${POWER_SELECT} FOR UPDATE`);
        const row = rows[0];
        if (row === undefined) throw new Error("otf store: the power row is missing (apply otf-migrations/0001_otf.sql)");
        const power = powerFromRow(row);
        const { patch, log, result } = await fn(clone(power));
        if (patch !== null) {
          checkPowerPatch(power, patch);
          const { sql, params } = setClauses(patch, POWER_PATCH_COLUMNS, 1);
          if (sql.length > 0) await tx.query(`UPDATE otf.power SET ${sql.join(", ")} WHERE id = 1`, params);
        }
        for (const entry of log) {
          await tx.query("INSERT INTO otf.power_log (at, actor, action, before, after, operation_id) VALUES ($1::timestamptz, $2, $3, $4, $5, $6)", [
            entry.at,
            entry.actor,
            entry.action,
            entry.before,
            entry.after,
            entry.operation_id,
          ]);
        }
        return result;
      });
    },
  };
}

// ---- in memory

interface MemoryJob {
  record: OtfJobRecord;
  events: (OtfEvent & { builder_seq: number | null; builder_bytes: string | null })[];
  lastBuilderSeq: number;
  artifacts: Map<OtfPart, OtfArtifactRecord & { bytes: Uint8Array }>;
}

export interface MemoryOtfStore extends OtfStore {
  /** The power log as written so far (tests). */
  powerLog(): OtfPowerLogEntry[];
  /** Sets the operator hold, as the operator script does in Postgres (tests). */
  setHold(hold_until: string | null): void;
  /**
   * claimNext without waiting for the power lock (it still claims nothing while the power row reads
   * stopping): the test-mode fake builder, which plays before every store call, also inside a lock.
   */
  claimNextUnlocked: OtfStore["claimNext"];
}

/** The power row a fresh store starts with, as the migration inserts it. */
export function initialPower(at: string): OtfPowerRecord {
  return {
    state: "unknown",
    since: at,
    preset: null,
    instance_state: null,
    last_api_call_at: null,
    last_start_at: null,
    last_stop_at: null,
    start_failures: 0,
    running_since: null,
    last_job_finished_at: null,
    vm_seconds_today: 0,
    vm_day: at.slice(0, 10),
    hold_until: null,
  };
}

/**
 * The OtfStore in one process's memory, with the Postgres store's behavior (the shared tests run
 * against both). Each call reads and writes without awaiting in between, so it is atomic; the power
 * lock is a queue, as the row lock is.
 */
export function createMemoryOtfStore(options: { now?: () => Date } = {}): MemoryOtfStore {
  const now = options.now ?? (() => new Date());
  const jobs = new Map<OtfJobId, MemoryJob>();
  const byClientKey = new Map<string, OtfJobId>();
  const validations = new Map<string, OtfValidationRecord>();
  const builders = new Map<string, OtfBuilderInfo & { last_seen_at: string }>();
  let power = initialPower(now().toISOString());
  const log: OtfPowerLogEntry[] = [];
  let powerTail: Promise<unknown> = Promise.resolve();

  const ordered = (list: OtfJobRecord[]): OtfJobRecord[] => list.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.job_id < b.job_id ? -1 : 1));

  function pushJobEvent(job: MemoryJob, event: ProductionEvent, at: string): OtfEvent {
    const stored = { ...clone(event), seq: job.events.length + 1, at } as OtfEvent;
    job.events.push({ ...stored, builder_seq: null, builder_bytes: null });
    return clone(stored);
  }

  function publicOf(event: MemoryJob["events"][number]): OtfEvent {
    const copy: Record<string, unknown> = clone({ ...event });
    delete copy.builder_seq;
    delete copy.builder_bytes;
    return copy as unknown as OtfEvent;
  }

  /** One claim, atomic (no await inside), refused while the power row reads stopping. */
  function claimNow(builder_id: string, at: string, opts: Parameters<OtfStore["claimNext"]>[2]): Awaited<ReturnType<OtfStore["claimNext"]>> {
    if (power.state === "stopping") return null;
    const validating = hostsWhere(opts.hosts, (entry) => entry.validate);
    if (validating.length > 0) {
      const claimable = (item: OtfValidationRecord): boolean => {
        const host = jobs.get(item.job_id)?.record.host_id;
        return item.state === "queued" && host !== undefined && validating.includes(host);
      };
      const queued = [...validations.values()].filter(claimable).sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : a.validation_id < b.validation_id ? -1 : 1))[0];
      if (queued !== undefined) {
        const next: OtfValidationRecord = { ...queued, state: "running", claimed_by: builder_id };
        validations.set(next.validation_id, next);
        return { kind: "validate", validation: clone(next) };
      }
    }
    const all = [...jobs.values()];
    const building = (host: OtfHostId): number => all.filter((job) => job.record.state === "building" && job.record.host_id === host).length;
    const open = hostsWhere(opts.hosts, (entry) => entry.build).filter((host) => building(host) < opts.hosts[host].maxActiveBuilds);
    const next = ordered(all.filter((job) => job.record.state === "queued" && open.includes(job.record.host_id)).map((job) => job.record))[0];
    if (next === undefined) return null;
    const job = jobs.get(next.job_id);
    if (job === undefined) return null;
    job.record = {
      ...job.record,
      state: "building",
      claimed_by: builder_id,
      claimed_at: at,
      deadline_at: addMs(at, opts.hosts[next.host_id].deadlineMs),
      lease_until: addMs(at, LEASE_MS),
      last_builder_post_at: at,
    };
    return { kind: "build", job: clone(job.record) };
  }

  return {
    createJob(job) {
      const existingId = byClientKey.get(job.client_key);
      if (existingId !== undefined) {
        const existing = jobs.get(existingId);
        if (existing === undefined) throw new Error("otf store: a client_key with no job");
        return Promise.resolve(existing.record.create_sha256 === job.create_sha256 ? { kind: "replayed", job: clone(existing.record) } : { kind: "conflict" });
      }
      if (jobs.has(job.job_id)) return Promise.reject(new Error("otf store: duplicate job_id"));
      const record: OtfJobRecord = {
        ...clone(job),
        outcome: null,
        reason: null,
        claimed_by: null,
        claimed_at: null,
        lease_until: null,
        deadline_at: null,
        last_builder_post_at: null,
        stop_requested_at: null,
        stop_reason: null,
        winner_lane: null,
        winner_model: null,
        model_microusd: 0,
        certificate: null,
        finished_at: null,
      };
      jobs.set(job.job_id, { record, events: [], lastBuilderSeq: 0, artifacts: new Map() });
      byClientKey.set(job.client_key, job.job_id);
      return Promise.resolve({ kind: "created", job: clone(record) });
    },

    getJob(job_id) {
      const job = jobs.get(job_id);
      return Promise.resolve(job === undefined ? null : clone(job.record));
    },

    listJobs(states) {
      return Promise.resolve(ordered([...jobs.values()].filter((job) => states.includes(job.record.state)).map((job) => clone(job.record))));
    },

    countJobsCreatedSince(at) {
      const since = Date.parse(at);
      return Promise.resolve([...jobs.values()].filter((job) => Date.parse(job.record.created_at) >= since).length);
    },

    totalModelMicrousd() {
      let total = 0;
      for (const job of jobs.values()) total += job.record.model_microusd;
      return Promise.resolve(total);
    },

    updateJob(job_id, whenStates, patch, when) {
      const job = jobs.get(job_id);
      if (job === undefined || !whenStates.includes(job.record.state)) return Promise.resolve(null);
      if (when !== undefined) {
        // As COALESCE(last_builder_post_at, claimed_at) <= quietSince: a job with neither never matches.
        const last = job.record.last_builder_post_at ?? job.record.claimed_at;
        if (last === null || Date.parse(last) > Date.parse(when.quietSince)) return Promise.resolve(null);
      }
      for (const key of Object.keys(patch)) if (!(key in JOB_PATCH_COLUMNS)) return Promise.reject(new Error(`otf store: ${key} cannot be patched`));
      const next = { ...job.record, ...clone(patch) };
      if (!jobInvariantHolds(next)) return Promise.reject(new Error(INVARIANT));
      job.record = next;
      return Promise.resolve(clone(next));
    },

    appendJobEvent(job_id, event, at) {
      const job = jobs.get(job_id);
      if (job === undefined) return Promise.reject(new Error("otf store: no job for this event"));
      return Promise.resolve(pushJobEvent(job, event, at));
    },

    appendBuilderEvents(job_id, builder_id, events, at) {
      const job = jobs.get(job_id);
      if (job === undefined) return Promise.resolve({ kind: "not_found" });
      if (job.record.state === "finished") return Promise.resolve({ kind: "finished" });
      if (job.record.state !== "building" || job.record.claimed_by !== builder_id) return Promise.resolve({ kind: "wrong_builder" });
      const plan = planBuilderEvents(events, job.lastBuilderSeq, (seq) => job.events.find((event) => event.builder_seq === seq)?.builder_bytes ?? undefined);
      if (plan.kind === "conflict") return Promise.resolve(plan);
      for (const event of plan.fresh) {
        const stored = publicEvent(clone(event), job.events.length + 1);
        job.events.push({ ...stored, builder_seq: event.builder_seq, builder_bytes: builderEventBytes(event) });
      }
      job.lastBuilderSeq = plan.through;
      const meter = plan.fresh.some((event) => event.type === "lane_meter") ? meterTotal(job.events) : 0;
      job.record = { ...job.record, lease_until: addMs(at, LEASE_MS), last_builder_post_at: at, model_microusd: Math.max(job.record.model_microusd, meter) };
      return Promise.resolve({ kind: "ok", accepted_through: plan.through });
    },

    listEvents(job_id, after) {
      const job = jobs.get(job_id);
      return Promise.resolve(job === undefined ? [] : job.events.filter((event) => event.seq > after).map(publicOf));
    },

    recordBuilderSeen(info, at) {
      const previous = builders.get(info.builder_id);
      builders.set(info.builder_id, { ...clone(info), last_seen_at: at });
      return Promise.resolve({ first_of_boot: previous?.boot_id !== info.boot_id });
    },

    lastBuilderSeen() {
      let latest: (OtfBuilderInfo & { last_seen_at: string }) | null = null;
      for (const builder of builders.values()) if (latest === null || builder.last_seen_at > latest.last_seen_at) latest = builder;
      return Promise.resolve(latest === null ? null : clone(latest));
    },

    claimNext(builder_id, at, opts) {
      // The claim waits for the power lock, as the Postgres claim takes the power row FOR SHARE.
      return powerTail.then(() => claimNow(builder_id, at, opts));
    },

    storeDelivery(job_id, builder_id, parts, patch, at) {
      const job = jobs.get(job_id);
      if (job === undefined) return Promise.resolve("not_found");
      if (job.record.state === "finished") {
        if (job.record.outcome !== "delivered") return Promise.resolve("finished");
        if (job.record.claimed_by !== builder_id) return Promise.resolve("wrong_builder");
        return Promise.resolve(sameParts([...job.artifacts.values()], parts) ? "replayed" : "conflict");
      }
      if (job.record.state !== "building" || job.record.claimed_by !== builder_id) return Promise.resolve("wrong_builder");
      for (const key of Object.keys(patch)) if (!(key in JOB_PATCH_COLUMNS)) return Promise.reject(new Error(`otf store: ${key} cannot be patched`));
      const next = { ...job.record, ...clone(patch) };
      if (!jobInvariantHolds(next)) return Promise.reject(new Error(INVARIANT));
      for (const part of parts) job.artifacts.set(part.part, { ...clone(part), job_id, bytes: new Uint8Array(part.bytes) });
      job.record = next;
      if (patch.state === "finished") pushJobEvent(job, finishedEvent(patch), at);
      return Promise.resolve("stored");
    },

    listArtifacts(job_id) {
      const job = jobs.get(job_id);
      if (job === undefined) return Promise.resolve([]);
      return Promise.resolve(
        [...job.artifacts.values()]
          .map((item): OtfArtifactRecord => ({ job_id: item.job_id, part: item.part, filename: item.filename, media_type: item.media_type, size: item.size, sha256: item.sha256 }))
          .sort((a, b) => (a.part < b.part ? -1 : 1)),
      );
    },

    getArtifact(job_id, part) {
      const found = jobs.get(job_id)?.artifacts.get(part);
      return Promise.resolve(found === undefined ? null : { ...clone(found), bytes: new Uint8Array(found.bytes) });
    },

    createValidation(job_id, validation_id, at) {
      if (!jobs.has(job_id)) return Promise.reject(new Error("otf store: no job for this validation"));
      if (validations.has(validation_id)) return Promise.reject(new Error("otf store: duplicate validation_id"));
      const record: OtfValidationRecord = { validation_id, job_id, state: "queued", cells: null, admission: null, started_at: at, finished_at: null, claimed_by: null };
      validations.set(validation_id, record);
      return Promise.resolve(clone(record));
    },

    getValidation(validation_id) {
      const found = validations.get(validation_id);
      return Promise.resolve(found === undefined ? null : clone(found));
    },

    latestValidation(job_id) {
      const list = [...validations.values()].filter((item) => item.job_id === job_id).sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : a.validation_id < b.validation_id ? 1 : -1));
      return Promise.resolve(list[0] === undefined ? null : clone(list[0]));
    },

    updateValidation(validation_id, whenStates, patch) {
      const found = validations.get(validation_id);
      if (found === undefined || !whenStates.includes(found.state)) return Promise.resolve(null);
      for (const key of Object.keys(patch)) if (!(key in VALIDATION_PATCH_COLUMNS)) return Promise.reject(new Error(`otf store: ${key} cannot be patched`));
      const next = { ...found, ...clone(patch) };
      validations.set(validation_id, next);
      return Promise.resolve(clone(next));
    },

    getPower() {
      return Promise.resolve(clone(power));
    },

    withPowerLock<T>(fn: (power: OtfPowerRecord) => Promise<{ patch: Partial<OtfPowerRecord> | null; log: OtfPowerLogEntry[]; result: T }>): Promise<T> {
      const run = powerTail.then(async () => {
        const { patch, log: entries, result } = await fn(clone(power));
        if (patch !== null) {
          checkPowerPatch(power, patch);
          for (const key of Object.keys(patch)) if (!(key in POWER_PATCH_COLUMNS)) throw new Error(`otf store: ${key} cannot be patched`);
          power = { ...power, ...clone(patch) };
        }
        log.push(...clone(entries));
        return result;
      });
      powerTail = run.catch(() => undefined);
      return run;
    },

    powerLog() {
      return clone(log);
    },

    setHold(hold_until) {
      power = { ...power, hold_until };
    },

    claimNextUnlocked(builder_id, at, opts) {
      return Promise.resolve(claimNow(builder_id, at, opts));
    },
  };
}


// ---- the live store

/**
 * Opens a node-postgres pool for DATABASE_URL. compose.ts sets it when an OTF route bundle loads;
 * until it is set, otfStoreFor answers null and every OTF route answers unavailable.
 */
let poolOpener: ((databaseUrl: string) => PgPoolLike) | null = null;

export function setOtfPoolOpener(opener: ((databaseUrl: string) => PgPoolLike) | null): void {
  poolOpener = opener;
  shared.__rbwOtfStores = undefined;
}

const shared = globalThis as { __rbwOtfStores?: Map<string, OtfStore> };

/** The live store for config.databaseUrl, one per process and URL; null without a URL or a driver. */
export function otfStoreFor(config: { databaseUrl: string | null }): Promise<OtfStore | null> {
  if (config.databaseUrl === null || poolOpener === null) return Promise.resolve(null);
  shared.__rbwOtfStores ??= new Map();
  let store = shared.__rbwOtfStores.get(config.databaseUrl);
  if (store === undefined) {
    store = createPgOtfStore(otfPoolFromPg(poolOpener(config.databaseUrl)));
    shared.__rbwOtfStores.set(config.databaseUrl, store);
  }
  return Promise.resolve(store);
}
