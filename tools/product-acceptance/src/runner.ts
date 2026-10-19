import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkStatus, checkValidation, integer, object, objects, text } from "./invariants.ts";

export const contractRevision = "7540362198f5940f1add45a65593ac314e8d751e";
export const scenarioIds = ["identity", "quantities", "shared-budget", "qualification", "unsupported", "stops", "continuity", "downloads"] as const;
type ScenarioId = typeof scenarioIds[number];
export interface Reply { status: number; body: unknown }
/** Local adapter interface, NOT a proposed service endpoint or response shape.
 * No adapter ships until the backend supplies its approved isolation procedure.
 */
export interface IsolatedBackend {
  verifyIsolation: () => Promise<{ backendRevision: string; contractRevision: string }>;
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply>;
  reconnect: () => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
}
export interface Probe {
  scenario: string;
  input: Record<string, unknown>;
  outcome: string;
  stopCode: string;
  expectedDelivery: string;
  expectedItems: Record<string, unknown>[];
  concurrent?: boolean;
  cancel?: boolean;
  validation?: "failed" | "error";
  reconcile?: boolean;
  downloads?: boolean;
}
class Unavailable extends Error {}
function body(reply: Reply, status: number): Record<string, unknown> {
  assert.equal(reply.status, status, "unexpected HTTP status");
  const result = object(reply.body);
  assert.equal(result.contract_version, "bug-request/1");
  return result;
}
function error(reply: Reply, status: number, code: string): void {
  assert.equal(object(body(reply, status).error).code, code);
}

