"use client";

import { useReducer, type Dispatch } from "react";
import { ASSIST_HOSTS, assistClient, queryProblem, type AssistClient, type AssistFailure } from "../assist/client.ts";
import { currentSpec, designerReducer, INITIAL_DESIGNER, specKey, type DesignerAction, type DesignerState } from "../assist/designer-state.ts";
import { planFromShape, type FactoryPlan } from "../assist/plan.ts";
import type { Capabilities } from "../factory/client.ts";
import { CALENDAR_HINT, calendarClosedHosts, calendarFallback, formatDateTime } from "../factory/format.ts";

export const DESIGNER_EXAMPLES: readonly string[] = ["date/time bugs", "race conditions", "lost updates"];
export const DESIGNER_CREDIT = "Designed by NVIDIA Nemotron 3 Super on Nebius Token Factory · sources found with Tavily";
export const CATALOG_HONESTY = "Today Random Bug Walk delivers the closest proven bug from its catalog, re-verified live on fresh clean, buggy and fixed copies.";
/** Where custom builds are enabled: this design is a starting point, and "Build a custom bug" writes the card that is built. */
export const OTF_DESIGNER_NOTE = "A catalog request delivers the closest proven bug from the catalog, re-verified live on fresh clean, buggy and fixed copies. This design is not built as written. To have a new bug built, use \u201cBuild a custom bug\u201d above: it writes its own spec card from one sentence, and you can edit that card before you accept it.";

const FALLBACK_HOST_LABELS: Readonly<Record<string, string>> = { umami: "Umami", "task-report": "Task and report service" };

export function hostLabel(capabilities: Capabilities | null, hostId: string): string {
  return capabilities?.hosts.find((host) => host.host_id === hostId)?.label ?? FALLBACK_HOST_LABELS[hostId] ?? hostId;
}
function bugTypeLabel(capabilities: Capabilities | null, bugTypeId: string): string {
  return capabilities?.bug_types.find((type) => type.bug_type_id === bugTypeId)?.label ?? bugTypeId.replaceAll("_", " ");
}

/** Plain words for a failure that leaves the designer open (refused, rate limited, unreadable request). */
export function describeAssistFailure(failure: AssistFailure): string {
  switch (failure.code) {
    case "refused": return `The designer covers non-security bugs only, such as date and time, concurrency, data handling, state and UI logic. ${failure.message ?? "Try a different kind of bug."}`;
    case "rate_limited": return failure.retryAfterS === null ? "The designer is busy. Try again in a minute." : `The designer is busy. Try again in ${String(failure.retryAfterS)} ${failure.retryAfterS === 1 ? "second" : "seconds"}.`;
    case "invalid_request": return `The designer could not read this request. ${failure.message ?? "Change it and try again."}`;
    case "signed_out": return "Sign in first: the designer uses the same judge sign-in as requests.";
    case "unavailable": return "The bug designer is unavailable right now. The request form below works exactly as before.";
  }
}

export interface BugDesignerProps {
  signedIn: boolean;
  capabilities: Capabilities | null;
  /** Hosts the calendar closes now (a UI hint): a plan cannot fill the form with them. Without it, the ones the capabilities report closed. */
  closedHosts?: readonly string[];
  /** Why "Use this plan" cannot fill the form now (for example a request in progress), or null. */
  applyBlocked: string | null;
  onUsePlan: (plan: FactoryPlan) => void;
  client?: AssistClient;
  otfEnabled?: boolean;
}

export function BugDesigner({ client = assistClient, ...props }: BugDesignerProps) {
  const [state, dispatch] = useReducer(designerReducer, INITIAL_DESIGNER);
  const search = async () => {
    if (state.busy !== null || queryProblem(state.query) !== null) return;
    dispatch({ type: "search" });
    const outcome = await client.bugShapes(state.query.trim());
    dispatch(outcome.ok ? { type: "shapes", result: outcome.value } : { type: "failed", failure: outcome.failure });
  };
  const write = async () => {
    const shape = state.shapes?.shapes.find((item) => item.id === state.shapeId);
    const hostId = state.hostId;
    if (state.busy !== null || shape === undefined || hostId === null) return;
    dispatch({ type: "write" });
    const outcome = await client.bugSpec(shape, hostId);
    dispatch(outcome.ok ? { type: "spec", result: outcome.value, specFor: specKey(shape.id, hostId) } : { type: "failed", failure: outcome.failure });
  };
  return <BugDesignerView {...props} state={state} dispatch={dispatch} onSearch={() => { void search(); }} onWrite={() => { void write(); }} />;
}

