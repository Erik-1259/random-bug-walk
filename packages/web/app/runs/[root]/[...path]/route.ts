// A run's published repository files and its manifest, prerendered as static files at the same
// paths they have in the results repository (runs/<root>/<path>). Only manifest-listed files exist.
import { loadSiteConfig } from "../../../../src/config.ts";
import { loadResults, publishedFiles, readPublishedFile } from "../../../../src/release.ts";

export const dynamic = "force-static";
export const dynamicParams = false;

interface Params {
  root: string;
  path: string[];
}

export async function generateStaticParams(): Promise<Params[]> {
  const { results } = await loadResults(loadSiteConfig().resultsDir);
  return publishedFiles(results).map((file) => ({ root: file.root, path: file.path.split("/") }));
}

export async function GET(_request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { root, path } = await context.params;
  const file = await readPublishedFile(loadSiteConfig().resultsDir, root, path.join("/"));
  if (file === null) return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(Buffer.from(file.bytes), { status: 200, headers: { "content-type": file.mediaType } });
}
