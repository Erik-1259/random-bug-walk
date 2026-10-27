"use client";

import type { FactoryCase, RequestStatus, ValidationRun } from "../factory/client.ts";

const OUTCOMES: Record<string, string> = {
  fulfilled: "Fulfilled",
  stopped_at_limit: "Stopped at a limit",
  sources_exhausted: "Sources exhausted",
  cancelled: "Cancelled",
  operational_error: "Operational error",
};
const money = (amount: number) => `$${(amount / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

function ValidationStatus({ run }: { run: ValidationRun | null }) {
  if (run === null) return <p>Validation has not been started.</p>;
  return <div role="status" aria-live="polite">
    <p>Validation: {run.state === "finished" ? run.result : run.state}</p>
    {run.state === "finished" && run.result === "passed" && <p>All six cells matched their expected outcomes.</p>}
    {run.state === "finished" && run.result === "failed" && <p>The harness completed, but at least one observed outcome differed from its expectation.</p>}
    {run.state === "finished" && run.result === "error" && <p>Validation could not establish a behavioral result. Setup failures, missing output and incomplete runs are not reproduction.</p>}
    {run.message !== null && <p>{run.message}</p>}
  </div>;
}

function PackageLinks({ item }: { item: FactoryCase }) {
  return <>
    <p>Bug case — debugging agent input, without verification checks or reference repairs.</p>
    {item.packages.bug_case.ready && item.packages.bug_case.download_path !== null && item.packages.bug_case.download_path !== ""
      ? <a href={item.packages.bug_case.download_path}>Download bug case</a>
      : <p>Bug-case download is not ready.</p>}
    <p>Validator package — evaluator material. Keep it separate from the debugging agent.</p>
    {item.packages.validator.ready && item.packages.validator.download_path !== null && item.packages.validator.download_path !== ""
      ? <a href={item.packages.validator.download_path}>Download validator package</a>
      : <p>Validator download is not ready.</p>}
  </>;
}

/** Contract bug-request/1, revision 2: render service facts; never infer qualification or completion. */
export function FactoryProgress({ status, busy, onStop, onValidate, validation = null, disabled = false, polling = false, stopPending = false }: {
  status: RequestStatus | null;
  busy: boolean;
  polling?: boolean;
  stopPending?: boolean;
  onStop: () => void;
  onValidate: (caseId: string) => void;
  validation?: ValidationRun | null;
  disabled?: boolean;
}) {
  if (status === null) return <section className="factory-panel" aria-labelledby="factory-progress">
    <h2 id="factory-progress">Request progress and results</h2>
    <p role="status">No request status is available. No progress or result is inferred.</p>
  </section>;
  const validationActive = (validation !== null && validation.state !== "finished") || status.cases.some((item) => item.validation !== null && item.validation.state !== "finished");
  return <section className="factory-panel" aria-labelledby="factory-progress">
    <h2 id="factory-progress">Request progress and results</h2>
    <div className="factory-status" role="status" aria-live="polite">
      <h3>{status.outcome === null ? `Request ${status.state}` : OUTCOMES[status.outcome] ?? status.outcome}</h3>
      <p>Delivery: {status.delivery}</p>
      {status.state === "finished" && status.delivery === "partial" && <p>Stopped with partial results. Every delivered case is retained below.</p>}
      {status.stop_reason !== null && <p>{status.stop_reason.message}</p>}
    </div>
    {status.attention !== null && <p role="alert">Attention required ({status.attention.code}): {status.attention.message}</p>}
    <h3>Requested and delivered</h3>
    <ul>{status.items.map((item) => <li key={item.item_key}>
      <strong>{item.item_key}: {item.bug_type_id}</strong>
      {item.description !== null && <p>{item.description}</p>}
      <p>Requested: {item.requested}; delivered: {item.delivered}; missing: {item.missing}.</p>
    </li>)}</ul>
    <dl className="factory-metrics">
      <dt>Candidates explored</dt><dd>{status.funnel.candidates_explored}</dd>
      <dt>Behavior checks passed</dt><dd>{status.funnel.behavior_checks_passed}</dd>
      <dt>Requested criteria passed</dt><dd>{status.funnel.requested_criteria_passed}</dd>
      <dt>Packages ready</dt><dd>{status.funnel.packages_ready}</dd>
      <dt>Shared budget</dt><dd>{money(status.budget.budget_microusd)}</dd>
      <dt>Reserved</dt><dd>{money(status.budget.reserved_microusd)}</dd>
      <dt>Spent</dt><dd>{money(status.budget.spent_microusd)}</dd>
      <dt>Committed</dt><dd>{money(status.budget.committed_microusd)}</dd>
      <dt>Remaining</dt><dd>{money(status.budget.remaining_microusd)}</dd>
    </dl>
    {status.budget.overrun && <p role="alert">The service reports a budget overrun.</p>}
    {status.state !== "finished" && <button type="button" onClick={onStop} disabled={stopPending || (busy && !polling) || disabled || status.state === "stopping"}>Stop request</button>}
    <h3>Recorded events</h3>
    {status.events.length === 0 ? <p>No events received yet.</p> : <ol className="factory-events">{status.events.map((event) => <li key={event.seq}>
      <time dateTime={event.at}>{event.at}</time> — {event.message}
    </li>)}</ol>}
    <h3>Candidate reasons</h3>
    <p>Retries, rejected candidates and incomplete cases are not delivered bugs.</p>
    <ul>{status.candidates.filter((candidate) => candidate.reason !== null).map((candidate) => <li key={candidate.candidate_id}>{candidate.host_id}: {candidate.stage} — {candidate.reason?.message}</li>)}</ul>
    <h3>Delivered cases</h3>
    <p>Qualification is determined by the backend. Original tests must pass unchanged on clean, buggy and reference-fixed copies; separate verification checks must pass clean and fixed copies and detect the intended buggy failure.</p>
    {status.cases.length === 0 ? <p>No qualified cases have been delivered.</p> : <ul>{status.cases.map((item) => {
      const run = validation?.case_id === item.case_id ? validation : item.validation;
      const cost = status.interpretation.budget.worst_case_per_validation_microusd.find((entry) => entry.host_id === item.host_id)?.microusd;
      const insufficientBudget = cost !== undefined && status.budget.remaining_microusd < cost;
      const canValidate = !busy && !disabled && !validationActive && status.state === "finished" && status.attention === null && !insufficientBudget && item.packages.bug_case.ready && !!item.packages.bug_case.download_path && item.packages.validator.ready && !!item.packages.validator.download_path;
      return <li className="factory-case-card" key={item.case_id}>
        <h4>{item.title}</h4>
        <p>{item.host_label} — {item.baseline_id}</p>
        <p>{item.summary.observed_failure}</p>
        <p>Difficulty: {item.difficulty.status}. {item.difficulty.note}</p>
        <PackageLinks item={item} />
        <ValidationStatus run={run} />
        <p>Validation runs the harness on both exported packages and uses this request’s remaining budget. Clicking alone does not establish execution.</p>
        {insufficientBudget && <p>The remaining budget cannot cover validation.</p>}
        <button type="button" disabled={!canValidate} onClick={() => { onValidate(item.case_id); }}>Validate case</button>
      </li>;
    })}</ul>}
  </section>;
}
