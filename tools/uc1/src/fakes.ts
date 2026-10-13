// The dry-run world: a PGlite spend ledger with the @rbw/spend migrations, a scripted model behind
// an injected fetch, fake kit sessions, a fake controller that writes grade summaries (and, for
// grade 2, reserves and settles a Sandbox copy under the root, as the controller does), synthetic
// case files and a public_demo policy. The tests and `--dry-run` use it; it makes no live call.
// No value here was observed from a real system.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { buildPolicy, sha256Hex } from "@rbw/schema";
import type { CommandResult, RebuildResult, ServerLogsPage, SolverSession } from "@rbw/solver";
import type { SubmitResult } from "@rbw/solver-session";
import { createSpend, migrate } from "@rbw/spend";
import type { Spend } from "@rbw/spend";
import type { FetchFunction } from "@rbw/writer";
import { ledgerAllowanceSource } from "./allowance.ts";
import type { AllowanceSource, LedgerView } from "./allowance.ts";
import type { CaseConfig } from "./case.ts";
import { SessionRefused } from "./deps.ts";
import type { AttemptSession, CaseStates, SessionRequest, Uc1Deps } from "./deps.ts";
import { DEVELOPMENT_POOL, DEVELOPMENT_SLOT, PILOT_CASE_ID } from "./plan.ts";

// Synthetic target file: the clean file passes a time zone, the planted one drops it.
export const DRY_TARGET = "src/synthetic/getStats.ts";
export const DRY_CLEAN = ["export function stats(unit, zone) {", "  const start = 0;", "  const end = 1;", "  return range(unit, zone);", "}", ""].join("\n");
export const DRY_PLANTED = DRY_CLEAN.replace("range(unit, zone)", "range(unit)");
export const DRY_ALTERNATIVE = DRY_CLEAN.replace("range(unit, zone)", "range(unit, zone || 'UTC')");
export const DRY_OTHER = "src/synthetic/other.ts";
export const DRY_DIGEST = `sha256:${"d1".repeat(32)}`;
export const DRY_ISSUE = "Synthetic report: the daily chart counts visits on the wrong day for some time zones.";
/** What one dry-run grade 2 copy reserves and settles (micro-USD); close to one real Sandbox copy. */
export const DRY_COPY_MICROUSD = 148_682;

/** One scripted model reply. */
export type ModelReply =
  | { calls: { name: string; input: unknown }[]; usage?: { prompt_tokens: number; completion_tokens: number } }
  | { text: string }
  | { status: number; body: string }
  | { throws: true };

/** What the scripted model sees of a request. */
export interface ModelTurn {
  seed: number;
  /** 1 for the first request of an attempt. */
  turn: number;
  tools: string[];
}

export type ModelScript = (turn: ModelTurn) => ModelReply;

/**
 * The default script: read the target, write a fix (the clean file on odd seeds, the alternative
 * fix on even ones), rebuild, read the server logs when the arm has them, then submit.
 */
export const defaultScript: ModelScript = ({ seed, turn, tools }) => {
  const steps: { name: string; input: unknown }[] = [
    { name: "read_file", input: { path: DRY_TARGET } },
    { name: "write_file", input: { path: DRY_TARGET, content: seed % 2 === 1 ? DRY_CLEAN : DRY_ALTERNATIVE } },
    { name: "rebuild_restart", input: {} },
    ...(tools.includes("server_logs") ? [{ name: "server_logs", input: {} }] : []),
    { name: "submit", input: { summary: "passed the time zone through" } },
  ];
  const step = steps[Math.min(turn, steps.length) - 1];
  return { calls: step === undefined ? [] : [step] };
};

let callCounter = 0;

