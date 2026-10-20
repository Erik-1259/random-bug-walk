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
it("rejects delivery when the complete history omits criterion evidence", async () => {
  const { backend, request } = scripted();
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "GET") {
      const value = object(reply.body);
      const after = Number(args[1].split("?after=")[1] ?? 0);
      value.events = objects(value.events).filter(event => event.type !== "requested_criteria_passed")
        .map((event, index) => ({ ...event, seq: after + index + 1 }));
      value.next_after = after + objects(value.events).length;
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("criterion event");
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
it.each(["misassigned", "missing-warning", "wrong-status"])("rejects %s unsupported item outcomes", async (change) => {
  const { runUnsupported } = await import("../src/runner.ts");
  const { backend } = scripted();
  const unsupported = fixture("interpretation-unsupported");
  const items = objects(unsupported.items);
  const first = items[0]; assert(first);
  if (change === "misassigned") {
    const problems = items.flatMap(item => objects(item.problems));
    for (const item of items) item.problems = [];
    first.problems = problems;
  } else if (change === "missing-warning") {
    const item = items.find(item => item.item_key === "concurrency-any"); assert(item);
    item.problems = [];
  } else first.status = "supported";
  backend.request = (_method, path, payload) => {
    if (path.endsWith("/test/reset")) return Promise.resolve({ status: 204, body: null });
    if (path.endsWith("/interpretations") && JSON.stringify(payload) === JSON.stringify(unsupported.input)) return Promise.resolve({ status: 200, body: unsupported });
    const code = path.endsWith("/requests") ? "unsupported_request" : "invalid_request";
    return Promise.resolve({ status: code === "unsupported_request" ? 422 : 400, body: { contract_version: "bug-request/1", error: { code } } });
  };
  await expect(runUnsupported(backend)).rejects.toThrow("unsupported item");
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
it("waits for the named second-candidate check before cancelling", async () => {
  const expected = fixture("status-cancelled");
  const second = objects(expected.candidates)[1]; assert(second);
  const events = objects(expected.events);
  const checkpoint = events.findIndex(event => event.type === "check_finished" && event.candidate_id === second.candidate_id);
  assert(checkpoint > 0);
  const active = structuredClone(expected);
  active.state = "running"; active.outcome = null; active.stop_reason = null;
  const pending = objects(active.candidates)[1]; assert(pending);
  pending.stage = "checking"; pending.reason = null; pending.finished_at = null;
  let id = text(expected.request_id); let starts = 0; let paused = false; let stopped = false;
  const replyState = (value: Record<string, unknown>, path: string, end: number) => {
    const response = object(JSON.parse(JSON.stringify(value).replaceAll(text(expected.request_id), id)) as unknown);
    const cursor = Number(path.split("?after=")[1] ?? 0);
    response.events = objects(response.events).slice(0, end).filter(event => integer(event.seq) > cursor);
    response.next_after = objects(response.events).at(-1)?.seq ?? cursor;
    return response;
  };
  const backend: IsolatedBackend = {
    verifyIsolation: () => Promise.resolve({ backendRevision: "a".repeat(40), contractRevision }), wait: () => Promise.resolve(), reconnect: () => Promise.resolve(),
    request: (_method, path, payload) => {
      if (path.endsWith("/test/reset")) return Promise.resolve({ status: 204, body: null });
      if (path.endsWith("/interpretations")) return Promise.resolve({ status: 200, body: expected.interpretation });
      if (path.endsWith("/requests")) {
        id = text(object(payload).request_id);
        const beforePause = replyState(active, path, checkpoint);
        object(beforePause.funnel).candidates_explored = 1;
        return Promise.resolve({ status: ++starts === 1 ? 202 : 200, body: beforePause });
      }
      if (path.endsWith("/stop")) {
        if (stopped) return Promise.resolve({ status: 200, body: replyState(expected, path, events.length) });
        assert(paused, "stop arrived before the named check checkpoint"); stopped = true;
        return Promise.resolve({ status: 200, body: replyState({ ...active, state: "stopping" }, path, checkpoint + 1) });
      }
      if (!stopped) { paused = true; return Promise.resolve({ status: 200, body: replyState(active, path, checkpoint + 1) }); }
      return Promise.resolve({ status: 200, body: replyState(expected, path, events.length) });
    },
  };
  await expect(runProbe(backend, { scenario: "cancel-midway", input: object(object(expected.interpretation).input),
    outcome: "cancelled", stopCode: "cancelled_by_user", expectedDelivery: "partial", expectedItems: objects(object(expected.interpretation).items),
    expectedCounts: objects(expected.items), expectedFunnel: object(expected.funnel), cancel: true,
  })).resolves.toBeUndefined();
  expect(stopped).toBe(true);
});
function reconciliationScenario() {
  const before = fixture("status-operational-error");
  const after = structuredClone(before);
  after.attention = null;
  const budget = object(after.budget);
  budget.spent_microusd = integer(budget.spent_microusd) + integer(budget.reserved_microusd);
  budget.reserved_microusd = 0;
  const previousEvents = objects(before.events);
  const last = previousEvents.at(-1); assert(last);
  after.events = [...objects(after.events),
    { ...last, seq: previousEvents.length + 1, type: "budget_updated", message: "synthetic reconciled spend", data: {
      reserved_microusd: 0, spent_microusd: budget.spent_microusd, remaining_microusd: budget.remaining_microusd,
    } },
    { ...last, seq: previousEvents.length + 2, type: "attention_cleared", message: "synthetic reconciliation complete", data: { code: "needs_reconciliation" } },
  ];
  after.next_after = previousEvents.length + 2;
  const evidence = fixture("test-evidence");
  const priorEvidence = structuredClone(evidence);
  for (const op of objects(evidence.operations)) { op.state = "reconciled"; op.settled_microusd = op.reserved_microusd; }
  object(evidence.slot).holder_request_id = null;
  const { backend } = scripted();
  let reconciled = false;
  const request = vi.fn((method: "GET" | "POST", path: string): Promise<Reply> => {
    if (path.endsWith("/reconcile")) reconciled = true;
    if (path.includes("/test/evidence?") && !reconciled) return Promise.resolve({ status: 200, body: priorEvidence });
    if (path.endsWith("/requests")) return Promise.resolve({ status: 409, body: { contract_version: "bug-request/1", error: { code: "busy", retryable: false, details: { reason: "needs_reconciliation" } } } });
    if (method === "GET" && path.includes("/requests/")) {
      const cursor = Number(path.split("?after=")[1] ?? 0);
      const events = objects(after.events).filter(event => integer(event.seq) > cursor);
      return Promise.resolve({ status: 200, body: { ...after, events, next_after: events.at(-1)?.seq ?? cursor } });
    }
    return Promise.resolve({ status: 200, body: path.includes("/test/evidence?") ? evidence : after });
  });
  backend.request = request;
  return { before, after, evidence, backend, request, restart: () => { reconciled = false; } };
}
it("checks reconciliation settles held spend and reads released-slot evidence before any reset", async () => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, after, backend, request, restart } = reconciliationScenario();
  await expect(runReconciliation(backend, before)).resolves.toBeUndefined();
  expect(request.mock.calls.map(([method, path]) => `${method} ${path}`)).toEqual([
    `GET /api/factory/test/evidence?request_id=${text(before.request_id)}`,
    "POST /api/factory/requests", "POST /api/factory/test/reconcile",
    `GET /api/factory/requests/${text(before.request_id)}`,
    `GET /api/factory/requests/${text(before.request_id)}?after=${String(after.next_after)}`,
    `GET /api/factory/test/evidence?request_id=${text(before.request_id)}`,
  ]);
  after.outcome = "sources_exhausted"; after.stop_reason = { code: "sources_exhausted", message: "synthetic changed outcome" };
  for (const event of objects(after.events)) if (event.type === "request_finished") {
    object(event.data).outcome = "sources_exhausted"; object(event.data).stop_code = "sources_exhausted";
  }
  restart();
  await expect(runReconciliation(backend, before)).rejects.toThrow("reconciliation changed terminal result");
});
it.each(["rekeyed", "collapsed", "redistributed", "rewritten-provider"])("rejects %s reconciliation evidence despite conserved totals", async change => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, evidence, backend } = reconciliationScenario();
  const copies = objects(evidence.operations).filter(op => op.kind === "candidate_copy");
  const first = copies[0]; const second = copies[1]; assert(first && second);
  if (change === "rekeyed") first.operation_id = "ab".repeat(32);
  if (change === "collapsed") {
    evidence.operations = objects(evidence.operations).filter(op => op !== second);
    evidence.provider_calls = objects(evidence.provider_calls).filter(call => call.call_name !== second.call_name);
    first.reserved_microusd = integer(first.reserved_microusd) + integer(second.reserved_microusd);
    first.settled_microusd = first.reserved_microusd;
  }
  if (change === "redistributed") {
    first.reserved_microusd = integer(first.reserved_microusd) + 1000; first.settled_microusd = first.reserved_microusd;
    second.reserved_microusd = integer(second.reserved_microusd) - 1000; second.settled_microusd = second.reserved_microusd;
  }
  if (change === "rewritten-provider") {
    const call = objects(evidence.provider_calls)[0]; assert(call); call.at = "2026-10-20T20:00:00.000Z";
  }
  await expect(runReconciliation(backend, before)).rejects.toThrow("reconciliation changed");
});
it.each(["candidates", "funnel", "limits"])("rejects changed %s after reconciliation", async (field) => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, after, backend } = reconciliationScenario();
  if (field === "candidates") {
    const candidates = objects(after.candidates);
    const candidate = candidates[0]; assert(candidate);
    after.candidates = [...candidates, { ...candidate, candidate_id: "ab".repeat(32), entry_id: "synthetic-replacement" }];
  } else if (field === "funnel") object(after.funnel).candidates_explored = 0;
  else object(after.limits).candidates_started = 2;
  checkStatus(after);
  await expect(runReconciliation(backend, before)).rejects.toThrow("reconciliation changed terminal result");
});
it.each(["no-content", "null-body", "missing-field", "stale-attention"])("rejects a %s reconciliation POST even when the later GET is correct", async change => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, after, backend, request } = reconciliationScenario();
  const response = structuredClone(after);
  if (change === "missing-field") delete response.created_at;
  if (change === "stale-attention") response.attention = before.attention;
  backend.request = (method, path) => path.endsWith("/reconcile")
    ? Promise.resolve({ status: change === "no-content" ? 204 : 200, body: ["no-content", "null-body"].includes(change) ? null : response })
    : request(method, path);
  await expect(runReconciliation(backend, before)).rejects.toThrow();
});
it.each(["request", "validation"])("rejects a retained %s slot holder after reconciliation", async holder => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, backend, evidence } = reconciliationScenario();
  object(evidence.slot).holder_request_id = before.request_id;
  if (holder === "validation") object(evidence.slot).holder_validation_id = "00000000-0000-4000-8000-000000000301";
  await expect(runReconciliation(backend, before)).rejects.toThrow();
});
it.each(["post", "get"])("rejects disappearing held spend in the reconciliation %s response", async location => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, after, backend, request, evidence } = reconciliationScenario();
  const dropped = structuredClone(after);
  const budget = object(dropped.budget);
  budget.spent_microusd = 200000; budget.committed_microusd = 200000;
  budget.remaining_microusd = integer(budget.budget_microusd) - 200000;
  // Evidence and reported totals agree, but the candidate's previously held amount disappeared.
  evidence.operations = objects(evidence.operations).filter(op => op.kind === "worker");
  evidence.provider_calls = objects(evidence.provider_calls).filter(call => call.call_name === "worker");
  checkStatus(dropped);
  backend.request = (method, path) => (location === "post" ? path.endsWith("/reconcile") : method === "GET" && path.includes("/requests/"))
    ? Promise.resolve({ status: 200, body: dropped }) : request(method, path);
  await expect(runReconciliation(backend, before)).rejects.toThrow();
});
it.each(["post", "get"])("rejects rewritten event history in the reconciliation %s response", async location => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, after, backend, request } = reconciliationScenario();
  const rewritten = structuredClone(after);
  const event = objects(rewritten.events)[0]; assert(event); event.message = "synthetic-rewritten-history";
  backend.request = (method, path) => (location === "post" ? path.endsWith("/reconcile") : method === "GET" && path.includes("/requests/"))
    ? Promise.resolve({ status: 200, body: rewritten }) : request(method, path);
  await expect(runReconciliation(backend, before)).rejects.toThrow();
});
it("preserves witnessed reconciliation events across paginated status reads", async () => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, after, backend, request } = reconciliationScenario();
  const requests: string[] = [];
  backend.request = (method, path) => {
    if (method === "GET" && path.includes("/requests/")) {
      requests.push(path);
      const cursor = Number(path.split("?after=")[1] ?? 0);
      const page = structuredClone(after);
      page.events = objects(page.events).filter(event => integer(event.seq) > cursor).slice(0, 2);
      page.next_after = cursor + objects(page.events).length;
      return Promise.resolve({ status: 200, body: page });
    }
    return request(method, path);
  };
  await expect(runReconciliation(backend, before)).resolves.toBeUndefined();
  expect(requests.length).toBeGreaterThan(1);
});
it.each(["missing-both", "missing-budget", "missing-clear", "wrong-budget", "wrong-clear-code", "reversed"])("rejects %s reconciliation transitions despite correct final status and evidence", async change => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, after, backend } = reconciliationScenario();
  const prior = objects(before.events);
  let added = objects(after.events).slice(prior.length);
  if (change === "missing-both") added = [];
  if (change === "missing-budget") added = added.filter(event => event.type !== "budget_updated");
  if (change === "missing-clear") added = added.filter(event => event.type !== "attention_cleared");
  if (change === "wrong-budget") { const event = added[0]; assert(event); object(event.data).spent_microusd = 1; }
  if (change === "wrong-clear-code") { const event = added[1]; assert(event); object(event.data).code = "worker_unresponsive"; }
  if (change === "reversed") added.reverse();
  after.events = [...structuredClone(prior), ...added].map((event, index) => ({ ...event, seq: index + 1 }));
  after.next_after = objects(after.events).length;
  await expect(runReconciliation(backend, before)).rejects.toThrow();
});
it("reads reconciliation transitions beyond a POST containing only old history", async () => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, after, backend, request } = reconciliationScenario();
  const previousEnd = integer(before.next_after);
  const cursors: number[] = [];
  backend.request = (method, path) => {
    if (path.endsWith("/reconcile")) return request(method, path).then(() => ({ status: 200, body: { ...after, events: before.events, next_after: previousEnd } }));
    if (method === "GET" && path.includes("/requests/")) {
      const cursor = Number(path.split("?after=")[1] ?? 0); cursors.push(cursor);
      const events = objects(after.events).filter(event => integer(event.seq) > cursor).slice(0, previousEnd);
      return Promise.resolve({ status: 200, body: { ...after, events, next_after: events.at(-1)?.seq ?? cursor } });
    }
    return request(method, path);
  };
  await expect(runReconciliation(backend, before)).resolves.toBeUndefined();
  expect(cursors).toContain(previousEnd);
});
it("accepts reconciliation settling held operations in separate budget updates", async () => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, after, backend } = reconciliationScenario();
  const prior = objects(before.events);
  const added = objects(after.events).slice(prior.length);
  const settled = added[0]; assert(settled);
  const held = integer(object(before.budget).reserved_microusd) / 2;
  const partial = { ...settled, data: { ...object(settled.data), reserved_microusd: held,
    spent_microusd: integer(object(settled.data).spent_microusd) - held } };
  after.events = [...prior, partial, ...added].map((event, index) => ({ ...event, seq: index + 1 }));
  after.next_after = objects(after.events).length;
  await expect(runReconciliation(backend, before)).resolves.toBeUndefined();
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
  for (const event of objects(wrong.events)) if (event.type === "requested_criteria_passed") event.item_key = any.item_key;
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
  await expect(runProbe(backend, probe)).rejects.toThrow("terminal result changed after completion");
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
it.each([1, 2, 3])("retains cases observed in concurrent start response %s", async (ordinal) => {
  const { backend, request } = scripted(); let starts = 0;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1] === "/api/factory/requests" && ++starts === ordinal) {
      const initial = fixture("status-fulfilled");
      const oldCase = text(objects(initial.cases)[0]?.case_id);
      const replaced: unknown = JSON.parse(JSON.stringify(initial)
        .replaceAll(text(initial.request_id), text(object(reply.body).request_id))
        .replaceAll(oldCase, "ac".repeat(32)));
      checkStatus(replaced);
      return { ...reply, body: replaced };
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("delivered case disappeared");
});
it("collects concurrent snapshots without imposing response order", async () => {
  const { backend, request } = scripted(); let starts = 0;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1] === "/api/factory/requests") {
      const ordinal = ++starts;
      if (ordinal === 2 || ordinal === 4) {
        const initial = fixture("status-fulfilled");
        const value: unknown = JSON.parse(JSON.stringify(initial).replaceAll(text(initial.request_id), text(object(reply.body).request_id)));
        return { ...reply, body: value };
      }
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).resolves.toBeUndefined();
});
for (const ordinal of [1, 2, 4]) it.each(["budget", "attention"])(`preserves terminal %s observed in Start response ${String(ordinal)}`, async field => {
  const { backend, request } = scripted(); let starts = 0;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1] === "/api/factory/requests" && reply.status !== 409) {
      const current = ++starts;
      const initial = fixture("status-fulfilled");
      const value = object(JSON.parse(JSON.stringify(initial).replaceAll(text(initial.request_id), text(object(reply.body).request_id))) as unknown);
      if (current === ordinal) {
        if (field === "attention") value.attention = fixture("status-operational-error").attention;
        else {
          const budget = object(value.budget);
          budget.spent_microusd = integer(budget.spent_microusd) + 1;
          budget.committed_microusd = integer(budget.committed_microusd) + 1;
          budget.remaining_microusd = integer(budget.remaining_microusd) - 1;
        }
      }
      checkStatus(value);
      return { ...reply, body: value };
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("terminal result changed after completion");
});

