// OTF test mode: a scripted, entirely SYNTHETIC builder for local development and browser proofs.
// No machine starts and no model is called. It plugs in through the contract's ports:
//
// - FakeVmPower is the VmPower port. start() moves the fake instance to STARTING, and it reads
//   RUNNING once the scenario's cold start has passed on the injected clock. In the
//   builder_start_failed scenario start() throws StartError("capacity").
// - FakeBuilder plays the scenario's timeline (timeline.ts) through an OtfStore, as the builder
//   machine and the builder routes would: once the fake instance runs it heartbeats (ready_hosts is
//   the scenario's host, so production offers only that host while the fake builder runs), moves
//   starting_builder jobs to queued with builder_ready, claims with job_claimed, posts the builder
//   events with a gap-free builder_seq, and posts the result (a delivery with an invented
//   certificate and two tiny invented gzip bundles, or another outcome). It honors a customer stop
//   (stop_requested_at) and the job deadline at the moment each took effect, after replaying what
//   the script holds before it, so a late poll or a clock jump never changes the stream.
// - The store is the production store's in-memory twin (store.ts createMemoryOtfStore), so test mode
//   needs no database and runs the same claim, event and delivery rules as Postgres.
// - OtfTestWorld ties them together on one clock. Its `store` advances the fake builder before
//   every call, so the customer routes need nothing special: they get `store` and `power` from the
//   world in place of Postgres and the cloud SDK, `now()` in place of the wall clock, and `hosts`
//   (every host enabled with its default profile, invented lanes and typical null) in place of the
//   per-host config, and the timeline plays as they read. In the umami_calendar_blocked scenario
//   `now()` starts on UTC day 3, so production's calendar check answers a Umami create
//   host_unavailable ("Umami is unavailable on UTC days 2–5.") and no job runs.
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
import { canonicalJson } from "../canonical.ts";
import { createMemoryOtfStore, type MemoryOtfStore } from "../store.ts";
import {
  ADMISSION_EVIDENCE,
  AGENT_LABEL,
  CERTIFICATE_FORMAT,
  CERTIFICATE_RUNNER,
  COPY_LIMITS,
  EXPECTED_CELLS,
  OTF_HOST_DEFAULTS,
  OTF_HOST_IDS,
  START_TIMEOUT_MS,
  CALENDAR_MARGIN_MS,
  StartError,
  hostCalendarOpen,
  TOKEN_FACTORY_PROVIDER,
  type NebiusInstanceState,
  type OtfArtifactRecord,
  type OtfCertificate,
  type OtfCriterionId,
  type OtfAdmissionResult,
  type OtfHostId,
  type OtfJobId,
  type OtfJobRecord,
  type OtfPart,
  type OtfStore,
  type QualifiedAdmission,
  type ResultPart,
  type ResultPost,
  type SixCells,
  type VmPower,
} from "../contract.ts";
import {
  REASON_TEXT,
  SCENARIO_HOST,
  TEST_BUILDER_REVISION,
  TEST_CALENDAR_BLOCKED_AT,
  TEST_COLD_START_MS,
  TEST_HOSTS,
  TEST_PRESET,
  isOtfTestJobScenario,
  lastMeters,
  scenarioRefusal,
  scenarioScript,
  stopSteps,
  timeLimitReason,
  type OtfTestHost,
  type OtfTestRefusal,
  type OtfTestScenario,
  type ScenarioScript,
  type ScriptStep,
} from "./timeline.ts";

const iso = (ms: number): string => new Date(Math.floor(ms)).toISOString();
const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** A validation run on the fake builder takes this long (script time) and always passes. */
const VALIDATION_MS = 180_000;

/** The only admission result a qualified Umami bundle carries; a passing validation repeats it. */
const QUALIFIED_ADMISSION: Readonly<QualifiedAdmission> = Object.freeze({
  decisions: Object.freeze({ adm_02: "pass", adm_03: "pass", adm_04: "pass", adm_05: "pass", adm_06: "pass" }),
  comparison: "blind_spot_demonstrated",
  alternative_fix: "pass",
});

/** The claim options a builder with these ready hosts sends (ClaimRequest.free per host), at this speed. */
export type ClaimHosts = Parameters<OtfStore["claimNext"]>[2]["hosts"];
export function claimHosts(ready: readonly OtfHostId[], speed: number, build = true): ClaimHosts {
  return Object.fromEntries(
    OTF_HOST_IDS.map((host) => {
      const profile = OTF_HOST_DEFAULTS[host];
      const isReady = ready.includes(host);
      return [host, { build: build && isReady, validate: isReady, maxActiveBuilds: profile.max_active, deadlineMs: Math.round(profile.deadline_ms / speed) }];
    }),
  ) as ClaimHosts;
}

