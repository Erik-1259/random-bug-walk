import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SqlClient } from "../../src/client.ts";
import { runOperator } from "../../src/operator.ts";
import { expectOk, harness, openDb, setup, reserveRequest, reserveAndLaunch, reserveToTerminal, settlement, haltWithOverrun, ROOT, OTHER_ROOT, SLOT, POOL, hex, type Harness } from "../helpers.ts";

let db: PGlite;
let h: Harness;
let directory: string;
let evidence: string;
const bytes = "synthetic evidence\n";
const sha256 = createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  db = await openDb();
  directory = await mkdtemp(join(tmpdir(), "synthetic-operator-"));
  evidence = relative(process.cwd(), join(directory, "synthetic-evidence.txt"));
  await writeFile(evidence, bytes);
});
afterAll(async () => { await db.close(); await rm(directory, { recursive: true }); });
beforeEach(async () => { h = await harness(db); });

async function run(args: string[], client: SqlClient = h.client, redact = (s: string) => s) {
  const lines: string[] = [];
  const code = await runOperator(client, args, { schema: h.schema, clock: h.clock.now, write: (line) => lines.push(line), redact });
  return { code, text: lines.join("\n"), lines };
}
function reconcile(op: string, extra: string[] = []) {
  return ["reconcile", "--operation", op, "--from", "terminal", "--decision", "accept_complete", "--retained", "1000", "--released", "0", "--evidence", evidence, "--reason", "synthetic reason", ...extra];
}
function release(root = ROOT) { return ["release-slot", "--slot", SLOT, "--root", root, "--evidence", evidence, "--reason", "synthetic reason"]; }
function confirm() { return ["confirm-child", "--slot", SLOT, "--root", ROOT, "--provider", "synthetic-provider", "--resource", "synthetic-child", "--status", "completed", "--evidence", evidence]; }
async function hold() { expectOk(await h.spend.acquireSlot({ slot_key: SLOT, root_execution_id: ROOT, actor_role: "workflow" })); }
async function child() {
  await hold();
  expectOk(await h.spend.recordChild({ slot_key: SLOT, root_execution_id: ROOT, provider: "synthetic-provider", resource_id: "synthetic-child", operation_id: null, execution_id: null, kind: "synthetic-kind", actor_role: "workflow" }));
}
async function unchanged(args: string[], code: number) {
  const before = await h.counts();
  const result = await run(args);
  expect(result.code).toBe(code);
  expect(await h.counts()).toEqual(before);
  return result;
}
interface Snapshot {
  halt: { halted: boolean };
  pools: { pool_key: string; cap_microusd: string; allocations: { allocation_key: string }[] }[];
  slots: { holder: string | null; latest_event: { recorded_at: string; actor_role: string; kind: string } | null }[];
  operations: { operation_id: string; state: string; open_microusd: string }[];
  root?: { operations: { operation_id: string }[]; slot_events: { kind: string; seq_text: string }[] };
}
function snapshot(text: string): Snapshot { return JSON.parse(text) as Snapshot; }