it("rejects source routing rewritten consistently across interpretation and status", async () => {
  const { backend, request } = scripted();
  const item = probe.expectedItems[0]; assert(item);
  const source = text(objects(item.eligible_sources)[0]?.source_id);
  backend.request = async (...args) => {
    const reply = await request(...args);
    const changed: unknown = JSON.parse(JSON.stringify(reply.body).replaceAll(source, "synthetic-wrong-source"));
    return { ...reply, body: changed };
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("eligible sources differ from pinned scenario");
});
it.each(["bug_type_id", "quantity", "description", "difficulty", "status", "unmatched_text", "problems"])("rejects rewritten interpreted item %s", async (field) => {
  const { backend, request } = scripted();
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (reply.body === null) return reply;
    const value = object(reply.body);
    const interpretation = args[1].endsWith("/interpretations") ? value : value.interpretation;
    if (interpretation) {
      const item = objects(object(interpretation).items)[0]; assert(item);
      const changes: Record<string, unknown> = {
        bug_type_id: "date_time", quantity: 2, description: null,
        difficulty: { requested: "source_inferable_allowed", status: "unsupported" },
        status: "unsupported", unmatched_text: ["synthetic-unmatched"],
        problems: [{ code: "no_matching_source", severity: "blocking", item_key: item.item_key }],
      };
      item[field] = changes[field];
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("item interpretation differs from pinned scenario");
});

it.each([1, 2])("rejects a frozen interpretation changed only in Start response %s", async ordinal => {
  const { backend, request } = scripted(); let starts = 0;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1] === "/api/factory/requests" && ++starts === ordinal) {
      const item = objects(object(object(reply.body).interpretation).items)[0]; assert(item);
      const source = objects(item.eligible_sources)[0]; assert(source);
      source.source_id = "synthetic-wrong-source";
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("frozen interpretation changed");
});
for (const ordinal of [1, 2]) it.each(["created_at", "deadline_at"])(`rejects rewritten %s from active Start response ${String(ordinal)}`, async field => {
  const { backend, request } = scripted(); let starts = 0;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1] === "/api/factory/requests" && ++starts === ordinal) {
      const value = object(reply.body);
      const target = field === "created_at" ? value : object(value.limits);
      target[field] = new Date(Date.parse(text(target[field])) + 1000).toISOString();
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow(/request (time|deadline)/);
});
it.each([1, 2])("retains funnel progress witnessed in concurrent Start response %s", async ordinal => {
  const { backend, request } = scripted(); let starts = 0;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1] === "/api/factory/requests" && ++starts === ordinal) {
      const running = fixture("status-running");
      const value = object(JSON.parse(JSON.stringify(running).replaceAll(text(running.request_id), text(object(reply.body).request_id))) as unknown);
      // Event paging is independent of the full current counters.
      value.events = object(reply.body).events; value.next_after = object(reply.body).next_after;
      return { ...reply, body: value };
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("funnel progress decreased");
});
it.each([1, 2])("retains event contents observed in Start response %s", async ordinal => {
  const { backend, request } = scripted(); let starts = 0;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1] === "/api/factory/requests" && ++starts === ordinal) {
      const event = objects(object(reply.body).events)[0]; assert(event);
      event.message = "synthetic-event-before-rewrite";
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("previous event changed");
});
it.each([1, 2])("rejects completion in Start response %s followed by a queued replay", async ordinal => {
  const { backend, request } = scripted(); let starts = 0;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1] === "/api/factory/requests" && ++starts === ordinal) {
      const state = object(reply.body);
      state.state = "finished"; state.outcome = "operational_error";
      state.stop_reason = { code: "operational_error", message: "synthetic launch failure" };
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("terminal result changed after completion");
});
it.each([1, 2])("retains delivered-case contents observed in Start response %s", async ordinal => {
  const { backend, request } = scripted(); let starts = 0;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1] === "/api/factory/requests") {
      const current = ++starts;
      if (current === ordinal || current === 4) {
        const initial = fixture("status-fulfilled");
        const value: unknown = JSON.parse(JSON.stringify(initial).replaceAll(text(initial.request_id), text(object(reply.body).request_id)));
        if (current === ordinal) { const delivered = objects(object(value).cases)[0]; assert(delivered); delivered.title = "synthetic original delivered title"; }
        return { ...reply, body: value };
      }
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("delivered case changed");
});
it("rejects a duplicate event present only in the accepted Start response", async () => {
  const { backend, request } = scripted();
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (reply.status === 202) {
      const state = object(reply.body); const events = objects(state.events);
      const first = events[0]; assert(first);
      state.events = [first, structuredClone(first), ...events.slice(1)];
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("event gap or duplicate");
});
it("accepts a recorded launch failure already finished in the 202 response", async () => {
  const { backend, request } = scripted();
  const expected = fixture("status-queued");
  expected.state = "finished"; expected.outcome = "operational_error";
  expected.stop_reason = { code: "operational_error", message: "synthetic launch failure" };
  const budget = object(expected.budget);
  budget.reserved_microusd = 0; budget.spent_microusd = budget.committed_microusd;
  const events = objects(expected.events); const last = events.at(-1); assert(last);
  expected.events = [...events, { ...last, seq: 3, type: "request_finished", message: "synthetic launch failure", data: { outcome: "operational_error", stop_code: "operational_error" } }];
  expected.next_after = 3;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (reply.status === 202 || (reply.status === 200 && args[1].includes("/requests"))) {
      const value: unknown = JSON.parse(JSON.stringify(expected).replaceAll(text(expected.request_id), text(object(reply.body).request_id)));
      return { ...reply, body: value };
    }
    return reply;
  };
  await expect(runProbe(backend, { ...probe, outcome: "operational_error", stopCode: "operational_error", expectedDelivery: "none", expectedCounts: objects(expected.items) })).resolves.toBeUndefined();
});