async function verify(backend: IsolatedBackend) {
  const verification = await backend.verifyIsolation();
  assert.match(verification.backendRevision, /^[a-f0-9]{40}$/);
  assert.equal(verification.contractRevision, contractRevision, "contract revision mismatch");
  return verification;
}
async function read(backend: IsolatedBackend, path: string) {
  for (const delay of [15000, 30000, 60000, null]) {
    const reply = await backend.request("GET", path);
    if (reply.status !== 503) return body(reply, 200);
    error(reply, 503, "unavailable");
    if (delay === null) throw new Unavailable("Status remained unavailable after polling backoff.");
    await backend.wait(delay);
  }
  throw new Error("unreachable polling state");
}
/** Exercise ordinary public operations through an approved isolated adapter. */
export async function runProbe(backend: IsolatedBackend, probe: Probe): Promise<void> {
  await verify(backend);
  const call = backend.request.bind(backend);
  const reset = await call("POST", "/api/factory/test/reset", { scenario: probe.scenario });
  assert(reset.status >= 200 && reset.status < 300, "reset failed");
  const interpretation = body(await call("POST", "/api/factory/interpretations", probe.input), 200);
  assert.equal(interpretation.startable, true);
  const criterionKeys = (item: Record<string, unknown>) => objects(item.criteria)
    .map(c => `${text(c.criterion_id)}@${text(c.version)}`).sort();
  const interpretedItems = objects(interpretation.items);
  assert.equal(interpretedItems.length, probe.expectedItems.length);
  for (const expected of probe.expectedItems) {
    const actual = interpretedItems.find(item => item.item_key === expected.item_key);
    assert(actual, "missing pinned scenario item");
    assert.deepEqual(criterionKeys(actual), criterionKeys(expected), "criteria differ from pinned scenario");
  }
  assert.deepEqual(interpretation.input, probe.input, "input silently changed");
  const requestId = randomUUID();
  const start = { request_id: requestId, input: probe.input, interpretation_sha256: interpretation.interpretation_sha256 };
  const replies = await Promise.all(Array.from({ length: probe.concurrent ? 3 : 1 }, () => call("POST", "/api/factory/requests", start)));
  assert.equal(replies.filter(r => r.status === 202).length, 1, "start accepted more or less than once");
  for (const reply of replies) {
    assert([200, 202].includes(reply.status));
    checkStatus(reply.body); assert.equal(object(reply.body).request_id, requestId);
  }
  const path = `/api/factory/requests/${requestId}`;
  const repeated = body(await call("POST", "/api/factory/requests", start), 200);
  assert.equal(repeated.request_id, requestId);
  if (probe.concurrent) {
    const changed = structuredClone(start);
    const first = objects(changed.input.items)[0]; assert(first);
    first.description = first.description === null ? "synthetic-conflicting-description" : null;
    error(await call("POST", "/api/factory/requests", changed), 409, "idempotency_conflict");
  }
  let cursor = 0;
  let stopped = false;
  let state = repeated;
  const deliveredIds = new Set<unknown>();
  const history: Record<string, unknown>[] = [];
  // Bound a stalled service; do not poll faster than its declared interval.
  for (let polls = 0; polls < 1000; polls++) {
    checkStatus(state);
    assert.equal(object(state.budget).overrun, false, "deterministic scenario exceeded budget");
    const currentIds = objects(state.cases).map(c => c.case_id);
    for (const id of deliveredIds) assert(currentIds.includes(id), "delivered case disappeared");
    for (const id of currentIds) deliveredIds.add(id);
    for (const event of objects(state.events)) {
      assert.equal(integer(event.seq), ++cursor, "event gap or duplicate");
      history.push(structuredClone(event));
    }
    assert.equal(state.next_after, cursor);
    assert.equal(state.request_id, requestId);
    assert.deepEqual(state.interpretation, interpretation, "frozen interpretation changed");
    if (probe.cancel && !stopped && objects(state.cases).length > 0 && state.state !== "finished") {
      body(await call("POST", `${path}/stop`, {}), 200);
      stopped = true;
    }
    if (state.state === "finished") break;
    const delay = integer(state.poll_after_ms);
    assert(delay >= 0, "unsupported polling interval");
    await backend.wait(delay);
    state = await read(backend, `${path}?after=${String(cursor)}`);
  }
  if (probe.cancel && !stopped) throw new Unavailable("cancel-midway requires an observable pause after the first delivery");
  if (state.state !== "finished") throw new Unavailable("Request observation reached the runner poll limit.");
  assert.equal(state.delivery, probe.expectedDelivery, "delivery differs from pinned scenario");
  assert.equal(state.outcome, probe.outcome);
  assert.equal(object(state.stop_reason).code, probe.stopCode);
  await backend.reconnect();
  const reconnect = await read(backend, `${path}?after=0`);
  let page = reconnect;
  let checked = 0;
  while (checked < history.length) {
    const events = objects(page.events);
    assert(events.length > 0, "previous events disappeared");
    for (const event of events) {
      if (checked === history.length) break;
      assert.deepEqual(event, history[checked++], "previous event changed");
    }
    if (checked < history.length) {
      await backend.wait(integer(page.poll_after_ms));
      page = await read(backend, `${path}?after=${String(checked)}`);
    }
  }
  checkStatus(reconnect);
  for (const field of ["request_id", "state", "outcome", "stop_reason", "delivery", "items", "cases"]) {
    assert.deepEqual(reconnect[field], state[field], "terminal result changed on reconnect");
  }
  if (probe.cancel) {
    const again = body(await call("POST", `${path}/stop`, {}), 200);
    for (const field of ["outcome", "items", "cases"]) assert.deepEqual(again[field], state[field]);
  }
  if (probe.downloads) await runDownloads(backend, state);
  if (probe.reconcile) await runReconciliation(backend, state);
  if (probe.validation) {
    const c = objects(state.cases)[0]; assert(c, "validation scenario delivered no case");
    const validationId = randomUUID();
    const validationPath = `${path}/cases/${text(c.case_id)}/validations`;
    let validation = body(await call("POST", validationPath, { validation_id: validationId }), 202);
    for (let polls = 0; polls < 1000; polls++) {
      checkValidation(validation);
      assert.equal(validation.validation_id, validationId);
      assert.equal(validation.case_id, c.case_id);
      assert.deepEqual(validation.package_sha256, {
        bug_case: object(object(c.packages).bug_case).sha256,
        validator: object(object(c.packages).validator).sha256,
      });
      if (validation.state === "finished") break;
      const delay = integer(validation.poll_after_ms); assert(delay >= 0);
      await backend.wait(delay);
      validation = await read(backend, `${validationPath}/${validationId}`);
    }
    if (validation.state !== "finished") throw new Unavailable("Validation observation reached the runner poll limit.");
    assert.equal(validation.result, probe.validation);
  }
}
export async function runDownloads(backend: IsolatedBackend, status: Record<string, unknown>): Promise<void> {
  await verify(backend);
  checkStatus(status);
  for (const c of objects(status.cases)) {
    const parts = object(c.packages);
    for (const kind of ["bug_case", "validator"]) {
      const part = object(parts[kind]);
      const response = await backend.request("GET", text(part.download_path));
      assert.equal(response.status, 200);
      assert(response.body instanceof Uint8Array, "archive response is not bytes");
      assert.equal(createHash("sha256").update(response.body).digest("hex"), part.sha256, "archive hash mismatch");
    }
  }
}

