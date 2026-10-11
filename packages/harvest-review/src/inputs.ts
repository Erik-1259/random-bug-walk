// The review inputs: for each harvested candidate that matched the source rule, one rule match and
// the code a model needs to judge it, rebuilt from the run directory's funnel and frozen responses
// with no network. Both frozen blobs are parsed again to find the after-side function around the
// call, every parent-side function at the same nesting path, and the patch hunks that touch them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import { candidateRule, enclosingFunctions, FUNCTION_KINDS, functionLabel, functionPath, replayTransport, schemas, urls } from "@rbw/harvest";
import type { Transport } from "@rbw/harvest";
import { z } from "zod";

const FunctionTextSchema = z.strictObject({
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  /** The function's whole lines, each prefixed with its line number. */
  text: z.string(),
});
export type FunctionText = z.infer<typeof FunctionTextSchema>;

const CandidateInputSchema = z.strictObject({
  candidate_id: z.string().min(1),
  repo: z.string().min(1),
  commit: z.string().min(1),
  path: z.string().min(1),
  /** The parent's path of a renamed file; null when the path did not change. */
  previous_path: z.string().min(1).nullable(),
  line: z.number().int().positive(),
  call: z.string().min(1),
  function: z.string().min(1),
  /** `confirmed`, or the reason the harvest dropped the match. */
  ast_grep: z.string().min(1),
  after: FunctionTextSchema,
  before: z.array(FunctionTextSchema),
  hunks: z.array(z.string()),
});
export type CandidateInput = z.infer<typeof CandidateInputSchema>;

const ReviewInputsSchema = z.strictObject({
  format_version: z.literal(1),
  candidates: z.array(CandidateInputSchema),
});
export type ReviewInputs = z.infer<typeof ReviewInputsSchema>;

