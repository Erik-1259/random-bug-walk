// The searches a live harvest runs, in order, loaded from `queries.json` so the list can be tuned
// without code changes. Commit search matches commit messages; issue search with `is:pr` finds
// merged pull requests. Neither searches diffs, so each query names the date API a time-zone fix
// touches, and the candidate rule checks the diff later. `api` labels a query in the funnel.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const querySchema = z.object({
  kind: z.enum(["commits", "pulls"]),
  api: z.string().min(1),
  q: z.string().min(1),
});

const queryFileSchema = z.object({ queries: z.array(querySchema).min(1) });

export type Query = z.infer<typeof querySchema>;

export const QUERY_FILE = fileURLToPath(new URL("../queries.json", import.meta.url));

export class QueryFileError extends Error {
  override name = "QueryFileError";
}

export function parseQueries(text: string): Query[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new QueryFileError("the query file is not JSON", { cause: error });
  }
  const parsed = queryFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new QueryFileError("the query file does not list queries as { kind, api, q }", { cause: parsed.error });
  }
  return parsed.data.queries;
}

export const QUERIES: readonly Query[] = parseQueries(readFileSync(QUERY_FILE, "utf8"));

export const PER_PAGE = 30;

export function searchUrl(query: Pick<Query, "kind" | "q">): string {
  const endpoint = query.kind === "commits" ? "commits" : "issues";
  return `/search/${endpoint}?${new URLSearchParams({ q: query.q, per_page: String(PER_PAGE), page: "1" }).toString()}`;
}
