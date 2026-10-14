import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { SqlClient } from "./client.ts";
import { assertSchemaName, createSpend, type Spend } from "./spend.ts";
import { OPERATION_STATES } from "./types.ts";
import type { ConfirmChildRequest, Evidence, ManualReconciliation, Refusal, ReleaseSlotRequest, Result, ResumeRequest } from "./types.ts";

export interface RunOperatorOptions {
  schema?: string;
  clock?: () => Date;
  write: (line: string, kind: "info" | "error") => void;
  redact?: (text: string) => string;
}

class UsageError extends Error {}
class LedgerError extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) { super(refusal.code); this.refusal = refusal; }
}
function checked<T>(result: Result<T>): { ok: true } & T {
  if (!result.ok) throw new LedgerError(result);
  return result;
}
function json(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => typeof v === "bigint" ? v.toString() : v);
}

type Action =
  | { command: "status"; root?: string; json: boolean }
  | { command: "reconcile"; request: ManualReconciliation }
  | { command: "confirm-child"; request: ConfirmChildRequest }
  | { command: "release-slot"; request: ReleaseSlotRequest }
  | { command: "resume"; request: ResumeRequest };

/** Validate all arguments and read all evidence before the first database read. */
async function parse(argv: string[], options: RunOperatorOptions): Promise<{ action: Action; schema: string; apply: boolean }> {
  const command = argv[0];
  const names: Record<string, string[]> = {
    status: ["root", "json"],
    reconcile: ["operation", "from", "decision", "retained", "released", "evidence", "reason", "resource", "apply"],
    "confirm-child": ["slot", "root", "provider", "resource", "status", "evidence", "apply"],
    "release-slot": ["slot", "root", "evidence", "reason", "apply"],
    resume: ["evidence", "reason", "apply"],
  };
  if (command === undefined || !Object.hasOwn(names, command)) throw new UsageError("expected status, reconcile, confirm-child, release-slot or resume");
  const definitions: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {};
  for (const name of ["schema", ...(names[command] ?? [])]) {
    definitions[name] = { type: name === "json" || name === "apply" ? "boolean" : "string", ...(name === "evidence" || name === "resource" ? { multiple: true } : {}) };
  }
  const { values } = parseArgs({ args: argv.slice(1), options: definitions, strict: true, allowPositionals: false });
  function required(name: string): string {
    const value = values[name];
    if (typeof value !== "string" || value.trim() === "") throw new UsageError(`--${name} is required`);
    return value;
  }
  function list(name: string): string[] {
    const value = values[name];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string" && v.trim() !== "")) throw new UsageError(`--${name} requires a non-blank value`);
    return value;
  }
  function root(): string {
    const value = required("root");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new UsageError("--root must be a UUID");
    return value.toLowerCase();
  }
  function amount(name: string): number {
    const value = required(name);
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new UsageError(`--${name} must be an integer from 0 to 9007199254740991`);
    return Number(value);
  }
  const schema = values.schema === undefined ? (options.schema ?? "public") : required("schema");
  assertSchemaName(schema);
  const apply = values.apply === true;
  if (command === "status") return { schema, apply, action: { command, json: values.json === true, ...(values.root === undefined ? {} : { root: root() }) } };
  const paths = list("evidence");
  if (paths.length === 0 || (command === "confirm-child" && paths.length !== 1)) throw new UsageError(command === "confirm-child" ? "--evidence requires exactly one file" : "--evidence requires at least one file");
  const evidence: Evidence[] = [];
  for (const key of paths) {
    evidence.push({ key, sha256: createHash("sha256").update(await readFile(key)).digest("hex") });
  }
  const actor_role = "operator";
  let action: Action;
  if (command === "reconcile") {
    const previous_state = required("from");
    if (!OPERATION_STATES.some(s => s === previous_state)) throw new UsageError("invalid --from state");
    const decision = required("decision");
    if (decision !== "found_running" && decision !== "confirm_no_launch" && decision !== "accept_complete" && decision !== "confirm_stopped_incomplete") throw new UsageError("invalid --decision");
    action = { command, request: {
      schema_version: 1, operation_id: required("operation"), previous_state: previous_state as ManualReconciliation["previous_state"],
      decision, retained_microusd: amount("retained"), released_microusd: amount("released"),
      evidence, provider_resource_ids: list("resource"), recorded_at: (options.clock ?? (() => new Date()))().toISOString(), actor_role, reason: required("reason"),
    } };
  } else if (command === "confirm-child") {
    const terminal_status = required("status");
    if (terminal_status !== "completed" && terminal_status !== "failed" && terminal_status !== "cancelled") throw new UsageError("--status must be completed, failed or cancelled");
    const resources = list("resource");
    const resource = resources[0];
    const proof = evidence[0];
    if (resources.length !== 1 || resource === undefined || proof === undefined) throw new UsageError("--resource requires exactly one ID");
    action = { command, request: { slot_key: required("slot"), root_execution_id: root(), provider: required("provider"), resource_id: resource, terminal_status, evidence: proof, actor_role } };
  } else if (command === "release-slot") {
    action = { command, request: { slot_key: required("slot"), root_execution_id: root(), evidence, reason: required("reason"), actor_role } };
  } else {
    action = { command: "resume", request: { evidence, reason: required("reason"), actor_role } };
  }
  return { action, schema, apply };
}

