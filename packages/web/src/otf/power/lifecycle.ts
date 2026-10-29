// The on-demand builder lifecycle (docs/otf/SPEC.md section 4) on the OtfStore power row: start on
// a session-checked create, the watchdog that production runs lazily and from its cron route, the
// stop-intent decision, the VM-hours day cap and the operator hold.
//
// Rules this module keeps:
// - Every power transition is taken under the power row lock and written to the power log.
// - At most one cloud API call per WATCHDOG_MIN_INTERVAL_MS, across every caller. A pass acts on
//   the instance state the last Get saw, so it makes one call: a Get, a Start or a Stop.
// - While the operator hold is set (hold_until in the future) production never starts or stops
//   the instance; Gets continue, so the state stays accurate.
// - It never stops the instance while a job is building with a fresh builder post, not even for
//   the uptime limit or the day cap. The builder's own timer enforces the uptime limit then.
// - A start error finishes every waiting job builder_start_failed with its reason; so does a start
//   that brought no healthy claim within START_TIMEOUT_MS.
// - A stopped or starting builder starts for a job of any host. Once a fresh heartbeat leaves a
//   queued job's host out of ready_hosts, that job finishes builder_unavailable on the next pass,
//   so a job no builder can take never keeps the machine up or blocks its self-stop.
// - The stop intent itself is decided by the builder routes (builder-handlers.ts); this module
//   reads the stopping state it leaves.
import {
  BUILDER_FRESH_MS,
  BUILDER_LOST_MS,
  MAX_UPTIME_MS,
  OTF_CONTRACT_VERSION,
  OTF_DEFAULTS,
  OTF_ERROR_STATUS,
  OTF_HOST_LABELS,
  START_TIMEOUT_MS,
  StartError,
  WATCHDOG_AFTER_LAST_JOB_MS,
  WATCHDOG_MIN_INTERVAL_MS,
  WATCHDOG_NO_HEARTBEAT_MS,
  type BuilderState,
  type NebiusInstanceState,
  type OtfErrorBody,
  type OtfHostId,
  type OtfJobRecord,
  type OtfPowerLogEntry,
  type OtfPowerRecord,
  type OtfStore,
  type StartFailureReason,
  type VmPower,
} from "../contract.ts";

/** After this many start failures in a row, starts pause for START_BACKOFF_MS. */
export const START_FAILURES_BEFORE_BACKOFF = 2;
export const START_BACKOFF_MS = 15 * 60_000;
/** A cached instance state older than this is refreshed with a Get before the watchdog acts on it. */
export const INSTANCE_STATE_STALE_MS = 10 * 60_000;
/** A start the instance still reports STOPPED this long after is counted as a failed start. */
export const START_SETTLE_MS = 60_000;
/** A stop intent the instance has not followed this long after is finished by production. */
export const STOPPING_GRACE_MS = 5 * 60_000;

export interface PowerDeps {
  store: OtfStore;
  /** null when any RBW_NEBIUS_* variable is unset: power is then unavailable (fail closed). */
  power: VmPower | null;
  now: () => Date;
  /** RBW_OTF_VM_HOURS_PER_DAY; defaults to OTF_DEFAULTS.vm_hours_per_day. */
  vmHoursPerDay?: number;
}

/** Why a start may not happen now. Every one answers a create with `unavailable`. */
export type StartBlock = "unconfigured" | "hold" | "day_cap" | "start_backoff";

type Actor = OtfPowerLogEntry["actor"];

const WAITING_STATES = ["queued", "starting_builder"] as const;
const OPEN_STATES = ["queued", "starting_builder", "building"] as const;

// ---- time helpers (every time is an ISO 8601 UTC string)

