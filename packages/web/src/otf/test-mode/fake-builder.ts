// OTF test mode: a scripted, entirely SYNTHETIC builder for local development and browser proofs.
// No machine starts and no model is called. It plugs in through the contract's ports:
//
// - FakeVmPower is the VmPower port. start() moves the fake instance to STARTING, and it reads
//   RUNNING once the scenario's cold start has passed on the injected clock. In the
//   builder_start_failed scenario start() throws StartError("capacity").
// - FakeBuilder plays the scenario's timeline (timeline.ts) through an OtfStore, as the builder
//   machine and the builder routes would: once the fake instance runs it heartbeats, moves
//   starting_builder jobs to queued with builder_ready, claims with job_claimed, posts the builder
//   events with a gap-free builder_seq, and posts the result (a delivery with an invented
//   certificate and two tiny invented gzip bundles, or another outcome). It honors a customer stop
//   (stop_requested_at) and the job deadline at the moment each took effect, after replaying what
//   the script holds before it, so a late poll or a clock jump never changes the stream.
// - MemoryOtfStore is an in-memory OtfStore, so test mode needs no database.
// - OtfTestWorld ties them together on one clock. Its `store` advances the fake builder before
//   every call, so the customer routes need nothing special: they get `store` and `power` from the
//   world in place of Postgres and the cloud SDK, and the timeline plays as they read.
//
// Test mode is selected exactly as the factory's: RBW_FACTORY_TEST_MODE=1 on a local server, refused
// on any Vercel deployment (VERCEL_ENV preview or production). otfTestWorld() throws outside it.
//
// Durations inside event data (cold_start_ms, goose_ms, qualify_ms, the certificate's wall_ms) are
// script time, what a real run would report; timestamps are the injected clock's, compressed by the
// world's speed (60 by default: a 16-minute script plays in 16 seconds).
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { loadFactoryConfig } from "../../config.ts";
import { builderEventBytes, canonicalJson } from "../canonical.ts";
import {
  AGENT_LABEL,
  CERTIFICATE_FORMAT,
  CERTIFICATE_RUNNER,
  COPY_LIMITS,
  EXPECTED_CELLS,
  LEASE_MS,
  OTF_DEFAULTS,
  StartError,
  TOKEN_FACTORY_PROVIDER,
  type AppendBuilderEventsResult,
  type BuilderEventIn,
  type CreateJobResult,
  type JobPatch,
  type NebiusInstanceState,
  type OtfArtifactRecord,
  type OtfBuilderInfo,
  type OtfCertificate,
  type OtfCriterionId,
  type OtfEvent,
  type OtfJobId,
  type OtfJobRecord,
  type OtfJobState,
  type OtfNewJob,
  type OtfPart,
  type OtfPowerLogEntry,
  type OtfPowerRecord,
  type OtfStore,
  type OtfValidationRecord,
  type OtfValidationState,
  type ProductionEvent,
  type ResultPart,
  type ResultPost,
  type SixCells,
  type VmPower,
} from "../contract.ts";
import {
  REASON_TEXT,
  TEST_BUILDER_REVISION,
  TEST_PRESET,
  lastMeters,
  scenarioScript,
  stopSteps,
  type OtfTestScenario,
  type ScenarioScript,
  type ScriptStep,
} from "./timeline.ts";

const iso = (ms: number): string => new Date(Math.floor(ms)).toISOString();
const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** A validation run on the fake builder takes this long (script time) and always passes. */
const VALIDATION_MS = 180_000;

/** Stands for grader material: it is in the grader bundle only, so a test can check no JSON body carries it. */
export const OTF_TEST_GRADER_SENTINEL = "synthetic-otf-test-mode-grader-material-7c41";

// ---- the in-memory store

interface StoredJob {
  record: OtfJobRecord;
  events: OtfEvent[];
  /** builderEventBytes of each stored builder event, by builder_seq - 1. */
  builderBytes: string[];
  artifacts: Map<OtfPart, OtfArtifactRecord & { bytes: Uint8Array }>;
}

const byCreated = (a: OtfJobRecord, b: OtfJobRecord): number => Date.parse(a.created_at) - Date.parse(b.created_at);

/** OtfStore in one process's memory. Every read returns a copy, so a caller can never change stored state. */
export class MemoryOtfStore implements OtfStore {
  private readonly jobs = new Map<OtfJobId, StoredJob>();
  private readonly keys = new Map<string, OtfJobId>();
  private readonly validations = new Map<string, OtfValidationRecord>();
  private readonly boots = new Set<string>();
  private seen: (OtfBuilderInfo & { last_seen_at: string }) | null = null;
  private power: OtfPowerRecord;
  readonly powerLog: OtfPowerLogEntry[] = [];
  private powerQueue: Promise<unknown> = Promise.resolve();

