// Known upstream lines: exact lines of a host's pinned upstream source that the publication scan flags
// although they are public upstream text. The prepare scan hook (`prepare-scan-hook.ts`) drops a finding
// at one of these lines only when the part, the member path, the line number and the SHA-256 of the
// line's text all match an entry; every other finding still blocks. Adding an entry is a public-safety
// exception: it is committed and reviewed like any other change, and it changes nothing for pushes,
// pull request text or CI.

/** One exempted line: a 1-based line of a member of a prepared part, pinned by the hash of its text. */
export interface KnownUpstreamLine {
  /** The prepared part name, as `case-package prepare` hands it to the hook. */
  readonly part: string;
  /** An anchored expression over the member path. */
  readonly path: RegExp;
  /** The 1-based line number. */
  readonly line: number;
  /** SHA-256, 64 lowercase hex, of the line's UTF-8 bytes without the line break. */
  readonly sha256: string;
  /** Why the line is upstream text and which check flags it. */
  readonly reason: string;
}

export const KNOWN_UPSTREAM_LINES: readonly KnownUpstreamLine[] = Object.freeze([
  Object.freeze({
    part: "bug_case",
    path: /^source\/src\/app\/api\/(?:[^/]+\/)+contract\.generated\.ts$/,
    line: 1,
    sha256: "177bdbd43301fb7810ee495d5c80630f5c843cf4ac9c19b359cf29185f5cbaba",
    reason: "Umami's generated API contract header, which the attribution check reads as a credit line.",
  }),
  Object.freeze({
    part: "bug_case",
    path: /^source\/docker-compose\.test\.yml$/,
    line: 36,
    sha256: "45cc5ae1f0d0cbe9c7f68edf29b7942cd5c9ec54cc3ca4c927544cb52d780e3b",
    reason: "Umami's public test-only encryption key in its test compose file, flagged by gitleaks' generic-key rule.",
  }),
]);
