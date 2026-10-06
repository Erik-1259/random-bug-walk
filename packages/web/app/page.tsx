import { CasePage } from "../src/components/case-page.tsx";
import { loadSiteConfig } from "../src/config.ts";
import { loadResults } from "../src/release.ts";

export const dynamic = "force-static";

export default async function Page() {
  return <CasePage results={(await loadResults(loadSiteConfig().resultsDir)).results} />;
}
