"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { FactoryPlan } from "../assist/plan.ts";
import { FactoryController, factoryClient, type Capabilities, type Interpretation } from "../factory/client.ts";
import { CALENDAR_HINT, calendarClockDelay, calendarClosedHosts, calendarClosesPair, calendarFallback, calendarReopened, describeFactoryMessage, describeServiceState, formatExactUsd, formatUsd } from "../factory/format.ts";
import { BugDesigner } from "./bug-designer.tsx";
import { CopyButton } from "./copy-button.tsx";
import { DeliveryBriefs } from "./delivery-brief.tsx";
import { FactoryRequestForm } from "./factory-request-form.tsx";
import { FactoryProgress, type FactoryLabels } from "./factory-progress.tsx";

/**
 * Under an item the service refuses because no selected host supports its bug type: the calendar
 * cause when the request includes Umami and the calendar closes that pair now, or nothing.
 */
export function CalendarCause({ capabilities, requestedHosts, item, nowMs }: { capabilities: Capabilities | null; requestedHosts: readonly string[]; item: Interpretation["items"][number]; nowMs: number }) {
  if (capabilities === null || !item.problems.some((problem) => problem.code === "unsupported_combination" && problem.severity === "blocking")) return null;
  const requested = (hostId: string) => requestedHosts.includes(hostId);
  if (!requested("umami") || !calendarClosesPair(capabilities, "umami", item.bug_type_id, nowMs)) return null;
  const fallback = requested("task-report") ? null : calendarFallback(capabilities);
  return <p className="factory-badge">{CALENDAR_HINT}{fallback !== null && <> {fallback}</>}</p>;
}

/** Sets one timer for the next calendar boundary, counted from this browser's clock now; returns its cancel. */
export function scheduleCalendarTick(capabilities: Capabilities | null, onTick: (nowMs: number) => void): () => void {
  const delay = calendarClockDelay(capabilities, Date.now());
  if (delay === null) return () => undefined;
  const timer = setTimeout(() => { onTick(Date.now()); }, delay);
  return () => { clearTimeout(timer); };
}

/**
 * This browser's clock, reread at each calendar boundary and with each new capabilities read so a
 * page left open updates its hints. At a boundary where capabilities read during the window are out
 * of date, it asks for a fresh read.
 */
function useCalendarClock(capabilities: Capabilities | null, controller: FactoryController): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [clockFor, setClockFor] = useState(capabilities);
  if (clockFor !== capabilities) { setClockFor(capabilities); setNowMs(Date.now()); }
  useEffect(() => scheduleCalendarTick(capabilities, (next) => {
    setNowMs(next);
    // The same read as "Refresh service availability".
    if (calendarReopened(capabilities, next)) void controller.initialize();
  }), [capabilities, nowMs, controller]);
  return nowMs;
}

function FactoryAlert({ message }: { message: string }) {
  const friendly = describeFactoryMessage(message);
  return <div role="alert" className="factory-alert">
    <p><strong>{friendly.title}</strong>{friendly.body !== null && <> {friendly.body}</>}</p>
    <p><small>Service message: {friendly.raw}</small></p>
  </div>;
}

export function FactoryWorkspace() {
  const [controller, setController] = useState<FactoryController | null>(null);
  useEffect(() => {
    // Storage is accessed only in the browser. The controller refuses a start if persistence fails.
    const instance = new FactoryController(factoryClient, {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => { window.localStorage.setItem(key, value); },
      removeItem: (key) => { window.localStorage.removeItem(key); },
    }, () => crypto.randomUUID());
    setController(instance);
    void instance.initialize();
  }, []);
  if (controller === null) return <p role="status">Live requests unavailable until service availability is confirmed. No work has started.</p>;
  return <ConnectedWorkspace controller={controller} />;
}

