"use client";

import type { FactoryCase, RequestStatus, ValidationRun } from "../factory/client.ts";
import { CALENDAR_HINT, describeEvent, describeStopReason, formatClock, formatDuration, formatExactUsd, formatOffset, formatUsd } from "../factory/format.ts";

const OUTCOMES: Record<string, string> = {
  fulfilled: "Fulfilled",
  stopped_at_limit: "Stopped at a limit",
  sources_exhausted: "Sources exhausted",
  cancelled: "Cancelled",
  operational_error: "Operational error",
};

/** Display names from the service's capabilities, keyed by ID; an ID without a name is shown as is. */
export interface FactoryLabels {
  hosts: Readonly<Record<string, string>>;
  bugTypes: Readonly<Record<string, string>>;
}
const NO_LABELS: FactoryLabels = { hosts: {}, bugTypes: {} };

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
export function FactoryProgress({ status, busy, onStop, onValidate, validation = null, disabled = false, polling = false, stopPending = false, labels = NO_LABELS, closedHosts = [] }: {
  status: RequestStatus | null;
  busy: boolean;
  polling?: boolean;
  stopPending?: boolean;
  onStop: () => void;
  onValidate: (caseId: string) => void;
  validation?: ValidationRun | null;
  disabled?: boolean;
  labels?: FactoryLabels;
  /** Hosts the calendar closes now (a UI hint): their cases cannot be validated. */
  closedHosts?: readonly string[];
}) {
  if (status === null) return <section className="factory-panel" aria-labelledby="factory-progress">
    <h2 id="factory-progress">Request progress and results</h2>
    <p role="status">No request status is available yet. When you start a request, its progress and delivered cases appear here.</p>
  </section>;
  const validationActive = (validation !== null && validation.state !== "finished") || status.cases.some((item) => item.validation !== null && item.validation.state !== "finished");
  const requested = status.items.reduce((total, item) => total + item.requested, 0);
  const delivered = status.items.reduce((total, item) => total + item.delivered, 0);
  const plainStop = describeStopReason(status);
  const finishedAt = status.state === "finished" ? status.events.find((event) => event.type === "request_finished")?.at ?? status.updated_at : null;
  const latest = status.events.findLast((event) => describeEvent(event) !== null);
  const setAside = status.candidates.filter((candidate) => candidate.reason !== null);
  const { budget } = status;
  return <section className="factory-panel" aria-labelledby="factory-progress">
    <h2 id="factory-progress">Request progress and results</h2>
    <div className="factory-status" role="status" aria-live="polite">
      <h3>{status.outcome === null ? `Request ${status.state}` : OUTCOMES[status.outcome] ?? status.outcome}</h3>
      <p>{delivered} of {requested} requested {requested === 1 ? "case" : "cases"} delivered.</p>
      {status.state === "finished" && status.delivery === "partial" && <p>Stopped with partial results. Every delivered case is retained below.</p>}
      {plainStop !== null && <p>{plainStop}</p>}
      {status.stop_reason !== null && (plainStop === null
        ? <p>{status.stop_reason.message}</p>
        : plainStop !== status.stop_reason.message && <details className="factory-details"><summary>The service’s explanation</summary><p>{status.stop_reason.message}</p></details>)}
    </div>
    <p className="factory-note">
      Started <time dateTime={status.created_at} title={status.created_at}>{formatClock(status.created_at)}</time>
      {finishedAt !== null && <>; finished after {formatDuration(Date.parse(finishedAt) - Date.parse(status.created_at))}</>}.
      {finishedAt === null && latest !== undefined && <> Latest update ({formatOffset(status.created_at, latest.at)}): {describeEvent(latest, labels.hosts)}</>}
    </p>
    {status.attention !== null && <p role="alert">Attention required ({status.attention.code}): {status.attention.message}</p>}
    <h3>Requested and delivered</h3>
    <ul>{status.items.map((item) => <li key={item.item_key}>
      <strong>{labels.bugTypes[item.bug_type_id] ?? item.bug_type_id}</strong> <small>({item.item_key})</small>
      {item.description !== null && <p>{item.description}</p>}
      <p>Requested: {item.requested}; delivered: {item.delivered}; missing: {item.missing}.</p>
    </li>)}</ul>
    <p className="factory-budget-line">
      Budget: {formatUsd(budget.spent_microusd)} spent of {formatUsd(budget.budget_microusd)}, {formatUsd(budget.remaining_microusd, "down")} left
      {budget.reserved_microusd > 0 && <>, with {formatUsd(budget.reserved_microusd, "up")} held for work in progress</>}.
      {" "}Candidate bugs tried: {status.funnel.candidates_explored}.
    </p>
    <details className="factory-details">
      <summary>Budget and check counts</summary>
      <dl className="factory-metrics">
        <dt>Candidates explored</dt><dd>{status.funnel.candidates_explored}</dd>
        <dt>Behavior checks passed</dt><dd>{status.funnel.behavior_checks_passed}</dd>
        <dt>Requested criteria passed</dt><dd>{status.funnel.requested_criteria_passed}</dd>
        <dt>Packages ready</dt><dd>{status.funnel.packages_ready}</dd>
        <dt>Shared budget</dt><dd>{formatExactUsd(budget.budget_microusd)}</dd>
        <dt>Reserved</dt><dd>{formatExactUsd(budget.reserved_microusd)}</dd>
        <dt>Spent</dt><dd>{formatExactUsd(budget.spent_microusd)}</dd>
        <dt>Committed</dt><dd>{formatExactUsd(budget.committed_microusd)}</dd>
        <dt>Remaining</dt><dd>{formatExactUsd(budget.remaining_microusd)}</dd>
      </dl>
    </details>
    {budget.overrun && <p role="alert">The service reports a budget overrun.</p>}
    {status.state !== "finished" && <button type="button" onClick={onStop} disabled={stopPending || (busy && !polling) || disabled || status.state === "stopping"}>Stop request</button>}
    <details className="factory-details">
      <summary>Activity log ({status.events.length} {status.events.length === 1 ? "event" : "events"})</summary>
      {status.events.length === 0 ? <p>No events received yet.</p> : <ol className="factory-events">{status.events.map((event) => <li key={event.seq}>
        <time dateTime={event.at} title={event.at}>{formatClock(event.at)}</time> <small>({formatOffset(status.created_at, event.at)})</small> — {event.message}
      </li>)}</ol>}
    </details>
    {setAside.length > 0 && <details className="factory-details">
      <summary>Why some candidate bugs were set aside ({setAside.length})</summary>
      <p>Retries, rejected candidates and incomplete cases are not delivered bugs.</p>
      <ul>{setAside.map((candidate) => <li key={candidate.candidate_id}>{labels.hosts[candidate.host_id] ?? candidate.host_id}: {candidate.stage.replaceAll("_", " ")} — {candidate.reason?.message}</li>)}</ul>
    </details>}
    <h3>Delivered cases</h3>
    <p>Each case comes as two downloads: the bug case for a debugging agent, and a separate validator package for checking a fix.</p>
    <details className="factory-details">
      <summary>How cases qualify</summary>
      <p>Qualification is determined by the backend. Original tests must pass unchanged on clean, buggy and reference-fixed copies; separate verification checks must pass clean and fixed copies and detect the intended buggy failure.</p>
    </details>
    {status.cases.length === 0 ? <p>No qualified cases have been delivered.</p> : <ul>{status.cases.map((item) => {
      const run = validation?.case_id === item.case_id ? validation : item.validation;
      const cost = status.interpretation.budget.worst_case_per_validation_microusd.find((entry) => entry.host_id === item.host_id)?.microusd;
      const insufficientBudget = cost !== undefined && status.budget.remaining_microusd < cost;
      const calendarClosed = closedHosts.includes(item.host_id);
      const canValidate = !calendarClosed && !busy && !disabled && !validationActive && status.state === "finished" && status.attention === null && !insufficientBudget && item.packages.bug_case.ready && !!item.packages.bug_case.download_path && item.packages.validator.ready && !!item.packages.validator.download_path;
      return <li className="factory-case-card" key={item.case_id}>
        <h4>{item.title}</h4>
        <p>{item.host_label} <small>(app version {item.baseline_id})</small></p>
        <p>{item.summary.observed_failure}</p>
        <p>{item.difficulty.note}</p>
        <PackageLinks item={item} />
        <ValidationStatus run={run} />
        <p>Validation reruns the checks on both downloads{cost !== undefined && <>, for up to {formatUsd(cost, "up")}</>}, paid from this request’s remaining budget.</p>
        <details className="factory-details"><summary>What validation shows</summary>
          <p>Validation runs the harness on both exported packages and uses this request’s remaining budget. Clicking alone does not establish execution.</p>
        </details>
        {insufficientBudget && <p>The remaining budget cannot cover validation.</p>}
        {calendarClosed && <p id={`factory-calendar-${item.case_id}`} className="factory-badge">{CALENDAR_HINT}</p>}
        <button type="button" disabled={!canValidate} aria-describedby={calendarClosed ? `factory-calendar-${item.case_id}` : undefined} onClick={() => { onValidate(item.case_id); }}>Validate case</button>
      </li>;
    })}</ul>}
  </section>;
}