/** Validates a review-inputs file's content. Throws on any problem. */
export function parseReviewInputs(value: unknown): ReviewInputs {
  const parsed = ReviewInputsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`the review inputs do not match the format: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** One rule match with both versions of its file and the file's patch. */
export interface CandidateSource {
  candidate_id: string;
  repo: string;
  commit: string;
  path: string;
  previous_path: string | null;
  before: string;
  after: string;
  patch: string;
  line: number;
  call: string;
  ast_grep: string;
}

/** Whole lines `start`..`end` (1-based) of `source`, each prefixed with its number. */
function numbered(source: string, start: number, end: number): FunctionText {
  const lines = source.split("\n").slice(start - 1, end);
  const width = String(end).length;
  const text = lines.map((line, index) => `${String(start + index).padStart(width)} | ${line}`).join("\n");
  return { start_line: start, end_line: end, text };
}

/** The whole file, without the empty line after a final newline. */
function wholeFile(source: string): FunctionText {
  const lines = source.split("\n");
  const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  return numbered(source, 1, Math.max(end, 1));
}

function functionText(source: string, fn: SgNode): FunctionText {
  const { start, end } = fn.range();
  return numbered(source, start.line + 1, end.line + 1);
}

interface Hunk {
  readonly text: string;
  readonly old: readonly [number, number] | null;
  readonly new: readonly [number, number] | null;
}

/** A hunk side's covered lines; null for an empty side, such as the old side of a pure addition. */
function span(start: string | undefined, count: string | undefined): readonly [number, number] | null {
  const lines = count === undefined ? 1 : Number(count);
  return lines === 0 ? null : [Number(start), Number(start) + lines - 1];
}

function hunks(patch: string): Hunk[] {
  const found: Hunk[] = [];
  let current: { header: RegExpExecArray; lines: string[] } | null = null;
  const close = (): void => {
    if (current !== null) {
      const [, oldStart, oldCount, newStart, newCount] = current.header;
      found.push({ text: current.lines.join("\n"), old: span(oldStart, oldCount), new: span(newStart, newCount) });
    }
  };
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null) {
      close();
      current = { header, lines: [line] };
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  close();
  return found;
}

function overlaps(side: readonly [number, number] | null, fn: FunctionText): boolean {
  return side !== null && side[0] <= fn.end_line && fn.start_line <= side[1];
}

/**
 * Every parent function whose full path (its enclosing functions and its own label, as the harvest
 * builds it) is `path`; several when sibling callbacks or same-named methods share it.
 */
function beforeFunctions(language: Lang, source: string, path: string): FunctionText[] {
  if (path === "<module>") {
    return [wholeFile(source)];
  }
  return parse(language, source)
    .root()
    .findAll({ rule: { any: [...FUNCTION_KINDS].map((kind) => ({ kind })) } })
    .filter((fn) => [...enclosingFunctions(fn).reverse(), fn].map(functionLabel).join("/") === path)
    .map((fn) => functionText(source, fn));
}

/** Builds one candidate's review input from both versions of its file. Throws when the call is not found. */
export function buildCandidateInput(source: CandidateSource): CandidateInput {
  const language = Lang[candidateRule(source.path).language];
  const afterRoot = parse(language, source.after).root();
  const call = afterRoot
    .findAll({ rule: { kind: "call_expression" } })
    .find((node) => node.range().start.line + 1 === source.line && node.text() === source.call);
  if (call === undefined) {
    throw new Error(`${source.candidate_id}: no call ${source.call} starts on line ${String(source.line)} of ${source.path}`);
  }
  const path = functionPath(call);
  const [enclosing] = enclosingFunctions(call);
  const after = enclosing === undefined ? wholeFile(source.after) : functionText(source.after, enclosing);

  const before = source.ast_grep === "function_missing_before" ? [] : beforeFunctions(language, source.before, path);

  const selected = hunks(source.patch)
    .filter((hunk) => overlaps(hunk.new, after) || before.some((fn) => overlaps(hunk.old, fn)))
    .map((hunk) => hunk.text);
  return {
    candidate_id: source.candidate_id,
    repo: source.repo,
    commit: source.commit,
    path: source.path,
    previous_path: source.previous_path,
    line: source.line,
    call: source.call,
    function: path,
    ast_grep: source.ast_grep,
    after,
    before,
    hunks: selected,
  };
}

/** The match a candidate is reviewed on: its structurally confirmed match, otherwise its first. */
export function reviewedMatch<M extends { readonly outcome: { readonly status: string } }>(matches: readonly M[]): M | undefined {
  return matches.find((match) => match.outcome.status === "confirmed") ?? matches[0];
}

const REVIEWED_STAGES: ReadonlySet<string> = new Set(["source_rule_matched", "structurally_confirmed"]);

const FunnelSchema = z.object({
  candidates: z.array(
    z.object({
      id: z.string(),
      repo: z.string(),
      commit: z.string().nullable(),
      stage_reached: z.string(),
      matches: z.array(
        z.object({
          path: z.string(),
          line: z.number(),
          call: z.string(),
          callee: z.string(),
          function: z.string(),
          outcome: z.union([
            z.object({ status: z.literal("confirmed"), before_call: z.string(), before_line: z.number(), timezone: z.string() }),
            z.object({ status: z.literal("rejected"), reason: z.string(), detail: z.string() }),
          ]),
        }),
      ),
    }),
  ),
});

async function blob(transport: Transport, repo: string, path: string, ref: string): Promise<string> {
  const response = await transport.get(urls.content(repo, path, ref));
  const content = schemas.content.parse(response.body);
  if (response.status !== 200 || content.content === undefined) {
    throw new Error(`the frozen blob of ${path} at ${ref} has no content`);
  }
  return Buffer.from(content.content, "base64").toString("utf8");
}

/** The review inputs of a harvest run directory, from its funnel.json and frozen responses only. */
export async function buildInputs(runDir: string): Promise<ReviewInputs> {
  const funnel = FunnelSchema.parse(JSON.parse(readFileSync(join(runDir, "funnel.json"), "utf8")));
  const transport = replayTransport(runDir);
  const candidates: CandidateInput[] = [];
  for (const candidate of funnel.candidates.filter((entry) => REVIEWED_STAGES.has(entry.stage_reached))) {
    const match = reviewedMatch(candidate.matches);
    if (match === undefined || candidate.commit === null) {
      throw new Error(`${candidate.id} reached ${candidate.stage_reached} with no match or commit`);
    }
    const commit = schemas.commit.parse((await transport.get(urls.commit(candidate.repo, candidate.commit))).body);
    const file = commit.files.find((entry) => entry.filename === match.path);
    const [parent] = commit.parents;
    if (file === undefined || parent === undefined) {
      throw new Error(`${candidate.id}: the frozen commit lists no ${match.path} or no parent`);
    }
    const previous = file.previous_filename ?? null;
    candidates.push(
      buildCandidateInput({
        candidate_id: candidate.id,
        repo: candidate.repo,
        commit: candidate.commit,
        path: match.path,
        previous_path: previous,
        before: await blob(transport, candidate.repo, previous ?? match.path, parent.sha),
        after: await blob(transport, candidate.repo, match.path, commit.sha),
        patch: file.patch ?? "",
        line: match.line,
        call: match.call,
        ast_grep: match.outcome.status === "confirmed" ? "confirmed" : match.outcome.reason,
      }),
    );
  }
  return { format_version: 1, candidates };
}