/** Stands for grader material: it is in the grader bundle only, so a test can check no JSON body carries it. */
export const OTF_TEST_GRADER_SENTINEL = "synthetic-otf-test-mode-grader-material-7c41";

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
  script: Pick<ScenarioScript, "host_id" | "lanes" | "steps" | "result" | "winner">;
}

/** The winner's qualifying cells and admission result, and its confirmation cells (null when none ran). */
function winnerRounds(steps: readonly ScriptStep[], lane: string): { cells: SixCells; confirmation_cells: SixCells | null; admission: OtfAdmissionResult | null } {
  let cells: SixCells | null = null;
  let confirmation: SixCells | null = null;
  let admission: OtfAdmissionResult | null = null;
  for (const { event } of steps) {
    if (event.type !== "round_finished" || event.lane_id !== lane || event.data.result !== "qualified") continue;
    if (event.data.kind === "qualification") {
      cells = event.data.cells;
      admission = event.data.admission;
    }
    if (event.data.kind === "confirmation") confirmation = event.data.cells;
  }
  return { cells: structuredClone(cells ?? EXPECTED_CELLS), confirmation_cells: structuredClone(confirmation), admission: structuredClone(admission) };
}

/** Invented bundle text per host: no application source, no checks, no fix and no spec in the agent bundle. */
const INCIDENT: Readonly<Record<OtfHostId, string>> = {
  "task-report": "# Synthetic incident\n\nInvented for test mode: after two quick saves, one saved value is missing from the list.\n",
  umami: "# Synthetic incident\n\nInvented for test mode: a visit just after midnight in a far time zone is counted on the wrong day of a daily report.\n",
};
const GRADER_CHECK: Readonly<Record<OtfHostId, string>> = {
  "task-report": "rbw-otf-grader/checks/synthetic-overlap-write.txt",
  umami: "rbw-otf-grader/checks/synthetic-day-boundary-total.txt",
};