export async function runReconciliation(backend: IsolatedBackend, before: Record<string, unknown>): Promise<void> {
  await verify(backend);
  assert.equal(before.state, "finished");
  assert.equal(object(before.attention).code, "needs_reconciliation");
  const interpretation = object(before.interpretation);
  const busy = await backend.request("POST", "/api/factory/requests", {
    request_id: randomUUID(), input: interpretation.input, interpretation_sha256: interpretation.interpretation_sha256,
  });
  error(busy, 409, "busy");
  const refusal = object(object(busy.body).error);
  assert.equal(refusal.retryable, false);
  assert.equal(object(refusal.details).reason, "needs_reconciliation");
  const result = await backend.request("POST", "/api/factory/test/reconcile", { request_id: before.request_id });
  assert(result.status >= 200 && result.status < 300, "reconciliation control failed");
  const after = await read(backend, `/api/factory/requests/${text(before.request_id)}`);
  checkStatus(after);
  assert.equal(after.attention, null);
  assert.equal(object(after.budget).reserved_microusd, 0);
  for (const field of ["request_id", "outcome", "stop_reason", "delivery", "items", "cases"]) {
    assert.deepEqual(after[field], before[field], "reconciliation changed terminal result");
  }
}

export async function runUnsupported(backend: IsolatedBackend): Promise<void> {
  await verify(backend);
  const call = backend.request.bind(backend);
  const reset = await call("POST", "/api/factory/test/reset", { scenario: "two-host-fulfilled" });
  assert(reset.status >= 200 && reset.status < 300);
  const fixture: unknown = JSON.parse(readFileSync(new URL("../fixtures/interpretation-unsupported.json", import.meta.url), "utf8"));
  const input = object(object(fixture).input);
  const interpretation = body(await call("POST", "/api/factory/interpretations", input), 200);
  assert.equal(interpretation.startable, false);
  assert.deepEqual(interpretation.input, input, "unsupported requirements silently changed");
  const codes = objects(interpretation.items).flatMap(i => objects(i.problems).map(p => p.code));
  for (const code of ["no_matching_source", "unrecognized_description", "unsupported_difficulty", "unsupported_combination"]) {
    assert(codes.includes(code), "missing explicit unsupported outcome");
  }
  error(await call("POST", "/api/factory/requests", {
    request_id: randomUUID(), input, interpretation_sha256: interpretation.interpretation_sha256,
  }), 422, "unsupported_request");
  const invalidHost = structuredClone(input); invalidHost.hosts = ["synthetic-unsupported-host"];
  const invalidType = structuredClone(input);
  const item = objects(invalidType.items)[0]; assert(item); item.bug_type_id = "synthetic-unsupported-type";
  for (const invalid of [invalidHost, invalidType]) error(await call("POST", "/api/factory/interpretations", invalid), 400, "invalid_request");
}

