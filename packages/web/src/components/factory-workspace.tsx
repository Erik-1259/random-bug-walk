"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { FactoryController, factoryClient } from "../factory/client.ts";
import { FactoryRequestForm } from "./factory-request-form.tsx";
import { FactoryProgress } from "./factory-progress.tsx";

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
  useEffect(() => {
    if (view.busy || !controller.needsPoll()) return;
    const timer = setTimeout(() => { void controller.poll(); }, controller.pollAfter());
    return () => { clearTimeout(timer); };
  }, [controller, view]);
  const unavailable = view.capabilities?.service.state !== "available";
  return <>
    <aside className="factory-availability" aria-label="Request availability">
      <strong>{unavailable ? "Live requests unavailable" : "Request service available"}</strong>
      <p>{view.capabilities?.service.message ?? (unavailable ? "The request service has not supplied available capabilities. No work can start." : "Review the service’s interpretation before starting. Execution uses the shared request budget.")}</p>
      <button type="button" disabled={view.busy} onClick={() => { void controller.initialize(); }}>Refresh service availability</button>
    </aside>
    {view.message !== null && <p role="alert">{view.message}</p>}
    {!view.signedIn && <form className="factory-panel factory-form" onSubmit={(event) => { event.preventDefault(); const value = passcode; setPasscode(""); void controller.signIn(value); }}>
      <h2>Factory session</h2>
      <p>Starting, resuming and stopping requests requires the judge passcode. This session is separate from the Umami replay.</p>
      <label htmlFor="factory-passcode">Judge passcode</label>
      <input id="factory-passcode" type="password" autoComplete="current-password" value={passcode} onChange={(event) => { setPasscode(event.target.value); }} />
      <button type="submit" disabled={view.busy || passcode.length === 0}>Sign in to the request service</button>
    </form>}
    <div hidden={view.requestId !== null}><FactoryRequestForm capabilities={view.capabilities} disabled={view.busy || view.requestId !== null || unavailable}
      onChange={() => { controller.invalidateInterpretation(); }} onInterpret={(input) => { void controller.interpret(input); }} /></div>
    {view.interpretation !== null && <section className="factory-panel" aria-labelledby="factory-interpretation">
      <h2 id="factory-interpretation">Service interpretation</h2>
      <p>{view.interpretation.startable ? "These requirements can be started." : "These requirements cannot be started. Address the blocking problems and review again."}</p>
      <ul>{view.interpretation.items.map(item => <li key={item.item_key}>
        <strong>{item.bug_type_id}: {item.quantity} requested — {item.status}</strong>
        {item.description !== null && <p>{item.description}</p>}
        <ul>{item.criteria.map(criterion => <li key={criterion.criterion_id}>{criterion.label}</li>)}</ul>
        {item.unmatched_text.length > 0 && <p>Unrecognized description: {item.unmatched_text.join(", ")}</p>}
        <ul>{item.problems.map((problem, index) => <li key={index}>{problem.severity}: {problem.message}</li>)}</ul>
      </li>)}</ul>
      <ul>{view.interpretation.problems.map((problem, index) => <li key={index}>{problem.severity}: {problem.message}</li>)}</ul>
      <ul>{view.interpretation.hosts.map(host => <li key={host.host_id}>{host.host_id}: {host.used ? "used" : "unused"}{host.reason === null ? "" : ` — ${host.reason}`}</li>)}</ul>
      <p>Shared budget: ${(view.interpretation.budget.budget_microusd / 1000000).toFixed(6)} USD. {view.interpretation.budget.estimate_note}</p>
      <button type="button" disabled={view.busy || unavailable || !view.signedIn || !view.interpretation.startable || view.requestId !== null} onClick={() => { void controller.start(); }}>Start request</button>
    </section>}
    {view.requestId !== null && <section className="factory-panel">
      <p>Saved request: <code>{view.requestId}</code>. Reloading resumes this identity; a temporary failure never starts replacement work.</p>
      <button type="button" disabled={view.busy || !view.signedIn} onClick={() => { void controller.poll(); }}>Refresh saved request</button>
      {view.canRetryStart && <button type="button" disabled={view.busy || !view.signedIn} onClick={() => { void controller.retryStart(); }}>Retry the same request</button>}
      {view.canRetryValidation && <button type="button" disabled={view.busy || !view.signedIn} onClick={() => { void controller.retryValidation(); }}>Retry the same validation</button>}
      {view.status?.state === "finished" && <button type="button" disabled={view.busy || view.status.attention !== null || (view.validation !== null && view.validation.state !== "finished") || view.canRetryValidation} onClick={() => { controller.newDraft(); }}>Prepare another request</button>}
    </section>}
    <FactoryProgress status={view.status} busy={view.busy || view.canRetryValidation} disabled={!view.signedIn} validation={view.validation}
      onStop={() => { void controller.stop(); }} onValidate={(caseId) => { void controller.validate(caseId); }} />
  </>;
}