  constructor(at: string = new Date().toISOString()) {
    this.power = {
      state: "stopped",
      since: at,
      preset: TEST_PRESET,
      instance_state: "STOPPED",
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

  createJob(job: OtfNewJob): Promise<CreateJobResult> {
    const existing = this.keys.get(job.client_key);
    if (existing !== undefined) {
      const stored = this.stored(existing);
      return Promise.resolve(stored.record.create_sha256 === job.create_sha256 ? { kind: "replayed", job: structuredClone(stored.record) } : { kind: "conflict" });
    }
    const record: OtfJobRecord = {
      ...structuredClone(job),
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
    this.jobs.set(job.job_id, { record, events: [], builderBytes: [], artifacts: new Map() });
    this.keys.set(job.client_key, job.job_id);
    return Promise.resolve({ kind: "created", job: structuredClone(record) });
  }

  getJob(job_id: OtfJobId): Promise<OtfJobRecord | null> {
    const stored = this.jobs.get(job_id);
    return Promise.resolve(stored === undefined ? null : structuredClone(stored.record));
  }

  listJobs(states: readonly OtfJobState[]): Promise<OtfJobRecord[]> {
    const list = [...this.jobs.values()].map((stored) => stored.record).filter((record) => states.includes(record.state));
    return Promise.resolve(list.sort(byCreated).map((record) => structuredClone(record)));
  }

  countJobsCreatedSince(at: string): Promise<number> {
    const since = Date.parse(at);
    return Promise.resolve([...this.jobs.values()].filter((stored) => Date.parse(stored.record.created_at) >= since).length);
  }

  totalModelMicrousd(): Promise<number> {
    return Promise.resolve([...this.jobs.values()].reduce((sum, stored) => sum + stored.record.model_microusd, 0));
  }

  updateJob(job_id: OtfJobId, whenStates: readonly OtfJobState[], patch: JobPatch): Promise<OtfJobRecord | null> {
    const stored = this.jobs.get(job_id);
    if (stored === undefined || !whenStates.includes(stored.record.state)) return Promise.resolve(null);
    Object.assign(stored.record, structuredClone(patch));
    return Promise.resolve(structuredClone(stored.record));
  }

  appendJobEvent(job_id: OtfJobId, event: ProductionEvent, at: string): Promise<OtfEvent> {
    const stored = this.stored(job_id);
    const appended = { seq: stored.events.length + 1, at, ...structuredClone(event) } as OtfEvent;
    stored.events.push(appended);
    return Promise.resolve(structuredClone(appended));
  }

  appendBuilderEvents(job_id: OtfJobId, builder_id: string, events: readonly BuilderEventIn[], at: string): Promise<AppendBuilderEventsResult> {
    const stored = this.jobs.get(job_id);
    if (stored === undefined) return Promise.resolve({ kind: "not_found" });
    if (stored.record.state === "finished") return Promise.resolve({ kind: "finished" });
    if (stored.record.claimed_by !== builder_id) return Promise.resolve({ kind: "wrong_builder" });
    const accepted = stored.builderBytes.length;
    const fresh: BuilderEventIn[] = [];
    for (const event of events) {
      const bytes = builderEventBytes(event);
      if (event.builder_seq <= accepted) {
        if (stored.builderBytes[event.builder_seq - 1] !== bytes) return Promise.resolve({ kind: "conflict", accepted_through: accepted, builder_seq: event.builder_seq });
        continue;
      }
      if (event.builder_seq !== accepted + fresh.length + 1) return Promise.resolve({ kind: "conflict", accepted_through: accepted, builder_seq: event.builder_seq });
      fresh.push(event);
    }
    for (const event of fresh) {
      stored.builderBytes.push(builderEventBytes(event));
      // The public event: production's seq in place of the builder's own builder_seq.
      stored.events.push({ seq: stored.events.length + 1, at: event.at, type: event.type, lane_id: event.lane_id, data: structuredClone(event.data) } as OtfEvent);
    }
    stored.record.lease_until = iso(Date.parse(at) + LEASE_MS);
    stored.record.last_builder_post_at = at;
    return Promise.resolve({ kind: "ok", accepted_through: stored.builderBytes.length });
  }

  listEvents(job_id: OtfJobId, after: number): Promise<OtfEvent[]> {
    const stored = this.jobs.get(job_id);
    return Promise.resolve(stored === undefined ? [] : structuredClone(stored.events.filter((event) => event.seq > after)));
  }

  recordBuilderSeen(info: OtfBuilderInfo, at: string): Promise<{ first_of_boot: boolean }> {
    const key = `${info.builder_id}\n${info.boot_id}`;
    const first = !this.boots.has(key);
    this.boots.add(key);
    this.seen = { ...info, last_seen_at: at };
    return Promise.resolve({ first_of_boot: first });
  }

  lastBuilderSeen(): Promise<(OtfBuilderInfo & { last_seen_at: string }) | null> {
    return Promise.resolve(this.seen === null ? null : { ...this.seen });
  }

  claimNext(
    builder_id: string,
    at: string,
    opts: { maxActiveBuilds: number; deadlineMs: number; build: boolean; validate: boolean },
  ): Promise<{ kind: "build"; job: OtfJobRecord } | { kind: "validate"; validation: OtfValidationRecord } | null> {
    if (opts.validate) {
      const waiting = [...this.validations.values()].filter((run) => run.state === "queued").sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))[0];
      if (waiting !== undefined) {
        waiting.state = "running";
        waiting.claimed_by = builder_id;
        return Promise.resolve({ kind: "validate", validation: structuredClone(waiting) });
      }
    }
    if (!opts.build) return Promise.resolve(null);
    const records = [...this.jobs.values()].map((stored) => stored.record);
    if (records.filter((record) => record.state === "building").length >= opts.maxActiveBuilds) return Promise.resolve(null);
    const next = records.filter((record) => record.state === "queued").sort(byCreated)[0];
    if (next === undefined) return Promise.resolve(null);
    const now = Date.parse(at);
    Object.assign(next, { state: "building", claimed_by: builder_id, claimed_at: at, deadline_at: iso(now + opts.deadlineMs), lease_until: iso(now + LEASE_MS) } satisfies Partial<OtfJobRecord>);
    return Promise.resolve({ kind: "build", job: structuredClone(next) });
  }

  /** Also appends job_finished, in the same step (SPEC section 3.2: store, set received, append job_finished, at once). */
  storeDelivery(
    job_id: OtfJobId,
    builder_id: string,
    parts: readonly (OtfArtifactRecord & { bytes: Uint8Array })[],
    patch: JobPatch,
  ): Promise<"stored" | "replayed" | "conflict" | "finished" | "wrong_builder" | "not_found"> {
    const stored = this.jobs.get(job_id);
    if (stored === undefined) return Promise.resolve("not_found");
    const { record } = stored;
    if (record.state === "finished") {
      if (record.outcome !== "delivered") return Promise.resolve("finished");
      const same = parts.length === stored.artifacts.size && parts.every((part) => stored.artifacts.get(part.part)?.sha256 === part.sha256);
      return Promise.resolve(same ? "replayed" : "conflict");
    }
    if (record.state !== "building") return Promise.resolve("finished");
    if (record.claimed_by !== builder_id) return Promise.resolve("wrong_builder");
    for (const part of parts) stored.artifacts.set(part.part, { ...structuredClone(part), bytes: new Uint8Array(part.bytes) });
    Object.assign(record, structuredClone(patch));
    const at = record.finished_at ?? new Date().toISOString();
    stored.events.push({ seq: stored.events.length + 1, at, type: "job_finished", lane_id: null, data: { outcome: record.outcome ?? "delivered", reason: record.reason } });
    return Promise.resolve("stored");
  }

  listArtifacts(job_id: OtfJobId): Promise<OtfArtifactRecord[]> {
    const stored = this.jobs.get(job_id);
    return Promise.resolve(stored === undefined ? [] : [...stored.artifacts.values()].map((found) => ({ job_id: found.job_id, part: found.part, filename: found.filename, media_type: found.media_type, size: found.size, sha256: found.sha256 })));
  }

  getArtifact(job_id: OtfJobId, part: OtfPart): Promise<(OtfArtifactRecord & { bytes: Uint8Array }) | null> {
    const found = this.jobs.get(job_id)?.artifacts.get(part);
    return Promise.resolve(found === undefined ? null : { ...found, bytes: new Uint8Array(found.bytes) });
  }

  createValidation(job_id: OtfJobId, validation_id: string, at: string): Promise<OtfValidationRecord> {
    const record: OtfValidationRecord = { validation_id, job_id, state: "queued", cells: null, started_at: at, finished_at: null, claimed_by: null };
    this.validations.set(validation_id, record);
    return Promise.resolve(structuredClone(record));
  }

  getValidation(validation_id: string): Promise<OtfValidationRecord | null> {
    const found = this.validations.get(validation_id);
    return Promise.resolve(found === undefined ? null : structuredClone(found));
  }

  latestValidation(job_id: OtfJobId): Promise<OtfValidationRecord | null> {
    const runs = [...this.validations.values()].filter((run) => run.job_id === job_id);
    const latest = runs.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];
    return Promise.resolve(latest === undefined ? null : structuredClone(latest));
  }

