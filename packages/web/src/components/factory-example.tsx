import { RELEASED_TIME_ZONE_CASE } from "./historical-replays.tsx";

const FROZEN = `https://github.com/Erik-1259/random-bug-walk-results/blob/d79fc64123c8a95171c229b1062e3ac3f903936d/releases/${RELEASED_TIME_ZONE_CASE}`;

/** The published example is independent of development previews and new requests. */
export function FactoryExample({ availableLocally }: { availableLocally: boolean }) {
  const caseHref = availableLocally ? `/cases/${RELEASED_TIME_ZONE_CASE}` : "https://random-bug-walk.vercel.app/";
  return (
    <section className="factory-panel factory-example" aria-labelledby="factory-example-title">
      <p className="factory-eyebrow">Completed example · published evidence</p>
      <h2 id="factory-example-title">A time-zone blind spot in Umami</h2>
      <p>A synthetic bug shifts daily pageview counts. The 271 measured original API tests still pass.
        All four separate checks pass on clean and reference-fixed copies; on the buggy copy, three non-UTC checks fail as expected while the UTC control passes.</p>
      <p>In Los Angeles, the expected counts are 3, 8, 1; the recorded API counts are 2, 8, 2.
        This demonstrates a test-suite blind spot, not debugging-agent performance.</p>
      <div className="factory-links">
        <a className="factory-link-primary" href={`${caseHref}#cell-2`}>Explore the completed example</a>
        <a href={`${caseHref}#cell-3`}>Compare original tests and added checks</a>
        <a href={`${FROZEN}/issue.json`}>Read the frozen bug report</a>
        <a href={`${FROZEN}/release.json`}>Release and provenance</a>
      </div>
      <p className="factory-note">Reading this example starts no replay. These are evidence links, not new bug-case or validator-package downloads.</p>
    </section>
  );
}