function normalize(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value === null) return [key, null];
    if (value instanceof Date) return [key, value.toISOString()];
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return [key, String(value)];
    throw new Error(`unexpected status column type: ${key}`);
  }));
}

async function snapshot(client: SqlClient, spend: Spend, schema: string, root: string | undefined, now: Date) {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const halt = checked(await spend.haltStatus());
    const pools = [];
    for (const row of (await client.query(`SELECT p.pool_key FROM ${schema}.pools p ORDER BY p.pool_key`)).rows) {
      pools.push(checked(await spend.poolStatus({ pool_key: String(row.pool_key) })));
    }
    const slots = [];
    for (const row of (await client.query(`SELECT s.slot_key FROM ${schema}.execution_slot s ORDER BY s.slot_key`)).rows) {
      const slot = checked(await spend.slotStatus({ slot_key: String(row.slot_key) }));
      const event = (await client.query(`SELECT e.seq::text AS seq_text, e.kind, e.root_execution_id::text AS root_execution_id, e.actor_role, e.recorded_at
        FROM ${schema}.slot_events e WHERE e.slot_key = $1 ORDER BY e.seq DESC LIMIT 1`, [slot.slot_key])).rows[0];
      const latest_event = event === undefined ? null : normalize(event);
      const holder_age_seconds = slot.holder !== null && latest_event !== null
        ? String(Math.floor((now.getTime() - Date.parse(String(latest_event.recorded_at))) / 1000)) : null;
      slots.push({ ...slot, latest_event, holder_age_seconds });
    }
    async function operations(where: string, params: unknown[]) {
      const rows = (await client.query(`SELECT o.seq::text AS seq_text, o.operation_id, o.root_execution_id::text AS root_execution_id,
        o.kind, o.call_name, o.provider, o.pool_key, o.allocation_key, o.recorded_at
        FROM ${schema}.operations o WHERE ${where} ORDER BY o.seq`, params)).rows;
      const out = [];
      for (const row of rows) out.push({ ...normalize(row), ...checked(await spend.operationStatus({ operation_id: String(row.operation_id) })) });
      return out;
    }
    const open = await operations(`${schema}.spend_operation_state(o.operation_id) <> 'reconciled'`, []);
    if (root === undefined) return { halt, pools, slots, operations: open };
    const rootOperations = await operations("o.root_execution_id = $1", [root]);
    const events = (await client.query(`SELECT e.seq::text AS seq_text, e.slot_key, e.kind, e.root_execution_id::text AS root_execution_id, e.actor_role, e.recorded_at
      FROM ${schema}.slot_events e WHERE e.root_execution_id = $1 ORDER BY e.seq`, [root])).rows.map(normalize);
    return { halt, pools, slots, operations: open, root: { root_execution_id: root, operations: rootOperations, slot_events: events } };
  } finally {
    await client.query("ROLLBACK");
  }
}

