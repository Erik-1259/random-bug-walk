// The release's release.json and the files its record lists, prerendered as static files at the
// paths they have in the results repository (releases/<release_id>/<path>). Nothing else exists.
import { loadSiteConfig } from "../../../../src/config.ts";
import { loadResults, readReleaseFile, releaseFiles } from "../../../../src/release.ts";

export const dynamic = "force-static";
export const dynamicParams = false;

interface Params {
  release: string;
  path: string[];
}

export async function generateStaticParams(): Promise<Params[]> {
  const { results } = await loadResults(loadSiteConfig().resultsDir);
  return releaseFiles(results).map((file) => ({ release: file.release, path: file.path.split("/") }));
}

export async function GET(_request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { release, path } = await context.params;
  const file = await readReleaseFile(loadSiteConfig().resultsDir, release, path.join("/"));
  if (file === null) return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(Buffer.from(file.bytes), { status: 200, headers: { "content-type": file.mediaType } });
}
