// A presentation snapshot of the frozen release's published evidence, not a live replay count.
export const RELEASED_TIME_ZONE_CASE = "319f3100-9ecf-441d-b7af-a643af9ae4e5";
const SNAPSHOT = "https://github.com/Erik-1259/random-bug-walk-results/blob/d79fc64123c8a95171c229b1062e3ac3f903936d";
const RECORDS = [
  "9a403b66-4b4e-5327-895b-e893e42acdab/results/bd289812-7a3c-5885-93b0-cace2e5c799a",
  "dd28e4f2-4de9-5215-a50e-2a627a7e0e74/results/5b6e5c93-c88c-5f38-818f-3377ff816fbc",
  "dd8a971d-6ee1-5b6b-bf68-da9cb21648f1/results/0132a5c0-615b-52f3-814b-3fefba7f52f3",
];

export function HistoricalReplays({ releaseId }: { releaseId: string | null }) {
  return (
    <section aria-labelledby="recorded-replays">
      <h3 id="recorded-replays">Previously published replay evidence</h3>
      {releaseId !== RELEASED_TIME_ZONE_CASE ? <p>No historical summary is provided for this case. Published runs remain in the <a href="/catalog">diagnostic catalog</a>.</p> : (
        <>
          <p>At the linked results snapshot, three published replays of <a href={`${SNAPSHOT}/releases/${RELEASED_TIME_ZONE_CASE}/release.json`}>this frozen release</a> each recorded all six comparison cells matching expectations.
            The planted copy’s added checks failed as expected; the original API suite passed on all three copies, and the added checks passed on clean and fixed copies.</p>
          <p>These historical records do not establish execution on the latest deployment. “Completed” alone does not establish reproduction.
            Their public decision fields (comparison, decisions and outcome_verdict) are null; the summary is supported by the recorded cells, not a published verdict.</p>
          <ul>
            {RECORDS.map((path, index) => (
              <li key={path}>Recorded replay {String(index + 1)}: <a href={`${SNAPSHOT}/runs/${path}/evidence.json`}>six comparison cells</a> and <a href={`${SNAPSHOT}/runs/${path}/decision.json`}>public decision fields</a>.</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
