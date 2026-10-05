// Target confirmation for DT-1.tz-arg: on the pinned file, select exactly one call with the rule,
// check where its timezone comes from and that the endpoint passes it through, then drop exactly
// the third argument with the rule's fix. Any failed check is `not_applicable`; it never permits
// choosing another site.
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { formatPatch, structuredPatch } from "diff";
import { bindingSites, destructuringDeclarator, enclosingFunction, fieldOf, functionName, kindOf, lineOf } from "./bindings.ts";
import { decodeUtf8, sha256Hex } from "./hash.ts";
import { fixMatches, loadRules, matchAll, requireRule } from "./rules.ts";
import { DT1_TARGET, FIDELITY, FIXED_RULE_ID, PLANTED_RULE_ID, SHAPE_ID, type TargetSpec } from "./shape.ts";

export interface TargetInput {
  /** Repository-relative path of the target file. */
  readonly path: string;
  /** Git file mode of the target file, such as `100644`. */
  readonly mode: string;
  readonly bytes: Uint8Array;
  readonly routeBytes: Uint8Array;
  readonly ruleBytes: Uint8Array;
}

export interface TargetRecord {
  readonly shape_id: string;
  readonly status: "confirmed";
  readonly fidelity: { readonly label: string; readonly tier: string };
  readonly rule_sha256: string;
  readonly target: {
    readonly path: string;
    readonly mode: string;
    readonly line: number;
    readonly original_sha256: string;
    readonly result_sha256: string;
    readonly diff: string;
    readonly function: string;
    readonly changed_calls: number;
    readonly original_call: string;
    readonly result_call: string;
    readonly host_commit: string;
  };
  readonly route: { readonly path: string; readonly sha256: string };
}

/** The declared mutation that the projection audit reads. */
export interface DeclaredMutation {
  readonly diff: string;
  readonly files: readonly {
    readonly mode: string;
    readonly original_sha256: string;
    readonly path: string;
    readonly result_sha256: string;
  }[];
  readonly host_commit: string;
}

export type TargetOutcome =
  | { readonly status: "confirmed"; readonly record: TargetRecord; readonly declaredMutation: DeclaredMutation; readonly result: string }
  | { readonly status: "not_applicable"; readonly reason: string; readonly detail: string };

function notApplicable(reason: string, detail: string): TargetOutcome {
  return { status: "not_applicable", reason, detail };
}

const PARAMETER_KINDS = new Set(["required_parameter", "optional_parameter"]);

/** Checks that `name` in the call is the local destructured from the function's filters parameter. */
function bindingProblem(spec: TargetSpec, fn: SgNode, call: SgNode, name: string): string | undefined {
  const { name: filters, index } = spec.filtersParam;
  const parameters = (fieldOf(fn, "parameters")?.namedChildren() ?? []).filter((node) => PARAMETER_KINDS.has(kindOf(node) ?? ""));
  const pattern = fieldOf(parameters[index], "pattern");
  if (pattern === null || kindOf(pattern) !== "identifier" || pattern.text() !== filters) {
    return `parameter ${String(index + 1)} of ${spec.functionName} is not ${filters}`;
  }
  const filterSites = bindingSites(fn, filters);
  if (filterSites.length !== 1 || filterSites[0]?.id() !== pattern.id()) {
    return `${filters} is bound or assigned more than once in ${spec.functionName}`;
  }
  const sites = bindingSites(fn, name);
  const [site] = sites;
  if (sites.length !== 1 || site === undefined) {
    return `expected one binding of ${name} in ${spec.functionName}, found ${String(sites.length)}`;
  }
  const declarator = destructuringDeclarator(site, name);
  const value = fieldOf(declarator, "value");
  if (declarator === undefined || value === null || kindOf(value) !== "identifier" || value.text() !== filters) {
    return `${name} is not destructured from ${filters} with a const declaration`;
  }
  if (declarator.range().end.index > call.range().start.index) {
    return `${name} is bound after the call`;
  }
  return undefined;
}

/** Checks that the route builds the filters and passes that same binding to the query. */
function endpointProblem(spec: TargetSpec, route: string): string | undefined {
  const root = parse(Lang.TypeScript, route).root();
  const filters = spec.filtersParam.name;
  const declarations = new Set(root.findAll({ rule: { pattern: spec.routeFiltersPattern } }).map((node) => node.id()));
  const calls = root.findAll({ rule: { pattern: spec.routeCallPattern } });
  if (calls.length === 0) {
    return `the route has no call ${spec.routeCallPattern}`;
  }
  const passes = calls.some((call) => {
    const fn = enclosingFunction(call);
    const sites = fn === undefined ? [] : bindingSites(fn, filters);
    const declaration = sites[0]?.parent()?.parent();
    return (
      sites.length === 1 &&
      declaration !== undefined &&
      declaration !== null &&
      declarations.has(declaration.id()) &&
      enclosingFunction(declaration)?.id() === fn?.id() &&
      declaration.range().end.index <= call.range().start.index
    );
  });
  return passes ? undefined : `the route does not pass the ${filters} built by ${spec.routeFiltersPattern} to ${spec.routeCallPattern}`;
}

