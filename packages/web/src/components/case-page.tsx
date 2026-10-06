// The one case page. Its six cells keep a fixed order: symptom, counts, suite matrix, replay,
// provenance and downloads, funnel and limitations.
import type { ReactNode } from "react";
import type { ObservedSymptom } from "@rbw/schema";
import {
  COLUMN_LABEL,
  COMPARISON_TEXT,
  countExamples,
  diagnosticArchives,
  fileHref,
  funnel,
  MATRIX_COLUMNS,
  MATRIX_ROWS,
  NO_VALIDATED_RESULT,
  NOT_IN_RECORDS,
  originalSuiteSize,
  REPLAY_STATE,
  REPLAY_STATE_TEXT,
  ROW_LABEL,
  runStatusText,
  suiteMatrix,
  VERDICT_TEXT,
} from "../model.ts";
import type { AdmissionRecords, Results, Run } from "../release.ts";

function Cell({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <section className="cell" data-cell={String(index)} aria-labelledby={`cell-${String(index)}`}>
      <h2 id={`cell-${String(index)}`}>
        {String(index)}. {title}
      </h2>
      {children}
    </section>
  );
}

function Symptom({ symptom }: { symptom: ObservedSymptom | null }) {
  if (symptom === null) return <p>No published run holds an observed symptom yet.</p>;
  const examples = countExamples(symptom);
  const differing = examples.filter((example) => example.differs).length;
  return (
    <>
      <p className="label">Development evidence, not validated</p>
      <p>
        Synthetic task: the bug in this case was planted on purpose in a copy of Umami, an open-source web analytics app. It is not a real Umami bug.
      </p>
      <p>{symptom.user_action}</p>
      <p>
        Observed counts differ from the expected local-day counts in {String(differing)} of {String(examples.length)} time zones.
      </p>
    </>
  );
}

