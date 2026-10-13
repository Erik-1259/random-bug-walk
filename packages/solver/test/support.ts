// Synthetic test support: a PGlite spend ledger, a scripted fetch standing in for the model, and a
// fake session standing in for the container. No value here was observed from a real system.
import { PGlite } from "@electric-sql/pglite";
import { createSpend, migrate } from "@rbw/spend";
import type { Spend } from "@rbw/spend";
import type { FetchFunction } from "@rbw/writer";
import type { AttemptOptions, TranscriptEvent } from "../src/agent.ts";
import { readSolverRateSheet } from "../src/envelope.ts";
import { SUPER_SOLVER_PROFILE } from "../src/profile.ts";
import type { SolverProfile } from "../src/profile.ts";
import type { CommandResult, RebuildResult, ServerLogsPage, SolverSession } from "../src/tools.ts";

export function hex(n: number): string {
  return n.toString(16).padStart(64, "0");
}

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export const CONTEXT = {
  project_id: uuid(1),
  project_policy_sha256: hex(11),
  batch_id: uuid(2),
  task_revision: hex(12),
  root_execution_id: uuid(3),
  execution_id: uuid(4),
  parent_execution_id: uuid(3),
};

export const POOL = "synthetic-pool";
export const SLOT = "synthetic-slot";
export const ISSUE = "Synthetic report: the weekly chart shows the wrong day for some visitors.";

let schemaCounter = 0;

export async function openDb(): Promise<PGlite> {
  return PGlite.create();
}

/** A fresh spend schema with a synthetic pool and slot key; the slot is held by CONTEXT's root. */
export async function freshSpend(db: PGlite, options: { cap?: number; acquire?: boolean } = {}): Promise<{ spend: Spend; schema: string }> {
  schemaCounter += 1;
  const schema = `synthetic_solver_${String(process.pid)}_${String(schemaCounter)}`;
  await db.exec(`CREATE SCHEMA ${schema}`);
  await migrate(db, { schema });
  const spend = createSpend({ client: db, schema });
  const pool = await spend.createPool({
    pool_key: POOL,
    cap_microusd: options.cap ?? 100_000_000,
    allocations: [],
    actor_role: "owner",
    reason: "synthetic test pool",
  });
  const slot = await spend.createSlotKey({ slot_key: SLOT, actor_role: "owner", reason: "synthetic test slot" });
  if (!pool.ok || !slot.ok) {
    throw new Error("could not create the synthetic pool or slot key");
  }
  if (options.acquire ?? true) {
    const hold = await spend.acquireSlot({ slot_key: SLOT, root_execution_id: CONTEXT.root_execution_id, actor_role: "workflow" });
    if (!hold.ok) {
      throw new Error(`could not acquire the synthetic slot: ${hold.code}`);
    }
  }
  return { spend, schema };
}

/** Records the order of spend writes. */
export function spySpend(spend: Spend, events: string[]): Spend {
  return {
    ...spend,
    reserve: (request) => {
      events.push("reserve");
      return spend.reserve(request);
    },
    transition: (request) => {
      events.push(`transition:${request.to_state}`);
      return spend.transition(request);
    },
    settle: (settlement) => {
      events.push("settle");
      return spend.settle(settlement);
    },
  };
}

export interface ScriptedCall {
  name: string;
  input: unknown;
}

/** One scripted model reply. `throws` simulates a lost response; `status` an HTTP error. */
export type ScriptedReply =
  | { calls: ScriptedCall[]; usage?: { prompt_tokens: number; completion_tokens: number } | null; text?: string }
  | { text: string; usage?: { prompt_tokens: number; completion_tokens: number } | null }
  | { status: number; body: string }
  | { throws: true };

export interface ScriptedFetch {
  fetch: FetchFunction;
  bodies: string[];
  urls: string[];
}

let callCounter = 0;

function completion(reply: Exclude<ScriptedReply, { status: number } | { throws: true }>, model: string): string {
  const calls = "calls" in reply ? reply.calls : [];
  const message = {
    role: "assistant",
    content: "text" in reply && reply.text !== undefined ? reply.text : null,
    ...(calls.length > 0
      ? {
          tool_calls: calls.map((call) => {
            callCounter += 1;
            return {
              id: `call_${String(callCounter)}`,
              type: "function",
              function: { name: call.name, arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input) },
            };
          }),
        }
      : {}),
  };
  const usage = reply.usage === undefined ? { prompt_tokens: 1000, completion_tokens: 100 } : reply.usage;
  return JSON.stringify({
    id: "synthetic",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message, finish_reason: calls.length > 0 ? "tool_calls" : "stop" }],
    ...(usage === null ? {} : { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }),
  });
}

