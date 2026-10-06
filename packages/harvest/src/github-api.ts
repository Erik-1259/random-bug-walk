// The GitHub REST responses the harvest reads, as strict-enough Zod schemas. Parsing strips every
// field not listed, so frozen bodies hold only what the funnel uses: no commit authors, no committer
// names or emails (only the commit time), no user records and no commit messages. Error bodies
// keep only GitHub's message.
import { z } from "zod";

const searchCommits = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z.array(
    z.object({
      sha: z.string(),
      repository: z.object({
        full_name: z.string(),
        fork: z.boolean().optional(),
        license: z.object({ spdx_id: z.string().nullable() }).nullable().optional(),
      }),
    }),
  ),
});

const searchIssues = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z.array(z.object({ number: z.number(), repository_url: z.string(), pull_request: z.object({}).optional() })),
});

const repository = z.object({
  full_name: z.string(),
  fork: z.boolean(),
  license: z.object({ spdx_id: z.string().nullable() }).nullable(),
});

const licence = z.object({ license: z.object({ spdx_id: z.string().nullable() }).nullable() });

const pull = z.object({ number: z.number(), merged: z.boolean(), merge_commit_sha: z.string().nullable() });

const commitFile = z.object({
  filename: z.string(),
  status: z.string(),
  sha: z.string().nullable(),
  patch: z.string().optional(),
  previous_filename: z.string().optional(),
});

const commit = z.object({
  sha: z.string(),
  commit: z.object({ committer: z.object({ date: z.string() }).nullable() }),
  parents: z.array(z.object({ sha: z.string() })),
  files: z.array(commitFile).default([]),
});

const content = z.object({
  type: z.string(),
  path: z.string(),
  sha: z.string(),
  size: z.number(),
  encoding: z.string().optional(),
  content: z.string().optional(),
});

const errorBody = z.object({ message: z.string().nullable().default(null) }).catch({ message: null });

export type SearchCommits = z.infer<typeof searchCommits>;
export type SearchIssues = z.infer<typeof searchIssues>;
export type Repository = z.infer<typeof repository>;
export type Licence = z.infer<typeof licence>;
export type Pull = z.infer<typeof pull>;
export type Commit = z.infer<typeof commit>;
export type CommitFile = z.infer<typeof commitFile>;
export type Content = z.infer<typeof content>;

const ROUTES = [
  { pattern: /^\/search\/commits\?/, schema: searchCommits },
  { pattern: /^\/search\/issues\?/, schema: searchIssues },
  { pattern: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/, schema: pull },
  { pattern: /^\/repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]+$/, schema: commit },
  { pattern: /^\/repos\/[^/]+\/[^/]+\/contents\/[^?]+\?ref=[0-9a-f]+$/, schema: content },
  { pattern: /^\/repos\/[^/]+\/[^/]+\/license$/, schema: licence },
  { pattern: /^\/repos\/[^/]+\/[^/]+$/, schema: repository },
] as const;

export class MalformedResponse extends Error {
  override name = "MalformedResponse";
}

/** The part of a response body that is frozen and read back: the route's fields on 200, else the message. */
export function projectBody(url: string, status: number, body: unknown): unknown {
  if (status !== 200) {
    return errorBody.parse(body);
  }
  const route = ROUTES.find((candidate) => candidate.pattern.test(url));
  if (route === undefined) {
    throw new MalformedResponse(`no response schema for ${url}`);
  }
  const parsed = route.schema.safeParse(body);
  if (!parsed.success) {
    throw new MalformedResponse(`the response for ${url} does not have the documented shape`, { cause: parsed.error });
  }
  return parsed.data;
}

export const schemas = { searchCommits, searchIssues, repository, licence, pull, commit, content } as const;

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export const urls = {
  repository: (repo: string) => `/repos/${repo}`,
  licence: (repo: string) => `/repos/${repo}/license`,
  pull: (repo: string, number: number) => `/repos/${repo}/pulls/${String(number)}`,
  commit: (repo: string, sha: string) => `/repos/${repo}/commits/${sha}`,
  content: (repo: string, path: string, ref: string) => `/repos/${repo}/contents/${encodePath(path)}?ref=${ref}`,
} as const;