function Counts({ symptom }: { symptom: ObservedSymptom | null }) {
  if (symptom === null) return <p>No counts to show.</p>;
  return (
    <>
      <p>{symptom.fixture_description}</p>
      <p>
        Request: <code>{`${symptom.request.method} ${symptom.request.path}`}</code> (HTTP {String(symptom.http_status)})
      </p>
      {countExamples(symptom).map((example) => (
        <table key={example.timezone} className="counts">
          <caption>{example.timezone}</caption>
          <thead>
            <tr>
              <th scope="col">Day bucket</th>
              <th scope="col">Expected</th>
              <th scope="col">Observed</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {example.rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.expected === null ? "none" : String(row.expected)}</td>
                <td>{row.observed === null ? "none" : String(row.observed)}</td>
                <td className={row.matches ? "status status-pass" : "status status-fail"}>{row.matches ? "Matches" : "Differs"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      <details>
        <summary>Source timestamps ({String(symptom.events.length)} pageviews)</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">UTC instant</th>
              <th scope="col">Unix seconds</th>
            </tr>
          </thead>
          <tbody>
            {symptom.events.map((event) => (
              <tr key={event.label}>
                <th scope="row">{event.label}</th>
                <td>{event.utc_instant}</td>
                <td>{String(event.timestamp_seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

function Matrix({ admission }: { admission: AdmissionRecords | null }) {
  const cells = suiteMatrix(admission);
  const size = originalSuiteSize(admission);
  const decision = admission?.decision ?? null;
  return (
    <>
      <p>
        Original Umami API suite{size === null ? "" : ` (${String(size)} tests measured)`}: the upstream API tests that were run in each copy. Other upstream tests were not evaluated.
      </p>
      <table className="matrix">
        <thead>
          <tr>
            <td />
            {MATRIX_COLUMNS.map((column) => (
              <th key={column} scope="col">
                {COLUMN_LABEL[column]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MATRIX_ROWS.map((row) => (
            <tr key={row}>
              <th scope="row">{ROW_LABEL[row]}</th>
              {cells
                .filter((cell) => cell.row === row)
                .map((cell) => (
                  <td key={cell.column} data-row={cell.row} data-column={cell.column}>
                    <span className="cell-label">
                      {ROW_LABEL[cell.row]}, {COLUMN_LABEL[cell.column]}
                    </span>
                    <span className={`status status-${cell.status}`}>{cell.statusText}</span>
                    {cell.detail === null ? null : <span className="detail">{cell.detail}</span>}
                  </td>
                ))}
            </tr>
          ))}
        </tbody>
      </table>
      {decision === null ? (
        <p>This run published no admission decision.</p>
      ) : (
        <ul>
          <li>Comparison (ADM-08): {decision.comparison === null ? "none" : COMPARISON_TEXT[decision.comparison.classification]}</li>
          <li>Admission verdict (ADM-02 to ADM-06): {decision.outcome_verdict === null ? "none" : VERDICT_TEXT[decision.outcome_verdict]}</li>
        </ul>
      )}
    </>
  );
}

function Replay() {
  return (
    <>
      <button type="button" disabled aria-describedby="replay-status">
        Run verified replay
      </button>
      <p id="replay-status">
        Replay status: {REPLAY_STATE_TEXT[REPLAY_STATE.state]}. {REPLAY_STATE.reason}
      </p>
      <p>The page above is complete without a replay.</p>
    </>
  );
}

function FileList({ run }: { run: Run }) {
  if (run.manifest === null) return null;
  const root = run.rootExecutionId;
  return (
    <ul>
      <li>
        <a href={fileHref(root, "manifest.json", null)}>manifest.json</a>
      </li>
      {run.manifest.entries
        .filter((entry) => entry.outcome === "published" || entry.outcome === "truncated")
        .map((entry) => (
          <li key={entry.path}>
            <a href={fileHref(root, entry.path, entry.public_uri)}>{entry.path}</a>
          </li>
        ))}
    </ul>
  );
}

function Provenance({ results }: { results: Results }) {
  const run = results.caseRun;
  const archives = run === null ? diagnosticArchives(results) : [run];
  return (
    <>
      {run === null ? null : (
        <dl>
          <dt>Run</dt>
          <dd>
            {run.rootExecutionId} ({run.kind}, {runStatusText(run).outcome.toLowerCase()})
          </dd>
          <dt>Project policy SHA-256</dt>
          <dd>{run.manifest?.project_policy_sha256 ?? NOT_IN_RECORDS}</dd>
          <dt>Task revision</dt>
          <dd>{run.admission?.evidence.request.task_revision ?? NOT_IN_RECORDS}</dd>
          <dt>Kit version</dt>
          <dd>{NOT_IN_RECORDS}</dd>
          <dt>Release</dt>
          <dd>None. The release step (ADM-09) is planned.</dd>
          <dt>Calibration</dt>
          <dd>Not requested</dd>
        </dl>
      )}
      <p>Validated-task downloads: disabled, because there is no validated release.</p>
      <h3>Diagnostic archive (not validated)</h3>
      {archives.length === 0 ? <p>No run has been published.</p> : null}
      {archives.map((archive) => (
        <div key={archive.rootExecutionId}>
          <p>
            {archive.rootExecutionId} {runStatusText(archive).outcome.toLowerCase()}, not validated
          </p>
          <FileList run={archive} />
        </div>
      ))}
    </>
  );
}

function FunnelAndLimitations({ results }: { results: Results }) {
  return (
    <>
      <table className="funnel">
        <caption>Batch funnel, counted from the published records</caption>
        <tbody>
          {funnel(results).map((step) => (
            <tr key={step.label}>
              <th scope="row">{step.label}</th>
              <td>{String(step.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Limitations</h3>
      <ul>
        <li>The planted bug is synthetic. It was introduced on purpose and is not a real Umami bug.</li>
        <li>Only the original Umami API suite was measured. Other upstream tests were not evaluated.</li>
        <li>Calibration: not requested. No solve counts are reported.</li>
        <li>The card, issue and leak checks (ADM-07) and releases (ADM-09) are planned, so no result here is validated.</li>
        <li>Verified replay is not built yet.</li>
        <li>This is a hackathon prototype.</li>
      </ul>
      <h3>Method</h3>
      <p>
        A candidate is admitted using 13 fresh app copies: 1 clean, 5 fixed, 5 planted, 1 partial-fix and 1 stub-fix. The original API suite runs once in each copy, and the added checks
        run in each, 20 times in the first fixed and the first planted copy. The six cells above come from the first clean, planted and fixed copies. A blind spot is shown only when the
        original suite passes in all 13 copies while the added checks pass on clean and fixed copies and fail as declared on planted and probe copies.
      </p>
    </>
  );
}

export function CasePage({ results }: { results: Results }) {
  const run = results.caseRun;
  return (
    <main>
      <h1>Random Bug Walk results</h1>
      <p className="headline">{NO_VALIDATED_RESULT}</p>
      <Cell index={1} title="Symptom">
        <Symptom symptom={run?.symptom ?? null} />
      </Cell>
      <Cell index={2} title="Expected and observed local-day counts">
        <Counts symptom={run?.symptom ?? null} />
      </Cell>
      <Cell index={3} title="Original API suite and added checks on clean, planted and fixed copies">
        <Matrix admission={run?.admission ?? null} />
      </Cell>
      <Cell index={4} title="Verified replay">
        <Replay />
      </Cell>
      <Cell index={5} title="Provenance and downloads">
        <Provenance results={results} />
      </Cell>
      <Cell index={6} title="Batch funnel and limitations">
        <FunnelAndLimitations results={results} />
      </Cell>
    </main>
  );
}