  updateValidation(
    validation_id: string,
    whenStates: readonly OtfValidationState[],
    patch: Partial<Pick<OtfValidationRecord, "state" | "cells" | "finished_at">>,
  ): Promise<OtfValidationRecord | null> {
    const found = this.validations.get(validation_id);
    if (found === undefined || !whenStates.includes(found.state)) return Promise.resolve(null);
    Object.assign(found, structuredClone(patch));
    return Promise.resolve(structuredClone(found));
  }

  getPower(): Promise<OtfPowerRecord> {
    return Promise.resolve(structuredClone(this.power));
  }

  withPowerLock<T>(fn: (power: OtfPowerRecord) => Promise<{ patch: Partial<OtfPowerRecord> | null; log: OtfPowerLogEntry[]; result: T }>): Promise<T> {
    const run = this.powerQueue.then(async () => {
      const { patch, log, result } = await fn(structuredClone(this.power));
      if (patch !== null) this.power = { ...this.power, ...structuredClone(patch) };
      this.powerLog.push(...structuredClone(log));
      return result;
    });
    this.powerQueue = run.catch(() => undefined);
    return run;
  }

  private stored(job_id: OtfJobId): StoredJob {
    const stored = this.jobs.get(job_id);
    if (stored === undefined) throw new Error(`otf test mode: no job ${job_id}`);
    return stored;
  }
}

