import type { Metadata } from "next";
import { Catalog } from "../../src/components/catalog.tsx";
import { loadSiteConfig } from "../../src/config.ts";
import { loadResults } from "../../src/release.ts";

export const dynamic = "force-static";
export const metadata: Metadata = { title: "Diagnostic catalog: Random Bug Walk results" };

export default async function CatalogPage() {
  return <Catalog results={(await loadResults(loadSiteConfig().resultsDir)).results} />;
}
