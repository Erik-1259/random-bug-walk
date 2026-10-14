// A released case's own page, prerendered for each release: the case page with that release and its
// run as the case. / keeps showing the first released case, so links shared before more releases
// were added still show it.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CasePage } from "../../../src/components/case-page.tsx";
import { judgeEnabled, loadJudgeConfig, loadSiteConfig } from "../../../src/config.ts";
import { caseView, loadResults } from "../../../src/release.ts";

export const dynamic = "force-static";
export const dynamicParams = false;

interface Params {
  release: string;
}

export async function generateStaticParams(): Promise<Params[]> {
  const { results } = await loadResults(loadSiteConfig().resultsDir);
  return results.releases.map((item) => ({ release: item.release.record.release_id }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { release } = await params;
  return { title: `Case of release ${release}: Random Bug Walk results` };
}

export default async function ReleasedCasePage({ params }: { params: Promise<Params> }) {
  const { release } = await params;
  const { results } = await loadResults(loadSiteConfig().resultsDir);
  const view = caseView(results, release);
  if (view === null) notFound();
  return <CasePage results={view} judgeEnabled={judgeEnabled(loadJudgeConfig(), release)} />;
}