// ---- the fake power port

export class FakeVmPower implements VmPower {
  private readonly clock: () => number;
  private readonly coldStartMs: number;
  private readonly failure: "capacity" | "api_error" | null;
  private state: NebiusInstanceState = "STOPPED";
  private operations = 0;
  /** The wall time of the last start request that moved the instance, or null. */
  lastStartMs: number | null = null;
  /** Every call, in order, for tests. */
  readonly calls: ("get" | "start" | "stop")[] = [];

  constructor(clock: () => number, options: { coldStartMs: number; failure: "capacity" | "api_error" | null }) {
    this.clock = clock;
    this.coldStartMs = options.coldStartMs;
    this.failure = options.failure;
  }

  /** The instance state now: STARTING turns RUNNING once the cold start has passed. */
  instanceState(): NebiusInstanceState {
    if (this.state === "STARTING" && this.lastStartMs !== null && this.clock() - this.lastStartMs >= this.coldStartMs) this.state = "RUNNING";
    return this.state;
  }

  get(): Promise<{ state: NebiusInstanceState; preset: string }> {
    this.calls.push("get");
    return Promise.resolve({ state: this.instanceState(), preset: TEST_PRESET });
  }

  start(): Promise<{ operation_id: string }> {
    this.calls.push("start");
    if (this.failure !== null) return Promise.reject(new StartError(this.failure, "synthetic test mode: the fake instance has no capacity for its preset"));
    const state = this.instanceState();
    if (state !== "RUNNING" && state !== "STARTING") {
      this.state = "STARTING";
      this.lastStartMs = this.clock();
    }
    return Promise.resolve({ operation_id: this.operationId() });
  }

  stop(): Promise<{ operation_id: string }> {
    this.calls.push("stop");
    this.state = "STOPPED";
    return Promise.resolve({ operation_id: this.operationId() });
  }

  private operationId(): string {
    this.operations += 1;
    return `synthetic-operation-${String(this.operations)}`;
  }
}

// ---- the invented delivery

const encoder = new TextEncoder();

