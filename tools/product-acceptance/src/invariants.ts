import assert from "node:assert/strict";

export function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "expected object");
  return value as Record<string, unknown>;
}
export function objects(value: unknown): Record<string, unknown>[] {
  assert(Array.isArray(value), "expected array");
  return value.map(object);
}
export function integer(value: unknown): number {
  assert(typeof value === "number" && Number.isSafeInteger(value), "expected safe integer");
  return value;
}
export function text(value: unknown): string {
  assert(typeof value === "string", "expected string");
  return value;
}
function nonnegative(value: unknown): number {
  const n = integer(value); assert(n >= 0, "negative count or amount"); return n;
}
function unique(values: unknown[]): void {
  assert.equal(new Set(values).size, values.length, "duplicate identity");
}
function cells(value: unknown): Record<string, unknown>[] {
  const matrix = object(value);
  return ["original_suite", "verification"].flatMap(set => {
    const group = object(matrix[set]);
    return ["clean", "buggy", "fixed"].map(copy => {
      const cell = object(group[copy]);
      assert.equal(cell.expected, set === "verification" && copy === "buggy" ? "fail" : "pass", "matrix expectation contradicts contract");
      assert(["pass", "fail", "error", "incomplete"].includes(text(cell.observed)), "invalid observed result");
      assert(nonnegative(cell.runs_valid) <= nonnegative(cell.runs_total), "invalid trial counts");
      assert.equal(cell.matches_expectation, cell.observed === cell.expected, "incorrect cell verdict");
      return cell;
    });
  });
}
export function checkValidation(value: unknown): void {
  const v = object(value);
  assert.equal(v.contract_version, "bug-request/1");
  assert(["queued", "running", "finished"].includes(text(v.state)));
  if (v.state !== "finished") {
    assert.equal(v.result, null); assert.equal(v.matrix, null); assert.equal(v.cost_microusd, null);
    return;
  }
  const observed = v.matrix === null ? [] : cells(v.matrix);
  const result = observed.length === 0 || observed.some(c => ["error", "incomplete"].includes(text(c.observed)))
    ? "error" : observed.every(c => c.matches_expectation === true) ? "passed" : "failed";
  assert.equal(v.result, result, "validation result contradicts observations");
}
const caseFields = new Set([
  "case_id", "defect_id", "title", "host_id", "host_label", "baseline_id", "bug_type_id", "item_key", "criteria_met",
  "summary", "matrix", "repetition", "difficulty", "qualification", "packages", "validation", "provenance",
]);
function checkCase(c: Record<string, unknown>, requestId: unknown): void {
  assert(Object.keys(c).every(key => caseFields.has(key)), "unexpected case field");
  assert.equal(object(c.qualification).verdict, "accepted");
  assert.equal(object(c.difficulty).status, "not_assessed");
  assert(cells(c.matrix).every(cell => cell.matches_expectation === true), "unqualified matrix");
  assert.equal(object(c.provenance).request_id, requestId);
  assert.equal(object(c.provenance).origin, "live_request");
  const packages = object(c.packages);
  for (const kind of ["bug_case", "validator"]) {
    const part = object(packages[kind]);
    assert.equal(part.kind, kind);
    assert.equal(part.format, kind === "bug_case" ? "rbw-bug-case/1" : "rbw-validator/1");
    assert.equal(part.ready, true, "delivered case package is not ready");
    assert.equal(part.download_path, `/api/factory/requests/${text(requestId)}/cases/${text(c.case_id)}/packages/${kind === "bug_case" ? "bug-case" : kind}`);
  }
  if (c.validation !== null) checkValidation(c.validation);
}
const stopCodes: Record<string, string[]> = {
  fulfilled: ["fulfilled"], stopped_at_limit: ["budget_exhausted", "time_limit", "candidate_limit"],
  sources_exhausted: ["sources_exhausted"], cancelled: ["cancelled_by_user"],
  operational_error: ["worker_lost", "needs_reconciliation", "operational_error"],
};