/** Exact integer formatting avoids rounding micro-USD through a floating-point conversion. */
function usd(amount: bigint): string {
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? "-" : ""}${String(absolute / 1_000_000n)}.${String(absolute % 1_000_000n).padStart(6, "0")} USD`;
}
function textLines(value: unknown, key = "status", depth = 0): string[] {
  const prefix = "  ".repeat(depth);
  if (typeof value === "bigint") return [`${prefix}${key}: ${String(value)}${key.endsWith("_microusd") ? ` micro-USD (${usd(value)})` : ""}`];
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return [`${prefix}${key}:${entries.length === 0 ? " []" : ""}`, ...entries.flatMap(([k, v]: [string, unknown]) => textLines(v, k, depth + 1))];
  }
  return [`${prefix}${key}: ${value === null && key === "holder" ? "free" : String(value)}`];
}

/** Operator reads and evidence-backed actions. The database retains authority over every write. */
export async function runOperator(client: SqlClient, argv: string[], options: RunOperatorOptions): Promise<number> {
  const redact = options.redact ?? ((text: string) => text);
  const emit = (label: string, value: unknown) => { options.write(`${label}: ${json(value)}`, "info"); };
  const fail = (message: string) => { options.write(message, "error"); return 1; };
  let parsed: Awaited<ReturnType<typeof parse>>;
  try { parsed = await parse(argv, options); }
  catch (error) { options.write(`operator usage: ${redact(error instanceof Error ? error.message : String(error))}`, "error"); return 2; }
  const { action, schema, apply } = parsed;
  const spend = createSpend({ client, schema, ...(options.clock === undefined ? {} : { clock: options.clock }) });
  try {
    if (action.command === "status") {
      const value = await snapshot(client, spend, schema, action.root, (options.clock ?? (() => new Date()))());
      if (action.json) options.write(json(value), "info");
      else for (const line of textLines(value)) options.write(line, "info");
      return 0;
    }
    if (action.command === "reconcile") {
      const request = action.request;
      const current = checked(await spend.operationStatus({ operation_id: request.operation_id }));
      emit("current operation", current);
      if (current.state !== request.previous_state) return fail(`current state is ${current.state}; --from was ${request.previous_state}`);
      const retained = BigInt(request.retained_microusd);
      const released = BigInt(request.released_microusd);
      const open = current.open_microusd;
      if (request.decision === "found_running") {
        if (request.provider_resource_ids.length === 0 || retained !== open || released !== 0n) return fail(`found_running requires at least one resource, retained equal to open amount ${String(open)}, and released 0`);
      } else {
        if (request.decision === "confirm_no_launch" && request.provider_resource_ids.length > 0) return fail(`confirm_no_launch lists no provider resources (open amount ${String(open)})`);
        if (retained + released !== open && !(released === 0n && retained > open)) return fail(`retained_microusd + released_microusd must equal the open amount ${String(open)}, or released 0 with retained above it when evidenced usage exceeds it`);
      }
      if (retained > open) options.write("over-envelope: evidenced usage exceeds open spend; applying records an observation and halts new work", "info");
      emit("request", request);
      if (!apply) return 0;
      const result = await spend.reconcile(request);
      emit("result", result);
      emit("operation", checked(await spend.operationStatus({ operation_id: request.operation_id })));
      if (result.ok && result.over_envelope) emit("halt", checked(await spend.haltStatus()));
      return result.ok ? 0 : 1;
    }
    if (action.command === "confirm-child" || action.command === "release-slot") {
      const request = action.request;
      const current = checked(await spend.slotStatus({ slot_key: request.slot_key }));
      emit("current slot", current);
      if (current.holder !== request.root_execution_id) return fail("slot holder does not match --root");
      if (action.command === "confirm-child") {
        const match = current.children.find(child => child.provider === action.request.provider && child.resource_id === action.request.resource_id);
        if (match === undefined) return fail("no matching child for --provider and --resource");
        emit("current child", match);
      } else if (current.release_blockers.operation_ids.length > 0 || current.release_blockers.child_resources.length > 0) return fail("slot release has blockers");
      emit("request", request);
      if (!apply) return 0;
      const result = action.command === "confirm-child" ? await spend.confirmChild(action.request) : await spend.releaseSlot(action.request);
      emit("result", result);
      emit("slot", checked(await spend.slotStatus({ slot_key: request.slot_key })));
      return result.ok ? 0 : 1;
    }
    const current = checked(await spend.haltStatus());
    emit("current halt", current);
    if (!current.halted) return fail("new work is not halted");
    emit("request", action.request);
    if (!apply) return 0;
    const result = await spend.resume(action.request);
    emit("result", result);
    emit("halt", checked(await spend.haltStatus()));
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof LedgerError) { emit("refusal", error.refusal); return 1; }
    options.write(`operator failed: ${redact(error instanceof Error ? error.message : String(error))}`, "error");
    return 2;
  }
}