/** One ustar entry: a 512-byte header (mtime 0, owner 0) and the content padded to 512 bytes. */
function tarEntry(name: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  const put = (text: string, offset: number): void => {
    header.set(encoder.encode(text), offset);
  };
  put(name, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put("0", 156);
  put("ustar\0", 257);
  put("00", 263);
  put(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
  const body = new Uint8Array(Math.ceil(content.length / 512) * 512);
  body.set(content);
  return Buffer.concat([header, body]);
}

/** A tiny deterministic .tar.gz of these text files. */
export function syntheticTarGz(files: readonly (readonly [string, string])[]): Uint8Array {
  const tar = Buffer.concat([...files.map(([name, text]) => tarEntry(name, encoder.encode(text))), new Uint8Array(1024)]);
  return new Uint8Array(gzipSync(tar, { level: 9 }));
}

export interface SyntheticDelivery {
  /** As the builder sends it: received is null. */
  certificate: OtfCertificate;
  parts: (OtfArtifactRecord & { bytes: Uint8Array })[];
  post: ResultPost;
}

export interface DeliveryInput {
  job_id: OtfJobId;
  criterion_id: OtfCriterionId;
  spec_sha256: string;
  builder_id: string;
  claimed_at_ms: number;
  speed: number;
  script: Pick<ScenarioScript, "lanes" | "steps" | "result" | "winner">;
}

function winnerCells(steps: readonly ScriptStep[], lane: string): { cells: SixCells; confirmation_cells: SixCells } {
  let cells: SixCells | null = null;
  let confirmation: SixCells | null = null;
  for (const { event } of steps) {
    if (event.type !== "round_finished" || event.lane_id !== lane || event.data.result !== "qualified") continue;
    if (event.data.kind === "qualification") cells = event.data.cells;
    if (event.data.kind === "confirmation") confirmation = event.data.cells;
  }
  return { cells: structuredClone(cells ?? EXPECTED_CELLS), confirmation_cells: structuredClone(confirmation ?? EXPECTED_CELLS) };
}

/** The invented certificate, the two invented bundles and the certificate part, and the result post that carries them. */
export function syntheticDelivery(input: DeliveryInput): SyntheticDelivery {
  const { job_id, script } = input;
  const winner = script.winner;
  if (winner === null) throw new Error("otf test mode: a delivery needs a winner");
  const job8 = job_id.slice(0, 8);
  const agent = syntheticTarGz([
    ["rbw-otf-agent/SYNTHETIC-TEST-MODE.txt", `Synthetic OTF test-mode agent bundle for job ${job_id}.\nIt holds no application source, no checks, no fix and no spec.\n`],
    ["rbw-otf-agent/INCIDENT.md", "# Synthetic incident\n\nInvented for test mode: after two quick saves, one saved value is missing from the list.\n"],
  ]);
  const grader = syntheticTarGz([
    ["rbw-otf-grader/SYNTHETIC-TEST-MODE.txt", `Synthetic OTF test-mode grader bundle for job ${job_id}.\nIn a real grader bundle the checks are model-written code.\n`],
    ["rbw-otf-grader/checks/synthetic-overlap-write.txt", `Invented check placeholder.\n${OTF_TEST_GRADER_SENTINEL}\n`],
  ]);
  const meters = [...lastMeters(script.steps.filter((step) => step.at_ms <= script.result.at_ms)).values()];
  const at = (ms: number): string => iso(input.claimed_at_ms + ms / input.speed);
  const certificate: OtfCertificate = {
    format: CERTIFICATE_FORMAT,
    job_id,
    host_id: "task-report",
    app_base_commit: createHash("sha1").update("synthetic-otf-test-mode-app-base").digest("hex"),
    criterion: { criterion_id: input.criterion_id, version: "1", failure_code: "synthetic-failure-code" },
    spec_sha256: input.spec_sha256,
    designer: { model: "synthetic/designer-model", route: "bug-spec" },
    implementer: { lane_id: winner.lane_id, agent: AGENT_LABEL, provider: TOKEN_FACTORY_PROVIDER, model: winner.model, rounds_used: winner.rounds_used },
    qualification: { ...winnerCells(script.steps, winner.lane_id), result: "qualified" },
    harness: {
      tier: "B",
      kit_image_id: `sha256:${sha256("synthetic-otf-test-mode-kit-image")}`,
      copy_limits: COPY_LIMITS,
      instances: { clean: 1, buggy: 3, fixed: 3 },
      runner: CERTIFICATE_RUNNER,
      harness_sha256: sha256("synthetic-otf-test-mode-harness"),
    },
    bundles: { agent_sha256: sha256(agent), grader_sha256: sha256(grader) },
    spend: {
      model_microusd: meters.reduce((sum, meter) => sum + meter.cost_microusd, 0),
      tokens_in: meters.reduce((sum, meter) => sum + meter.tokens_in, 0),
      tokens_out: meters.reduce((sum, meter) => sum + meter.tokens_out, 0),
      lanes: script.lanes.length,
    },
    timings: { started_at: at(0), qualified_at: at(winner.qualified_at_ms), wall_ms: Math.round(script.result.at_ms) },
    issued_at: at(script.result.at_ms),
    builder_revision: TEST_BUILDER_REVISION,
    received: null,
  };
  const certificateBytes = encoder.encode(canonicalJson(certificate));
  const record = (part: OtfPart, filename: string, media_type: OtfArtifactRecord["media_type"], bytes: Uint8Array): OtfArtifactRecord & { bytes: Uint8Array } => ({
    job_id,
    part,
    filename,
    media_type,
    size: bytes.length,
    sha256: sha256(bytes),
    bytes,
  });
  const parts = [
    record("agent", `rbw-otf-agent-${job8}.tar.gz`, "application/gzip", agent),
    record("grader", `rbw-otf-grader-${job8}.tar.gz`, "application/gzip", grader),
    record("certificate", `rbw-otf-certificate-${job8}.json`, "application/json", certificateBytes),
  ];
  const wire: ResultPart[] = parts.map((part) => ({ part: part.part, filename: part.filename, sha256: part.sha256, size: part.size, base64: Buffer.from(part.bytes).toString("base64") }));
  return { certificate, parts, post: { builder_id: input.builder_id, outcome: "delivered", reason: null, certificate, parts: wire } };
}

// ---- the fake builder

interface Run {
  job: OtfJobRecord;
  claimedMs: number;
  steps: ScriptStep[];
  result: ScenarioScript["result"];
  winner: ScenarioScript["winner"];
  lanes: ScenarioScript["lanes"];
  posted: number;
  cut: boolean;
}

export interface FakeBuilderOptions {
  store: OtfStore;
  power: FakeVmPower;
  clock: () => number;
  scenario: OtfTestScenario;
  /** Script milliseconds per clock millisecond. */
  speed: number;
  builder_id?: string;
}

export class FakeBuilder {
  readonly builder_id: string;
  private readonly store: OtfStore;
  private readonly power: FakeVmPower;
  private readonly clock: () => number;
  private readonly scenario: OtfTestScenario;
  private readonly speed: number;
  private boot: { boot_id: string; booted_at: string } | null = null;
  private boots = 0;
  private readonly runs = new Map<OtfJobId, Run>();
  /** Validation id to the clock time it finishes. */
  private readonly validations = new Map<string, number>();

  constructor(options: FakeBuilderOptions) {
    this.store = options.store;
    this.power = options.power;
    this.clock = options.clock;
    this.scenario = options.scenario;
    this.speed = options.speed;
    this.builder_id = options.builder_id ?? "synthetic-builder-1";
  }

  /** Jobs this builder is playing now. */
  get active(): number {
    return this.runs.size;
  }

  /** Plays everything due at the clock's current time. Call it before every read of the store. */
  async advance(): Promise<void> {
    const now = this.clock();
    if (this.power.instanceState() !== "RUNNING") {
      // A stopped machine loses its work; production finds the jobs builder_lost.
      this.boot = null;
      this.runs.clear();
      this.validations.clear();
      return;
    }
    if (this.boot === null) {
      this.boots += 1;
      this.boot = { boot_id: `synthetic-boot-${String(this.boots)}`, booted_at: iso(now) };
    }
    const at = iso(now);
    await this.store.recordBuilderSeen({ builder_id: this.builder_id, builder_revision: TEST_BUILDER_REVISION, ...this.boot }, at);
    await this.promoteWaiting(now);
    await this.claim(now);
    for (const run of [...this.runs.values()]) await this.play(run, now);
    for (const [validation_id, due] of [...this.validations]) {
      if (due > now) continue;
      this.validations.delete(validation_id);
      await this.store.updateValidation(validation_id, ["running"], { state: "passed", cells: structuredClone(EXPECTED_CELLS), finished_at: iso(due) });
    }
  }

  /** What the claim route does on a healthy claim: every starting_builder job moves to queued with builder_ready. */
  private async promoteWaiting(now: number): Promise<void> {
    for (const job of await this.store.listJobs(["starting_builder"])) {
      if ((await this.store.updateJob(job.job_id, ["starting_builder"], { state: "queued" })) === null) continue;
      const from = Math.max(this.power.lastStartMs ?? now, Date.parse(job.created_at));
      await this.store.appendJobEvent(job.job_id, { type: "builder_ready", lane_id: null, data: { cold_start_ms: Math.max(0, Math.round((now - from) * this.speed)) } }, iso(now));
    }
  }

  private async claim(now: number): Promise<void> {
    for (;;) {
      const claimed = await this.store.claimNext(this.builder_id, iso(now), {
        maxActiveBuilds: OTF_DEFAULTS.max_active,
        deadlineMs: Math.round(OTF_DEFAULTS.deadline_ms / this.speed),
        build: true,
        validate: true,
      });
      if (claimed === null) return;
      if (claimed.kind === "validate") {
        this.validations.set(claimed.validation.validation_id, now + VALIDATION_MS / this.speed);
        continue;
      }
      await this.store.appendJobEvent(claimed.job.job_id, { type: "job_claimed", lane_id: null, data: { builder_revision: TEST_BUILDER_REVISION } }, iso(now));
      const script = scenarioScript(this.scenario);
      this.runs.set(claimed.job.job_id, { job: claimed.job, claimedMs: now, steps: script.steps, result: script.result, winner: script.winner, lanes: script.lanes, posted: 0, cut: false });
    }
  }

  /** Replaces the rest of the script with every live lane stopping now and the given result. */
  private cut(run: Run, atMs: number, lane: "cancelled", laneReason: string, result: ScenarioScript["result"]): void {
    const posted = run.steps.slice(0, run.posted);
    run.steps = [...posted, ...stopSteps(posted, atMs, lane, laneReason)];
    run.result = result;
    run.winner = null;
    run.cut = true;
  }

  private async play(run: Run, now: number): Promise<void> {
    const job = await this.store.getJob(run.job.job_id);
    if (job?.state !== "building" || job.claimed_by !== this.builder_id) {
      this.runs.delete(run.job.job_id);
      return;
    }
    const elapsed = (now - run.claimedMs) * this.speed;
    // A stop or a passed deadline takes effect at its own moment on script time, not at the moment this
    // post happens: everything scripted before it is replayed first, so a late or skipped poll (a clock
    // jump) never changes the stream. The earlier of the two wins.
    let limit: { atMs: number; kind: "customer" | "deadline" } | null = null;
    if (!run.cut) {
      const toScript = (at: string): number => Math.max(0, (Date.parse(at) - run.claimedMs) * this.speed);
      if (job.stop_requested_at !== null) limit = { atMs: Math.min(toScript(job.stop_requested_at), elapsed), kind: "customer" };
      if (job.deadline_at !== null && now >= Date.parse(job.deadline_at) && run.result.outcome !== "time_limit") {
        const atMs = toScript(job.deadline_at);
        if (limit === null || atMs < limit.atMs) limit = { atMs, kind: "deadline" };
      }
    }
    if (!(await this.post(run, job, limit === null ? elapsed : limit.atMs, now))) return;
    if (this.finishDue(run, limit === null ? elapsed : limit.atMs)) return this.finish(run, job);
    if (limit !== null) {
      // Once a winner is selected the delivery goes ahead; otherwise every live lane stops at the limit.
      const selected = run.steps.slice(0, run.posted).some((step) => step.event.type === "winner_selected");
      if (!selected) {
        const atMs = Math.max(limit.atMs, run.steps[run.posted - 1]?.at_ms ?? 0);
        if (limit.kind === "customer") this.cut(run, atMs, "cancelled", REASON_TEXT.customer_lane, { at_ms: atMs + 2_000, outcome: "cancelled", reason: REASON_TEXT.cancelled });
        else this.cut(run, atMs, "cancelled", REASON_TEXT.deadline_lane, { at_ms: atMs + 2_000, outcome: "time_limit", reason: REASON_TEXT.time_limit });
      }
      if (!(await this.post(run, job, elapsed, now))) return;
      if (this.finishDue(run, elapsed)) return this.finish(run, job);
    }
  }

  private finishDue(run: Run, upTo: number): boolean {
    return run.posted === run.steps.length && run.result.at_ms <= upTo;
  }

  /** Posts every step due up to `upTo` (script time); an empty post is the heartbeat. False when the job is gone. */
  private async post(run: Run, job: OtfJobRecord, upTo: number, now: number): Promise<boolean> {
    const due: ScriptStep[] = [];
    for (let k = run.posted; k < run.steps.length; k += 1) {
      const step = run.steps[k];
      if (step === undefined || step.at_ms > upTo) break;
      due.push(step);
    }
    const events = due.map((step, k) => ({ ...structuredClone(step.event), builder_seq: run.posted + k + 1, at: iso(run.claimedMs + step.at_ms / this.speed) }));
    // Every post extends the lease.
    const reply = await this.store.appendBuilderEvents(job.job_id, this.builder_id, events, iso(now));
    if (reply.kind !== "ok") {
      this.runs.delete(job.job_id);
      return false;
    }
    run.posted += due.length;
    if (due.some((step) => step.event.type === "lane_meter")) {
      const spend = [...lastMeters(run.steps.slice(0, run.posted)).values()].reduce((sum, meter) => sum + meter.cost_microusd, 0);
      await this.store.updateJob(job.job_id, ["building"], { model_microusd: spend });
    }
    return true;
  }

  private async finish(run: Run, job: OtfJobRecord): Promise<void> {
    this.runs.delete(job.job_id);
    const finishedAt = iso(run.claimedMs + run.result.at_ms / this.speed);
    if (run.result.outcome === "delivered" && run.winner !== null) {
      const delivery = syntheticDelivery({
        job_id: job.job_id,
        criterion_id: job.criterion_id,
        spec_sha256: job.spec_sha256,
        builder_id: this.builder_id,
        claimed_at_ms: run.claimedMs,
        speed: this.speed,
        script: run,
      });
      // As production stores it: received set once the hashes check (they are this builder's own here).
      const certificate: OtfCertificate = { ...delivery.certificate, received: { at: finishedAt, sha256_verified: true } };
      await this.store.storeDelivery(job.job_id, this.builder_id, delivery.parts, {
        state: "finished",
        outcome: "delivered",
        reason: null,
        winner_lane: run.winner.lane_id,
        winner_model: run.winner.model,
        model_microusd: certificate.spend.model_microusd,
        certificate,
        finished_at: finishedAt,
        lease_until: null,
      });
      return;
    }
    const finished = await this.store.updateJob(job.job_id, ["building"], { state: "finished", outcome: run.result.outcome, reason: run.result.reason, finished_at: finishedAt, lease_until: null });
    if (finished !== null) await this.store.appendJobEvent(job.job_id, { type: "job_finished", lane_id: null, data: { outcome: run.result.outcome, reason: run.result.reason } }, finishedAt);
  }
}

// ---- the world: one store, one power port and one fake builder on one clock

export const DEFAULT_TEST_SPEED = 60;

export interface OtfTestWorldOptions {
  scenario?: OtfTestScenario;
  /** The clock in milliseconds; Date.now by default. */
  clock?: () => number;
  /** Script milliseconds per clock millisecond; DEFAULT_TEST_SPEED by default. */
  speed?: number;
}

interface WorldState {
  scenario: OtfTestScenario;
  speed: number;
  memory: MemoryOtfStore;
  power: FakeVmPower;
  builder: FakeBuilder;
}

export class OtfTestWorld {
  private readonly clock: () => number;
  private current: WorldState;
  private pending: Promise<void> | null = null;
  /** The store the customer routes use: every call first plays what is due. Stable across reset(). */
  readonly store: OtfStore;
  /** The power port the customer routes use. Stable across reset(). */
  readonly power: VmPower;

  constructor(options: OtfTestWorldOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.current = this.build(options.scenario ?? "delivered", options.speed ?? DEFAULT_TEST_SPEED);
    this.store = this.advancingStore();
    this.power = {
      get: () => this.current.power.get(),
      start: () => this.current.power.start(),
      stop: () => this.current.power.stop(),
    };
  }

  get scenario(): OtfTestScenario {
    return this.current.scenario;
  }

  get speed(): number {
    return this.current.speed;
  }

  /** The store and fakes underneath, without advancing: for tests and evidence. */
  get fakes(): Readonly<WorldState> {
    return this.current;
  }

  now(): Date {
    return new Date(this.clock());
  }

  /** Discards every job, the power state and the builder, and selects a scenario for the next jobs. */
  reset(scenario: OtfTestScenario, speed: number = this.current.speed): void {
    this.current = this.build(scenario, speed);
    this.pending = null;
  }

  /** Plays what is due now. Concurrent callers share one pass. */
  advance(): Promise<void> {
    this.pending ??= this.current.builder.advance().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private build(scenario: OtfTestScenario, speed: number): WorldState {
    if (!(speed > 0) || !Number.isFinite(speed)) throw new RangeError("otf test mode: speed must be a positive number");
    const script = scenarioScript(scenario);
    const memory = new MemoryOtfStore(iso(this.clock()));
    const power = new FakeVmPower(this.clock, { coldStartMs: script.cold_start_ms / speed, failure: script.start_failure });
    const builder = new FakeBuilder({ store: memory, power, clock: this.clock, scenario, speed });
    return { scenario, speed, memory, power, builder };
  }

  private advancingStore(): OtfStore {
    return new Proxy({} as OtfStore, {
      get: (_target, property) => {
        const inner = this.current.memory;
        const member: unknown = Reflect.get(inner, property);
        if (typeof member !== "function") return member;
        const method = member as (...args: unknown[]) => unknown;
        return async (...args: unknown[]): Promise<unknown> => {
          await this.advance();
          return method.apply(inner, args);
        };
      },
    });
  }
}

// ---- selection, as the factory's test mode

type Env = Readonly<Record<string, string | undefined>>;

export class OtfTestModeRefusedError extends Error {
  constructor() {
    super("otf test mode needs RBW_FACTORY_TEST_MODE=1 on a local server; it is refused on a Vercel deployment");
    this.name = "OtfTestModeRefusedError";
  }
}

/** "test" exactly when the factory's own test mode is selected; "refused" on a Vercel deployment that asks for it. */
export function otfTestMode(env: Env = process.env): "test" | "refused" | "off" {
  const { mode } = loadFactoryConfig(env);
  return mode === "live" ? "off" : mode;
}

const WORLD_KEY = "__rbwOtfTestWorld";

/** The test-mode world: one per server process, shared by every route bundle. Throws outside test mode. */
export function otfTestWorld(env: Env = process.env): OtfTestWorld {
  if (otfTestMode(env) !== "test") throw new OtfTestModeRefusedError();
  const holder = globalThis as typeof globalThis & { [WORLD_KEY]?: OtfTestWorld };
  holder[WORLD_KEY] ??= new OtfTestWorld();
  return holder[WORLD_KEY];
}