function ConnectedWorkspace({ controller }: { controller: FactoryController }) {
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [passcode, setPasscode] = useState("");
  const [plan, setPlan] = useState<FactoryPlan | null>(null);
  useEffect(() => {
    // After "Use this plan", move to the refilled request form so keyboard and screen reader users land on it.
    if (plan !== null) document.getElementById("factory-draft-heading")?.focus();
  }, [plan]);
  useEffect(() => {
    if (view.busy || !controller.needsPoll()) return;
    const timer = setTimeout(() => { void controller.poll(); }, controller.pollAfter());
    return () => { clearTimeout(timer); };
  }, [controller, view]);
  const unavailable = view.capabilities?.service.state !== "available";
  const labels: FactoryLabels = {
    hosts: Object.fromEntries((view.capabilities?.hosts ?? []).map((host) => [host.host_id, host.label])),
    bugTypes: Object.fromEntries((view.capabilities?.bug_types ?? []).map((type) => [type.bug_type_id, type.label])),
  };
  const serviceMessage = view.capabilities?.service.message ?? null;
  // A UI hint only, from the capabilities and this browser's clock; the service decides.
  const nowMs = useCalendarClock(view.capabilities, controller);
  const closedHosts = calendarClosedHosts(view.capabilities, nowMs);
  const requestedHosts = view.interpretation?.hosts.map((host) => host.host_id) ?? [];
  return <>
    <aside className={unavailable ? "factory-availability factory-availability-closed" : "factory-availability"} aria-label="Request availability">
      <strong>{unavailable ? "Live requests unavailable" : "Request service available"}</strong>
      <p>{view.capabilities === null && view.busy ? "Checking whether the request service is available. No work has started." : describeServiceState(view.capabilities?.service ?? null)}</p>
      {serviceMessage !== null && <p><small>Service message: {serviceMessage}</small></p>}
      <button type="button" disabled={view.busy} onClick={() => { void controller.initialize(); }}>Refresh service availability</button>
    </aside>
    {view.message !== null && <FactoryAlert message={view.message} />}
    {!view.signedIn && <form className="factory-panel factory-form" onSubmit={(event) => { event.preventDefault(); const value = passcode; setPasscode(""); void controller.signIn(value); }}>
      <h2>Sign in to start requests</h2>
      <p>Reading this page and reviewing requirements need no sign-in. Starting, resuming and stopping a request needs the judge passcode. This sign-in is separate from the replay on the example case page.</p>
      <label htmlFor="factory-passcode">Judge passcode</label>
      <input id="factory-passcode" type="password" autoComplete="current-password" value={passcode} onChange={(event) => { setPasscode(event.target.value); }} />
      <button type="submit" disabled={view.busy || passcode.length === 0}>Sign in to the request service</button>
    </form>}
    <BugDesigner signedIn={view.signedIn} capabilities={view.capabilities} closedHosts={closedHosts}
      applyBlocked={view.requestId !== null ? "A request is in progress on this page. When it finishes, prepare another request, then use this plan." : view.capabilities === null ? "The request form is not loaded, so this plan cannot fill it." : null}
      onUsePlan={(next) => { controller.invalidateInterpretation(); setPlan(next); }} />
    <div hidden={view.requestId !== null}><FactoryRequestForm key={plan?.key ?? 0} plan={plan} capabilities={view.capabilities} closedHosts={closedHosts} disabled={view.busy || view.requestId !== null || unavailable}
      onChange={() => { controller.invalidateInterpretation(); }} onInterpret={(input) => { void controller.interpret(input); }} /></div>
    {view.interpretation !== null && <section className="factory-panel" aria-labelledby="factory-interpretation">
      <h2 id="factory-interpretation">Service interpretation</h2>
      <p>{view.interpretation.startable ? "These requirements can be started." : "These requirements cannot be started. Address the blocking problems and review again."}</p>
      <ul>{view.interpretation.items.map(item => <li key={item.item_key}>
        <strong>{labels.bugTypes[item.bug_type_id] ?? item.bug_type_id}: {item.quantity} requested — {item.status === "supported" ? "can be delivered" : "cannot be delivered"}</strong>
        {item.description !== null && <p>{item.description}</p>}
        {item.criteria.length > 0 && <p>Recognized behavior:</p>}
        <ul>{item.criteria.map(criterion => <li key={criterion.criterion_id}>{criterion.label}</li>)}</ul>
        {item.unmatched_text.length > 0 && <p>Unrecognized description: {item.unmatched_text.join(", ")}</p>}
        <ul>{item.problems.map((problem, index) => <li key={index}>{problem.severity === "blocking" ? "Must fix" : "Note"}: {problem.message}</li>)}</ul>
        <CalendarCause capabilities={view.capabilities} requestedHosts={requestedHosts} item={item} nowMs={nowMs} />
      </li>)}</ul>
      <ul>{view.interpretation.problems.map((problem, index) => <li key={index}>{problem.severity === "blocking" ? "Must fix" : "Note"}: {problem.message}</li>)}</ul>
      <p>Applications: {view.interpretation.hosts.map(host => `${labels.hosts[host.host_id] ?? host.host_id} (${host.used ? "used" : "not used"})`).join(", ")}.</p>
      <p>This request can spend up to {formatUsd(view.interpretation.budget.budget_microusd, "down")} from the shared judging budget. Before each step runs, its maximum cost is held; afterward only the actual cost is kept and the rest is released.</p>
      <details className="factory-details">
        <summary>Cost limits and service notes</summary>
        <ul>
          <li>Budget: {formatExactUsd(view.interpretation.budget.budget_microusd)}</li>
          <li>Held when the request starts: {formatExactUsd(view.interpretation.budget.worker_worst_case_microusd)}</li>
          {view.interpretation.budget.worst_case_per_candidate_microusd.map(entry => <li key={`candidate-${entry.host_id}`}>Held per candidate bug on {labels.hosts[entry.host_id] ?? entry.host_id}: {formatExactUsd(entry.microusd)}</li>)}
          {view.interpretation.budget.worst_case_per_validation_microusd.map(entry => <li key={`validation-${entry.host_id}`}>Held per validation run on {labels.hosts[entry.host_id] ?? entry.host_id}: {formatExactUsd(entry.microusd)}</li>)}
        </ul>
        <ul>{view.interpretation.hosts.filter(host => host.reason !== null).map(host => <li key={host.host_id}>{labels.hosts[host.host_id] ?? host.host_id}: {host.reason}</li>)}</ul>
        <p>{view.interpretation.budget.estimate_note}</p>
      </details>
      <button type="button" disabled={view.busy || unavailable || !view.signedIn || !view.interpretation.startable || view.requestId !== null} onClick={() => { void controller.start(); }}>Start request</button>
    </section>}
    {view.requestId !== null && <section className="factory-panel">
      <p>Your request is saved in this browser. You can reload or come back later, and this page picks it up again; a temporary failure never starts replacement work.</p>
      <p className="factory-note">Request ID <code>{view.requestId}</code> <CopyButton value={view.requestId} label="Copy request ID" /></p>
      <button type="button" disabled={view.busy || !view.signedIn} onClick={() => { void controller.poll(); }}>Refresh saved request</button>
      {view.canRetryStart && <button type="button" disabled={view.busy || !view.signedIn} onClick={() => { void controller.retryStart(); }}>Retry the same request</button>}
      {view.canRetryValidation && <button type="button" disabled={view.busy || !view.signedIn} onClick={() => { void controller.retryValidation(); }}>Retry the same validation</button>}
      {view.status?.state === "finished" && <button type="button" disabled={view.busy || view.status.attention !== null || (view.validation !== null && view.validation.state !== "finished") || view.status.cases.some((item) => item.validation !== null && item.validation.state !== "finished") || view.canRetryValidation} onClick={() => { void controller.newDraft(); }}>Prepare another request</button>}
    </section>}
    <FactoryProgress status={view.status} busy={view.busy || view.canRetryValidation} polling={view.polling} stopPending={view.stopPending} disabled={!view.signedIn} validation={view.validation} labels={labels} closedHosts={closedHosts}
      onStop={() => { void controller.stop(); }} onValidate={(caseId) => { void controller.validate(caseId); }} />
    {view.requestId !== null && view.status?.state === "finished" && <DeliveryBriefs key={view.requestId} requestId={view.requestId} cases={view.status.cases} signedIn={view.signedIn} />}
  </>;
}