/** Checks public response invariants, not provider side effects or package replay. */
export function checkStatus(value: unknown): void {
  const s = object(value);
  assert.equal(s.contract_version, "bug-request/1");
  const interpretation = object(s.interpretation);
  const input = object(interpretation.input);
  const inputs = objects(input.items);
  const items = objects(s.items);
  const cases = objects(s.cases);
  const candidates = objects(s.candidates);
  unique(items.map(i => i.item_key)); unique(cases.map(c => c.case_id)); unique(cases.map(c => c.defect_id));
  unique(candidates.map(c => c.candidate_id));
  assert.equal(items.length, inputs.length);
  for (const item of items) {
    const requested = inputs.find(i => i.item_key === item.item_key);
    assert(requested, "unknown item");
    assert.equal(item.requested, requested.quantity);
    assert.equal(item.description, requested.description);
    assert.equal(item.bug_type_id, requested.bug_type_id);
    const delivered = cases.filter(c => c.item_key === item.item_key);
    assert.equal(nonnegative(item.delivered), delivered.length);
    assert.equal(nonnegative(item.missing), nonnegative(item.requested) - delivered.length);
    assert(Array.isArray(item.case_ids));
    assert.deepEqual(item.case_ids.map(text).sort(), delivered.map(c => text(c.case_id)).sort());
    for (const c of delivered) {
      assert.equal(c.bug_type_id, item.bug_type_id);
      const interpreted = objects(interpretation.items).find(i => i.item_key === item.item_key);
      assert(interpreted);
      assert(Array.isArray(input.hosts) && input.hosts.includes(c.host_id), "unselected case host");
      assert(objects(interpreted.eligible_sources).some(source => source.host_id === c.host_id
        && source.source_id === object(c.provenance).source_id), "case source is not eligible");
      const met = objects(c.criteria_met);
      for (const criterion of objects(interpreted.criteria)) {
        assert(met.some(m => m.criterion_id === criterion.criterion_id && m.version === criterion.version), "missing requested criterion");
      }
    }
  }
  for (const c of cases) {
    assert(items.some(i => i.item_key === c.item_key), "case assigned to unknown item");
    const candidate = candidates.find(candidate => candidate.case_id === c.case_id && candidate.stage === "qualified");
    assert(candidate, "case without qualified candidate");
    assert.equal(candidate.defect_id, c.defect_id);
    assert.equal(candidate.item_key, c.item_key);
    checkCase(c, s.request_id);
  }
  for (const candidate of candidates) {
    if (["rejected", "invalid", "incomplete", "skipped"].includes(text(candidate.stage))) {
      assert(!cases.some(c => c.case_id === candidate.case_id), "unsuccessful candidate delivered");
    }
  }
  const totals = objects(s.type_totals);
  unique(totals.map(t => t.bug_type_id));
  assert.equal(totals.length, new Set(items.map(i => i.bug_type_id)).size);
  for (const total of totals) for (const field of ["requested", "delivered", "missing"]) {
    assert.equal(total[field], items.filter(i => i.bug_type_id === total.bug_type_id).reduce((sum, i) => sum + nonnegative(i[field]), 0));
  }
  assert.equal(object(s.funnel).packages_ready, cases.length);
  const b = object(s.budget);
  assert.equal(b.budget_microusd, input.budget_microusd, "request budget changed");
  const committed = nonnegative(b.reserved_microusd) + nonnegative(b.spent_microusd);
  assert.equal(b.committed_microusd, committed);
  assert.equal(b.remaining_microusd, integer(b.budget_microusd) - committed);
  assert.equal(b.overrun, committed > integer(b.budget_microusd));
  const missing = items.reduce((sum, i) => sum + nonnegative(i.missing), 0);
  assert.equal(s.delivery, cases.length === 0 ? "none" : missing === 0 ? "complete" : "partial");
  if (s.state === "finished") {
    assert(stopCodes[text(s.outcome)]?.includes(text(object(s.stop_reason).code)), "outcome/stop code mismatch");
    if (s.outcome === "fulfilled") assert.equal(missing, 0);
  } else {
    assert(["queued", "starting", "running", "stopping"].includes(text(s.state)));
    assert.equal(s.outcome, null); assert.equal(s.stop_reason, null);
  }
}
