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
    if (path.endsWith("/test/reset")) reply = { status: 200, body: { contract_version: "bug-request/1", scenario: object(payload).scenario } };
    else if (path.endsWith("/interpretations")) reply = { status: 200, body: fixture("interpretation-supported") };
    else if (method === "POST" && path.endsWith("/requests")) {
      id = String(object(payload).request_id); starts++;
      if (starts === 5) reply = { status: 409, body: { contract_version: "bug-request/1", error: { code: "idempotency_conflict", message: "synthetic conflict", retryable: false, details: null } } };
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
function lifecycleScenario(starts: string[], polls: string[]) {
  const { backend, request } = scripted(); let startIndex = 0; let pollIndex = 0;
  let active: Record<string, unknown> | undefined;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1] === "/api/factory/requests" && reply.status !== 409) {
      const value = object(reply.body);
      value.state = starts[startIndex++];
      active = structuredClone(value);
    } else if (args[0] === "GET" && pollIndex < polls.length) {
      assert(active);
      const value = structuredClone(active); value.state = polls[pollIndex++];
      const cursor = Number(args[1].split("?after=")[1] ?? 0);
      value.events = objects(value.events).filter(event => integer(event.seq) > cursor);
      value.next_after = objects(value.events).at(-1)?.seq ?? cursor;
      return { ...reply, body: value };
    }
    return reply;
  };
  return backend;
}
it.each([
  ["starting", "queued"], ["running", "queued"], ["running", "starting"],
  ["stopping", "queued"], ["stopping", "starting"], ["stopping", "running"],
])("rejects observed lifecycle regression from %s to %s between polls", async (from, to) => {
  const backend = lifecycleScenario(["queued", "queued", "queued", "queued"], [from, to]);
  await expect(runProbe(backend, probe)).rejects.toThrow("request lifecycle regressed");
});
it.each([0, 1, 2])("retains lifecycle progress from concurrent Start response %s before replay", async ordinal => {
  const states = ["queued", "queued", "queued", "queued"]; states[ordinal] = "running";
  await expect(runProbe(lifecycleScenario(states, []), probe)).rejects.toThrow("request lifecycle regressed");
});
it.each([
  ["running", "queued", "starting", "running"],
  ["queued", "running", "starting", "running"],
  ["starting", "queued", "running", "running"],
])("allows unordered concurrent lifecycle snapshots %s/%s/%s before replay %s", async (...states) => {
  await expect(runProbe(lifecycleScenario(states, []), probe)).resolves.toBeUndefined();
});
it.each([
  ["queued", "starting", "starting", "running", "running", "stopping", "stopping"],
  ["running", "running", "stopping"],
])("allows repeated and skipped lifecycle states in observed polls %j", async (...states) => {
  const backend = lifecycleScenario(["queued", "queued", "queued", "queued"], states);
  await expect(runProbe(backend, probe)).resolves.toBeUndefined();
});
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
for (const ordinal of [1, 2, 3, 4]) it.each(["missing-field", "extra-field"])(`schema-checks %s in Start response ${String(ordinal)}`, async change => {
  const { backend, request } = scripted(); let starts = 0;
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1] === "/api/factory/requests" && ++starts === ordinal) {
      const value = object(reply.body);
      if (change === "missing-field") delete value.updated_at;
      else value.synthetic_internal = "synthetic uncontracted field";
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("invalid RequestStatus");
});
it.each(["poll", "reconnect"])("schema-checks a malformed %s status", async stage => {
  const { backend, request } = scripted(); let reconnected = false;
  backend.reconnect = () => { reconnected = true; return Promise.resolve(); };
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "GET" && (stage === "poll" || reconnected)) object(reply.body).synthetic_internal = "synthetic uncontracted field";
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("invalid RequestStatus");
});
it.each(["no-body", "malformed", "wrong-scenario"])("rejects a %s reset instead of assuming isolation controls selected the scenario", async change => {
  const { backend, request } = scripted();
  backend.request = (...args) => args[1].endsWith("/test/reset")
    ? Promise.resolve({ status: change === "no-body" ? 204 : 200, body: change === "no-body" ? null
      : change === "malformed" ? { scenario: "two-host-fulfilled" } : { contract_version: "bug-request/1", scenario: "worker-lost" } })
    : request(...args);
  await expect(runProbe(backend, probe)).rejects.toThrow();
});
it.each(["message", "retryable", "details"])("requires %s in a conflict error response", async field => {
  const { backend, request } = scripted();
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (reply.status === 409) object(reply.body).error = Object.fromEntries(Object.entries(object(object(reply.body).error)).filter(([key]) => key !== field));
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("invalid ErrorResponse");
});
it("rejects delivery when the complete history omits criterion evidence", async () => {
  const { backend, request } = scripted();
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "GET") {
      const value = object(reply.body);
      const after = Number(args[1].split("?after=")[1] ?? 0);
      const original = fixture("status-fulfilled");
      const history = objects(object(JSON.parse(JSON.stringify(original).replaceAll(text(original.request_id), text(value.request_id))) as unknown).events)
        .filter(event => event.type !== "requested_criteria_passed")
        .map((event, index) => ({ ...event, seq: index + 1 }));
      value.events = history.filter(event => event.seq > after);
      value.next_after = history.at(-1)?.seq;
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
    if (args[0] === "GET") {
      const value = object(reply.body);
      value.events = objects(value.events).map((event, index) => ({ ...event, seq: index + 7 }));
      value.next_after = objects(value.events).at(-1)?.seq;
    }
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
it.each(["same-page", "next-page"])("rejects terminal history appended on reconnect in %s", async location => {
  const { backend, request } = scripted(); let reconnected = false;
  backend.reconnect = () => { reconnected = true; return Promise.resolve(); };
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (reconnected && args[0] === "GET") {
      const value = object(reply.body);
      const history = objects(fixture("status-fulfilled").events);
      const last = history.at(-1); assert(last);
      const budget = history.findLast(event => event.type === "budget_updated"); assert(budget);
      const added = { ...structuredClone(budget), seq: integer(last.seq) + 1, at: last.at };
      const cursor = Number(args[1].split("?after=")[1] ?? 0);
      const events = [...objects(value.events), added];
      value.events = location === "next-page" && cursor === 0 ? events.slice(0, history.length) : events;
      value.next_after = objects(value.events).at(-1)?.seq ?? cursor;
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("terminal history changed on reconnect");
});
it("backs off unavailable status reads without starting a replacement request", async () => {
  const { backend, request } = scripted();
  let outages = 0;
  backend.request = (...args) => {
    if (args[0] === "GET" && outages++ < 3) return Promise.resolve({ status: 503, body: { contract_version: "bug-request/1", error: { code: "unavailable", message: "synthetic unavailable", retryable: true, details: null } } });
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
    if (path.endsWith("/test/reset")) return Promise.resolve({ status: 200, body: { contract_version: "bug-request/1", scenario: object(payload).scenario } });
    if (path.endsWith("/interpretations") && JSON.stringify(payload) === JSON.stringify(unsupported.input)) return Promise.resolve({ status: 200, body: unsupported });
    const code = path.endsWith("/requests") ? "unsupported_request" : "invalid_request";
    return Promise.resolve({ status: code === "unsupported_request" ? 422 : 400, body: { contract_version: "bug-request/1", error: { code, message: "synthetic refusal", retryable: false, details: code === "unsupported_request" ? { interpretation: unsupported } : null } } });
  };
  await expect(runUnsupported(backend)).resolves.toBeUndefined();
});
it("rejects an unsupported refusal carrying a different valid interpretation", async () => {
  const { runUnsupported } = await import("../src/runner.ts");
  const { backend } = scripted(); const unsupported = fixture("interpretation-unsupported");
  const other = structuredClone(unsupported); other.interpretation_sha256 = "ab".repeat(32);
  backend.request = (_method, path) => {
    if (path.endsWith("/test/reset")) return Promise.resolve({ status: 200, body: { contract_version: "bug-request/1", scenario: "two-host-fulfilled" } });
    if (path.endsWith("/interpretations")) return Promise.resolve({ status: 200, body: unsupported });
    return Promise.resolve({ status: 422, body: { contract_version: "bug-request/1", error: { code: "unsupported_request", message: "synthetic refusal", retryable: false, details: { interpretation: other } } } });
  };
  await expect(runUnsupported(backend)).rejects.toThrow("refusal interpretation changed");
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
    if (path.endsWith("/test/reset")) return Promise.resolve({ status: 200, body: { contract_version: "bug-request/1", scenario: object(payload).scenario } });
    if (path.endsWith("/interpretations") && JSON.stringify(payload) === JSON.stringify(unsupported.input)) return Promise.resolve({ status: 200, body: unsupported });
    const code = path.endsWith("/requests") ? "unsupported_request" : "invalid_request";
    return Promise.resolve({ status: code === "unsupported_request" ? 422 : 400, body: { contract_version: "bug-request/1", error: { code, message: "synthetic refusal", retryable: false, details: code === "unsupported_request" ? { interpretation: unsupported } : null } } });
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
      value.events = objects(value.events).filter(event => event.type !== "request_finished");
      value.next_after = objects(value.events).at(-1)?.seq;
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
      candidate.stage = "incomplete"; candidate.case_id = null; candidate.reason = { code: "incomplete_run", message: "synthetic incomplete" };
      object(value.funnel).packages_ready = 1;
      value.delivery = "partial"; value.outcome = "stopped_at_limit";
      value.stop_reason = { code: "budget_exhausted", message: "synthetic stop" };
      for (const event of objects(value.events)) if (event.type === "request_finished") event.data = { outcome: "stopped_at_limit", stop_code: "budget_exhausted" };
      checkStatus(value);
    }
    return reply;
  };
  await expect(runProbe(backend, { ...probe, outcome: "stopped_at_limit", stopCode: "budget_exhausted" })).rejects.toThrow("delivered case disappeared");
});
function cancellationScenario(repeat?: (response: Record<string, unknown>, stored: Record<string, unknown>) => void,
  changeHistory?: (events: Record<string, unknown>[]) => Record<string, unknown>[], pageSize = 200) {
  const expected = fixture("status-cancelled");
  if (changeHistory) {
    expected.events = changeHistory(objects(expected.events)).map((event, index) => ({ ...event, seq: index + 1 }));
    expected.next_after = objects(expected.events).length;
  }
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
    const history = objects(response.events).slice(0, end);
    if (response.state === "running" && history.some(event => event.type === "stop_requested")) response.state = "stopping";
    response.events = history.filter(event => integer(event.seq) > cursor).slice(0, pageSize);
    response.next_after = objects(response.events).at(-1)?.seq ?? cursor;
    return response;
  };
  const backend: IsolatedBackend = {
    verifyIsolation: () => Promise.resolve({ backendRevision: "a".repeat(40), contractRevision }), wait: () => Promise.resolve(), reconnect: () => Promise.resolve(),
    request: (_method, path, payload) => {
      if (path.endsWith("/test/reset")) return Promise.resolve({ status: 200, body: { contract_version: "bug-request/1", scenario: object(payload).scenario } });
      if (path.endsWith("/interpretations")) return Promise.resolve({ status: 200, body: expected.interpretation });
      if (path.endsWith("/requests")) {
        id = text(object(payload).request_id);
        const beforePause = replyState(active, path, checkpoint);
        object(beforePause.funnel).candidates_explored = 1;
        return Promise.resolve({ status: ++starts === 1 ? 202 : 200, body: beforePause });
      }
      if (path.endsWith("/stop")) {
        if (stopped) {
          const response = replyState(expected, path, objects(expected.events).length);
          repeat?.(response, expected);
          return Promise.resolve({ status: 200, body: response });
        }
        assert(paused, "stop arrived before the named check checkpoint"); stopped = true;
        return Promise.resolve({ status: 200, body: replyState({ ...active, state: "stopping" }, path, checkpoint + 1) });
      }
      if (!stopped) { paused = true; return Promise.resolve({ status: 200, body: replyState(active, path, checkpoint + 1) }); }
      return Promise.resolve({ status: 200, body: replyState(expected, path, objects(expected.events).length) });
    },
  };
  const probe = { scenario: "cancel-midway", input: object(object(expected.interpretation).input),
    outcome: "cancelled", stopCode: "cancelled_by_user", expectedDelivery: "partial", expectedItems: objects(object(expected.interpretation).items),
    expectedCounts: objects(expected.items), expectedFunnel: object(expected.funnel), cancel: true,
  };
  return { backend, probe, wasStopped: () => stopped };
}
it("waits for the named second-candidate check before cancelling", async () => {
  const s = cancellationScenario();
  await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
  expect(s.wasStopped()).toBe(true);
});
it("rejects a successful Stop response still in the running lifecycle state", async () => {
  const s = cancellationScenario(); const request = s.backend.request.bind(s.backend);
  s.backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1].endsWith("/stop") && object(reply.body).state === "stopping") object(reply.body).state = "running";
    return reply;
  };
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow("Stop response did not record stopping or completion");
});
it.each(["queued", "starting", "running", "stopping"])("preserves the stopping lifecycle witness when the next poll is %s", async state => {
  const s = cancellationScenario(); const request = s.backend.request.bind(s.backend);
  let stopping: Record<string, unknown> | undefined; let observed = false;
  s.backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1].endsWith("/stop") && !stopping) stopping = structuredClone(object(reply.body));
    else if (args[0] === "GET" && stopping && !observed) {
      observed = true;
      const value = structuredClone(stopping); value.state = state;
      const cursor = Number(args[1].split("?after=")[1] ?? 0);
      value.events = objects(value.events).filter(event => integer(event.seq) > cursor);
      value.next_after = objects(value.events).at(-1)?.seq ?? cursor;
      return { ...reply, body: value };
    }
    return reply;
  };
  if (state === "stopping") await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
  else await expect(runProbe(s.backend, s.probe)).rejects.toThrow("request lifecycle regressed");
  expect(observed).toBe(true);
});
it.each([false, true])("preserves a terminal Stop response timestamp before status reads with drift=%s", async drift => {
  const s = cancellationScenario(); const request = s.backend.request.bind(s.backend); let stops = 0;
  s.backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1].endsWith("/stop") && ++stops === 1) {
      const terminal = fixture("status-cancelled");
      const value = object(JSON.parse(JSON.stringify(terminal).replaceAll(text(terminal.request_id), text(object(reply.body).request_id))) as unknown);
      if (drift) value.updated_at = new Date(Date.parse(text(value.updated_at)) - 1000).toISOString();
      return { ...reply, body: value };
    }
    return reply;
  };
  if (drift) await expect(runProbe(s.backend, s.probe)).rejects.toThrow("terminal result changed after completion");
  else await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
});
it.each(["missing", "before-checkpoint", "after-in-flight-check", "after-incomplete", "duplicate-paged"])("rejects %s stop_requested in cancellation history", async change => {
  const s = cancellationScenario(undefined, events => {
    const stop = events.find(event => event.type === "stop_requested"); assert(stop);
    if (change === "duplicate-paged") {
      const at = events.indexOf(stop);
      return [...events.slice(0, at + 1), structuredClone(stop), ...events.slice(at + 1)];
    }
    const history = events.filter(event => event !== stop);
    if (change === "missing") return history;
    const incomplete = history.find(event => event.type === "candidate_incomplete"); assert(incomplete);
    const at = change === "before-checkpoint"
      ? history.findIndex(event => event.type === "check_finished" && event.candidate_id === incomplete.candidate_id)
      : history.indexOf(incomplete) + (change === "after-incomplete" ? 1 : 0);
    assert(at > 0);
    return [...history.slice(0, at), stop, ...history.slice(at)];
  }, change === "duplicate-paged" ? 1 : 200);
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow();
});
it.each(["updated-at", "extra-event", "paged-extra-event", "hidden-tail"])("rejects repeated stop with %s despite unchanged counts", async change => {
  const s = cancellationScenario((response, stored) => {
    if (change === "updated-at") response.updated_at = new Date(Date.parse(text(response.updated_at)) + 1000).toISOString();
    else {
      const history = objects(stored.events); const last = history.at(-1); assert(last);
      const budget = history.findLast(event => event.type === "budget_updated"); assert(budget);
      const added = { ...structuredClone(budget), seq: integer(last.seq) + 1, at: last.at };
      stored.events = [...history, added]; stored.next_after = integer(added.seq);
      if (change !== "hidden-tail") {
        response.events = [...objects(response.events), added]; response.next_after = added.seq;
      }
      if (change === "paged-extra-event") { response.events = objects(response.events).slice(0, 2); response.next_after = 2; }
    }
  });
  await expect(runProbe(s.backend, s.probe)).rejects.toThrow(change === "updated-at" ? "terminal result changed after completion" : "terminal history changed on repeated stop");
});
it("allows repeated stop to return an unchanged terminal result with different paging hints", async () => {
  const s = cancellationScenario(response => {
    response.poll_after_ms = 1; response.events = objects(response.events).slice(0, 2); response.next_after = 2;
  });
  await expect(runProbe(s.backend, s.probe)).resolves.toBeUndefined();
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
    if (path.endsWith("/requests")) return Promise.resolve({ status: 409, body: { contract_version: "bug-request/1", error: { code: "busy", message: "synthetic busy", retryable: false, details: { reason: "needs_reconciliation" } } } });
    if (method === "GET" && path.includes("/requests/")) {
      const cursor = Number(path.split("?after=")[1] ?? 0);
      const state = reconciled ? after : before;
      const events = objects(state.events).filter(event => integer(event.seq) > cursor);
      return Promise.resolve({ status: 200, body: { ...state, events, next_after: events.at(-1)?.seq ?? cursor } });
    }
    return Promise.resolve({ status: 200, body: path.includes("/test/evidence?") ? evidence : after });
  });
  backend.request = request;
  return { before, after, evidence, backend, request, restart: () => { reconciled = false; } };
}
it.each(["worker_lost", "needs_reconciliation"])("rejects a validation holder before reconciling request failure %s", async code => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, after, backend, request } = reconciliationScenario();
  for (const value of [before, after]) {
    object(value.stop_reason).code = code;
    for (const event of objects(value.events)) if (event.type === "request_finished") object(event.data).stop_code = code;
  }
  let readEvidence = false;
  backend.request = async (...args) => {
    const reply = await request(args[0], args[1]);
    if (args[1].includes("/test/evidence?") && !readEvidence) {
      readEvidence = true;
      object(object(reply.body).slot).holder_validation_id = "00000000-0000-4000-8000-000000000301";
    }
    return reply;
  };
  await expect(runReconciliation(backend, before)).rejects.toThrow("request reconciliation has a validation holder");
  expect(request.mock.calls.some(call => call[1].endsWith("/reconcile"))).toBe(false);
});
it("checks reconciliation settles held spend and reads released-slot evidence before any reset", async () => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, after, backend, request, restart } = reconciliationScenario();
  await expect(runReconciliation(backend, before)).resolves.toBeUndefined();
  expect(request.mock.calls.map(([method, path]) => `${method} ${path}`)).toEqual([
    `GET /api/factory/requests/${text(before.request_id)}?after=0`,
    `GET /api/factory/requests/${text(before.request_id)}?after=${String(before.next_after)}`,
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
it("does not reconcile unrecorded attention even when later transitions are consistent", async () => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, after, backend, request } = reconciliationScenario();
  for (const value of [before, after]) {
    value.events = objects(value.events).filter(event => !(event.type === "attention" && object(event.data).code === "needs_reconciliation"))
      .map((event, index) => ({ ...event, seq: index + 1 }));
    value.next_after = objects(value.events).length;
  }
  await expect(runReconciliation(backend, before)).rejects.toThrow("attention history");
  expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
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
  await expect(runReconciliation(backend, before)).rejects.toThrow(change === "collapsed" ? "candidate copy count differs" : "reconciliation changed");
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
  await expect(runReconciliation(backend, before, objects(before.events))).rejects.toThrow();
});
it.each(["post", "get"])("rejects rewritten event history in the reconciliation %s response", async location => {
  const { runReconciliation } = await import("../src/runner.ts");
  const { before, after, backend, request } = reconciliationScenario();
  const rewritten = structuredClone(after);
  const event = objects(rewritten.events)[0]; assert(event); event.message = "synthetic-rewritten-history";
  backend.request = (method, path) => (location === "post" ? path.endsWith("/reconcile") : method === "GET" && path.includes("/requests/"))
    ? Promise.resolve({ status: 200, body: rewritten }) : request(method, path);
  await expect(runReconciliation(backend, before, objects(before.events))).rejects.toThrow();
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
  await expect(runReconciliation(backend, before, objects(before.events))).resolves.toBeUndefined();
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
  await expect(runReconciliation(backend, before, objects(before.events))).resolves.toBeUndefined();
  expect(cursors).toContain(previousEnd);
});
function pageReconciliation(backend: IsolatedBackend): void {
  const request = backend.request.bind(backend);
  backend.request = async (method, path, payload) => {
    const reply = await request(method, path, payload);
    if (!(method === "GET" && path.includes("/requests/")) && !path.endsWith("/reconcile")) return reply;
    const page = structuredClone(object(reply.body));
    page.events = objects(page.events).slice(0, 1);
    page.next_after = objects(page.events).at(-1)?.seq ?? page.next_after;
    return { ...reply, body: page };
  };
}
for (const paged of [false, true]) {
  it.each(["initial", "partial", "settled"])(`rejects no-change reconciliation budget updates at %s with paged=${String(paged)}`, async position => {
    const { runReconciliation } = await import("../src/runner.ts");
    const { before, after, backend } = reconciliationScenario();
    const prior = objects(before.events);
    const [settled, cleared] = objects(after.events).slice(prior.length); assert(settled && cleared);
    const previousBudget = object(before.budget);
    const held = integer(previousBudget.reserved_microusd) / 2;
    const partial = { ...settled, data: { ...object(settled.data), reserved_microusd: held,
      spent_microusd: integer(object(settled.data).spent_microusd) - held } };
    const unchanged = { ...settled, data: Object.fromEntries(["reserved_microusd", "spent_microusd", "remaining_microusd"]
      .map(field => [field, previousBudget[field]])) };
    const added = position === "initial" ? [unchanged, settled, cleared]
      : position === "partial" ? [partial, structuredClone(partial), settled, cleared]
        : [settled, structuredClone(settled), cleared];
    after.events = [...prior, ...added].map((event, index) => ({ ...event, seq: index + 1 }));
    after.next_after = objects(after.events).length;
    if (paged) pageReconciliation(backend);
    await expect(runReconciliation(backend, before)).rejects.toThrow("reconciliation budget update did not reduce held spend");
  });
}
it.each([false, true])("accepts reconciliation settling held operations in separate budget updates with paged=%s", async paged => {
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
  if (paged) pageReconciliation(backend);
  await expect(runReconciliation(backend, before)).resolves.toBeUndefined();
});
it("checks separate download paths and hashes without implementing package replay", async () => {
  const { createHash } = await import("node:crypto");
  const { runDownloads } = await import("../src/runner.ts");
  const status = fixture("status-fulfilled");
  const { backend } = scripted();
  for (const c of objects(status.cases)) for (const kind of ["bug_case", "validator"]) {
    object(object(c.packages)[kind]).sha256 = createHash("sha256").update(`synthetic-${kind}`).digest("hex");
    object(object(c.packages)[kind]).size_bytes = Buffer.byteLength(`synthetic-${kind}`);
  }
  backend.request = (_method, path) => Promise.resolve({ status: 200, body: Buffer.from(path.endsWith("validator") ? "synthetic-validator" : "synthetic-bug_case") });
  await expect(runDownloads(backend, status)).resolves.toBeUndefined();
  backend.request = () => Promise.resolve({ status: 200, body: Buffer.from("synthetic-corruption") });
  await expect(runDownloads(backend, status)).rejects.toThrow("archive hash mismatch");
});
it("rejects an archive size that disagrees with its downloaded bytes", async () => {
  const { createHash } = await import("node:crypto");
  const { runDownloads } = await import("../src/runner.ts");
  const status = fixture("status-fulfilled");
  const { backend } = scripted();
  const bytes = Buffer.from("synthetic archive");
  for (const c of objects(status.cases)) for (const kind of ["bug_case", "validator"]) {
    const part = object(object(c.packages)[kind]);
    part.sha256 = createHash("sha256").update(bytes).digest("hex");
    part.size_bytes = bytes.length + 1;
  }
  backend.request = () => Promise.resolve({ status: 200, body: bytes });
  await expect(runDownloads(backend, status)).rejects.toThrow("archive size mismatch");
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
      for (const event of objects(v.events)) if (event.type === "request_finished") event.data = { outcome: "sources_exhausted", stop_code: "sources_exhausted" };
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
    if (path.endsWith("/test/reset")) return Promise.resolve({ status: 200, body: { contract_version: "bug-request/1", scenario: object(payload).scenario } });
    if (path.endsWith("/interpretations")) return Promise.resolve({ status: 200, body: expected.interpretation });
    if (path.endsWith("/requests")) {
      const id = text(object(payload).request_id);
      const old = text(wrong.request_id);
      Object.assign(wrong, JSON.parse(JSON.stringify(wrong).replaceAll(old, id)) as Record<string, unknown>);
      const first = ++starts === 1;
      const value = structuredClone(wrong);
      if (first) {
        value.state = "running"; value.outcome = null; value.stop_reason = null;
        value.events = objects(value.events).filter(event => event.type !== "request_finished");
        value.next_after = objects(value.events).at(-1)?.seq;
      }
      return Promise.resolve({ status: first ? 202 : 200, body: value });
    }
    const cursor = Number(path.split("?after=")[1] ?? 0);
    const events = objects(wrong.events).filter(event => integer(event.seq) > cursor);
    return Promise.resolve({ status: 200, body: { ...wrong, events, next_after: events.at(-1)?.seq ?? cursor } });
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
      if (reply.status === 202) {
        initial.state = "running"; initial.outcome = null; initial.stop_reason = null;
        initial.events = objects(initial.events).filter(event => event.type !== "request_finished");
        initial.next_after = objects(initial.events).at(-1)?.seq;
      }
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
      const initial = recordedLaunchFailure();
      const value = object(JSON.parse(JSON.stringify(initial).replaceAll(text(initial.request_id), text(object(reply.body).request_id))) as unknown);
      value.outcome = "operational_error";
      value.stop_reason = { code: "operational_error", message: "synthetic failure" };
      for (const event of objects(value.events)) if (event.type === "request_finished") event.data = { outcome: "operational_error", stop_code: "operational_error" };
      if (current === ordinal) {
        if (field === "attention") value.attention = fixture("status-operational-error").attention;
        else {
          const budget = object(value.budget);
          budget.spent_microusd = integer(budget.spent_microusd) - 1;
          budget.committed_microusd = integer(budget.committed_microusd) - 1;
          budget.remaining_microusd = integer(budget.remaining_microusd) + 1;
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
        if (reply.status === 202) {
          initial.state = "running"; initial.outcome = null; initial.stop_reason = null;
          initial.events = objects(initial.events).filter(event => event.type !== "request_finished");
          initial.next_after = objects(initial.events).at(-1)?.seq;
        }
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
it("rejects a successful terminal result in the fresh 202 response", async () => {
  const { backend, request } = scripted();
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === "POST" && args[1] === "/api/factory/requests" && [200, 202].includes(reply.status)) {
      const initial = fixture("status-fulfilled");
      return { ...reply, body: object(JSON.parse(JSON.stringify(initial).replaceAll(text(initial.request_id), text(object(reply.body).request_id))) as unknown) };
    }
    return reply;
  };
  await expect(runProbe(backend, probe)).rejects.toThrow("finished fresh Start is not an operational failure");
});
function recordedLaunchFailure() {
  const expected = fixture("status-queued");
  expected.state = "finished"; expected.outcome = "operational_error";
  expected.stop_reason = { code: "operational_error", message: "synthetic launch failure" };
  const budget = object(expected.budget);
  budget.reserved_microusd = 0; budget.spent_microusd = budget.committed_microusd;
  const events = objects(expected.events); const last = events.at(-1); assert(last);
  expected.events = [...events, { ...last, seq: 3, type: "request_finished", message: "synthetic launch failure", data: { outcome: "operational_error", stop_code: "operational_error" } }];
  expected.next_after = 3;
  return expected;
}
async function runRecordedFailure(expected: Record<string, unknown>, paged = false,
  changeReply?: (value: Record<string, unknown>, method: "GET" | "POST", path: string) => void) {
  const { backend, request } = scripted();
  backend.request = async (...args) => {
    const reply = await request(...args);
    if (reply.status === 202 || (reply.status === 200 && args[1].includes("/requests"))) {
      const value = object(JSON.parse(JSON.stringify(expected).replaceAll(text(expected.request_id), text(object(reply.body).request_id))) as unknown);
      if (paged && reply.status === 202) { value.events = objects(value.events).slice(0, 2); value.next_after = 2; }
      if (args[0] === "GET") {
        const cursor = Number(args[1].split("?after=")[1] ?? 0);
        value.events = objects(value.events).filter(event => integer(event.seq) > cursor);
        value.next_after = objects(value.events).at(-1)?.seq ?? cursor;
      }
      changeReply?.(value, args[0], args[1]);
      return { ...reply, body: value };
    }
    return reply;
  };
  await runProbe(backend, { ...probe, outcome: "operational_error", stopCode: text(object(expected.stop_reason).code),
    expectedDelivery: text(expected.delivery), expectedCounts: objects(expected.items),
    expectedAttention: expected.attention === null ? null : text(object(expected.attention).code) });
}
it.each(["concurrent replies", "sequential replay"])("preserves a terminal Start timestamp across %s", async phase => {
  const expected = recordedLaunchFailure(); let starts = 0;
  const changedAt = new Date(Date.parse(text(expected.updated_at)) + 1000).toISOString();
  await expect(runRecordedFailure(expected, false, (value, method, path) => {
    if (method === "POST" && path.endsWith("/requests")) starts++;
    if (starts >= (phase === "concurrent replies" ? 2 : 4)) value.updated_at = changedAt;
  })).rejects.toThrow("terminal result changed after completion");
});
it("allows terminal Start replay to change paging and polling hints", async () => {
  await expect(runRecordedFailure(recordedLaunchFailure(), false, (value, method) => {
    if (method === "POST") {
      value.events = objects(value.events).slice(0, 1); value.next_after = 1; value.poll_after_ms = 1;
    }
  })).resolves.toBeUndefined();
});
it.each([false, true])("accepts a recorded launch failure already finished in the 202 response with uncertain spend=%s", uncertain => {
  const expected = recordedLaunchFailure();
  if (uncertain) {
    expected.attention = fixture("status-operational-error").attention;
    const budget = object(expected.budget); budget.reserved_microusd = budget.committed_microusd; budget.spent_microusd = 0;
    const events = objects(expected.events); const last = events.at(-1); assert(last);
    expected.events = [...events, { ...last, seq: 4, type: "attention", data: { code: "needs_reconciliation" } }];
    expected.next_after = 4;
  }
  return expect(runRecordedFailure(expected)).resolves.toBeUndefined();
});
it.each(["worker_lost", "needs_reconciliation"])("rejects post-launch stop code %s in a fresh terminal202", code => {
  const expected = recordedLaunchFailure(); object(expected.stop_reason).code = code;
  for (const event of objects(expected.events)) if (event.type === "request_finished") object(event.data).stop_code = code;
  return expect(runRecordedFailure(expected)).rejects.toThrow("fresh terminal Start");
});
it.each(["heartbeat", "candidate-count", "candidate-row", "candidate-spend", "worker-started", "paged-worker-started"])("rejects %s progress after a fresh terminal202", change => {
  const expected = recordedLaunchFailure();
  if (change === "heartbeat") expected.last_heartbeat_at = expected.created_at;
  if (change === "candidate-count") object(expected.limits).candidates_started = 1;
  if (change === "candidate-row") expected.candidates = fixture("status-operational-error").candidates;
  if (change === "candidate-spend") {
    const budget = object(expected.budget); budget.spent_microusd = integer(budget.spent_microusd) + 1;
    budget.committed_microusd = budget.spent_microusd; budget.remaining_microusd = integer(budget.remaining_microusd) - 1;
  }
  if (change.endsWith("worker-started")) {
    const events = objects(expected.events); const first = events[0]; assert(first);
    events.splice(2, 0, { ...first, type: "worker_started" });
    expected.events = events.map((event, index) => ({ ...event, seq: index + 1 })); expected.next_after = events.length;
  }
  return expect(runRecordedFailure(expected, change === "paged-worker-started")).rejects.toThrow("fresh terminal Start");
});

it.each(["validation_started", "validation_finished"])("rejects prior %s before request reconciliation", async type => {
  const { runReconciliation } = await import("../src/runner.ts");
  const s = reconciliationScenario();
  const history = objects(s.before.events); const last = history.at(-1); assert(last);
  const prior = { ...last, type, seq: history.length + 1, candidate_id: null, case_id: "bc".repeat(32), host_id: "task-report",
    item_key: objects(s.before.items)[0]?.item_key,
    data: type === "validation_started" ? { validation_id: "00000000-0000-4000-8000-000000000301" }
      : { validation_id: "00000000-0000-4000-8000-000000000301", result: "failed" } };
  s.before.events = [...history, prior]; s.before.next_after = history.length + 1;
  s.after.events = [...objects(s.before.events), ...objects(s.after.events).slice(history.length)]
    .map((event, index) => ({ ...event, seq: index + 1 }));
  s.after.next_after = objects(s.after.events).length;
  await expect(runReconciliation(s.backend, s.before)).rejects.toThrow("before validation");
  expect(s.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
});
