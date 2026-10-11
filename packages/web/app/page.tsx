import { CasePage } from "../src/components/case-page.tsx";
import { judgeEnabled, loadJudgeConfig, loadSiteConfig } from "../src/config.ts";
import { loadResults } from "../src/release.ts";

export const dynamic = "force-static";

export default async function Page() {
  const { results } = await loadResults(loadSiteConfig().resultsDir);
  return <CasePage results={results} judgeEnabled={judgeEnabled(loadJudgeConfig(), results.release?.record.release_id ?? null)} />;
}
