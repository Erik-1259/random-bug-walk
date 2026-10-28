import type { Metadata } from "next";
import { FactoryExample } from "../../src/components/factory-example.tsx";
import { FactoryWorkspace } from "../../src/components/factory-workspace.tsx";
import { RELEASED_TIME_ZONE_CASE } from "../../src/components/historical-replays.tsx";
import { loadSiteConfig } from "../../src/config.ts";
import { loadResults } from "../../src/release.ts";
import "./factory.css";

export const dynamic = "force-static";
export const metadata: Metadata = {
  title: "Request synthetic bug cases · Random Bug Walk",
  description: "Explore a completed synthetic bug example and request cases when the service is configured.",
};

export default async function FactoryPage() {
  const { results } = await loadResults(loadSiteConfig().resultsDir);
  return (
    <main className="factory">
      <div className="factory-heading">
        <p className="factory-eyebrow">Random Bug Walk</p>
        <h1>Synthetic bugs. Useful test cases.</h1>
        <p>Request a bug that an application’s own tests miss. Each case comes with separate checks that prove the bug is there and that a fix removes it.</p>
        <ol className="factory-steps-intro">
          <li><strong>Describe</strong> the kind of bug you want, on one or both applications.</li>
          <li><strong>Review</strong> how the service reads your request. Reviewing is free.</li>
          <li><strong>Start</strong> the request. One runs at a time, paid from the shared judging budget, and the cases appear on this page as they are delivered.</li>
        </ol>
      </div>
      <FactoryExample availableLocally={results.releases.some(({ release }) => release.record.release_id === RELEASED_TIME_ZONE_CASE)} />
      <FactoryWorkspace />
      <details className="factory-panel factory-details" aria-labelledby="factory-qualification">
        <summary><h2 id="factory-qualification">What makes a case qualified?</h2></summary>
        <p>The service must confirm that unchanged original tests pass on clean, buggy and reference-fixed copies.
          Separate verification checks must pass on clean and fixed copies and detect the intended failure on the buggy copy.
          Setup failures and missing checks are not reproduction.</p>
        <p>A debugging package must exclude verification tests and the reference fix.
          Separate validator packages and validation actions become available only when the service reports them ready.
          Clicking a validation action alone does not establish that a replay ran.</p>
        <a href="/#cell-6">Read the completed experiment’s scope and limitations</a>
      </details>
    </main>
  );
}
