import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { contractRevision, runAcceptance, runProbe, type IsolatedBackend, type Reply } from "../src/runner.ts";
import { checkStatus, object, objects, integer, text } from "../src/invariants.ts";
const fixture = (name: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
  return object(value);
};
const probe = { scenario: "two-host-fulfilled", input: object(fixture("interpretation-supported").input), outcome: "fulfilled", stopCode: "fulfilled", concurrent: true, expectedDelivery: "complete", expectedItems: objects(fixture("interpretation-supported").items), expectedCounts: objects(fixture("status-fulfilled").items) };
function scripted() {
  let id = "";
  let starts = 0;
  const response = (name: string) => {
    const value: unknown = JSON.parse(JSON.stringify(fixture(name)).replaceAll("00000000-0000-4000-8000-000000000101", id));
    return object(value);
  };
  const request = vi.fn((method: "GET" | "POST", path: string, payload?: unknown): Promise<Reply> => {
    let reply: Reply;
    if (path.endsWith("/test/reset")) reply = { status: 204, body: null };
    else if (path.endsWith("/interpretations")) reply = { status: 200, body: fixture("interpretation-supported") };
    else if (method === "POST" && path.endsWith("/requests")) {
      id = String(object(payload).request_id); starts++;
      if (starts === 5) reply = { status: 409, body: { contract_version: "bug-request/1", error: { code: "idempotency_conflict" } } };
      else reply = { status: starts === 1 ? 202 : 200, body: response("status-queued") };
    } else {
      assert(path.includes(id));
      const value = response("status-fulfilled");
      const after = Number(path.split("?after=")[1] ?? 0);
      value.events = objects(value.events).filter(e => integer(e.seq) > after);
      reply = { status: 200, body: value };
    }
    return Promise.resolve(reply);
  });
  const backend: IsolatedBackend = {
    verifyIsolation: vi.fn(() => Promise.resolve({ backendRevision: "a".repeat(40), contractRevision })),
    request, wait: vi.fn(() => Promise.resolve()), reconnect: vi.fn(() => Promise.resolve()),
  };
  return { backend, request };
}
it("reports eight unavailable scenarios without an approved isolated backend", async () => {
  const report = await runAcceptance();
  expect(report.acceptance_executed).toBe(false);
  expect(report.summary).toEqual({ passed: 0, failed: 0, unavailable: 8 });
  expect(report.exit_code).toBe(2);
});
it("does not reset or start when isolation verification fails", async () => {
  const { backend, request } = scripted();
  backend.verifyIsolation = () => Promise.reject(new Error("synthetic-verification-failure"));
  expect((await runAcceptance(backend)).exit_code).toBe(2);
  expect(request).not.toHaveBeenCalled();
});
it("does not execute against a different contract revision", async () => {
  const { backend, request } = scripted();
  backend.verifyIsolation = () => Promise.resolve({ backendRevision: "a".repeat(40), contractRevision: "b".repeat(40) });
  expect((await runAcceptance(backend)).acceptance_executed).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
it("exercises repeated, concurrent and conflicting starts with one ID then reconnects", async () => {
  const { backend, request } = scripted();
  await runProbe(backend, probe);
  const starts = request.mock.calls.filter(c => c[1] === "/api/factory/requests");
  expect(starts).toHaveLength(5);
  expect(new Set(starts.map(c => object(c[2]).request_id)).size).toBe(1);
  expect(starts.slice(0, 4).map(c => c[2])).toEqual(Array(4).fill(starts[0]?.[2]));
  expect(backend.wait).toHaveBeenCalledWith(fixture("status-queued").poll_after_ms);
  expect(backend.reconnect).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]).toEqual(["POST", "/api/factory/test/reset", { scenario: "two-host-fulfilled" }]);
});
it("detects duplicate acceptance rather than trusting the returned identity", async () => {
  const { backend, request } = scripted();
  backend.request = async (...args) => {
    const reply = await request(...args);
    return args[0] === "POST" && args[1] === "/api/factory/requests" ? { ...reply, status: 202 } : reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("start accepted more or less than once");
});
it("detects incorrect event sequence on status reads", async () => {
  const { backend, request } = scripted();
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "GET") object(reply.body).events = [{ seq: 7 }];
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("event gap or duplicate");
});
it("does not accept changed terminal identity after reconnect", async () => {
  const { backend, request } = scripted();
  let connectedAgain = false;
  backend.reconnect = () => { connectedAgain = true; return Promise.resolve(); };
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (connectedAgain) object(reply.body).request_id = "synthetic-other-request";
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow();
});
it("backs off unavailable status reads without starting a replacement request", async () => {
  const { backend, request } = scripted();
  let outages = 0;
  backend.request = (...args) => {
    if (args[0] === "GET" && outages++ < 3) return Promise.resolve({ status: 503, body: { contract_version: "bug-request/1", error: { code: "unavailable" } } });
    return request(...args);
  };
  await runProbe(backend, probe);
  expect(backend.wait).toHaveBeenCalledWith(15000);
  expect(backend.wait).toHaveBeenCalledWith(30000);
  expect(backend.wait).toHaveBeenCalledWith(60000);
  expect(request.mock.calls.filter(c => c[1] === "/api/factory/requests")).toHaveLength(5);
});
it("verifies isolation even when a single probe is invoked directly", async () => {
  const { backend, request } = scripted();
  backend.verifyIsolation = () => Promise.reject(new Error("synthetic-isolation-failure"));
  await expect(runProbe(backend, probe)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
it("refuses a successful but nonblocking unsupported interpretation", async () => {
  const { runUnsupported } = await import("../src/runner.ts");
  const { backend } = scripted();
  await expect(runUnsupported(backend)).rejects.toThrow();
});
it("checks unsupported meanings and explicit invalid host/type outcomes", async () => {
  const { runUnsupported } = await import("../src/runner.ts");
  const { backend } = scripted();
  const unsupported = fixture("interpretation-unsupported");
  backend.request = (_method, path, payload) => {
    if (path.endsWith("/test/reset")) return Promise.resolve({ status: 204, body: null });
    if (path.endsWith("/interpretations") && JSON.stringify(payload) === JSON.stringify(unsupported.input)) return Promise.resolve({ status: 200, body: unsupported });
    const code = path.endsWith("/requests") ? "unsupported_request" : "invalid_request";
    return Promise.resolve({ status: code === "unsupported_request" ? 422 : 400, body: { contract_version: "bug-request/1", error: { code } } });
  };
  await expect(runUnsupported(backend)).resolves.toBeUndefined();
});
it("rejects an earlier delivered case disappearing during a stop", async () => {
  const { backend, request } = scripted();
  let reads = 0;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "GET" && reads++ === 0) {
      const value = object(reply.body); value.state = "running"; value.outcome = null; value.stop_reason = null;
      return reply;
    }
    if (args[0] === "GET") {
      const value = object(reply.body);
      const removed = objects(value.cases).pop(); assert(removed);
      value.cases = objects(value.cases).filter(c => c.case_id !== removed.case_id);
      const item = objects(value.items).find(i => i.item_key === removed.item_key); assert(item);
      item.delivered = 0; item.missing = 1; item.case_ids = [];
      const total = objects(value.type_totals).find(t => t.bug_type_id === removed.bug_type_id); assert(total);
      total.delivered = 0; total.missing = 1;
      const candidate = objects(value.candidates).find(c => c.case_id === removed.case_id); assert(candidate);
      candidate.stage = "incomplete"; candidate.case_id = null;
      object(value.funnel).packages_ready = 1;
      value.delivery = "partial"; value.outcome = "stopped_at_limit";
      value.stop_reason = { code: "budget_exhausted", message: "synthetic stop" };
      checkStatus(value);
    }
    return reply;
  };
  await expect(runProbe(backend, { ...probe, outcome: "stopped_at_limit", stopCode: "budget_exhausted" })).rejects.toThrow("delivered case disappeared");
});
it("checks reconciliation clears held spend without rewriting terminal delivery", async () => {
  const { runReconciliation } = await import("../src/runner.ts");
  const before = fixture("status-operational-error");
  const after = structuredClone(before);
  after.attention = null;
  const budget = object(after.budget);
  budget.spent_microusd = integer(budget.spent_microusd) + integer(budget.reserved_microusd);
  budget.reserved_microusd = 0;
  const { backend } = scripted();
  backend.request = (_method, path) => Promise.resolve(path.endsWith("/requests")
    ? { status: 409, body: { contract_version: "bug-request/1", error: { code: "busy", retryable: false, details: { reason: "needs_reconciliation" } } } }
    : path.endsWith("/reconcile") ? { status: 204, body: null } : { status: 200, body: after });
  await expect(runReconciliation(backend, before)).resolves.toBeUndefined();
  after.outcome = "sources_exhausted"; after.stop_reason = { code: "sources_exhausted", message: "synthetic changed outcome" };
  await expect(runReconciliation(backend, before)).rejects.toThrow("reconciliation changed terminal result");
});
it("checks separate download paths and hashes without implementing package replay", async () => {
  const { createHash } = await import("node:crypto");
  const { runDownloads } = await import("../src/runner.ts");
  const status = fixture("status-fulfilled");
  const { backend } = scripted();
  for (const c of objects(status.cases)) for (const kind of ["bug_case", "validator"]) {
    object(object(c.packages)[kind]).sha256 = createHash("sha256").update(`synthetic-${kind}`).digest("hex");
  }
  backend.request = (_method, path) => Promise.resolve({ status: 200, body: Buffer.from(path.endsWith("validator") ? "synthetic-validator" : "synthetic-bug_case") });
  await expect(runDownloads(backend, status)).resolves.toBeUndefined();
  backend.request = () => Promise.resolve({ status: 200, body: Buffer.from("synthetic-corruption") });
  await expect(runDownloads(backend, status)).rejects.toThrow("archive hash mismatch");
});
it("detects an already observed event being rewritten after reconnect", async () => {
  const { backend, request } = scripted();
  let reconnected = false;
  backend.reconnect = () => { reconnected = true; return Promise.resolve(); };
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (reconnected) for (const event of objects(object(reply.body).events)) event.message = "synthetic-rewritten-event";
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("previous event changed");
});
it("rejects a described criterion omitted consistently by interpretation and status", async () => {
  const { backend, request } = scripted();
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (reply.body === null) return reply;
    const v = object(reply.body);
    const interpreted = args[1].endsWith("/interpretations") ? v : v.interpretation;
    if (interpreted) for (const item of objects(object(interpreted).items)) item.criteria = [];
    if (v.cases) for (const c of objects(v.cases)) c.criteria_met = [];
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("criteria differ from pinned scenario");
});
it("rejects an overrun in a deterministic within-budget scenario", async () => {
  const { backend, request } = scripted();
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "GET") {
      const b = object(object(reply.body).budget);
      b.spent_microusd = integer(b.budget_microusd) + 1;
      b.reserved_microusd = 0; b.committed_microusd = b.spent_microusd;
      b.remaining_microusd = -1; b.overrun = true;
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("deterministic scenario exceeded budget");
});
it("requires the pinned scenario's partial delivery rather than trusting its outcome label", async () => {
  const { backend, request } = scripted();
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "GET") {
      const v = object(reply.body); v.outcome = "sources_exhausted";
      v.stop_reason = { code: "sources_exhausted", message: "synthetic exhaustion" };
    }
    return reply;
  };
  await expect(runProbe(backend, { ...probe, outcome: "sources_exhausted", stopCode: "sources_exhausted", expectedDelivery: "partial" })).rejects.toThrow("delivery differs from pinned scenario");
});
it("rejects assigning the exhausted scenario's case to the less specific item", async () => {
  const expected = fixture("status-exhausted");
  const { backend } = scripted();
  const wrong = structuredClone(expected);
  const items = objects(wrong.items); const any = items[0]; const described = items[1]; assert(any && described);
  any.delivered = 1; any.missing = 0; any.case_ids = described.case_ids;
  described.delivered = 0; described.missing = 1; described.case_ids = [];
  for (const c of objects(wrong.cases)) c.item_key = any.item_key;
  for (const c of objects(wrong.candidates)) if (c.case_id !== null) c.item_key = any.item_key;
  checkStatus(wrong);
  let starts = 0;
  backend.request = (_method, path, payload) => {
    if (path.endsWith("/test/reset")) return Promise.resolve({ status: 204, body: null });
    if (path.endsWith("/interpretations")) return Promise.resolve({ status: 200, body: expected.interpretation });
    if (path.endsWith("/requests")) {
      const id = text(object(payload).request_id);
      const old = text(wrong.request_id);
      Object.assign(wrong, JSON.parse(JSON.stringify(wrong).replaceAll(old, id)) as Record<string, unknown>);
      return Promise.resolve({ status: ++starts === 1 ? 202 : 200, body: wrong });
    }
    return Promise.resolve({ status: 200, body: wrong });
  };
  await expect(runProbe(backend, { scenario: "sources-exhausted", input: object(object(expected.interpretation).input),
    outcome: "sources_exhausted", stopCode: "sources_exhausted", expectedDelivery: "partial",
    expectedItems: objects(object(expected.interpretation).items), expectedCounts: objects(expected.items),
  })).rejects.toThrow("item counts differ from pinned scenario");
});
it("rejects a consistent budget rewrite on reconnect", async () => {
  const { backend, request } = scripted(); let reconnected = false;
  backend.reconnect = () => { reconnected = true; return Promise.resolve(); };
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (reconnected) {
      const b = object(object(reply.body).budget);
      b.spent_microusd = integer(b.spent_microusd) + 1;
      b.committed_microusd = integer(b.committed_microusd) + 1;
      b.remaining_microusd = integer(b.remaining_microusd) - 1;
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("terminal result changed on reconnect");
});
for (const startOrdinal of [1, 2]) it(`rejects an overrun seen only in start response ${String(startOrdinal)}`, async () => {
  const { backend, request } = scripted(); let starts = 0;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1] === "/api/factory/requests" && ++starts === startOrdinal) {
      const b = object(object(reply.body).budget);
      b.spent_microusd = integer(b.budget_microusd) + 1; b.reserved_microusd = 0;
      b.committed_microusd = b.spent_microusd; b.remaining_microusd = -1; b.overrun = true;
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("deterministic scenario exceeded budget");
});
