// One trial of the F3 check. A forced trial fills the app's database pool with ten PATCHes held
// behind two row-lock gates (L1 one filler row, L2 nine), sends the kind's completions with the
// declared gaps while the pool is full, frees exactly one pool connection by releasing L1, and
// lets the completions settle while L2 still holds the other nine. Then it reads the daily report
// for the trial's own date. An ungated trial sends the completions one after another. Every
// observation is recorded; classifyTrial decides validity and outcome from the record alone.
import { randomUUID } from "node:crypto";
import { readTimings } from "./applog.ts";
import { classifyTrial } from "./classify.ts";
import type { BackendSnapshot, Classification, CompletionView, RequestView, TrialObservation } from "./classify.ts";
import { trialDate, trialInstant } from "./data.ts";
import type { F3Data, KindId, SendLabel } from "./data.ts";
import { GateFailure, openPgGate } from "./gate.ts";
import type { GateSession } from "./gate.ts";
import { settleWithin, sleep } from "./http.ts";
import type { HttpClient, InFlight } from "./http.ts";
import type { Monitor } from "./monitor.ts";

export interface TrialDeps {
  http: HttpClient;
  monitor: Monitor;
  gateUrl: string;
  appLogPath: string;
  /** Sets the origin of the trial's millisecond clock to now. */
  resetOrigin(): void;
}

export interface TrialRecord {
  observation: TrialObservation;
  classification: Classification;
  started_at: string;
  ended_at: string;
}

function copyView(view: RequestView): RequestView {
  return { ...view, body: view.body === null ? null : { ...view.body } };
}

async function idleCheck(data: F3Data, monitor: Monitor): Promise<TrialObservation["idle"]> {
  const first = await monitor.backends();
  if (first.idle_in_transaction === 0) return { initial: 0, final: 0, waited_ms: 0 };
  const began = performance.now();
  let now: BackendSnapshot = first;
  while (performance.now() - began < data.timing.idle_recheck_wait_ms) {
    await sleep(data.timing.idle_recheck_poll_ms);
    now = await monitor.backends();
    if (now.idle_in_transaction === 0) break;
  }
  return { initial: first.idle_in_transaction, final: now.idle_in_transaction, waited_ms: Math.round(performance.now() - began) };
}

async function createTask(http: HttpClient, title: string, expected: number): Promise<string | null> {
  const handle = http.send("POST", "/api/tasks", { title });
  await handle.done;
  const json = handle.json as { id?: unknown } | null;
  return handle.view.status === expected && typeof json?.id === "string" ? json.id : null;
}

async function readReport(data: F3Data, http: HttpClient, date: string): Promise<{ status: number | null; count: number | null }> {
  const handle = http.send("GET", `/api/reports/completions/daily?date=${date}&time_zone=${encodeURIComponent(data.environment.report_time_zone)}`, undefined);
  await handle.done;
  const json = handle.json as { count?: unknown } | null;
  return { status: handle.view.status, count: handle.view.status === data.statuses.report && typeof json?.count === "number" ? json.count : null };
}

async function pollGates(l1: GateSession, l2: GateSession): Promise<{ l1: number; l2: number; lock_types: string[] }> {
  const [a, b] = await Promise.all([l1.poll(), l2.poll()]);
  return { l1: a.blocked, l2: b.blocked, lock_types: [...new Set([...a.lockTypes, ...b.lockTypes])].sort() };
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    const step = (error as { step?: unknown }).step;
    return typeof step === "string" ? `${error.name}:${step}` : error.name;
  }
  return "unknown";
}