export interface BugDesignerViewProps extends Omit<BugDesignerProps, "client"> {
  state: DesignerState;
  dispatch: Dispatch<DesignerAction>;
  onSearch: () => void;
  onWrite: () => void;
}

/** Everything the designer shows, from its state; BugDesigner supplies the state and the calls. */
export function BugDesignerView({ signedIn, capabilities, closedHosts = calendarClosedHosts(capabilities), applyBlocked, onUsePlan, state, dispatch, onSearch, onWrite, otfEnabled = false }: BugDesignerViewProps) {
  const header = <>
    <h2 id="designer-heading">Find a bug for your agent evaluation</h2>
    <p>Describe a kind of bug. The designer searches the public web for real bug reports of that kind, sums them up as a few bug shapes, and writes a bug specification for one of the two applications. Non-security bugs only: date and time, concurrency, data handling, state and UI logic.</p>
    <p className="model-credit">{DESIGNER_CREDIT}</p>
  </>;
  const failure = state.failure;
  if (!signedIn || failure?.code === "signed_out") return <section className="factory-panel designer" aria-labelledby="designer-heading">
    {header}
    <p className="designer-notice" role="status">Sign in first: the designer uses the same judge sign-in as requests. The request form below works without it for reviewing.</p>
  </section>;
  if (failure?.code === "unavailable") return <section className="factory-panel designer" aria-labelledby="designer-heading">
    {header}
    <p className="designer-notice" role="status">{describeAssistFailure(failure)}</p>
    <button type="button" onClick={() => { dispatch({ type: "retry" }); }}>Try the designer again</button>
  </section>;
  const problem = queryProblem(state.query);
  const shapes = state.shapes;
  const shape = shapes?.shapes.find((item) => item.id === state.shapeId) ?? null;
  const spec = currentSpec(state);
  const busyText = state.busy === "shapes" ? "Searching public bug reports and summing them up as bug shapes. This can take up to a minute."
    : state.busy === "spec" ? "Writing the bug specification. This can take up to a minute." : null;
  return <section className="factory-panel designer" aria-labelledby="designer-heading" aria-busy={state.busy !== null}>
    {header}
    <form className="factory-form" role="search" aria-label="Bug designer" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
      <label htmlFor="designer-query">Step 1: the kind of bug you want</label>
      <input id="designer-query" type="text" value={state.query} aria-describedby="designer-query-help" autoComplete="off"
        onChange={(event) => { dispatch({ type: "query", query: event.target.value }); }} />
      <p id="designer-query-help" className="factory-note">For example a bug class or a short description, 3 to 300 characters.</p>
      <p className="designer-chips"><span>Examples:</span>{DESIGNER_EXAMPLES.map((example) => <button key={example} type="button" className="designer-chip" aria-pressed={state.query === example}
        onClick={() => { dispatch({ type: "query", query: example }); }}>{example}</button>)}</p>
      <button className="factory-button" type="submit" disabled={state.busy !== null || problem !== null}>Find bug shapes</button>
    </form>
    <div role="status" aria-live="polite" className="designer-live">
      {busyText !== null && <p>{busyText}</p>}
      {busyText === null && shapes !== null && <p>Found {shapes.shapes.length} bug {shapes.shapes.length === 1 ? "shape" : "shapes"} from {shapes.search.result_count} public {shapes.search.result_count === 1 ? "result" : "results"}.</p>}
    </div>
    {failure !== null && <p className="designer-notice designer-notice-warn" role="alert">{describeAssistFailure(failure)}</p>}
    {shapes !== null && <fieldset className="designer-shapes" disabled={state.busy !== null}>
      <legend>Step 2: pick a bug shape</legend>
      <p className="factory-note">Search for “{shapes.search.query}” on <time dateTime={shapes.search.at}>{formatDateTime(shapes.search.at)}</time>. Written by <code>{shapes.model.model_id}</code>.</p>
      <ul className="designer-list">{shapes.shapes.map((item) => <li key={item.id} className="designer-card">
        <label><input type="radio" name="designer-shape" value={item.id} checked={state.shapeId === item.id}
          onChange={() => { dispatch({ type: "pick_shape", shapeId: item.id }); }} /> {item.title}</label>
        <p>{item.summary}</p>
        <p>{item.fit === null
          ? "No proven bug in the catalog matches this shape yet."
          : <>Closest proven bug: {hostLabel(capabilities, item.fit.host_id)}, {bugTypeLabel(capabilities, item.fit.bug_type_id)} — “{item.fit.phrase}”.</>}
          {item.fit !== null && item.fit_reason !== "" && <> <small>{item.fit_reason}</small></>}</p>
        {item.sources.length > 0 && <details className="factory-details"><summary>Sources ({item.sources.length})</summary>
          <ul>{item.sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer nofollow">{source.title}</a></li>)}</ul>
        </details>}
      </li>)}</ul>
    </fieldset>}
    {shape !== null && <fieldset disabled={state.busy !== null}>
      <legend>Step 3: choose the target application</legend>
      {ASSIST_HOSTS.map((hostId) => <label key={hostId}><input type="radio" name="designer-host" value={hostId} checked={state.hostId === hostId}
        onChange={() => { dispatch({ type: "pick_host", hostId }); }} /> {hostLabel(capabilities, hostId)}</label>)}
      <button type="button" disabled={state.busy !== null || state.hostId === null} onClick={onWrite}>Write the bug specification</button>
    </fieldset>}
    {shape !== null && spec !== null && state.hostId !== null && <SpecCard state={state} capabilities={capabilities} closedHosts={closedHosts} applyBlocked={applyBlocked} onUsePlan={onUsePlan} dispatch={dispatch} />}
    <p className="factory-note">{otfEnabled ? OTF_DESIGNER_NOTE : CATALOG_HONESTY}</p>
  </section>;
}

let planCounter = 0;

function SpecCard({ state, capabilities, closedHosts = [], applyBlocked, onUsePlan, dispatch }: Pick<BugDesignerViewProps, "state" | "capabilities" | "closedHosts" | "applyBlocked" | "onUsePlan" | "dispatch">) {
  const result = currentSpec(state);
  const shape = state.shapes?.shapes.find((item) => item.id === state.shapeId);
  const hostId = state.hostId;
  if (result === null || shape === undefined || hostId === null) return null;
  const { spec, model } = result;
  const preview = planFromShape(shape, hostId, capabilities, 0);
  const key = specKey(shape.id, hostId);
  const fallback = hostId === "task-report" ? null : calendarFallback(capabilities);
  return <article className="designer-card designer-spec" aria-labelledby="designer-spec-title">
    <p className="factory-badge">Design, not a built bug</p>
    <h3 id="designer-spec-title">{spec.title}</h3>
    <dl>
      <dt>Target application</dt><dd>{spec.target_app}</dd>
      <dt>Where</dt><dd>{spec.where}</dd>
      <dt>What changes</dt><dd>{spec.change}</dd>
      <dt>Why the existing tests miss it</dt><dd>{spec.why_tests_miss}</dd>
      <dt>Checks that would catch it</dt><dd>{spec.checks_to_add.length === 0 ? "None listed." : <ul>{spec.checks_to_add.map((check) => <li key={check}>{check}</li>)}</ul>}</dd>
      <dt>The fix</dt><dd>{spec.fix}</dd>
    </dl>
    <p className="factory-note">Written by <code>{model.model_id}</code> on <time dateTime={model.at}>{formatDateTime(model.at)}</time>.</p>
    {closedHosts.includes(hostId)
      ? <p className="factory-badge">{CALENDAR_HINT}{fallback !== null && <> {fallback}</>}</p>
      : preview === null
      ? <p>No proven bug on {hostLabel(capabilities, hostId)} can fill the request form yet.</p>
      : <>
        <p>“Use this plan” fills the request form below with {hostLabel(capabilities, preview.host_id)}, {bugTypeLabel(capabilities, preview.bug_type_id)}
          {preview.exact ? <>, described as “{preview.description}”</> : <>: the closest proven bug on this application</>}. Nothing starts until you review and start it.</p>
        {applyBlocked !== null && <p className="factory-note">{applyBlocked}</p>}
        <button type="button" className="factory-button" disabled={applyBlocked !== null} onClick={() => {
          planCounter += 1;
          const plan = planFromShape(shape, hostId, capabilities, planCounter);
          if (plan === null) return;
          dispatch({ type: "applied", appliedFor: key });
          onUsePlan(plan);
        }}>Use this plan</button>
        <p role="status" aria-live="polite">{state.appliedFor !== key ? "" : preview.exact
          ? "The request form below now holds this plan. Review it there."
          : `The request form below now starts from ${hostLabel(capabilities, preview.host_id)}, ${bugTypeLabel(capabilities, preview.bug_type_id)}: the closest proven bug on this application. Your design's own text is not copied, and the design itself is not built. Review it there.`}</p>
      </>}
  </article>;
}
