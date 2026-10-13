// A published run's file index: its summary and every manifest entry, with links to the files the
// site serves at /runs/<root>/<path>. The case page links here instead of listing the files.
import { RUN_KIND_TEXT, runStatusText } from "../model.ts";
import { RunSummary } from "./run-summary.tsx";
import type { Results, Run } from "../release.ts";
import { RunFiles } from "./catalog.tsx";

function runLabel(results: Results, run: Run): string {
  const released = results.release?.record;
  if (released?.run.root_execution_id === run.rootExecutionId) return `Validated release ${released.release_id}`;
  if (run.kind === "judge_replay" || run.kind === "paired_comparison") return `${RUN_KIND_TEXT[run.kind]}, not a factory run`;
  return "Diagnostic archive, not validated";
}

export function RunIndex({ results, run }: { results: Results; run: Run }) {
  return (
    <main>
      <h1>Files of run {run.rootExecutionId}</h1>
      <p className="label">{runLabel(results, run)}</p>
      <p>
        {RUN_KIND_TEXT[run.kind]}, {runStatusText(run).outcome.toLowerCase()}. <a href="/">Back to the case</a>
      </p>
      <RunSummary run={run} index={false} />
      <RunFiles run={run} />
    </main>
  );
}