function ms(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

function latest(...values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

// ---- derived state

/** Machine seconds used this UTC day: the closed intervals counted so far plus the open one. */
export function vmSecondsUsed(power: OtfPowerRecord, now: Date): number {
  const at = now.getTime();
  const today = utcDay(at);
  const closed = power.vm_day === today ? power.vm_seconds_today : 0;
  const since = ms(power.running_since);
  const open = since === null ? 0 : Math.max(0, at - Math.max(since, dayStart(today))) / 1000;
  return closed + open;
}

function dayCapSeconds(deps: PowerDeps): number {
  return (deps.vmHoursPerDay ?? OTF_DEFAULTS.vm_hours_per_day) * 3600;
}

/** Why a start is refused right now, or null when it may go ahead. */
export function startBlock(power: OtfPowerRecord, now: Date, deps: Pick<PowerDeps, "power" | "vmHoursPerDay">): StartBlock | null {
  const at = now.getTime();
  if (deps.power === null) return "unconfigured";
  const hold = ms(power.hold_until);
  if (hold !== null && hold > at) return "hold";
  if (vmSecondsUsed(power, now) >= (deps.vmHoursPerDay ?? OTF_DEFAULTS.vm_hours_per_day) * 3600) return "day_cap";
  const lastStart = ms(power.last_start_at);
  if (power.start_failures >= START_FAILURES_BEFORE_BACKOFF && lastStart !== null && at - lastStart < START_BACKOFF_MS) return "start_backoff";
  return null;
}

/**
 * The builder state for availability and status: stopping once a stop was granted or sent, else
 * running only with a fresh builder heartbeat; an instance that is up without one reads starting.
 */
export function builderState(power: OtfPowerRecord, lastSeenAt: string | null, now: Date): BuilderState {
  // A builder told to stop keeps its heartbeat until the instance stops; a new job waits for that.
  if (power.state === "stopping") return "stopping";
  const seen = ms(lastSeenAt);
  if (seen !== null && now.getTime() - seen < BUILDER_FRESH_MS) return "running";
  if (power.state === "starting") return "starting";
  switch (power.instance_state) {
    case "STOPPED":
      return "stopped";
    case "STOPPING":
      return "stopping";
    case "RUNNING":
    case "STARTING":
      return "starting";
    default:
      return power.state === "stopped" ? "stopped" : "unknown";
  }
}

function rateLimited(power: OtfPowerRecord, at: number): boolean {
  const last = ms(power.last_api_call_at);
  return last !== null && at - last < WATCHDOG_MIN_INTERVAL_MS;
}

/** The patch that moves the day counter to today, or an empty patch. */
function rollDay(power: OtfPowerRecord, at: number): Partial<OtfPowerRecord> {
  const today = utcDay(at);
  return power.vm_day === today ? {} : { vm_day: today, vm_seconds_today: 0 };
}

/** The patch that closes the open running interval at `at` (counting only today's part). */
function closeInterval(power: OtfPowerRecord, at: number): Partial<OtfPowerRecord> {
  const since = ms(power.running_since);
  if (since === null) return {};
  const today = utcDay(at);
  const closed = power.vm_day === today ? power.vm_seconds_today : 0;
  const counted = Math.max(0, at - Math.max(since, dayStart(today))) / 1000;
  return { vm_day: today, vm_seconds_today: Math.round(closed + counted), running_since: null };
}

/** The patch for what a Get saw. */
function observe(power: OtfPowerRecord, seen: NebiusInstanceState, preset: string, at: number, heartbeatFresh: boolean): Partial<OtfPowerRecord> {
  const iso = new Date(at).toISOString();
  const patch: Partial<OtfPowerRecord> = { instance_state: seen, preset: preset === "" ? power.preset : preset };
  const lastStart = ms(power.last_start_at);
  if (seen === "STOPPED" && power.state === "starting" && lastStart !== null && at - lastStart < START_SETTLE_MS) {
    // A Start sent moments ago that the instance has not shown yet: still starting.
    return patch;
  }
  if (seen === "STOPPED") {
    // The machine bills until it has stopped, and the first Get that sees it stopped is the
    // earliest known stop time, so the interval closes there (the cron keeps that gap at 5 min).
    Object.assign(patch, closeInterval(power, at));
    if (power.state !== "stopped") Object.assign(patch, { state: "stopped", since: iso });
  } else if (seen === "RUNNING" || seen === "STARTING") {
    if (power.running_since === null) patch.running_since = iso;
    if (power.state === "stopping") {
      // A granted or sent stop stays in force while the instance runs on (the heartbeat continues
      // until it stops); the stopping_stuck rule enforces it.
    } else if (heartbeatFresh) {
      if (power.state !== "running") Object.assign(patch, { state: "running", since: iso });
    } else if (power.state === "stopped" || power.state === "unknown") {
      Object.assign(patch, { state: "starting", since: iso });
    }
  } else if (seen === "STOPPING" && power.state !== "stopping") {
    Object.assign(patch, { state: "stopping", since: iso });
  }
  return patch;
}

function log(at: number, actor: Actor, action: OtfPowerLogEntry["action"], before: string | null, after: string | null, operationId: string | null): OtfPowerLogEntry {
  return { at: new Date(at).toISOString(), actor, action, before, after, operation_id: operationId };
}

function freshPost(job: OtfJobRecord, at: number): boolean {
  const last = latest(ms(job.last_builder_post_at), ms(job.claimed_at));
  return last !== null && at - last < BUILDER_LOST_MS;
}

// ---- follow-up job changes (made after the power lock is released)

/** started: builder_starting to every starting_builder job; start_failed: finish every waiting job; lost: finish building jobs with no recent post. */
type FollowUp =
  | { kind: "started"; requested_at: string; preset: string }
  /** starting: set when this pass's own Start threw, so builder_starting is appended before the failure. */
  | { kind: "start_failed"; reason: StartFailureReason; starting?: { requested_at: string; preset: string } }
  | { kind: "lost" };

type Finish =
  | { outcome: "builder_start_failed"; reason: StartFailureReason }
  | { outcome: "builder_lost"; reason: "builder_stopped" }
  /** A start block code (unconfigured, hold, day_cap), or hostNotReadyReason. */
  | { outcome: "builder_unavailable"; reason: string };

/** The job reason when a fresh heartbeat leaves the job's host out of ready_hosts. */
export function hostNotReadyReason(host: OtfHostId): string {
  return `The builder machine is not ready for ${OTF_HOST_LABELS[host]} builds right now.`;
}

/** The ready_hosts of the last builder heartbeat while it is fresh, or null (readiness unknown). */
export function freshReadyHosts(seen: { ready_hosts: readonly OtfHostId[]; last_seen_at: string } | null, at: number): readonly OtfHostId[] | null {
  const seenAt = ms(seen?.last_seen_at);
  return seen !== null && seenAt !== null && at - seenAt < BUILDER_FRESH_MS ? seen.ready_hosts : null;
}

/** Finishes one job (compare-and-set on its state) and appends its events; false when another finish won. */
async function finishJob(
  store: OtfStore,
  job: OtfJobRecord,
  whenStates: readonly OtfJobRecord["state"][],
  finish: Finish,
  at: string,
  starting?: { requested_at: string; preset: string },
): Promise<boolean> {
  const done = await store.updateJob(job.job_id, whenStates, { state: "finished", outcome: finish.outcome, reason: finish.reason, finished_at: at });
  if (done === null) return false;
  if (starting !== undefined) {
    await store.appendJobEvent(job.job_id, { type: "builder_starting", lane_id: null, data: { preset: starting.preset, requested_at: starting.requested_at } }, at);
  }
  if (finish.outcome === "builder_start_failed") {
    await store.appendJobEvent(job.job_id, { type: "builder_start_failed", lane_id: null, data: { reason: finish.reason } }, at);
  }
  await store.appendJobEvent(job.job_id, { type: "job_finished", lane_id: null, data: { outcome: finish.outcome, reason: finish.reason } }, at);
  return true;
}

async function applyFollowUp(store: OtfStore, followUp: FollowUp | null, at: string): Promise<void> {
  if (followUp === null) return;
  if (followUp.kind === "lost") {
    const now = Date.parse(at);
    for (const job of await store.listJobs(["building"])) {
      if (!freshPost(job, now)) await finishJob(store, job, ["building"], { outcome: "builder_lost", reason: "builder_stopped" }, at);
    }
    return;
  }
  if (followUp.kind === "started") {
    for (const job of await store.listJobs(["starting_builder"])) {
      await store.appendJobEvent(job.job_id, { type: "builder_starting", lane_id: null, data: { preset: followUp.preset, requested_at: followUp.requested_at } }, at);
    }
    return;
  }
  // A failed start fails every job that needed the machine: the ones waiting for it to start, and
  // queued ones whose machine stopped (an uptime or day-cap stop) and could not be restarted.
  for (const job of await store.listJobs(WAITING_STATES)) {
    await finishJob(store, job, [job.state], { outcome: "builder_start_failed", reason: followUp.reason }, at, followUp.starting);
  }
}

/** Sends Start; the patch, the log entry and the follow-up for either result. */
async function sendStart(
  power: VmPower,
  row: OtfPowerRecord,
  at: number,
  actor: Actor,
): Promise<{ patch: Partial<OtfPowerRecord>; entry: OtfPowerLogEntry; followUp: FollowUp; failure: Exclude<StartFailureReason, "timeout"> | null }> {
  const iso = new Date(at).toISOString();
  const base = { last_api_call_at: iso, last_start_at: iso };
  try {
    const { operation_id } = await power.start();
    const patch: Partial<OtfPowerRecord> = { ...base, state: "starting", since: iso, instance_state: "STARTING", running_since: row.running_since ?? iso };
    return { patch, entry: log(at, actor, "start", row.instance_state, "STARTING", operation_id), followUp: { kind: "started", requested_at: iso, preset: row.preset ?? "unknown" }, failure: null };
  } catch (error) {
    const reason = error instanceof StartError ? error.reason : "api_error";
    const patch: Partial<OtfPowerRecord> = { ...base, start_failures: row.start_failures + 1, state: row.instance_state === "STOPPED" ? "stopped" : "unknown", since: iso };
    return { patch, entry: log(at, actor, "start", row.instance_state, `error:${reason}`, null), followUp: { kind: "start_failed", reason, starting: { requested_at: iso, preset: row.preset ?? "unknown" } }, failure: reason };
  }
}

// ---- start on create

export type StartRequestResult =
  /** A Start was sent now; builder_starting was appended to every waiting job. */
  | { kind: "started"; requested_at: string }
  /** The builder is running (fresh heartbeat): the job only queues. */
  | { kind: "running" }
  /** A Start is already in flight: the job waits for the same boot. */
  | { kind: "starting" }
  /** No call now (the API interval, or a stop still in progress): the watchdog starts it on a later pass. */
  | { kind: "deferred" }
  /** The start failed; every waiting job (starting_builder or queued) finished builder_start_failed with this reason. */
  | { kind: "failed"; reason: Exclude<StartFailureReason, "timeout"> }
  /** Power is unavailable: the create answers unavailable. */
  | { kind: "unavailable"; block: StartBlock };

/**
 * The create path: call it after inserting the job (in starting_builder unless the builder is
 * running). Answers without waiting for the machine.
 */
export async function requestStart(deps: PowerDeps): Promise<StartRequestResult> {
  const at = deps.now().getTime();
  const iso = new Date(at).toISOString();
  const lastSeenAt = (await deps.store.lastBuilderSeen())?.last_seen_at ?? null;
  const outcome = await deps.store.withPowerLock<{ result: StartRequestResult; followUp: FollowUp | null }>(async (row) => {
    const patch: Partial<OtfPowerRecord> = rollDay(row, at);
    const current = { ...row, ...patch };
    const done = (result: StartRequestResult, extra: Partial<OtfPowerRecord> = {}, entries: OtfPowerLogEntry[] = [], followUp: FollowUp | null = null) => ({
      patch: Object.keys(patch).length + Object.keys(extra).length === 0 ? null : { ...patch, ...extra },
      log: entries,
      result: { result, followUp },
    });
    const block = startBlock(current, deps.now(), deps);
    if (block !== null || deps.power === null) return done({ kind: "unavailable", block: block ?? "unconfigured" });
    const state = builderState(current, lastSeenAt, deps.now());
    if (state === "running") return done({ kind: "running" });
    const lastStart = ms(current.last_start_at);
    if (current.state === "starting" && lastStart !== null && at - lastStart < START_TIMEOUT_MS) return done({ kind: "starting" });
    if (rateLimited(current, at)) return done({ kind: "deferred" });
    if (state === "stopping") {
      // The builder was told to stop: see whether it has, and start it on a later pass.
      try {
        const seen = await deps.power.get();
        const observed = observe(current, seen.state, seen.preset, at, false);
        return done({ kind: "deferred" }, { ...observed, last_api_call_at: iso }, [log(at, "create", "get", current.instance_state, seen.state, null)]);
      } catch {
        return done({ kind: "deferred" }, { last_api_call_at: iso }, [log(at, "create", "get", current.instance_state, "error", null)]);
      }
    }
    const sent = await sendStart(deps.power, current, at, "create");
    const result: StartRequestResult = sent.failure === null ? { kind: "started", requested_at: iso } : { kind: "failed", reason: sent.failure };
    return done(result, sent.patch, [sent.entry], sent.followUp);
  });
  await applyFollowUp(deps.store, outcome.followUp, iso);
  return outcome.result;
}

// ---- the watchdog

export type WatchdogAction = "none" | "get" | "start" | "stop";
export type StopRule = "no_heartbeat" | "after_last_job" | "max_uptime" | "day_cap" | "stopping_stuck";

export interface WatchdogResult {
  action: WatchdogAction;
  /** Why it did what it did: a stop rule, "jobs_waiting" for a start, or why it made no call. */
  reason: StopRule | "jobs_waiting" | "refresh" | "rate_limited" | "unconfigured" | "hold" | "error" | null;
  /** Waiting jobs finished on this pass because they could not start (builder_start_failed or builder_unavailable). */
  timed_out: number;
}

/** Which stop rule fires for a running instance, or null. Never one while a building job posts. */
export function stopRule(row: OtfPowerRecord, jobs: readonly OtfJobRecord[], lastSignal: number | null, lastFinished: number | null, at: number, capSeconds: number): StopRule | null {
  if (jobs.some((job) => job.state === "building" && freshPost(job, at))) return null;
  const up = latest(ms(row.running_since), ms(row.last_start_at));
  const signal = latest(lastSignal, up);
  if (signal !== null && at - signal >= WATCHDOG_NO_HEARTBEAT_MS) return "no_heartbeat";
  const since = ms(row.running_since);
  if (since !== null && at - since >= MAX_UPTIME_MS) return "max_uptime";
  if (vmSecondsUsed(row, new Date(at)) >= capSeconds) return "day_cap";
  const open = jobs.some((job) => (OPEN_STATES as readonly string[]).includes(job.state));
  const idleSince = latest(lastFinished, since);
  if (!open && idleSince !== null && at - idleSince >= WATCHDOG_AFTER_LAST_JOB_MS) return "after_last_job";
  const stoppingSince = ms(row.since);
  if (row.state === "stopping" && stoppingSince !== null && at - stoppingSince >= STOPPING_GRACE_MS) return "stopping_stuck";
  return null;
}

/**
 * One watchdog pass. Production runs it on availability and status reads and from the cron route.
 * It makes at most one cloud API call, and none within WATCHDOG_MIN_INTERVAL_MS of the last one.
 */
export async function runWatchdog(deps: PowerDeps): Promise<WatchdogResult> {
  const at = deps.now().getTime();
  const iso = new Date(at).toISOString();
  // Status reads run this every few seconds: inside the API interval it only finishes stuck jobs,
  // without the job listings or the lock.
  const before = await deps.store.getPower();
  if (deps.power !== null && rateLimited(before, at)) {
    const seenAt = ms((await deps.store.lastBuilderSeen())?.last_seen_at);
    return { action: "none", reason: "rate_limited", timed_out: await finishStuckJobs(deps, before, at, seenAt !== null && at - seenAt < BUILDER_FRESH_MS) };
  }
  const [open, finished, seen] = await Promise.all([deps.store.listJobs(OPEN_STATES), deps.store.listJobs(["finished"]), deps.store.lastBuilderSeen()]);
  const lastSignal = latest(ms(seen?.last_seen_at), ...open.map((job) => ms(job.last_builder_post_at)));
  const heartbeatFresh = lastSignal !== null && at - lastSignal < BUILDER_FRESH_MS;
  const lastFinished = latest(...finished.map((job) => ms(job.finished_at)));
  const waiting = open.filter((job) => (WAITING_STATES as readonly string[]).includes(job.state));

  const outcome = await deps.store.withPowerLock<{ result: WatchdogResult; followUp: FollowUp | null; row: OtfPowerRecord }>(async (row) => {
    const patch: Partial<OtfPowerRecord> = rollDay(row, at);
    if (lastFinished !== null && (ms(row.last_job_finished_at) ?? -Infinity) < lastFinished) patch.last_job_finished_at = new Date(lastFinished).toISOString();
    const down = row.instance_state === "STOPPED" || row.instance_state === "STOPPING";
    if (heartbeatFresh && !down && row.state !== "running" && row.state !== "stopping") Object.assign(patch, { state: "running", since: iso, start_failures: 0 });
    const current: OtfPowerRecord = { ...row, ...patch };
    const finish = (action: WatchdogAction, reason: WatchdogResult["reason"], extra: Partial<OtfPowerRecord> = {}, entries: OtfPowerLogEntry[] = [], followUp: FollowUp | null = null) => {
      const merged = { ...patch, ...extra };
      return { patch: Object.keys(merged).length === 0 ? null : merged, log: entries, result: { result: { action, reason, timed_out: 0 }, followUp, row: { ...current, ...extra } } };
    };
    if (deps.power === null) return finish("none", "unconfigured");
    if (rateLimited(current, at)) return finish("none", "rate_limited");

    const hold = ms(current.hold_until);
    const held = hold !== null && hold > at;
    const observedAt = ms(current.last_api_call_at);
    const known = current.instance_state !== null && observedAt !== null && at - observedAt < INSTANCE_STATE_STALE_MS;

    if (known && !held) {
      if (current.instance_state === "RUNNING" || current.instance_state === "STARTING") {
        const lastJobFinished = latest(lastFinished, ms(current.last_job_finished_at));
        let rule = stopRule(current, open, lastSignal, lastJobFinished, at, dayCapSeconds(deps));
        if (rule !== null) {
          // The job listing above predates the lock: a claim since then may have started a build.
          // Re-read the open jobs right before the Stop so a fresh claim is never cut off.
          rule = stopRule(current, await deps.store.listJobs(OPEN_STATES), lastSignal, lastJobFinished, at, dayCapSeconds(deps));
        }
        if (rule !== null) {
          try {
            const { operation_id } = await deps.power.stop();
            return finish("stop", rule, { last_api_call_at: iso, last_stop_at: iso, state: "stopping", since: iso, instance_state: "STOPPING" }, [log(at, "watchdog", "stop", current.instance_state, "STOPPING", operation_id)], { kind: "lost" });
          } catch {
            return finish("stop", "error", { last_api_call_at: iso }, [log(at, "watchdog", "stop", current.instance_state, "error", null)]);
          }
        }
      }
      if (current.instance_state === "STOPPED" && waiting.length > 0 && startBlock(current, deps.now(), deps) === null) {
        const lastStart = ms(current.last_start_at);
        const inFlight = current.state === "starting" && lastStart !== null && at - lastStart < START_SETTLE_MS;
        if (!inFlight) {
          const sent = await sendStart(deps.power, current, at, "watchdog");
          return finish("start", "jobs_waiting", sent.patch, [sent.entry], sent.followUp);
        }
      }
    }

    try {
      const got = await deps.power.get();
      const observed = observe(current, got.state, got.preset, at, heartbeatFresh);
      const extra: Partial<OtfPowerRecord> = { ...observed, last_api_call_at: iso };
      let followUp: FollowUp | null = null;
      // A start the instance never followed: count it as a failed start.
      const lastStart = ms(current.last_start_at);
      if (got.state === "STOPPED" && current.state === "starting" && lastStart !== null && at - lastStart >= START_SETTLE_MS) {
        extra.start_failures = current.start_failures + 1;
        followUp = { kind: "start_failed", reason: "api_error" };
      }
      return finish("get", held ? "hold" : "refresh", extra, [log(at, "watchdog", "get", current.instance_state, got.state, null)], followUp);
    } catch {
      return finish("get", "error", { last_api_call_at: iso }, [log(at, "watchdog", "get", current.instance_state, "error", null)]);
    }
  });

  await applyFollowUp(deps.store, outcome.followUp, iso);
  const timedOut = await finishStuckJobs(deps, outcome.row, at, heartbeatFresh);
  return { ...outcome.result, timed_out: timedOut };
}

/**
 * Finishes the jobs that can no longer start, START_TIMEOUT_MS after the later of their creation
 * and the last start request: builder_unavailable while the operator hold, the day cap or missing
 * credentials prevent a start (a queued job too, once its machine has stopped), and otherwise
 * builder_start_failed (timeout) for a job that never saw a healthy claim. A queued job counts as
 * waiting for a start only when a start was requested after it was created and no builder
 * heartbeat is fresh, so an ordinary wait behind a healthy builder never times out here.
 *
 * A queued job whose host a fresh heartbeat leaves out of ready_hosts finishes builder_unavailable
 * at once: no claim can take it. The heartbeat is read after the job listing, so a claim that
 * promoted a job before the listing has already recorded its own ready_hosts. A starting_builder job
 * is left to the timeout, because a claim with images_ok: false heartbeats without promoting it.
 */
async function finishStuckJobs(deps: PowerDeps, row: OtfPowerRecord, at: number, heartbeatFresh: boolean): Promise<number> {
  const iso = new Date(at).toISOString();
  const block = startBlock(row, new Date(at), deps);
  const unavailable: Finish | null = block === null || block === "start_backoff" ? null : { outcome: "builder_unavailable", reason: block };
  const timeout: Finish = { outcome: "builder_start_failed", reason: "timeout" };
  const lastStart = ms(row.last_start_at);
  let count = 0;
  const waiting = await deps.store.listJobs(WAITING_STATES);
  const readyHosts = waiting.some((job) => job.state === "queued") ? freshReadyHosts(await deps.store.lastBuilderSeen(), at) : null;
  for (const job of waiting) {
    if (job.state === "queued" && readyHosts !== null && !readyHosts.includes(job.host_id)) {
      if (await finishJob(deps.store, job, ["queued"], { outcome: "builder_unavailable", reason: hostNotReadyReason(job.host_id) }, iso)) count += 1;
      continue;
    }
    const created = ms(job.created_at);
    const from = latest(created, lastStart);
    if (from === null || at - from < START_TIMEOUT_MS) continue;
    let finish: Finish | null;
    if (job.state === "starting_builder") finish = unavailable ?? timeout;
    else if (row.instance_state === "STOPPED" && unavailable !== null) finish = unavailable;
    else finish = !heartbeatFresh && lastStart !== null && created !== null && lastStart >= created ? timeout : null;
    if (finish !== null && (await finishJob(deps.store, job, [job.state], finish, iso))) count += 1;
  }
  return count;
}

// ---- the cron route

/** Constant-time comparison of two strings of possibly different lengths. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let index = 0; index < b.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

/** Whether the request carries `Authorization: Bearer <CRON_SECRET>`, as Vercel Cron sends it. */
export function cronAuthorized(request: Request, cronSecret: string | null): boolean {
  if (cronSecret === null || cronSecret === "") return false;
  const header = request.headers.get("authorization") ?? "";
  return sameSecret(header, `Bearer ${cronSecret}`);
}

function cronError(code: "unauthorized" | "unavailable", message: string): Response {
  const body: OtfErrorBody = { contract_version: OTF_CONTRACT_VERSION, error: { code, message, retryable: code === "unavailable" } };
  return Response.json(body, { status: OTF_ERROR_STATUS[code], headers: { "cache-control": "no-store" } });
}

/**
 * GET /api/factory/otf/cron/power: one watchdog pass for Vercel Cron, so a machine left running is
 * stopped even when nobody reads availability or status. Without CRON_SECRET it answers
 * unavailable; a wrong or missing bearer answers unauthorized. `resolve` opens the store and the
 * power port only after the secret checks, and answers null when either is unconfigured.
 */
export async function powerCron(request: Request, cronSecret: string | null, resolve: () => Promise<PowerDeps | null>, log: (line: string) => void): Promise<Response> {
  if (cronSecret === null || cronSecret === "") return cronError("unavailable", "The power cron is not configured.");
  if (!cronAuthorized(request, cronSecret)) return cronError("unauthorized", "The cron secret did not match.");
  try {
    const deps = await resolve();
    if (deps === null) return cronError("unavailable", "Custom builds are not configured.");
    const result = await runWatchdog(deps);
    if (result.action !== "none" || result.timed_out > 0) log(`otf power cron: ${result.action} (${result.reason ?? "no reason"}), ${String(result.timed_out)} timed out`);
    return Response.json(result, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    log(`otf power cron: the pass failed (${error.name})`);
    return cronError("unavailable", "The watchdog pass failed.");
  }
}