function fixtureStatus(name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
  return object(value);
}
function probes(): { groups: ScenarioId[]; probe: Probe }[] {
  const plans: [string, string, string, string, ScenarioId[]][] = [
    ["two-host-fulfilled", "fulfilled", "fulfilled", "fulfilled", ["identity", "shared-budget", "continuity", "downloads"]],
    ["partial-budget", "partial-budget", "stopped_at_limit", "budget_exhausted", ["shared-budget", "stops"]],
    ["sources-exhausted", "exhausted", "sources_exhausted", "sources_exhausted", ["quantities", "stops"]],
    ["duplicate-defect", "duplicate-defect", "sources_exhausted", "sources_exhausted", ["qualification"]],
    ["zero-result", "zero-result", "sources_exhausted", "sources_exhausted", ["qualification", "stops"]],
    ["worker-lost", "operational-error", "operational_error", "worker_lost", ["stops", "continuity"]],
    ["uncertain-provider", "operational-error", "operational_error", "needs_reconciliation", ["stops", "continuity"]],
    ["cancel-midway", "cancelled", "cancelled", "cancelled_by_user", ["stops"]],
    ["validation-failed", "fulfilled", "fulfilled", "fulfilled", ["downloads"]],
    ["validation-error", "fulfilled", "fulfilled", "fulfilled", ["downloads"]],
  ];
  return plans.map(([scenario, fixture, outcome, stopCode, groups]) => {
    const expected = fixtureStatus(`status-${fixture}`);
    const interpretation = object(expected.interpretation);
    const input = object(interpretation.input);
    if (scenario === "sources-exhausted") {
      const first = objects(input.items)[0]; assert(first); first.quantity = 2;
    }
    return { groups, probe: {
    scenario, input, outcome, stopCode, expectedDelivery: text(expected.delivery), expectedItems: objects(interpretation.items),
    concurrent: scenario === "two-host-fulfilled", cancel: scenario === "cancel-midway",
    reconcile: scenario === "worker-lost" || scenario === "uncertain-provider",
    downloads: scenario === "two-host-fulfilled",
    ...(scenario === "validation-failed" ? { validation: "failed" as const } : scenario === "validation-error" ? { validation: "error" as const } : {}),
  } }; });
}
interface Result { id: ScenarioId; status: "passed" | "failed" | "unavailable"; checks: string[]; dependencies: string[] }
const gaps: Record<ScenarioId, string[]> = {
  identity: ["Exact evidence response shape and durable request/job identities are not defined in revision 1."],
  quantities: [],
  "shared-budget": ["Exact ledger-operation/provider-call evidence shape is needed to verify reservations across hosts."],
  qualification: ["A deterministic setup_failed candidate control is not named in revision 1."],
  unsupported: [],
  stops: ["cancel-midway needs an observable pause or documented timing so a stop can arrive after a delivery."],
  continuity: [],
  downloads: ["Pending-package access needs a documented deterministic window and case ID; archive layout and full payload privacy validation remain pending the package contract."],
};
export async function runAcceptance(backend?: IsolatedBackend) {
  const results: Result[] = scenarioIds.map(id => ({ id, status: "unavailable", checks: [], dependencies: [...gaps[id]] }));
  let backendRevision: string | null = null;
  let verified = false;
  if (backend) {
    try {
      const verification = await verify(backend);
      backendRevision = verification.backendRevision; verified = true;
    } catch {
      for (const result of results) result.dependencies.push("Backend isolation verification failed; no API operations attempted.");
    }
  }
  if (backend && verified) {
    const unsupported = results.find(r => r.id === "unsupported"); assert(unsupported);
    try { await runUnsupported(backend); unsupported.checks.push("unsupported-interpretation-and-start"); }
    catch { unsupported.status = "failed"; unsupported.checks.push("unsupported: assertion or transport failure"); }
    for (const { groups, probe } of probes()) {
      try {
        await runProbe(backend, probe);
        for (const result of results.filter(r => groups.includes(r.id))) result.checks.push(probe.scenario);
      } catch (error) {
        for (const result of results.filter(r => groups.includes(r.id))) {
          if (error instanceof Unavailable) result.dependencies.push(error.message);
          else { result.status = "failed"; result.checks.push(`${probe.scenario}: assertion or transport failure`); }
        }
      }
    }
    for (const result of results) if (result.status !== "failed") {
      result.status = result.dependencies.length === 0 && result.checks.length > 0 ? "passed" : "unavailable";
    }
  } else for (const result of results) result.dependencies.push("Approved isolated backend startup, verification and session adapter are unavailable.");
  const summary = { passed: 0, failed: 0, unavailable: 0 };
  for (const result of results) summary[result.status]++;
  return { schema_version: 1, suite: "request-api-acceptance", contract_revision: contractRevision,
    backend_revision: backendRevision, isolated_target_verified: verified, acceptance_executed: verified,
    summary, scenarios: results, exit_code: summary.failed > 0 ? 1 : summary.unavailable > 0 ? 2 : 0 };
}
