import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { addedLines, applyPatch } from "./diff.ts";
import { checkHistory, type AuditedFile, type CommitSummary, type Finding } from "./history.ts";
import { InputError, compareUtf8, sha256Hex } from "./input.ts";
import { manifestBytes, parseManifest, type Manifest, type ManifestFile } from "./manifest.ts";
import { parseMutation, type MutatedFile } from "./mutation.ts";
import { expandExclusions, parsePolicy, policyBytes, type Policy } from "./policy.ts";
import { matchSpans, parseTerms, textHasTerm, type Term, type TermList } from "./terms.ts";
import { walkCopy, type CopyEntry } from "./walk.ts";

export interface AuditPaths {
  manifest: string;
  policy: string;
  mutation: string;
  terms: string;
  copy: string;
  report: string;
}

export type Verdict = "pass" | "refused" | "unavailable";

export interface AuditOutcome {
  verdict: Verdict;
  exitCode: 0 | 1 | 2;
  /** The report to write, or null when it must not be written (its path is inside the copy). */
  report: Record<string, unknown> | null;
  /** Output lines: the verdict, then each finding and review entry by location only. */
  lines: string[];
}

// ADM-01: build output and caches that a copy must not inherit; a manifest path is never one.
const ARTIFACT_DIRECTORIES = new Set([".next", ".turbo", ".swc", ".cache"]);

function isArtifactFile(name: string): boolean {
  return name.endsWith(".map") || name.endsWith(".tsbuildinfo") || name === ".eslintcache";
}

/** Shipped prose: README, CONTRIBUTING, CHANGELOG and HISTORY files anywhere, root-level Markdown, and everything under docs/. */
export function isProse(path: string): boolean {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  if (/^(readme|contributing|changelog|history)/i.test(name)) return true;
  if (segments.length === 1 && /\.(md|mdx|markdown)$/i.test(name)) return true;
  return segments.length > 1 && segments[0] === "docs";
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path));
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Whether `path` (which may not exist yet) resolves inside the copy, lexically or through symlinks. */
function resolvesInside(path: string, copy: string, copyReal: string | null): boolean {
  if (isInside(resolve(path), resolve(copy))) return true;
  if (copyReal === null) return false;
  const real = realOrNull(path) ?? (() => {
    const parent = realOrNull(dirname(resolve(path)));
    return parent === null ? null : resolve(parent, basename(path));
  })();
  return real !== null && isInside(real, copyReal);
}

function unavailable(error: string, writeReport = true): AuditOutcome {
  return {
    verdict: "unavailable",
    exitCode: 2,
    report: writeReport ? { error, exit_code: 2, verdict: "unavailable" } : null,
    lines: [`verdict=unavailable error=${error}`],
  };
}

function readInput(path: string, code: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new InputError(code);
  }
}

interface Inputs {
  manifest: Manifest;
  pinned: Map<string, ManifestFile>;
  policy: Policy;
  excluded: Map<string, string>;
  mutation: Map<string, MutatedFile>;
  terms: TermList;
  termsSha: string;
}

function loadInputs(paths: AuditPaths, copyReal: string): Inputs {
  // ADM-07: the term list comes from the host at run time; an unusable list is never a pass.
  const termBytes = readInput(paths.terms, "terms_unavailable");
  const terms = parseTerms(termBytes);
  if (terms.strict.length === 0) throw new InputError("terms_unavailable");
  const manifest = parseManifest(readInput(paths.manifest, "malformed_manifest").toString("utf8"));
  const policy = parsePolicy(readInput(paths.policy, "malformed_policy").toString("utf8"));
  const excluded = expandExclusions(policy, manifest);
  for (const link of policy.dependency_links) {
    const rootReal = realOrNull(link.root);
    if (isInside(link.root, copyReal) || (rootReal !== null && isInside(rootReal, copyReal))) throw new InputError("malformed_policy");
    if (manifest.files.some((file) => file.path === link.path || file.path.startsWith(`${link.path}/`))) throw new InputError("malformed_policy");
  }
  const mutation = parseMutation(readInput(paths.mutation, "malformed_mutation").toString("utf8"), manifest, excluded);
  const pinned = new Map(manifest.files.map((file) => [file.path, file]));
  return { manifest, pinned, policy, excluded, mutation, terms, termsSha: sha256Hex(termBytes) };
}

class Collector {
  readonly findings = new Map<string, Finding>();
  readonly review = new Map<string, { path: string; line: number }>();

  add(reason: string, path: string, line: number | null = null): void {
    this.findings.set(`${reason}\0${path}\0${String(line)}`, { reason, path, line });
  }

  addReview(path: string, line: number): void {
    this.review.set(`${path}\0${String(line)}`, { path, line });
  }
}

/**
 * Splits a path into runs of segments: each redacted run is the shortest run of whole segments,
 * ending where a strict term is first complete, that holds the term (a term may contain "/").
 */