/** The invented certificate, the two invented bundles and the certificate part, and the result post that carries them. */
export function syntheticDelivery(input: DeliveryInput): SyntheticDelivery {
  const { job_id, script } = input;
  const winner = script.winner;
  if (winner === null) throw new Error("otf test mode: a delivery needs a winner");
  const job8 = job_id.slice(0, 8);
  const host = script.host_id;
  const agent = syntheticTarGz([
    ["rbw-otf-agent/SYNTHETIC-TEST-MODE.txt", `Synthetic OTF test-mode agent bundle for job ${job_id}.\nIt holds no application source, no checks, no fix and no spec.\n`],
    ["rbw-otf-agent/INCIDENT.md", INCIDENT[host]],
  ]);
  const grader = syntheticTarGz([
    ["rbw-otf-grader/SYNTHETIC-TEST-MODE.txt", `Synthetic OTF test-mode grader bundle for job ${job_id}.\nIn a real grader bundle the checks are model-written code.\n`],
    [GRADER_CHECK[host], `Invented check placeholder.\n${OTF_TEST_GRADER_SENTINEL}\n`],
  ]);
  const meters = [...lastMeters(script.steps.filter((step) => step.at_ms <= script.result.at_ms)).values()];
  const at = (ms: number): string => iso(input.claimed_at_ms + ms / input.speed);
  // Every hash below is of an invented string: none names a real kit, image or commit.
  const invented = (name: string): string => sha256(`synthetic-otf-test-mode-${host}-${name}`);
  const common = {
    format: CERTIFICATE_FORMAT,
    job_id,
    app_base_commit: createHash("sha1").update(`synthetic-otf-test-mode-${host}-app-base`).digest("hex"),
    criterion: { criterion_id: input.criterion_id, version: "1", failure_code: "synthetic-failure-code" },
    spec_sha256: input.spec_sha256,
    designer: { model: "synthetic/designer-model", route: "bug-spec" },
    implementer: { lane_id: winner.lane_id, agent: AGENT_LABEL, provider: TOKEN_FACTORY_PROVIDER, model: winner.model, rounds_used: winner.rounds_used },
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
  } as const;
  const rounds = winnerRounds(script.steps, winner.lane_id);
  const certificate: OtfCertificate =
    host === "umami"
      ? {
          ...common,
          host_id: "umami",
          // confirm_rounds 0: no confirmation round, so confirmation_cells is null.
          qualification: { cells: rounds.cells, confirmation_cells: null, admission: structuredClone(QUALIFIED_ADMISSION), result: "qualified" },
          harness: {
            tier: "admission",
            kit_sha256: invented("kit"),
            kit_image_id: `sha256:${invented("kit-image")}`,
            added_suite_sha256: invented("added-suite"),
            runtime_image_digest: `sha256:${invented("runtime-image")}`,
            original_suite: { test_count: 120, sha256: invented("original-suite") },
            copy_limits: COPY_LIMITS,
            copies: { kit_check_clean: 5, observe_planted: 1, clean: 1, planted: 5, fixed: 5, partial: 1, stub: 1 },
            repetitions: 20,
            evidence: ADMISSION_EVIDENCE,
            runner: CERTIFICATE_RUNNER,
            harness_sha256: invented("harness"),
          },
        }
      : {
          ...common,
          host_id: "task-report",
          qualification: { cells: rounds.cells, confirmation_cells: rounds.confirmation_cells ?? structuredClone(EXPECTED_CELLS), admission: null, result: "qualified" },
          harness: {
            tier: "B",
            kit_image_id: `sha256:${sha256("synthetic-otf-test-mode-kit-image")}`,
            copy_limits: COPY_LIMITS,
            instances: { clean: 1, buggy: 3, fixed: 3 },
            runner: CERTIFICATE_RUNNER,
            harness_sha256: sha256("synthetic-otf-test-mode-harness"),
          },
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
  host_id: OtfHostId;
  steps: ScriptStep[];
  result: ScenarioScript["result"];
  winner: ScenarioScript["winner"];
  lanes: ScenarioScript["lanes"];
  posted: number;
  cut: boolean;
}

export interface FakeBuilderOptions {
  store: MemoryOtfStore;
  power: FakeVmPower;
  clock: () => number;
  scenario: OtfTestScenario;
  /** Script milliseconds per clock millisecond. */
  speed: number;
  builder_id?: string;
}

export class FakeBuilder {
  readonly builder_id: string;
  private readonly store: MemoryOtfStore;
  private readonly power: FakeVmPower;
  private readonly clock: () => number;
  private readonly scenario: OtfTestScenario;
  private readonly speed: number;
  private boot: { boot_id: string; booted_at: string } | null = null;
  private boots = 0;
  private readonly runs = new Map<OtfJobId, Run>();
  /** Validation id to the clock time it finishes and the host of its job. */
  private readonly validations = new Map<string, { due: number; host: OtfHostId }>();
  /** ClaimRequest.ready_hosts: the scenario's host only. */
  readonly ready_hosts: readonly OtfHostId[];

  constructor(options: FakeBuilderOptions) {
    this.store = options.store;
    this.power = options.power;
    this.clock = options.clock;
    this.scenario = options.scenario;
    this.speed = options.speed;
    this.builder_id = options.builder_id ?? "synthetic-builder-1";
    this.ready_hosts = Object.freeze([SCENARIO_HOST[options.scenario]]);
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
    await this.store.recordBuilderSeen({ builder_id: this.builder_id, builder_revision: TEST_BUILDER_REVISION, ...this.boot, ready_hosts: [...this.ready_hosts] }, at);
    await this.promoteWaiting(now);
    await this.claim(now);
    for (const run of [...this.runs.values()]) await this.play(run, now);
    for (const [validation_id, { due, host }] of [...this.validations]) {
      if (due > now) continue;
      this.validations.delete(validation_id);
      // A passing validation repeats the qualified result: on Umami with its admission result, on task-report with none.
      const admission = host === "umami" ? structuredClone(QUALIFIED_ADMISSION) as OtfAdmissionResult : null;
      await this.store.updateValidation(validation_id, ["running"], { state: "passed", cells: structuredClone(EXPECTED_CELLS), admission, finished_at: iso(due) });
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
    // A scenario without a job (the calendar block) takes no build: a job created anyway waits, and
    // production finishes it builder_unavailable on read once its calendar window is closed.
    const scenario = this.scenario;
    const build = isOtfTestJobScenario(scenario);
    for (;;) {
      // The world's store plays this builder before every call, also from inside a power lock, so
      // the claim cannot wait for that lock.
      const claimed = await this.store.claimNextUnlocked(this.builder_id, iso(now), { hosts: claimHosts(this.ready_hosts, this.speed, build) });
      if (claimed === null) return;
      if (claimed.kind === "validate") {
        const parent = await this.store.getJob(claimed.validation.job_id);
        this.validations.set(claimed.validation.validation_id, { due: now + VALIDATION_MS / this.speed, host: parent?.host_id ?? "task-report" });
        continue;
      }
      if (!isOtfTestJobScenario(scenario)) return;
      await this.store.appendJobEvent(claimed.job.job_id, { type: "job_claimed", lane_id: null, data: { builder_revision: TEST_BUILDER_REVISION } }, iso(now));
      const script = scenarioScript(scenario);
      this.runs.set(claimed.job.job_id, { job: claimed.job, claimedMs: now, host_id: script.host_id, steps: script.steps, result: script.result, winner: script.winner, lanes: script.lanes, posted: 0, cut: false });
    }
  }

  /** Replaces the rest of the script with every live lane stopping now and the given result. */
  private cut(run: Run, atMs: number, lane: "cancelled" | "time_limit", laneReason: string, result: ScenarioScript["result"]): void {
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
        else this.cut(run, atMs, "time_limit", REASON_TEXT.deadline_lane, { at_ms: atMs + 2_000, outcome: "time_limit", reason: timeLimitReason(run.host_id) });
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
      await this.store.storeDelivery(
        job.job_id,
        this.builder_id,
        delivery.parts,
        {
          state: "finished",
          outcome: "delivered",
          reason: null,
          winner_lane: run.winner.lane_id,
          winner_model: run.winner.model,
          model_microusd: certificate.spend.model_microusd,
          certificate,
          finished_at: finishedAt,
          lease_until: null,
        },
        finishedAt,
      );
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
  /** The world's clock: the injected clock, moved by a fixed offset when the scenario needs a calendar day. */
  clock: () => number;
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

  /** The per-host config test mode runs with: every host enabled, the default profiles, invented lanes, typical null. */
  get hosts(): Readonly<Record<OtfHostId, Readonly<OtfTestHost>>> {
    return TEST_HOSTS;
  }

  /** What production must answer a create with in this scenario, or null when the create succeeds. */
  get refusal(): OtfTestRefusal | null {
    return scenarioRefusal(this.current.scenario);
  }

  get speed(): number {
    return this.current.speed;
  }

  /** The store and fakes underneath, without advancing: for tests and evidence. */
  get fakes(): Readonly<WorldState> {
    return this.current;
  }

  /** The time the customer routes must use in place of the wall clock. */
  now(): Date {
    return new Date(this.current.clock());
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
    const base = this.clock;
    const offset = clockOffset(scenario, base());
    const clock = offset === 0 ? base : (): number => base() + offset;
    const script = isOtfTestJobScenario(scenario) ? scenarioScript(scenario) : null;
    const memory = createMemoryOtfStore({ now: () => new Date(clock()) });
    const power = new FakeVmPower(clock, { coldStartMs: (script?.cold_start_ms ?? TEST_COLD_START_MS) / speed, failure: script?.start_failure ?? null });
    const builder = new FakeBuilder({ store: memory, power, clock, scenario, speed });
    return { scenario, speed, clock, memory, power, builder };
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

const DAY_MS = 86_400_000;

/**
 * How far the world's clock moves from the injected one when the world is built:
 * - umami_calendar_blocked: to TEST_CALENDAR_BLOCKED_AT (UTC day 3), so a Umami create is refused;
 * - any other scenario whose host's create window [now, now + START_TIMEOUT_MS + deadline +
 *   CALENDAR_MARGIN_MS] (production's check at create, on contract time, not test speed) is closed
 *   now: whole days forward to the first open one, so the scenario plays on any real date;
 * - otherwise 0.
 */
function clockOffset(scenario: OtfTestScenario, now: number): number {
  if (scenario === "umami_calendar_blocked") return Date.parse(TEST_CALENDAR_BLOCKED_AT) - now;
  const host = SCENARIO_HOST[scenario];
  const window = START_TIMEOUT_MS + OTF_HOST_DEFAULTS[host].deadline_ms + CALENDAR_MARGIN_MS;
  for (let days = 0; days < 31; days += 1) {
    const at = now + days * DAY_MS;
    if (hostCalendarOpen(host, at, at + window)) return days * DAY_MS;
  }
  return 0;
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

