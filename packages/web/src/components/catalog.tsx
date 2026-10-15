// The diagnostic catalog: every run in the results directory with its recorded status, and each
// published run's manifest entries, including those that were not produced or were withheld.
import { entryOutcomeText, fileHref, releaseOfRun, RUN_KIND_TEXT, runStatusText } from "../model.ts";
import type { Results, Run } from "../release.ts";

/** A published run's manifest entries with their outcome, size and SHA-256; the catalog and the run's file index page show it. */
export function RunFiles({ run }: { run: Run }) {
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
          <td data-label="Outcome">Published</td>
          <td data-label="Size" />
          <td data-label="SHA-256" />
        </tr>
        {run.manifest.entries.map((entry) => (
          <tr key={entry.path}>
            <th scope="row">{entry.sha256 === null ? entry.path : <a href={fileHref(root, entry.path, entry.public_uri)}>{entry.path}</a>}</th>
            <td data-label="Outcome">{entryOutcomeText(entry)}</td>
            <td data-label="Size">{entry.size_bytes === null ? "" : `${String(entry.size_bytes)} bytes`}</td>
            <td data-label="SHA-256" className="hash">{entry.sha256 ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function releaseLabel(results: Results, root: string) {
  const released = releaseOfRun(results, root);
  return released === undefined ? null : <span className="label">{`Validated release ${released.release_id}`}</span>;
}

function releaseSentence(results: Results): string {
  const record = results.release?.record;
  const replays =
    (results.runs.some((run) => run.kind === "judge_replay") ? " Verification replays (judge) are not factory runs." : "") +
    (results.runs.some((run) => run.kind === "paired_comparison") ? " Paired comparisons are not factory runs." : "");
  if (record === undefined) return `None of them is a validated release.${replays}`;
  if (results.releases.length > 1) {
    const pairs = results.releases.map((item) => `run ${item.run.rootExecutionId} is validated release ${item.release.record.release_id}`);
    return `Of the factory runs, ${pairs.join("; ")}; the other factory runs are not validated.${replays}`;
  }
  return `Run ${record.run.root_execution_id} is validated release ${record.release_id}; the other factory runs are not validated.${replays}`;
}

export function Catalog({ results }: { results: Results }) {
  return (
    <main>
      <h1>Diagnostic catalog</h1>
      <p>{`Every run in the published records, with its recorded status. ${releaseSentence(results)}`}</p>
      <div className="table-scroll">
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
                    {releaseLabel(results, run.rootExecutionId)}
                  </th>
                  <td>{RUN_KIND_TEXT[run.kind]}</td>
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
      </div>
      {results.runs.map((run) => (
        <section key={run.rootExecutionId} id={`run-${run.rootExecutionId}`}>
          <h2>{run.rootExecutionId}</h2>
          <RunFiles run={run} />
        </section>
      ))}
    </main>
  );
}