function redactionRuns(path: string, strict: readonly Term[]): { text: string; redact: boolean }[] {
  const segments = path.split("/");
  const runs: { text: string; redact: boolean }[] = [];
  let start = 0;
  for (let end = 0; end < segments.length; end += 1) {
    if (!textHasTerm(segments.slice(start, end + 1).join("/"), strict)) continue;
    let from = end;
    while (!textHasTerm(segments.slice(from, end + 1).join("/"), strict)) from -= 1;
    for (const segment of segments.slice(start, from)) runs.push({ text: segment, redact: false });
    runs.push({ text: segments.slice(from, end + 1).join("/"), redact: true });
    start = end + 1;
  }
  for (const segment of segments.slice(start)) runs.push({ text: segment, redact: false });
  return runs;
}

/** ADM-07: replaces every run of path segments that holds a strict term with a numbered placeholder. */
function redactor(paths: Iterable<string>, strict: readonly Term[]): (path: string) => string {
  const hits = new Set<string>();
  for (const path of paths) for (const run of redactionRuns(path, strict)) if (run.redact) hits.add(run.text);
  const names = new Map([...hits].sort(compareUtf8).map((text, index) => [text, `[redacted-${String(index + 1)}]`]));
  return (path) =>
    redactionRuns(path, strict)
      .map((run) => (run.redact ? (names.get(run.text) ?? "[redacted]") : run.text))
      .join("/");
}

function formatLocation(path: string, line: number | null): string {
  const shown = /^[\x21-\x7e]+$/.test(path) && !/["\\]/.test(path) ? path : JSON.stringify(path);
  return line === null ? shown : `${shown}:${String(line)}`;
}

function checkSymlink(entry: CopyEntry, policy: Policy, copyReal: string, collect: Collector): void {
  const link = policy.dependency_links.find((candidate) => candidate.path === entry.path);
  const target = realOrNull(entry.absolute);
  if (link !== undefined) {
    // ADM-01: a declared dependency link is not entered, and must resolve inside its root.
    const root = realOrNull(link.root);
    if (target === null || root === null || !isInside(target, root)) collect.add("symlink", entry.path);
    return;
  }
  collect.add("symlink", entry.path);
  let escapes: boolean;
  if (target !== null) {
    escapes = !isInside(target, copyReal);
  } else {
    let raw: string;
    try {
      raw = readlinkSync(entry.absolute);
    } catch {
      raw = "";
    }
    escapes = !isInside(resolve(dirname(entry.absolute), raw), copyReal);
  }
  if (escapes) collect.add("path_traversal", entry.path);
}

function checkFile(entry: CopyEntry, bytes: Buffer, executable: boolean, inputs: Inputs, artifactRoot: boolean, collect: Collector): void {
  const { pinned: manifest, excluded, mutation } = inputs;
  for (const span of matchSpans(bytes, inputs.terms.strict)) collect.add("strict_term", entry.path, span.start);
  if (entry.unsafeName) return;
  if (excluded.has(entry.path)) {
    collect.add("excluded_present", entry.path);
    return;
  }
  const pinned = manifest.get(entry.path);
  if (pinned === undefined) {
    if (artifactRoot) return;
    const segments = entry.path.split("/");
    if (segments.slice(0, -1).some((segment) => ARTIFACT_DIRECTORIES.has(segment)) || isArtifactFile(entry.name)) {
      collect.add("inherited_build_artifact", entry.path);
    } else {
      collect.add("unlisted_file", entry.path);
    }
    return;
  }
  if (executable !== (pinned.mode === "100755")) collect.add("mode_changed", entry.path);
  const mutated = mutation.get(entry.path);
  const actual = sha256Hex(bytes);
  if (mutated === undefined) {
    if (actual !== pinned.sha256) collect.add("changed_bytes", entry.path);
    return;
  }
  // ADM-01: the copy holds the declared result, and reversing the diff on it gives the pinned
  // bytes, so applying the diff to the pinned bytes gives exactly the declared result.
  const reversed = actual === mutated.result_sha256 ? applyPatch(bytes, mutated.patch, "reverse") : null;
  if (reversed === null || sha256Hex(reversed) !== mutated.original_sha256) collect.add("mutation_mismatch", entry.path);
  // ADM-07: a generic term in an added line is listed for review and does not fail the audit.
  const added = new Set(addedLines(mutated.patch));
  for (const span of matchSpans(bytes, inputs.terms.generic)) {
    for (let line = span.start; line <= span.end; line += 1) if (added.has(line)) collect.addReview(entry.path, line);
  }
}

/**
 * ADM-01 and ADM-07: audits a finished copy against the pinned manifest, the policy, the
 * declared mutation and the host's term list, and reports every finding by location only.
 */
export function audit(paths: AuditPaths): AuditOutcome {
  const copyReal = realOrNull(paths.copy);
  if (resolvesInside(paths.report, paths.copy, copyReal)) return unavailable("report_inside_copy", false);
  if (copyReal === null || !lstatSync(copyReal).isDirectory()) return unavailable("copy_unreadable");
  if (resolvesInside(paths.terms, paths.copy, copyReal)) return unavailable("terms_inside_copy");

  let inputs: Inputs;
  try {
    inputs = loadInputs(paths, copyReal);
  } catch (error) {
    if (error instanceof InputError) return unavailable(error.code);
    throw error;
  }

  const collect = new Collector();
  const audited = new Map<string, AuditedFile>();
  const prose: string[] = [];
  const pinnedDirectories = new Set<string>();
  for (const file of inputs.manifest.files) {
    const segments = file.path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) pinnedDirectories.add(segments.slice(0, depth).join("/"));
  }
  const artifactRoots: string[] = [];
  let entries: CopyEntry[];
  try {
    entries = walkCopy(copyReal);
  } catch {
    return unavailable("copy_unreadable");
  }
  for (const entry of entries) {
    // ADM-07: strict terms fail in any path segment, including terms that span segments; reported once, where first complete.
    const parent = entry.path.slice(0, Math.max(0, entry.path.length - entry.name.length - 1));
    if (textHasTerm(entry.path, inputs.terms.strict) && !textHasTerm(parent, inputs.terms.strict)) collect.add("strict_term", entry.path);
    // ADM-01: names that could escape or confuse a path are refused.
    if (entry.unsafeName) collect.add("path_traversal", entry.path);
    const underArtifact = artifactRoots.some((root) => entry.path.startsWith(`${root}/`));
    if (entry.kind === "directory") {
      if (ARTIFACT_DIRECTORIES.has(entry.name) && !pinnedDirectories.has(entry.path) && !underArtifact) {
        collect.add("inherited_build_artifact", entry.path);
        artifactRoots.push(entry.path);
      }
    } else if (entry.kind === "symlink") {
      checkSymlink(entry, inputs.policy, copyReal, collect);
    } else if (entry.kind === "special") {
      collect.add("special_file", entry.path);
    } else if (!entry.undecodable) {
      let bytes: Buffer;
      let executable: boolean;
      try {
        bytes = readFileSync(entry.absolute);
        executable = (lstatSync(entry.absolute).mode & 0o100) !== 0;
      } catch {
        return unavailable("copy_unreadable");
      }
      audited.set(entry.path, { mode: executable ? "100755" : "100644", bytes });
      if (isProse(entry.path)) prose.push(entry.path);
      checkFile(entry, bytes, executable, inputs, underArtifact, collect);
    }
  }
  for (const file of inputs.manifest.files) {
    if (!inputs.excluded.has(file.path) && !audited.has(file.path)) collect.add("missing_file", file.path);
  }
  const history = checkHistory(copyReal, audited, inputs.policy.neutral_commit, inputs.terms.strict);
  for (const finding of history.findings) collect.add(finding.reason, finding.path, finding.line);

  return buildOutcome(inputs, collect, prose, history.summary);
}

