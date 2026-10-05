// Source confirmation for DT-1.tz-arg: in the upstream fix commit, pair the one date-range call in
// the same component before and after the fix, and show that the fix added the timezone argument
// bound from the timezone hook. Anything else is `unsupported_source_match`.
import type { SgNode } from "@ast-grep/napi";
import { structuredPatch } from "diff";
import { bindingSites, destructuringDeclarator, enclosingFunction, fieldOf, functionName, kindOf, lineOf } from "./bindings.ts";
import { decodeUtf8, gitBlobSha1, sha256Hex } from "./hash.ts";
import { loadRules, matchAll, requireRule, type LoadedRule } from "./rules.ts";
import { DT1_SOURCE, FIDELITY, SHAPE_ID, SOURCE_RULE_ID, type BlobSpec, type SourceSpec } from "./shape.ts";

export interface SourceChange {
  /** Git's name-status letter, with the similarity score for renames and copies (for example `R097`). */
  readonly status: string;
  readonly path: string;
  readonly oldPath?: string;
}

export interface SourceInput {
  readonly commit: string;
  /** The parent the caller pairs the commit with. */
  readonly parent: string;
  /** The commit's parents in git order, as read from the repository. */
  readonly parents: readonly string[];
  /** Every file the pairing changes. */
  readonly changes: readonly SourceChange[];
  readonly before?: Uint8Array;
  readonly after?: Uint8Array;
  readonly ruleBytes: Uint8Array;
}

interface SideRecord {
  readonly call: string;
  readonly git_blob: string;
  readonly line: number;
  readonly sha256: string;
}

export interface SourceRecord {
  readonly shape_id: string;
  readonly status: "confirmed";
  readonly fidelity: { readonly label: string; readonly tier: string };
  readonly rule_sha256: string;
  readonly source: {
    readonly commit: string;
    readonly parent: string;
    readonly path: string;
    readonly function: string;
    readonly callee: string;
    readonly added_argument: string;
    readonly hunk: string;
    readonly before: SideRecord;
    readonly after: SideRecord & { readonly binding: { readonly line: number; readonly text: string } };
  };
}

export type SourceOutcome =
  | { readonly status: "confirmed"; readonly record: SourceRecord }
  | { readonly status: "unsupported_source_match"; readonly reason: string; readonly detail: string };

class Unsupported extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

function argumentsOf(call: SgNode): SgNode[] {
  return fieldOf(call, "arguments")?.namedChildren().filter((node) => kindOf(node) !== "comment") ?? [];
}

function sideText(side: "before" | "after", bytes: Uint8Array | undefined, expected: BlobSpec): string {
  if (bytes === undefined) {
    throw new Unsupported("blob_missing", `the ${side} blob was not supplied`);
  }
  const sha = sha256Hex(bytes);
  const blob = gitBlobSha1(bytes);
  if (sha !== expected.sha256 || blob !== expected.gitBlob) {
    throw new Unsupported("blob_hash_mismatch", `the ${side} blob is ${blob} (sha256 ${sha}), expected ${expected.gitBlob}`);
  }
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    throw new Unsupported("blob_hash_mismatch", `the ${side} blob is not valid UTF-8`);
  }
  return text;
}

/** The function named in the spec and the one call to the callee inside it, on one side. */
function anchor(spec: SourceSpec, rule: LoadedRule, side: "before" | "after", text: string): { fn: SgNode; call: SgNode } {
  const { root, matches } = matchAll(rule, text);
  const functions = root.findAll({ rule: { kind: "function_declaration", has: { field: "name", regex: `^${spec.functionName}$` } } });
  const [fn] = functions;
  if (functions.length !== 1 || fn === undefined) {
    throw new Unsupported("function_missing", `${side}: expected one function ${spec.functionName}, found ${String(functions.length)}`);
  }
  const calls = matches.filter((node) => node.ancestors().some((ancestor) => ancestor.id() === fn.id()));
  const [call] = calls;
  if (calls.length !== 1 || call === undefined) {
    throw new Unsupported("call_count", `${side}: expected one ${spec.callee} call in ${spec.functionName}, found ${String(calls.length)}`);
  }
  return { fn, call };
}

/** Requires `const { <argument> } = <binder>();` as the only binding of the argument in the function. */
function binderDeclarator(spec: SourceSpec, fn: SgNode, call: SgNode): SgNode {
  const sites = bindingSites(fn, spec.argument);
  const declarator = sites.length === 1 && sites[0] !== undefined ? destructuringDeclarator(sites[0], spec.argument) : undefined;
  const value = fieldOf(declarator, "value");
  const callee = fieldOf(value, "function");
  if (
    declarator === undefined ||
    value === null ||
    kindOf(value) !== "call_expression" ||
    callee === null ||
    kindOf(callee) !== "identifier" ||
    callee.text() !== spec.binder ||
    argumentsOf(value).length !== 0
  ) {
    throw new Unsupported("binding_mismatch", `after: ${spec.argument} is not bound by const { ${spec.argument} } = ${spec.binder}()`);
  }
  if (enclosingFunction(declarator)?.id() !== fn.id() || declarator.range().end.index > call.range().start.index) {
    throw new Unsupported("binding_mismatch", `after: ${spec.argument} is not bound in ${spec.functionName} before the call`);
  }
  return declarator;
}

