// One line per published run instead of its full file list: the file count and total size, the
// manifest and report, and a link to the run's file index page.
import { fileHref } from "../model.ts";
import { formatBytes, runFileSummary, runIndexHref } from "../files.ts";
import type { Run } from "../release.ts";

/** `index`: whether to link the run's file index page (the index page itself does not). */
export function RunSummary({ run, index = true }: { run: Run; index?: boolean }) {
  const summary = runFileSummary(run);
  if (summary === null) return null;
  const root = run.rootExecutionId;
  return (
    <p className="run-summary" data-run-summary={root}>
      {String(summary.count)} published {summary.count === 1 ? "file" : "files"}, {formatBytes(summary.bytes)} in all, plus the manifest:{" "}
      <a href={fileHref(root, "manifest.json", null)}>manifest.json</a>
      {summary.reportHref === null ? null : (
        <>
          {", "}
          <a href={summary.reportHref}>report.md</a>
        </>
      )}
      {index ? (
        <>
          {", "}
          <a href={runIndexHref(root)}>every file of this run</a>
        </>
      ) : null}
      .
    </p>
  );
}