function buildOutcome(inputs: Inputs, collect: Collector, prose: string[], summary: CommitSummary | null): AuditOutcome {
  const findings = [...collect.findings.values()];
  const review = [...collect.review.values()];
  const redact = redactor(
    [...findings.map((finding) => finding.path), ...review.map((entry) => entry.path), ...inputs.excluded.keys(), ...prose],
    inputs.terms.strict,
  );
  const shownFindings = findings
    .map((finding) => ({ line: finding.line, path: redact(finding.path), reason: finding.reason }))
    .sort((a, b) => compareUtf8(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || compareUtf8(a.reason, b.reason));
  const shownReview = review
    .map((entry) => ({ path: redact(entry.path), line: entry.line }))
    .sort((a, b) => compareUtf8(a.path, b.path) || a.line - b.line);
  const refused = shownFindings.length > 0;
  const verdict: Verdict = refused ? "refused" : "pass";
  const exitCode = refused ? 1 : 0;
  const report = {
    counts: {
      excluded: inputs.excluded.size,
      included: inputs.manifest.files.length - inputs.excluded.size,
      mutated: inputs.mutation.size,
    },
    exclusions: [...inputs.excluded]
      .map(([path, category]) => ({ category, path: redact(path) }))
      .sort((a, b) => compareUtf8(a.path, b.path)),
    exit_code: exitCode,
    findings: shownFindings,
    git: summary,
    manifest_sha256: sha256Hex(manifestBytes(inputs.manifest)),
    policy_sha256: sha256Hex(policyBytes(inputs.policy)),
    prose_files: prose.map(redact).sort(compareUtf8),
    review: shownReview.map((entry) => formatLocation(entry.path, entry.line)),
    terms_sha256: inputs.termsSha,
    verdict,
  };
  const lines = [
    `verdict=${verdict}`,
    ...shownFindings.map((finding) => `${finding.reason} ${formatLocation(finding.path, finding.line)}`),
    ...shownReview.map((entry) => `review ${formatLocation(entry.path, entry.line)}`),
  ];
  return { verdict, exitCode, report, lines };
}