function completion(reply: Extract<ModelReply, { calls: unknown } | { text: string }>): string {
  const calls = "calls" in reply ? reply.calls : [];
  const message = {
    role: "assistant",
    content: "text" in reply ? reply.text : null,
    ...(calls.length > 0
      ? {
          tool_calls: calls.map((call) => {
            callCounter += 1;
            return { id: `call_${String(callCounter)}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } };
          }),
        }
      : {}),
  };
  const usage = "calls" in reply && reply.usage !== undefined ? reply.usage : { prompt_tokens: 1200, completion_tokens: 150 };
  return JSON.stringify({
    id: "synthetic",
    object: "chat.completion",
    created: 1,
    model: "synthetic-model",
    choices: [{ index: 0, message, finish_reason: calls.length > 0 ? "tool_calls" : "stop" }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  });
}

export interface ScriptedModel {
  fetch: FetchFunction;
  /** Every request body, in order. */
  bodies: string[];
}

/** A fetch that answers each solver request from the script, keyed by the request's seed and turn. */
export function scriptedModel(script: ModelScript): ScriptedModel {
  const bodies: string[] = [];
  const fetch: FetchFunction = (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    bodies.push(body);
    const parsed = JSON.parse(body) as { seed?: number; messages?: { role: string }[]; tools?: { function?: { name?: string } }[] };
    const turn = (parsed.messages ?? []).filter((message) => message.role === "assistant").length + 1;
    const tools = (parsed.tools ?? []).map((tool) => tool.function?.name ?? "");
    const reply = script({ seed: parsed.seed ?? 0, turn, tools });
    if ("throws" in reply) return Promise.reject(new Error("synthetic connection reset"));
    if ("status" in reply) return Promise.resolve(new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json" } }));
    return Promise.resolve(new Response(completion(reply), { status: 200, headers: { "content-type": "application/json" } }));
  };
  return { fetch, bodies };
}

/** A fake kit session over an in-memory app tree with the planted file in place. */
export class FakeKitSession implements AttemptSession {
  readonly planted_sha256 = sha256Hex(Buffer.from(DRY_PLANTED));
  readonly digest = DRY_DIGEST;
  readonly request: SessionRequest;
  readonly calls: string[] = [];
  private readonly initial = new Map<string, string>([
    [DRY_TARGET, DRY_PLANTED],
    [DRY_OTHER, "export const other = 1;\n"],
  ]);
  private readonly files = new Map(this.initial);
  private ended: { submission: SubmitResult; target: Buffer | null } | null = null;
  closed = false;
  readonly solver: SolverSession;

  constructor(request: SessionRequest, delayMs = 0) {
    this.request = request;
    const wait = () => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    const files = this.files;
    const calls = this.calls;
    const serverLogs = request.serverLogs;
    this.solver = {
      async bash(command: string): Promise<CommandResult> {
        calls.push(`bash:${command}`);
        await wait();
        return { exit_code: 0, stdout: "ok\n", stderr: "", timed_out: false };
      },
      async readFile(path: string) {
        calls.push(`read_file:${path}`);
        await wait();
        const content = files.get(path);
        return content === undefined ? { ok: false as const, error: "no such tracked file" } : { ok: true as const, content };
      },
      async writeFile(path: string, content: string) {
        calls.push(`write_file:${path}`);
        await wait();
        if (!files.has(path)) return { ok: false as const, error: "not_tracked" };
        files.set(path, content);
        return { ok: true as const };
      },
      async rebuildRestart(): Promise<RebuildResult> {
        calls.push("rebuild_restart");
        await wait();
        return {
          build: { exit_code: 0, stdout: "build_exit=0\n", stderr: "" },
          start: { exit_code: 0, stdout: "postgres_ready_ms=900\nready_ms=4200\nlistening tcp 127.0.0.1:3000", stderr: "" },
        };
      },
      async serverLogs(): Promise<ServerLogsPage> {
        calls.push("server_logs");
        await wait();
        if (!serverLogs) throw new Error("the session was opened for the off arm");
        return { text: "--- umami.stderr.log\nsynthetic log line\n--- postgres.stderr.log\n", next_cursor: "1.20.0", truncated: false };
      },
    };
  }

  end(reason: "submit" | "cap"): Promise<{ submission: SubmitResult; target: Buffer | null }> {
    this.calls.push(`end:${reason}`);
    if (this.ended !== null) return Promise.resolve(this.ended);
    const changed = [...this.initial.keys()].filter((path) => this.files.get(path) !== this.initial.get(path)).sort().map((path) => ({ path, change: "modified" as const }));
    const target = Buffer.from(this.files.get(DRY_TARGET) ?? "");
    this.ended = {
      submission: {
        scope: changed.some((item) => item.path !== DRY_TARGET) ? "out_of_scope" : "in_scope",
        changed,
        target_sha256: sha256Hex(target),
        target_patch: "",
      },
      target,
    };
    return Promise.resolve(this.ended);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** A grade's outcome in the fake controller. */
export type ControllerOutcome = "passed" | "failed" | "infrastructure";

export interface ControllerCall {
  args: string[];
  grade: 1 | 2;
  name: string;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function required(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new Error(`the fake controller needs ${name}`);
  return value;
}

interface GradeIds {
  project_id: string;
  batch_id: string;
  root_execution_id: string;
  executions: Record<string, string>;
}

/** Grade 2's ledger work as the controller does it: slot, one copy reserved, launched, ended and settled, slot released. */
async function chargeCopy(spend: Spend, ids: GradeIds, policySha: string, name: string): Promise<{ ok: true; settled: number } | { ok: false; reason: string }> {
  const root = ids.root_execution_id;
  const hold = await spend.acquireSlot({ slot_key: DEVELOPMENT_SLOT, root_execution_id: root, actor_role: "controller" });
  if (!hold.ok) return { ok: false, reason: `slot_${hold.code}` };
  const operation = sha256Hex(Buffer.from(`fake-copy:${root}:${name}`));
  const reserved = await spend.reserve({
    operation_id: operation,
    payload_hash: sha256Hex(Buffer.from(`payload:${name}`)),
    attempt_ordinal: 1,
    previous_operation_id: null,
    project_id: ids.project_id,
    project_policy_sha256: policySha,
    batch_id: ids.batch_id,
    task_revision: "0".repeat(64),
    root_execution_id: root,
    execution_id: ids.executions["alternative-fix"] ?? root,
    parent_execution_id: root,
    kind: "copy",
    call_name: `copy:${name}:1`,
    provider: "vercel-sandbox",
    provider_replay_key: null,
    pool_key: DEVELOPMENT_POOL,
    allocation_key: null,
    runtime_profile_sha256: "e".repeat(64),
    rate_sheet_sha256: "f".repeat(64),
    envelope: [{ service: "vercel-sandbox", unit: "creation", limit: 1, enforced_by: "client_counter", price: { microusd: DRY_COPY_MICROUSD, per_units: 1 } }],
  });
  if (!reserved.ok) {
    await spend.releaseSlot({ slot_key: DEVELOPMENT_SLOT, root_execution_id: root, actor_role: "controller", evidence: null, reason: null });
    return { ok: false, reason: `reserve_${reserved.code}` };
  }
  await spend.transition({ operation_id: operation, from_state: "prepared", to_state: "launching", actor_role: "controller", slot_key: DEVELOPMENT_SLOT });
  await spend.transition({ operation_id: operation, from_state: "launching", to_state: "terminal", actor_role: "controller", terminal_status: "completed" });
  await spend.settle({
    schema_version: 1,
    operation_id: operation,
    runtime_profile_sha256: "e".repeat(64),
    rate_sheet_sha256: "f".repeat(64),
    reserved_microusd: DRY_COPY_MICROUSD,
    service_lines: [{ service: "vercel-sandbox", unit: "creation", actual_quantity: 1, actual_microusd: DRY_COPY_MICROUSD, retained_microusd: 0 }],
    usage_state: "known",
    terminal_evidence_key: null,
    terminal_evidence_sha256: null,
  });
  await spend.releaseSlot({ slot_key: DEVELOPMENT_SLOT, root_execution_id: root, actor_role: "controller", evidence: null, reason: null });
  return { ok: true, settled: DRY_COPY_MICROUSD };
}

/**
 * A controller stand-in: reads the grade's arguments, writes `<work>/jobs/<name>/summary.json` as
 * the controller does, and for grade 2 charges one Sandbox copy under the root in the ledger.
 */
export function fakeController(spend: Spend, calls: ControllerCall[], outcome: (call: ControllerCall) => ControllerOutcome) {
  return async (args: readonly string[]): Promise<number> => {
    const name = required(args, "--name");
    const work = required(args, "--work");
    const backend = required(args, "--backend");
    const grade = backend === "docker" ? 1 : 2;
    const call: ControllerCall = { args: [...args], grade, name };
    calls.push(call);
    const fix = required(args, "--fix");
    const placed =
      required(args, "--judge-fixed") === "fixed"
        ? sha256Hex(Buffer.from(DRY_CLEAN))
        : (JSON.parse(readFileSync(join(fix, "alternative-fix.json"), "utf8")) as { result_sha256: string }).result_sha256;
    let state = outcome(call);
    let settled = 0;
    let reason: string | null = state === "infrastructure" ? "launch_failed" : null;
    if (grade === 2 && state !== "infrastructure") {
      const ids = JSON.parse(readFileSync(required(args, "--ids"), "utf8")) as GradeIds;
      const policySha = sha256Hex(readFileSync(required(args, "--project-policy")));
      const charged = await chargeCopy(spend, ids, policySha, name);
      if (charged.ok) settled = charged.settled;
      else {
        state = "infrastructure";
        reason = charged.reason;
      }
    }
    const trial = { trial_id: "fixed-01", code_state: "fixed", status: "complete", stage: "verify", reason: null, code: null, added_verdict: state === "passed" ? "match" : "mismatch", original_executed: 12, original_failed: 0, failed_test_ids: [] };
    const summary = {
      schema_version: 1,
      status: state === "infrastructure" ? "failed" : "complete",
      reason,
      job: { name, kind: "judge_verify", trials: ["fixed-01"] },
      controller: { backend, pool_key: DEVELOPMENT_POOL, allocation_key: null, slot_key: DEVELOPMENT_SLOT },
      copies: state === "infrastructure" ? [] : [{ trial_id: "fixed-01", copy: { placed_sha256: placed } }],
      import: state === "infrastructure" ? { refusal: null, trials: [] } : { refusal: null, trials: [trial] },
      spend: { reserved_microusd: settled, settled_microusd: settled, open_microusd: 0 },
    };
    const dir = join(work, "jobs", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
    return state === "passed" ? 0 : 1;
  };
}

export interface DryRunOptions {
  /** A temporary directory for the inputs and the runs. */
  root: string;
  script?: ModelScript;
  /** Thrown by openSession for this attempt (its work directory names it): an infrastructure error or a refusal. */
  sessionFault?: (request: SessionRequest, opened: number) => "error" | "refused" | null;
  controller?: (call: ControllerCall) => ControllerOutcome;
  /** Changes what the ledger shows (for example spend already settled under the roots). */
  view?: (real: LedgerView) => LedgerView;
  sessionDelayMs?: number;
  /** What the case's image tag resolves to now; the case's digest by default. */
  imageDigest?: () => string;
}

export interface DryRunWorld {
  deps: Uc1Deps;
  db: PGlite;
  spend: Spend;
  model: ScriptedModel;
  sessions: FakeKitSession[];
  controllerCalls: ControllerCall[];
  /** The time-zone pilot case (synthetic inputs, the committed screen record). */
  pilotCase: string;
  /** A synthetic race case whose screen record passes both verdicts. */
  raceCase: string;
  /** A public_demo policy. */
  policy: string;
  /** An evaluation (private) policy, which the orchestrator refuses. */
  privatePolicy: string;
  runsDir: string;
  reports: string[];
  close(): Promise<void>;
}

/** The committed screen record of the time-zone case. */
export const PILOT_SCREEN_RECORD = new URL("../../../docs/uc1-screen/umami-tz-arg-001.json", import.meta.url);

function writeJson(path: string, value: unknown): string {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

/** Builds the dry-run world under `options.root`. */
export async function dryRunWorld(options: DryRunOptions): Promise<DryRunWorld> {
  const inputs = join(options.root, "inputs");
  const runsDir = join(options.root, "runs");
  mkdirSync(inputs, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  const db = await PGlite.create();
  await migrate(db, { schema: "public" });
  const spend = createSpend({ client: db, schema: "public" });
  const slot = await spend.createSlotKey({ slot_key: DEVELOPMENT_SLOT, actor_role: "owner", reason: "dry-run ledger" });
  if (!slot.ok) throw new Error(`the dry-run ledger refused the slot key (${slot.code})`);

  writeFileSync(join(inputs, "issue.txt"), DRY_ISSUE);
  for (const name of ["manifest.json", "terms.txt", "original-suite.json"]) writeFileSync(join(inputs, name), "synthetic\n");
  mkdirSync(join(inputs, "stage"), { recursive: true });
  mkdirSync(join(inputs, "reference-fix"), { recursive: true });
  const base = {
    issue: join(inputs, "issue.txt"),
    image: "rbw-umami-kit:synthetic",
    image_digest: DRY_DIGEST,
    sandbox_image: `synthetic/kit@sha256:${"ab".repeat(32)}`,
    manifest: join(inputs, "manifest.json"),
    terms: join(inputs, "terms.txt"),
    audit_policy: null,
    probes_dir: null,
    reference_fix: join(inputs, "reference-fix"),
    kit_stage: join(inputs, "stage"),
    original_suite: join(inputs, "original-suite.json"),
  };
  const raceScreen = writeJson(join(inputs, "race-screen.json"), {
    schema_version: 1,
    case_id: "umami-race-synthetic-001",
    recorded: "2026-10-13",
    recorded_by: "synthetic",
    target: {},
    static_headroom: { verdict: "pass", judgment: "synthetic", reasons: [] },
    leak_screen: { verdict: "pass" },
    uc1_use: "synthetic",
  });
  const pilotCase = writeJson(join(inputs, "pilot-case.json"), { case_id: PILOT_CASE_ID, screen_record: fileURLToPath(PILOT_SCREEN_RECORD), ...base });
  const raceCase = writeJson(join(inputs, "race-case.json"), { case_id: "umami-race-synthetic-001", screen_record: raceScreen, ...base });
  const projectId = "00000000-0000-4000-8000-0000000000aa";
  const publicPolicy = buildPolicy({ projectId, outputRepository: "https://github.com/example/results", publicArtifactBaseUri: "https://example.invalid/artifacts/", policyVersion: 1 });
  const policy = join(inputs, "policy.json");
  writeFileSync(policy, publicPolicy.bytes);
  const privatePolicy = join(inputs, "private-policy.json");
  writeFileSync(privatePolicy, buildPolicy({ projectId, outputRepository: null, publicArtifactBaseUri: null, policyVersion: 1 }).bytes);

  const model = scriptedModel(options.script ?? defaultScript);
  const sessions: FakeKitSession[] = [];
  const controllerCalls: ControllerCall[] = [];
  const reports: string[] = [];
  const real = ledgerAllowanceSource(db, spend);
  const source: AllowanceSource = { view: async (roots) => (options.view ?? ((view) => view))(await real.view(roots)) };
  let uuidCounter = 0x100;
  let clock = Date.UTC(2026, 9, 13, 12, 0, 0);
  let opened = 0;
  const deps: Uc1Deps = {
    spend,
    allowanceSource: source,
    fetch: model.fetch,
    openSession: (request) => {
      opened += 1;
      const fault = options.sessionFault?.(request, opened) ?? null;
      if (fault === "refused") return Promise.reject(new SessionRefused("audit_not_passed: synthetic refusal"));
      if (fault === "error") return Promise.reject(new Error("container_start_failed: synthetic"));
      const session = new FakeKitSession(request, options.sessionDelayMs ?? 0);
      sessions.push(session);
      return Promise.resolve(session);
    },
    deriveStates: (config: CaseConfig): Promise<CaseStates> =>
      Promise.resolve({ target_path: DRY_TARGET, digest: config.image_digest, clean: Buffer.from(DRY_CLEAN), planted: Buffer.from(DRY_PLANTED), alternative: Buffer.from(DRY_ALTERNATIVE) }),
    resolveImage: () => Promise.resolve(options.imageDigest?.() ?? DRY_DIGEST),
    runController: fakeController(spend, controllerCalls, options.controller ?? (() => "passed")),
    grade2WorstCaseMicrousd: BigInt(DRY_COPY_MICROUSD),
    uuid: () => {
      uuidCounter += 1;
      return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, "0")}`;
    },
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    report: (line) => {
      reports.push(line);
    },
  };
  return { deps, db, spend, model, sessions, controllerCalls, pilotCase, raceCase, policy, privatePolicy, runsDir, reports, close: () => db.close() };
}
