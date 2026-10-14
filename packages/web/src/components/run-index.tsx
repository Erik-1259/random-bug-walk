// A published run's file index: its summary and every manifest entry, with links to the files the
// site serves at /runs/<root>/<path>. The case page links here instead of listing the files.
import { caseHref, releaseOfRun, RUN_KIND_TEXT, runStatusText } from "../model.ts";
import { RunSummary } from "./run-summary.tsx";
import type { Results, Run } from "../release.ts";
import { RunFiles } from "./catalog.tsx";

function runLabel(results: Results, run: Run): string {
  const released = releaseOfRun(results, run.rootExecutionId);
  if (released !== undefined) return `Validated release ${released.release_id}`;
  if (run.kind === "judge_replay" || run.kind === "paired_comparison") return `${RUN_KIND_TEXT[run.kind]}, not a factory run`;
  return "Diagnostic archive, not validated";
}

/** The case this run belongs to: its release's page when the site has several releases, otherwise /. */
function backHref(results: Results, run: Run): string {
  if (results.releases.length <= 1) return "/";
  const releaseId = releaseOfRun(results, run.rootExecutionId)?.release_id ?? (run.kind === "judge_replay" ? run.replayReleaseId : null);
  return releaseId !== null && results.releases.some((item) => item.release.record.release_id === releaseId) ? caseHref(releaseId) : "/";
}

export function RunIndex({ results, run }: { results: Results; run: Run }) {
  return (
    <main>
      <h1>Files of run {run.rootExecutionId}</h1>
      <p className="label">{runLabel(results, run)}</p>
      <p>
        {RUN_KIND_TEXT[run.kind]}, {runStatusText(run).outcome.toLowerCase()}. <a href={backHref(results, run)}>Back to the case</a>
      </p>
      <RunSummary run={run} index={false} />
      <RunFiles run={run} />
    </main>
  );
}