describe("operator status", () => {
  it("shows seeded pools, allocations and no operations or slots, then a new free key", async () => {
    const result = await unchanged(["status", "--json"], 0);
    const status = snapshot(result.text);
    expect(status.halt.halted).toBe(false);
    expect(status.pools.map(p => p.pool_key)).toEqual(["development", "judge-demo"]);
    expect(status.pools[1]?.allocations.map(a => a.allocation_key).sort()).toEqual(["judge", "public"]);
    expect(status.pools.every(p => /^\d+$/.test(p.cap_microusd))).toBe(true);
    expect(status.slots).toEqual([]);
    expect(status.operations).toEqual([]);
    await setup(h);
    expect(snapshot((await run(["status", "--json"])).text).slots[0]?.holder).toBeNull();
    expect((await run(["status"])).text).toContain("free");
  });
  it("lists prepared, uncertain and terminal open operations, with reconciled operations only under root", async () => {
    await setup(h);
    const prepared = expectOk(await h.spend.reserve(reserveRequest(1))).operation_id;
    const uncertain = await reserveAndLaunch(h, 2);
    expectOk(await h.spend.transition({ operation_id: uncertain, from_state: "launching", to_state: "uncertain", actor_role: "workflow", uncertainty: "lost_response" }));
    const terminal = await reserveToTerminal(h, 3);
    const closed = await reserveToTerminal(h, 4);
    expectOk(await h.spend.settle(settlement(closed)));
    const result = await unchanged(["status", "--json", "--root", ROOT], 0);
    const status = snapshot(result.text);
    expect(status.operations.map(o => o.operation_id)).toEqual([prepared, uncertain, terminal]);
    expect(status.operations.map(o => o.state)).toEqual(["prepared", "uncertain", "terminal"]);
    expect(status.operations.map(o => o.open_microusd)).toEqual(["1000", "1000", "1000"]);
    expect(status.root?.operations.map(o => o.operation_id)).toEqual([prepared, uncertain, terminal, closed]);
    expect(status.slots[0]).toMatchObject({ holder: ROOT, latest_event: { actor_role: "workflow", recorded_at: h.clock.now().toISOString() } });
    expect(result.text).not.toContain('"intent"');
    const text = (await run(["status"])).text;
    expect(text).toContain("0.001000 USD");
    expect(text).toContain("synthetic.generate");
  });
  it("wraps every read in a repeatable read read-only transaction and rolls back", async () => {
    const statements: string[] = [];
    const client: SqlClient = { exec: s => h.client.exec(s), query: async (s, p) => { statements.push(s); return h.client.query(s, p); } };
    expect((await run(["status"], client)).code).toBe(0);
    expect(statements[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.slice(1, -1).every(s => s.startsWith("SELECT"))).toBe(true);
  });
  it("rolls back after a failed snapshot read and redacts infrastructure errors", async () => {
    const statements: string[] = [];
    const client: SqlClient = { exec: s => h.client.exec(s), query: async (s, p) => { statements.push(s); if (s.startsWith("SELECT")) throw new Error("synthetic-secret"); return h.client.query(s, p); } };
    const result = await run(["status"], client, s => s.replaceAll("synthetic-secret", "[redacted]"));
    expect(result.code).toBe(2);
    expect(result.text).toContain("[redacted]");
    expect(result.text).not.toContain("synthetic-secret");
    expect(statements.at(-1)).toBe("ROLLBACK");
  });
  it("orders operations by numeric sequence across 100 even when timestamps run backward", async () => {
    await setup(h);
    const ids: string[] = [];
    for (let n = 1; n <= 55; n++) {
      if (n === 25) h.clock.advance(-3_600_000);
      ids.push(expectOk(await h.spend.reserve(reserveRequest(n))).operation_id);
    }
    const seqs = await h.sql("SELECT o.seq::text AS seq_text FROM operations o ORDER BY o.seq");
    expect(Number(seqs[0]?.seq_text)).toBeLessThan(100);
    expect(Number(seqs.at(-1)?.seq_text)).toBeGreaterThanOrEqual(100);
    expect(snapshot((await run(["status", "--json"])).text).operations.map(o => o.operation_id)).toEqual(ids);
  });
  it("uses the latest numeric event and orders root events by sequence across 100", async () => {
    await setup(h);
    for (let n = 1; n <= 10; n++) expectOk(await h.spend.reserve(reserveRequest(n, { root_execution_id: OTHER_ROOT, execution_id: OTHER_ROOT })));
    await hold();
    for (let n = 11; n <= 55; n++) expectOk(await h.spend.reserve(reserveRequest(n, { root_execution_id: OTHER_ROOT, execution_id: OTHER_ROOT })));
    h.clock.advance(-3_600_000);
    expectOk(await h.spend.releaseSlot({ slot_key: SLOT, root_execution_id: ROOT, actor_role: "operator", evidence: [{ key: "synthetic-evidence", sha256: hex(1) }], reason: "synthetic reason" }));
    const events = await h.sql("SELECT e.seq::text AS seq_text FROM slot_events e ORDER BY e.seq");
    expect(Number(events[0]?.seq_text)).toBeLessThan(100);
    expect(Number(events[1]?.seq_text)).toBeGreaterThanOrEqual(100);
    expect(String(events[0]?.seq_text) > String(events[1]?.seq_text)).toBe(true);
    const status = snapshot((await run(["status", "--json", "--root", ROOT])).text);
    expect(status.slots[0]).toMatchObject({ holder: null, latest_event: { kind: "release", recorded_at: h.clock.now().toISOString(), actor_role: "operator" } });
    expect(status.root?.slot_events.map(e => e.kind)).toEqual(["acquire", "release"]);
    expect(status.root?.slot_events.map(e => e.seq_text)).toEqual(events.map(e => e.seq_text));
  });
});

describe("operator writes", () => {
  beforeEach(async () => { await setup(h); });
  it.each(["reconcile", "confirm-child", "release-slot", "resume"])("%s dry run prints exact evidence and request without writing", async command => {
    let args: string[];
    if (command === "reconcile") args = reconcile(await reserveToTerminal(h, 1));
    else if (command === "confirm-child") { await child(); args = confirm(); }
    else if (command === "release-slot") { await hold(); args = release(); }
    else { await haltWithOverrun(h, 1); args = ["resume", "--evidence", evidence, "--reason", "synthetic reason"]; }
    const result = await unchanged(args, 0);
    const requestLine = result.lines.find(l => l.startsWith("request: "));
    expect(requestLine).toBeDefined();
    const request = JSON.parse((requestLine ?? "").slice(9)) as Record<string, unknown>;
    expect(request.actor_role).toBe("operator");
    expect(request.evidence).toEqual(command === "confirm-child" ? { key: evidence, sha256 } : [{ key: evidence, sha256 }]);
    if (command === "reconcile") expect(request).toMatchObject({ schema_version: 1, previous_state: "terminal", provider_resource_ids: [], recorded_at: h.clock.now().toISOString(), retained_microusd: 1000, released_microusd: 0 });
    expect(result.text).toContain("current");
  });
  it("applies reconciliation and lowers pool open spend", async () => {
    const op = await reserveToTerminal(h, 1);
    expect((await run([...reconcile(op), "--apply"])).code).toBe(0);
    expect(expectOk(await h.spend.operationStatus({ operation_id: op })).state).toBe("reconciled");
    expect(expectOk(await h.spend.poolStatus({ pool_key: POOL })).open_microusd).toBe(0n);
  });
  it("allows evidenced over-envelope reconciliation, warns in dry run and apply, and prints the resulting halt", async () => {
    const op = await reserveToTerminal(h, 1);
    const args = reconcile(op); args[args.indexOf("--retained") + 1] = "1400";
    expect((await unchanged(args, 0)).text).toMatch(/over-envelope.*halt/i);
    const result = await run([...args, "--apply"]);
    expect(result.code).toBe(0);
    expect(result.text).toMatch(/over-envelope.*halt/i);
    expect(result.text).toContain('"over_envelope":true');
    expect(result.text).toContain('"halted":true');
    expect(expectOk(await h.spend.operationStatus({ operation_id: op })).state).toBe("reconciled");
    expect(expectOk(await h.spend.haltStatus()).halted).toBe(true);
  });
  it("rejects a stale state before writing and prints current open spend", async () => {
    const op = await reserveToTerminal(h, 1); const args = reconcile(op); args[args.indexOf("--from") + 1] = "prepared";
    const result = await unchanged([...args, "--apply"], 1);
    expect(result.text).toContain("terminal"); expect(result.text).toContain("1000");
  });
  it("rejects amounts that do not account for open spend", async () => {
    const args = reconcile(await reserveToTerminal(h, 1)); args[args.indexOf("--retained") + 1] = "500"; args[args.indexOf("--released") + 1] = "400";
    const result = await unchanged([...args, "--apply"], 1);
    expect(result.text).toMatch(/retained.*released/); expect(result.text).toContain("1000");
  });
  it("reports the database's invalid_transition refusal", async () => {
    const args = reconcile(await reserveToTerminal(h, 1)); args[args.indexOf("--decision") + 1] = "found_running";
    const result = await run([...args, "--resource", "synthetic-child", "--apply"]);
    expect(result.code).toBe(1); expect(result.text).toContain("invalid_transition");
  });
  it.each(["no-resource", "wrong-retained", "nonzero-released", "no-launch-resource"])("prechecks reconciliation resource and amount rule: %s", async scenario => {
    const args = reconcile(await reserveToTerminal(h, 1)); args[args.indexOf("--decision") + 1] = scenario === "no-launch-resource" ? "confirm_no_launch" : "found_running";
    if (scenario !== "no-resource") args.push("--resource", "synthetic-child");
    if (scenario === "wrong-retained") args[args.indexOf("--retained") + 1] = "999";
    if (scenario === "nonzero-released") args[args.indexOf("--released") + 1] = "1";
    expect((await unchanged(args, 1)).text).toContain("1000");
  });
  it("releases a held slot and records evidence and reason", async () => {
    await hold(); const result = await run([...release(), "--apply"]);
    expect(result.code).toBe(0); expect(result.text).toContain('"holder":null');
    expect(expectOk(await h.spend.slotStatus({ slot_key: SLOT })).holder).toBeNull();
    const rows = await h.sql("SELECT evidence, reason, actor_role FROM slot_events WHERE kind = 'release'");
    expect(rows[0]).toMatchObject({ evidence: [{ key: evidence, sha256 }], reason: "synthetic reason", actor_role: "operator" });
  });
  it("refuses release for a wrong root", async () => { await hold(); expect((await unchanged([...release(OTHER_ROOT), "--apply"], 1)).text).toContain(ROOT); });
  it("refuses release with operation and child blockers and prints them", async () => {
    await child(); const op = expectOk(await h.spend.reserve(reserveRequest(1))).operation_id;
    const result = await unchanged([...release(), "--apply"], 1);
    expect(result.text).toContain(op); expect(result.text).toContain("synthetic-child");
  });
  it("confirms a child, removes its blocker, and permits a replay", async () => {
    await child(); expect((await run([...confirm(), "--apply"])).code).toBe(0);
    const status = expectOk(await h.spend.slotStatus({ slot_key: SLOT }));
    expect(status.children[0]).toMatchObject({ confirmed: true, terminal_status: "completed" });
    expect(status.release_blockers.child_resources).toEqual([]);
    expect((await run([...confirm(), "--apply"])).code).toBe(0);
  });
  it.each(["root", "resource"])("rejects child confirmation for a mismatched %s", async field => {
    await child(); const args = confirm(); args[args.indexOf(`--${field}`) + 1] = field === "root" ? OTHER_ROOT : "synthetic-missing";
    expect((await unchanged([...args, "--apply"], 1)).text).toContain(ROOT);
  });
  it("resumes a halt and prints the cleared status", async () => {
    await haltWithOverrun(h, 1);
    const result = await run(["resume", "--evidence", evidence, "--reason", "synthetic reason", "--apply"]);
    expect(result.code).toBe(0); expect(result.text).toContain('"halted":false');
    expect(expectOk(await h.spend.haltStatus()).halted).toBe(false);
  });
  it("refuses resume when nothing is halted", async () => { expect((await unchanged(["resume", "--evidence", evidence, "--reason", "synthetic reason"], 1)).text).toMatch(/not halted|nothing.*halted/i); });
  it("does not redact ledger values", async () => {
    await hold(); const result = await run(release(), h.client, s => s.replaceAll("synthetic", "[redacted]"));
    expect(result.text).toContain("synthetic reason"); expect(result.text).toContain(SLOT);
  });
});

describe("operator usage", () => {
  it.each([
    ["unknown"], ["resume", "--evidence", "synthetic-missing"],
    ["resume", "--evidence", "synthetic-missing", "--reason", "synthetic"],
    ["status", "--role", "owner"], ["status", "--apply"], ["status", "--root", "bad"],
    ["status", "--schema", "bad-schema"],
  ])("rejects invalid arguments before any database reads: %j", async (...args: string[]) => {
    let reads = 0;
    const client: SqlClient = { exec: () => { reads++; return Promise.resolve(); }, query: () => { reads++; return Promise.resolve({ rows: [] }); } };
    expect((await run(args, client)).code).toBe(2); expect(reads).toBe(0);
  });
  it.each(["-1", "1.5", "9007199254740992", "1e3", "NaN"])("rejects invalid amount %s before reading", async amount => {
    const args = reconcile(hex(1)); args[args.indexOf("--retained") + 1] = amount;
    let reads = 0;
    const client: SqlClient = { exec: () => { reads++; return Promise.resolve(); }, query: () => { reads++; return Promise.resolve({ rows: [] }); } };
    expect((await run(args, client)).code).toBe(2); expect(reads).toBe(0);
  });
  it("rejects an invalid decision before reading", async () => {
    const args = reconcile(hex(1)); args[args.indexOf("--decision") + 1] = "bad-decision";
    expect((await unchanged(args, 2)).text).toContain("decision");
  });
  it("requires a reason with readable evidence before any database read", async () => {
    let reads = 0;
    const client: SqlClient = { exec: () => { reads++; return Promise.resolve(); }, query: () => { reads++; return Promise.resolve({ rows: [] }); } };
    const result = await run(["resume", "--evidence", evidence], client);
    expect(result.code).toBe(2); expect(result.text).toContain("--reason"); expect(reads).toBe(0);
  });
  it.each(["0", "9007199254740991"])("accepts the amount boundary %s without losing precision", async amount => {
    await setup(h);
    const args = reconcile(await reserveToTerminal(h, 1));
    args[args.indexOf("--retained") + 1] = amount;
    args[args.indexOf("--released") + 1] = amount === "0" ? "1000" : "0";
    const result = await unchanged(args, 0);
    expect(result.text).toContain(`"retained_microusd":${amount}`);
  });
  it("preserves repeated evidence keys and resources in a reconciliation request", async () => {
    await setup(h);
    const op = await reserveAndLaunch(h, 1);
    const args = reconcile(op);
    args[args.indexOf("--from") + 1] = "launching";
    args[args.indexOf("--decision") + 1] = "found_running";
    const result = await unchanged([...args, "--resource", "synthetic-first", "--resource", "synthetic-second", "--evidence", `./${evidence}`], 0);
    const request = JSON.parse((result.lines.find(l => l.startsWith("request: ")) ?? "").slice(9)) as Record<string, unknown>;
    expect(request.evidence).toEqual([{ key: evidence, sha256 }, { key: `./${evidence}`, sha256 }]);
    expect(request.provider_resource_ids).toEqual(["synthetic-first", "synthetic-second"]);
  });
  it("uses --schema to select the requested snapshot", async () => {
    const other = await harness(db);
    await setup(other);
    const result = await unchanged(["status", "--schema", other.schema, "--json"], 0);
    expect(snapshot(result.text).pools.some(p => p.pool_key === POOL)).toBe(true);
  });
  it("requires exactly one evidence for confirm-child", async () => { expect((await unchanged([...confirm(), "--evidence", evidence], 2)).text).toContain("evidence"); });
});

describe("operator CLI", () => {
  function cli(url?: string) {
    const environment = { ...process.env }; delete environment.DATABASE_URL;
    if (url !== undefined) environment.DATABASE_URL = url;
    return spawnSync(process.execPath, ["src/operator-cli.ts", "status"], { env: environment, encoding: "utf8", timeout: 20_000 });
  }
  it("names unset DATABASE_URL and exits 2", () => { const result = cli(); expect(result.status).toBe(2); expect(result.stderr).toContain("DATABASE_URL"); });
  it("prints no connection-string parts on connection failure", () => {
    const result = cli("postgres://synthetic-user:synthetic-secret@127.0.0.1:9/synthetic-db");
    expect(result.status).toBe(2);
    const text = `${result.stdout}\n${result.stderr}`;
    for (const part of ["synthetic-user", "synthetic-secret", "127.0.0.1", "9", "synthetic-db"]) expect(text).not.toContain(part);
    expect(text).toContain("DATABASE_URL"); expect(text).toContain("again");
  });
});