function pair(spec: SourceSpec, input: SourceInput): SourceRecord {
  const rule = requireRule(loadRules(input.ruleBytes), SOURCE_RULE_ID);
  if (input.commit !== spec.commit) {
    throw new Unsupported("unsupported_commit", `commit ${input.commit} is not a supported source commit`);
  }
  if (input.parent !== spec.parent || input.parents.length !== 1 || input.parents[0] !== input.parent) {
    throw new Unsupported("not_first_parent", `parent ${input.parent} is not the only parent of ${input.commit} in the supported pairing`);
  }
  if (input.changes.length !== 1) {
    throw new Unsupported("changed_files", `the pairing changes ${String(input.changes.length)} files, expected 1`);
  }
  const [change] = input.changes;
  if (change?.status !== "M" || change.oldPath !== undefined) {
    const kind = change?.status.startsWith("R") === true ? "rename" : "changed_files";
    throw new Unsupported(kind, `the changed file has status ${change?.status ?? "none"}, expected M`);
  }
  if (change.path !== spec.path) {
    throw new Unsupported("path_mismatch", `the changed file ${change.path} is not ${spec.path}`);
  }
  const before = sideText("before", input.before, spec.before);
  const after = sideText("after", input.after, spec.after);

  const old = anchor(spec, rule, "before", before);
  const fixed = anchor(spec, rule, "after", after);
  const binderCalls = old.fn.findAll({ rule: { pattern: `${spec.binder}($$$ARGS)` } });
  if (argumentsOf(old.call).length !== 0 || binderCalls.length !== 0) {
    throw new Unsupported("before_form", `before: expected ${spec.callee}() with no argument and no ${spec.binder} call`);
  }
  const [argument] = argumentsOf(fixed.call);
  const properties = argument !== undefined && kindOf(argument) === "object" ? argument.namedChildren() : [];
  const [property] = properties;
  if (
    argumentsOf(fixed.call).length !== 1 ||
    properties.length !== 1 ||
    property === undefined ||
    kindOf(property) !== "shorthand_property_identifier" ||
    property.text() !== spec.argument
  ) {
    throw new Unsupported("after_form", `after: expected ${spec.callee}({ ${spec.argument} })`);
  }
  const declarator = binderDeclarator(spec, fixed.fn, fixed.call);

  // The pairing must sit in the change itself: the hunk that holds the new call also removes the old one.
  const patch = structuredPatch(spec.path, spec.path, before, after, undefined, undefined, { context: 3 });
  const oldLine = lineOf(old.call);
  const newLine = lineOf(fixed.call);
  const hunk = patch.hunks.find((candidate) => {
    let oldAt = candidate.oldStart;
    let newAt = candidate.newStart;
    let removed = false;
    let added = false;
    for (const text of candidate.lines) {
      if (text.startsWith("-")) {
        removed ||= oldAt === oldLine;
        oldAt += 1;
      } else if (text.startsWith("+")) {
        added ||= newAt === newLine;
        newAt += 1;
      } else if (text.startsWith(" ")) {
        oldAt += 1;
        newAt += 1;
      }
    }
    return removed && added;
  });
  if (hunk === undefined) {
    throw new Unsupported("hunk_mismatch", "no changed hunk removes the old call and adds the new one");
  }

  return {
    shape_id: SHAPE_ID,
    status: "confirmed",
    fidelity: { ...FIDELITY },
    rule_sha256: sha256Hex(input.ruleBytes),
    source: {
      commit: spec.commit,
      parent: spec.parent,
      path: spec.path,
      function: `${spec.path}#${functionName(fixed.fn) ?? spec.functionName}`,
      callee: spec.callee,
      added_argument: spec.argument,
      hunk: `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`,
      before: { call: old.call.text(), git_blob: spec.before.gitBlob, line: oldLine, sha256: spec.before.sha256 },
      after: {
        binding: { line: lineOf(declarator), text: declarator.parent()?.text() ?? "" },
        call: fixed.call.text(),
        git_blob: spec.after.gitBlob,
        line: newLine,
        sha256: spec.after.sha256,
      },
    },
  };
}

export function confirmSourceWith(spec: SourceSpec, input: SourceInput): SourceOutcome {
  try {
    return { status: "confirmed", record: pair(spec, input) };
  } catch (error) {
    if (error instanceof Unsupported) {
      return { status: "unsupported_source_match", reason: error.reason, detail: error.message };
    }
    throw error;
  }
}

/** Confirms the DT-1.tz-arg source fix. The supported commit pairing comes from the package. */
export function confirmSource(input: SourceInput): SourceOutcome {
  return confirmSourceWith(DT1_SOURCE, input);
}
