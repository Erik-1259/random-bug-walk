// The home page: the case page of the one release (or of the case chosen without one). With several
// releases it lists them all and shows the first released case, which this page showed while it
// was the only one; each case also has its own page at /cases/<release_id>.
import { CasePage } from "../src/components/case-page.tsx";
import { judgeEnabled, loadJudgeConfig, loadSiteConfig } from "../src/config.ts";
import { loadResults } from "../src/release.ts";

export const dynamic = "force-static";

export default async function Page() {
  const { results } = await loadResults(loadSiteConfig().resultsDir);
  return <CasePage results={results} home judgeEnabled={judgeEnabled(loadJudgeConfig(), results.release?.record.release_id ?? null)} />;
}
