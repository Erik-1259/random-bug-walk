/** UI-only display data for local previews, not a request or response contract.
 * A future adapter must map the published contract to allowed presentation metadata.
 * No request, download or validation service is connected here.
 */
export interface FactoryProgressSnapshot {
  source: "development-preview";
  outcomeLabel: string;
  summary: string;
  requested: number;
  delivered: number;
  missing: number;
  candidatesExplored: number;
  checksCompleted: number;
  budgetLabel: string;
  events: readonly string[];
  rejections: readonly string[];
  cases: readonly {
    id: string;
    title: string;
    hostLabel: string;
    bugCaseReadiness: string;
    validatorReadiness: string;
    validationLabel: string;
  }[];
}

export function FactoryProgress({ snapshot }: { snapshot: FactoryProgressSnapshot | null }) {
  return (
    <section className="factory-panel" aria-labelledby="factory-progress">
      <h2 id="factory-progress">Request progress and results</h2>
      {snapshot === null ? (
        <p role="status">No live request is connected. Progress and results will appear here after live integration is available.</p>
      ) : (
        <>
          <p><strong>Development preview — not a live request or published result</strong></p>
          <div className="factory-status" role="status" aria-live="polite" aria-atomic="true">
            <h3>{snapshot.outcomeLabel}</h3>
            <p>{snapshot.summary}</p>
          </div>
          <dl className="factory-metrics">
            <dt>Requested</dt><dd>{snapshot.requested}</dd>
            <dt>Delivered</dt><dd>{snapshot.delivered}</dd>
            <dt>Missing</dt><dd>{snapshot.missing}</dd>
            <dt>Candidates explored</dt><dd>{snapshot.candidatesExplored}</dd>
            <dt>Checks completed</dt><dd>{snapshot.checksCompleted}</dd>
            <dt>Shared budget</dt><dd>{snapshot.budgetLabel}</dd>
          </dl>
          <h3>Recorded events in this preview</h3>
          {snapshot.events.length === 0 ? <p>No events in this preview.</p> : (
            <ol className="factory-events">{snapshot.events.map((event, index) => <li key={index}>{event}</li>)}</ol>
          )}
          <h3>Rejection reasons</h3>
          <p>Retries, rejected candidates and incomplete cases are not delivered bugs.</p>
          {snapshot.rejections.length === 0 ? <p>No rejections in this preview.</p> : (
            <ul>{snapshot.rejections.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
          )}
          <h3>Completed cases in this preview</h3>
          <p>Completed qualified cases remain available even when the requested quantity is unmet. Qualification is determined by the backend, not this display.</p>
          <p id="factory-services-unavailable">Preview only: downloads and validation are unavailable. No replay service is connected; no validation has been started here.</p>
          {snapshot.cases.length === 0 ? <p>No completed cases in this preview.</p> : (
            <ul>{snapshot.cases.map((item) => (
              <li className="factory-case-card" key={item.id}>
                <h4>{item.title}</h4>
                <p>{item.hostLabel}</p>
                <p>Bug-case package: {item.bugCaseReadiness}</p>
                <button type="button" disabled aria-describedby="factory-services-unavailable">Download bug case</button>
                <p>Validator package: {item.validatorReadiness}</p>
                <button type="button" disabled aria-describedby="factory-services-unavailable">Download validator package</button>
                <p>Validation: {item.validationLabel}</p>
                <button type="button" disabled aria-describedby="factory-services-unavailable">Validate case</button>
              </li>
            ))}</ul>
          )}
        </>
      )}
    </section>
  );
}
