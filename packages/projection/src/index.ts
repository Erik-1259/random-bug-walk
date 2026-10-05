export { audit, isProse, type AuditOutcome, type AuditPaths, type Verdict } from "./audit.ts";
export { addedLines, applyPatch, parseDiff, type FilePatch, type Hunk, type PatchLine } from "./diff.ts";
export { checkHistory, type AuditedFile, type CommitSummary, type Finding } from "./history.ts";
export { InputError, canonicalJson, isRepoPath } from "./input.ts";
export { buildManifest, manifestBytes, parseManifest, type FileMode, type Manifest, type ManifestFile } from "./manifest.ts";
export { parseMutation, type MutatedFile } from "./mutation.ts";
export { BRANCH, commitNeutral } from "./neutral.ts";
export {
  DEFAULT_NEUTRAL_COMMIT,
  EXCLUSION_CATEGORIES,
  expandExclusions,
  parsePolicy,
  policyBytes,
  type DependencyLink,
  type Exclusion,
  type ExclusionCategory,
  type NeutralCommit,
  type Policy,
} from "./policy.ts";
export { runCli, USAGE, type Io } from "./run.ts";
export { compileTerm, matchSpans, parseTerms, textHasTerm, type Span, type Term, type TermList } from "./terms.ts";