/** Runs one trial of the kind with the given index and classifies it. */
export async function runTrial(data: F3Data, kind: KindId, index: number, deps: TrialDeps): Promise<TrialRecord> {
  const startedAt = new Date().toISOString();
  const def = data.kinds[kind];
  const date = trialDate(data, kind, index);
  const instant = trialInstant(data, date);
  const observation: TrialObservation = {
    kind,
    index,
    date,
    instant,
    errors: [],
    idle: { initial: 0, final: 0, waited_ms: 0 },
    setup_ok: false,
    precount: null,
    gate_ok: def.forced ? false : null,
    s1: null,
    s2: null,
    s3: null,
    completions: [],
    patches: [],
    report: null,
    app_log: {},
    direct: null,
  };
  const { http } = deps;
  let l1: GateSession | null = null;
  let l2: GateSession | null = null;
  const patches: InFlight[] = [];
  const sent: { label: SendLabel; task: string; handle: InFlight }[] = [];
  try {
    observation.idle = await idleCheck(data, deps.monitor);
    const tag = `f3-${kind}-${String(index)}`;
    const taskY = await createTask(http, `${tag}-y`, data.statuses.task_create);
    const partner = def.sends.includes("partner") ? await createTask(http, `${tag}-p`, data.statuses.task_create) : null;
    const fillers: string[] = [];
    if (def.forced) {
      for (let i = 1; i <= data.environment.fillers; i += 1) {
        const id = await createTask(http, `${tag}-f${String(i)}`, data.statuses.task_create);
        if (id !== null) fillers.push(id);
      }
    }
    const pre = await readReport(data, http, date);
    observation.precount = pre.count;
    observation.setup_ok =
      taskY !== null && (partner !== null || !def.sends.includes("partner")) && fillers.length === (def.forced ? data.environment.fillers : 0) && pre.status === data.statuses.report;
    if (!observation.setup_ok || taskY === null || observation.precount !== 0 || observation.idle.final > 0) {
      return finish();
    }
    const unknown = randomUUID();
    const taskOf = (label: SendLabel): string => (label === "x" ? taskY : label === "partner" ? (partner ?? taskY) : unknown);
    const bodyOf = (label: SendLabel): Record<string, string> => (label === "unknown" ? {} : { completed_at: instant });
    const sendCompletion = (label: SendLabel): InFlight => {
      const task = taskOf(label);
      const handle = http.send("POST", `/api/tasks/${task}/completions`, bodyOf(label));
      sent.push({ label, task, handle });
      return handle;
    };

    if (!def.forced) {
      deps.resetOrigin();
      for (const label of def.sends) {
        await settleWithin([sendCompletion(label)], data.timing.client_timeout_ms);
      }
    } else {
      const gateConfig = { lock_statement: data.gate.lock_statement, lock_timeout_ms: data.gate.lock_timeout_ms, idle_in_transaction_session_timeout_ms: data.gate.idle_in_transaction_session_timeout_ms };
      const open = (): Promise<GateSession> => openPgGate({ gateUrl: deps.gateUrl, appRole: data.environment.app_role, config: gateConfig });
      const opened = await Promise.allSettled([open(), open()]);
      l1 = opened[0].status === "fulfilled" ? opened[0].value : null;
      l2 = opened[1].status === "fulfilled" ? opened[1].value : null;
      if (l1 === null || l2 === null) throw new GateFailure("connect");
      await l1.lock(fillers.slice(0, data.gate.l1_rows));
      await l2.lock(fillers.slice(data.gate.l1_rows));
      observation.gate_ok = true;

      deps.resetOrigin();
      fillers.forEach((id, i) => patches.push(http.send("PATCH", `/api/tasks/${id}`, { title: `${tag}-patched-${String(i + 1)}` })));
      const saturationStart = performance.now();
      let gates = await pollGates(l1, l2);
      while (performance.now() - saturationStart < data.timing.saturation_bound_ms && !(gates.l1 >= data.preconditions.p1.l1_blocked && gates.l2 >= data.preconditions.p1.l2_blocked)) {
        await sleep(data.timing.poll_ms);
        gates = await pollGates(l1, l2);
      }
      observation.s1 = { ...gates, backends: await deps.monitor.backends() };
      const p1 = observation.s1;
      const saturated = p1.l1 === data.preconditions.p1.l1_blocked && p1.l2 === data.preconditions.p1.l2_blocked && p1.backends.app_backends === data.preconditions.p1.app_backends;
      if (saturated) {
        // The first send, then each later one GAP_SEND after the previous; the release follows
        // POST_D after the last. A single send waits both, so L1 is released at the same time.
        def.sends.forEach((label, position) => {
          if (position === 0) sendCompletion(label);
        });
        for (const label of def.sends.slice(1)) {
          await sleep(data.timing.gap_send_ms);
          sendCompletion(label);
        }
        await sleep(def.sends.length > 1 ? data.timing.post_d_ms : data.timing.gap_send_ms + data.timing.post_d_ms);
        const before = await pollGates(l1, l2);
        observation.s2 = { l1: before.l1, l2: before.l2, backends: await deps.monitor.backends(), settled: sent.filter((item) => item.handle.view.settled).length };
        await l1.release();
        await settleWithin(
          sent.map((item) => item.handle),
          data.timing.settle_bound_ms,
        );
        const allSettled = sent.every((item) => item.handle.view.settled);
        const window = await l2.poll();
        observation.s3 = { l2: window.blocked, all_settled: allSettled };
      } else {
        await l1.release();
      }
      await l2.release();
      await settleWithin([...patches, ...sent.map((item) => item.handle)], data.timing.patch_bound_ms);
    }

    observation.report = await readReport(data, http, date);
    const xId = sent.find((item) => item.label === "x")?.handle.view.body?.id ?? null;
    observation.direct = await deps.monitor.directRead(date, xId);
    const ids = [...sent.map((item) => item.handle.view.request_id), patches[0]?.view.request_id ?? null].filter((id): id is string => id !== null);
    if (def.forced && ids.length > 0) observation.app_log = await readTimings(deps.appLogPath, data.app_log.event, ids, data.timing.app_log_wait_ms);
  } catch (error) {
    // A gate that fails at any step makes the trial invalid as gate_failed; anything else is a probe error.
    if (error instanceof GateFailure) observation.gate_ok = false;
    else observation.errors.push(errorName(error));
  } finally {
    await l1?.close();
    await l2?.close();
    if (patches.some((handle) => !handle.view.settled)) await settleWithin(patches, data.timing.patch_bound_ms);
  }
  return finish();

  function finish(): TrialRecord {
    observation.completions = sent.map((item): CompletionView => ({ ...copyView(item.handle.view), label: item.label, task_id: item.task }));
    observation.patches = patches.map((handle) => copyView(handle.view));
    return { observation, classification: classifyTrial(data, observation), started_at: startedAt, ended_at: new Date().toISOString() };
  }
}