export function confirmTargetWith(spec: TargetSpec, input: TargetInput): TargetOutcome {
  const rules = loadRules(input.ruleBytes);
  const fixedRule = requireRule(rules, FIXED_RULE_ID);
  const plantedRule = requireRule(rules, PLANTED_RULE_ID);

  if (input.path !== spec.path) {
    return notApplicable("path_mismatch", `target path ${input.path} is not ${spec.path}`);
  }
  if (input.mode !== spec.mode) {
    return notApplicable("mode_mismatch", `target mode ${input.mode} is not ${spec.mode}`);
  }
  const originalSha = sha256Hex(input.bytes);
  if (originalSha !== spec.sha256) {
    return notApplicable("file_hash_mismatch", `target file hashes to ${originalSha}, expected ${spec.sha256}`);
  }
  const routeSha = sha256Hex(input.routeBytes);
  if (routeSha !== spec.routeSha256) {
    return notApplicable("route_hash_mismatch", `route file hashes to ${routeSha}, expected ${spec.routeSha256}`);
  }
  const source = decodeUtf8(input.bytes);
  const route = decodeUtf8(input.routeBytes);
  if (source === undefined || route === undefined) {
    return notApplicable("not_utf8", "the target or route file is not valid UTF-8");
  }

  const selected = matchAll(fixedRule, source);
  const [call] = selected.matches;
  if (selected.matches.length !== 1 || call === undefined) {
    const lines = selected.matches.map(lineOf).join(", ");
    const where = lines === "" ? "" : ` (lines ${lines})`;
    return notApplicable("match_count", `expected exactly one rule match, found ${String(selected.matches.length)}${where}`);
  }
  const fn = enclosingFunction(call);
  if (fn === undefined || kindOf(fn) !== "function_declaration" || functionName(fn) !== spec.functionName) {
    return notApplicable("function_mismatch", `the selected call is not directly inside function ${spec.functionName}`);
  }
  const tz = call.getMatch("TZ")?.text();
  const binding = tz === undefined ? "the rule does not capture $TZ" : bindingProblem(spec, fn, call, tz);
  if (binding !== undefined) {
    return notApplicable("binding_mismatch", binding);
  }
  const endpoint = endpointProblem(spec, route);
  if (endpoint !== undefined) {
    return notApplicable("endpoint_mismatch", endpoint);
  }

  const result = fixMatches(fixedRule, selected);
  const line = lineOf(call);
  const plantedBefore = matchAll(plantedRule, source).matches.length;
  const planted = matchAll(plantedRule, result).matches;
  const resultCall = planted.find((node) => lineOf(node) === line);
  if (matchAll(fixedRule, result).matches.length !== 0 || planted.length !== plantedBefore + 1 || resultCall === undefined) {
    return notApplicable("fix_not_single_call", "the fix did not turn exactly the selected call into the planted form");
  }

  const patch = structuredPatch(`a/${spec.path}`, `b/${spec.path}`, source, result, undefined, undefined, { context: 3 });
  const [hunk] = patch.hunks;
  const changed = hunk?.lines.filter((text) => text.startsWith("-") || text.startsWith("+")) ?? [];
  const expected = [`-${source.split("\n")[line - 1] ?? ""}`, `+${result.split("\n")[line - 1] ?? ""}`];
  if (patch.hunks.length !== 1 || changed.length !== 2 || changed[0] !== expected[0] || changed[1] !== expected[1]) {
    return notApplicable("diff_not_single_hunk", `expected one hunk changing only line ${String(line)}`);
  }
  const resultSha = sha256Hex(result);
  if (resultSha !== spec.resultSha256) {
    return notApplicable("result_hash_mismatch", `result hashes to ${resultSha}, expected ${spec.resultSha256}`);
  }

  const diff = formatPatch({ ...patch, isGit: true });
  const record: TargetRecord = {
    shape_id: SHAPE_ID,
    status: "confirmed",
    fidelity: { ...FIDELITY },
    rule_sha256: sha256Hex(input.ruleBytes),
    target: {
      path: spec.path,
      mode: spec.mode,
      line,
      original_sha256: originalSha,
      result_sha256: resultSha,
      diff,
      function: `${spec.path}#${spec.functionName}`,
      changed_calls: 1,
      original_call: call.text(),
      result_call: resultCall.text(),
      host_commit: spec.hostCommit,
    },
    route: { path: spec.routePath, sha256: routeSha },
  };
  const declaredMutation: DeclaredMutation = {
    diff,
    files: [{ mode: spec.mode, original_sha256: originalSha, path: spec.path, result_sha256: resultSha }],
    host_commit: spec.hostCommit,
  };
  return { status: "confirmed", record, declaredMutation, result };
}

/** Confirms the pinned DT-1.tz-arg target. The expected hashes come from the package, not the caller. */
export function confirmTarget(input: TargetInput): TargetOutcome {
  return confirmTargetWith(DT1_TARGET, input);
}
