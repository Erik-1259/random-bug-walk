import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureHelperRepository, readRemoteBranch, runGh, type Decision, type OperationContext } from "./operation.ts";
import type { ProcessResult } from "./run.ts";
import { scan } from "./scan.ts";

interface SelectedPullRequest {
  number: number;
  title: string;
  body: string;
}

class GhUnavailable extends Error {}

/** Equal apart from line endings and surrounding whitespace, which GitHub may trim. */
function sameText(a: string, b: string): boolean {
  return a.replace(/\r\n?/g, "\n").trim() === b.replace(/\r\n?/g, "\n").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(result: ProcessResult): unknown {
  if (result.code !== 0) throw new GhUnavailable();
  try {
    return JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new GhUnavailable();
  }
}

/** Open PRs from the registered branch in the registered repository; fork PRs never count. */
async function selectedPullRequests(context: OperationContext, repository: string): Promise<SelectedPullRequest[]> {
  const owner = repository.split("/")[0]?.toLowerCase();
  const listed = parseJson(
    await runGh(context, [
      "pr", "list", "--repo", repository, "--head", context.entry.branch, "--state", "open", "--json",
      "number,title,body,isCrossRepository,headRepositoryOwner",
    ]),
  );
  if (!Array.isArray(listed)) throw new GhUnavailable();
  const selected: SelectedPullRequest[] = [];
  for (const item of listed as unknown[]) {
    if (!isRecord(item) || typeof item.number !== "number" || typeof item.title !== "string" || typeof item.body !== "string") {
      throw new GhUnavailable();
    }
    const headOwner = isRecord(item.headRepositoryOwner) ? item.headRepositoryOwner.login : undefined;
    if (item.isCrossRepository === false && typeof headOwner === "string" && headOwner.toLowerCase() === owner) {
      selected.push({ number: item.number, title: item.title, body: item.body });
    }
  }
  return selected;
}

/** The PR number when the stored text is already published, otherwise null. */
async function findPublished(context: OperationContext, repository: string): Promise<number | null> {
  const { request } = context;
  const selected = await selectedPullRequests(context, repository);
  if (request.operation === "pr-create") {
    const match = selected.find((pr) => sameText(pr.title, request.title ?? "") && sameText(pr.body, request.body ?? ""));
    return match?.number ?? null;
  }
  const [only, ...others] = selected;
  if (only === undefined || others.length > 0) return null;
  const viewed = parseJson(await runGh(context, ["pr", "view", String(only.number), "--repo", repository, "--json", "comments"]));
  if (!isRecord(viewed) || !Array.isArray(viewed.comments)) throw new GhUnavailable();
  const posted = (viewed.comments as unknown[]).some(
    (comment) => isRecord(comment) && typeof comment.body === "string" && sameText(comment.body, request.body ?? ""),
  );
  return posted ? only.number : null;
}

async function findPublishedOrPending(context: OperationContext, repository: string): Promise<number | null | "pending"> {
  try {
    return await findPublished(context, repository);
  } catch (error) {
    if (error instanceof GhUnavailable) return "pending";
    throw error;
  }
}

function pullRequestNumber(output: Buffer): number | undefined {
  const match = /\/pull\/(\d+)/.exec(output.toString("utf8"));
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** Creates a draft PR or posts a comment with exactly the scanned bytes. */
export async function publishPullRequest(context: OperationContext): Promise<Decision> {
  try {
    return await publishPullRequestChecked(context);
  } catch (error) {
    if (error instanceof GhUnavailable) return { outcome: "unavailable", category: "gh-failed" };
    throw error;
  } finally {
    await context.state.clearTemporary(context.request.requestId);
  }
}

async function publishPullRequestChecked(context: OperationContext): Promise<Decision> {
  const { request, entry, state, config } = context;
  const repository = entry.repository;
  const attempted = await state.hasAttempt(request.requestId);
  if (repository === undefined) return { outcome: attempted ? "pending" : "unavailable", category: "no-repository" };

  if (attempted) {
    const existing = await findPublishedOrPending(context, repository);
    if (existing === "pending") return { outcome: "pending", category: "resume-check-failed" };
    if (existing !== null) return { outcome: "published", category: "found-after-restart", pullRequest: existing };
  }

  const helperRepository = await ensureHelperRepository(context);
  if (helperRepository === null) return { outcome: "unavailable", category: "helper-repository" };
  const head = await readRemoteBranch(context, helperRepository);
  if (head === undefined) return { outcome: "unavailable", category: "remote-read" };
  if (head !== request.sha) return { outcome: "stale", category: "remote-head-differs" };

  // Freeze the stored text into helper-owned files; these exact bytes are scanned and sent.
  const dir = state.temporary(request.requestId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { mode: 0o700 });
  const bodyPath = join(dir, "body");
  await writeFile(bodyPath, request.body ?? "", { flag: "wx", mode: 0o600 });
  const body = await readFile(bodyPath);
  const texts = [{ name: request.operation === "pr-create" ? "pr-body" : "pr-comment", content: body }];
  let title: string | undefined;
  if (request.operation === "pr-create") {
    const titlePath = join(dir, "title");
    await writeFile(titlePath, request.title ?? "", { flag: "wx", mode: 0o600 });
    const titleBytes = await readFile(titlePath);
    // ignoreBOM keeps a leading U+FEFF, so the argument holds exactly the scanned bytes.
    title = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(titleBytes);
    texts.unshift({ name: "pr-title", content: titleBytes });
  }

  // PUB-02: the PR text is scanned exactly as it will be sent.
  const result = await scan({
    patternFile: config.patternFile,
    gitleaksCommand: config.gitleaksCommand,
    gitTimeoutMs: config.timeouts.git,
    gitleaksTimeoutMs: config.timeouts.gitleaks,
    repository,
    texts,
  });
  if (result.outcome === "unavailable") return { outcome: "unavailable", category: "scan-unavailable" };
  if (result.outcome === "blocked") return { outcome: "blocked", category: "content", locations: result.locations };

  const selected = await selectedPullRequests(context, repository);
  let posted: ProcessResult;
  let target: number | undefined;
  if (request.operation === "pr-create") {
    if (selected.length > 0) return { outcome: "blocked", category: "pull-request-exists" };
    await state.markAttempt(request.requestId);
    posted = await runGh(context, [
      "pr", "create", "--repo", repository, "--draft", "--base", "main", "--head", entry.branch,
      `--title=${title ?? ""}`, "--body-file", bodyPath,
    ]);
  } else {
    const [only, ...others] = selected;
    if (only === undefined) return { outcome: "blocked", category: "no-pull-request" };
    if (others.length > 0) return { outcome: "unavailable", category: "ambiguous-pull-request" };
    target = only.number;
    await state.markAttempt(request.requestId);
    posted = await runGh(context, ["pr", "comment", String(only.number), "--repo", repository, "--body-file", bodyPath]);
  }
  if (posted.code === 0) {
    return { outcome: "published", category: "posted", pullRequest: target ?? pullRequestNumber(posted.stdout) };
  }
  // The post may have gone through; never answer unavailable unless the check shows it did not.
  const existing = await findPublishedOrPending(context, repository);
  if (existing === "pending") return { outcome: "pending", category: "resume-check-failed" };
  if (existing !== null) return { outcome: "published", category: "posted-with-error", pullRequest: existing };
  return { outcome: "unavailable", category: "gh-failed" };
}