/** A fetch that answers each request with the next scripted reply, and records every request. */
export function scriptedFetch(replies: readonly ScriptedReply[], events?: string[], model = "synthetic-model"): ScriptedFetch {
  const queue = [...replies];
  const bodies: string[] = [];
  const urls: string[] = [];
  const fetch: FetchFunction = (input, init) => {
    events?.push("fetch");
    urls.push(input instanceof Request ? input.url : String(input));
    bodies.push(typeof init?.body === "string" ? init.body : "");
    const reply = queue.shift();
    if (reply === undefined) {
      return Promise.reject(new Error("no scripted reply left"));
    }
    if ("throws" in reply) {
      return Promise.reject(new Error("synthetic connection reset"));
    }
    if ("status" in reply) {
      return Promise.resolve(new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json" } }));
    }
    return Promise.resolve(new Response(completion(reply, model), { status: 200, headers: { "content-type": "application/json" } }));
  };
  return { fetch, bodies, urls };
}

/** A fake session that records what it was asked and answers from fixed results. */
export class FakeSession implements SolverSession {
  readonly log: string[] = [];
  files = new Map<string, string>([["src/lib/date.ts", "export const offset = 0;\n"]]);
  rebuildResult: RebuildResult = {
    build: { exit_code: 0, stderr: "" },
    start: { exit_code: 0, stdout: "postgres_ready_ms=900\nready_ms=4200 budget_ms=60000 within_budget=yes\nlistening tcp 127.0.0.1:3000", stderr: "" },
  };
  logsPage: ServerLogsPage = { text: "synthetic log line\n", next_cursor: "c1", truncated: false };
  bashResult: CommandResult = { exit_code: 0, stdout: "ok\n", stderr: "", timed_out: false };
  failOn: string | null = null;

  private check(name: string): void {
    this.log.push(name);
    if (this.failOn === name) {
      throw new Error(`synthetic ${name} failure`);
    }
  }

  bash(command: string): Promise<CommandResult> {
    this.check(`bash:${command}`);
    return Promise.resolve(this.bashResult);
  }

  readFile(path: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    this.check(`read_file:${path}`);
    const content = this.files.get(path);
    return Promise.resolve(content === undefined ? { ok: false, error: "no such tracked file" } : { ok: true, content });
  }

  writeFile(path: string, content: string): Promise<{ ok: true } | { ok: false; error: string }> {
    this.check(`write_file:${path}`);
    if (!this.files.has(path)) {
      return Promise.resolve({ ok: false, error: "not a tracked file" });
    }
    this.files.set(path, content);
    return Promise.resolve({ ok: true });
  }

  rebuildRestart(): Promise<RebuildResult> {
    this.check("rebuild_restart");
    return Promise.resolve(this.rebuildResult);
  }

  serverLogs(request: { cursor: string | null; maxBytes: number }): Promise<ServerLogsPage> {
    this.check(`server_logs:${request.cursor ?? "tail"}`);
    return Promise.resolve(this.logsPage);
  }
}

/** A clock that advances by `stepMs` on every reading. */
export function steppingClock(stepMs: number, start = Date.UTC(2026, 9, 13, 12, 0, 0)): () => Date {
  let t = start - stepMs;
  return () => {
    t += stepMs;
    return new Date(t);
  };
}

/** A copy of `profile` with some attempt caps replaced; its digest differs from the frozen one. */
export function withCaps(profile: SolverProfile, caps: Partial<SolverProfile["hashed"]["attempt_caps"]>): SolverProfile {
  return { ...profile, hashed: { ...profile.hashed, attempt_caps: { ...profile.hashed.attempt_caps, ...caps } } };
}

export interface Run {
  options: AttemptOptions;
  events: TranscriptEvent[];
}

/** Attempt options over the ledger, the fetch and the session, collecting the transcript. */
export function attemptOptions(
  spend: Spend,
  fetch: FetchFunction,
  session: SolverSession,
  overrides: Partial<AttemptOptions> = {},
): Run {
  const events: TranscriptEvent[] = [];
  return {
    events,
    options: {
      spend,
      fetch,
      profile: SUPER_SOLVER_PROFILE,
      context: CONTEXT,
      poolKey: POOL,
      allocationKey: null,
      slotKey: SLOT,
      rateSheet: readSolverRateSheet(),
      spec: { arm: "off", index: 1, rerun: 0 },
      issue: ISSUE,
      session,
      transcript: (event) => {
        events.push(event);
      },
      now: steppingClock(1000),
      ...overrides,
    },
  };
}
