// The diagnostic catalog: every run in the results directory with its recorded status, and each
// published run's manifest entries, including those that were not produced or were withheld.
import { ENTRY_OUTCOME_TEXT, fileHref, runStatusText } from "../model.ts";
import type { Results, Run } from "../release.ts";

function RunFiles({ run }: { run: Run }) {
  if (run.manifest === null) return <p>No files: the run has not been published.</p>;
  const root = run.rootExecutionId;
  return (
    <table className="files">
      <thead>
        <tr>
          <th scope="col">Path</th>
          <th scope="col">Outcome</th>
          <th scope="col">Size</th>
          <th scope="col">SHA-256</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">
            <a href={fileHref(root, "manifest.json", null)}>manifest.json</a>
          </th>
          <td>Published</td>
          <td />
          <td />
        </tr>
        {run.manifest.entries.map((entry) => (
          <tr key={entry.path}>
            <th scope="row">{entry.sha256 === null ? entry.path : <a href={fileHref(root, entry.path, entry.public_uri)}>{entry.path}</a>}</th>
            <td>
              {ENTRY_OUTCOME_TEXT[entry.outcome]}
              {entry.reason === null ? "" : ` (${entry.reason})`}
            </td>
            <td>{entry.size_bytes === null ? "" : `${String(entry.size_bytes)} bytes`}</td>
            <td className="hash">{entry.sha256 ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function releaseSentence(results: Results): string {
  const record = results.release?.record;
  if (record === undefined) return "None of them is a validated release.";
  return `Run ${record.run.root_execution_id} is validated release ${record.release_id}; the others are not validated.`;
}

export function Catalog({ results }: { results: Results }) {
  const released = results.release?.record;
  return (
    <main>
      <h1>Diagnostic catalog</h1>
      <p>{`Every run in the published records, with its recorded status. ${releaseSentence(results)}`}</p>
      <table className="runs">
        <thead>
          <tr>
            <th scope="col">Root execution</th>
            <th scope="col">Kind</th>
            <th scope="col">Status</th>
            <th scope="col">Outcome</th>
            <th scope="col">Publication</th>
            <th scope="col">Stages</th>
            <th scope="col">Child executions</th>
          </tr>
        </thead>
        <tbody>
          {results.runs.map((run) => {
            const text = runStatusText(run);
            return (
              <tr key={run.rootExecutionId}>
                <th scope="row">
                  <a href={`#run-${run.rootExecutionId}`}>{run.rootExecutionId}</a>
                  {released?.run.root_execution_id === run.rootExecutionId ? <span className="label">{`Validated release ${released.release_id}`}</span> : null}
                </th>
                <td>{run.kind}</td>
                <td>{text.status}</td>
                <td>{text.outcome}</td>
                <td>{text.publication}</td>
                <td>{String(run.declaredStageCount)}</td>
                <td>{String(run.childExecutionCount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {results.runs.map((run) => (
        <section key={run.rootExecutionId} id={`run-${run.rootExecutionId}`}>
          <h2>{run.rootExecutionId}</h2>
          <RunFiles run={run} />
        </section>
      ))}
    </main>
  );
}
