// A published run's file index, prerendered for each run with a manifest. Its files stay at
// /runs/<root>/<path> (the route beside this page).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RunIndex } from "../../../src/components/run-index.tsx";
import { loadSiteConfig } from "../../../src/config.ts";
import { loadResults } from "../../../src/release.ts";

export const dynamic = "force-static";
export const dynamicParams = false;

interface Params {
  root: string;
}

export async function generateStaticParams(): Promise<Params[]> {
  const { results } = await loadResults(loadSiteConfig().resultsDir);
  return results.runs.filter((run) => run.manifest !== null).map((run) => ({ root: run.rootExecutionId }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { root } = await params;
  return { title: `Files of run ${root}: Random Bug Walk results` };
}

export default async function RunIndexPage({ params }: { params: Promise<Params> }) {
  const { root } = await params;
  const { results } = await loadResults(loadSiteConfig().resultsDir);
  const run = results.runs.find((item) => item.rootExecutionId === root && item.manifest !== null);
  if (run === undefined) notFound();
  return <RunIndex results={results} run={run} />;
}
