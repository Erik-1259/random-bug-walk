// The candidate source rule and structural confirmation for the race class, shape
// RC-1.guarded-write: a record is read, the code awaits, and a write then changes the record
// without checking that the state it read still holds, so two concurrent requests can both act on
// it (check-then-act). The fix makes the write compare and swap: its filter gains a condition on
// that state.
//
// A rule match (`rules/race-guard.candidate.yml`: a call to a write method with an object
// argument) whose filter sits on a line the commit added is confirmed when, structurally:
// - the parent has a function at the same nesting path (`function_missing_before` otherwise);
// - that function calls a write method on the same receiver the same number of times on both
//   sides (`call_added`); the method may change, as `update` to `updateMany`;
// - a parent write that no other write of the commit keeps unchanged, preferably the one at the
//   same position, has filter keys that are a strict subset of the commit's filter keys, so the
//   commit added a condition to the write (`guard_not_added`);
// - an added condition compares a state: its value is a literal (`used: false`), an operator
//   object (`{ gt: 0 }`, `{ $ne: "done" }`) or the same field of a record the function bound from
//   an awaited read (`version: row.version`), not a value such as `userId: session.user.id` or
//   `teamId: ctx.teamId`, which scopes the write to an owner rather than re-checking a state
//   (`guard_not_state`);
// - the write's own function awaits a read before the write, through the write's receiver or bound
//   to the record the write goes through or the guard compares with (`no_read_before_write`): the
//   read, the await and the write are the check-then-act window the guard closes.
import { fileURLToPath } from "node:url";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { argumentsOf, calleeOf, enclosingFunctions, fieldOf, functionPath, hasFunctionPath, isLiteral, kindOf, squash } from "./confirm.ts";
import { loadCandidateRules } from "./rule-file.ts";

export const RACE_SHAPE_ID = "RC-1.guarded-write";
export const RACE_RULE_FILE = fileURLToPath(new URL("../rules/race-guard.candidate.yml", import.meta.url));
export const RACE_RULE_IDS = { TypeScript: "race-guard.candidate.ts", Tsx: "race-guard.candidate.tsx" } as const;

export const RACE_CANDIDATE_RULES = loadCandidateRules(RACE_RULE_FILE, RACE_RULE_IDS);

/** The write methods the candidate rule matches. The rule file uses the same list. */
export const WRITE_METHOD =
  /^(update|updateMany|updateOne|findOneAndUpdate|findOneAndReplace|findOneAndDelete|findAndModify|replaceOne|delete|deleteMany|deleteOne|destroy)$/;

/**
 * A read: a callee whose name is, or starts with as a camel-case word, find, get, select, count,
 * query, fetch, load, read or exists (`findFirst`, `getUser`, `query`), but not `getter` or `finder`,
 * and not a write that also returns the record (`findOneAndUpdate`, `findAndModify`).
 */
export const READ_METHOD = /^(?!findOneAnd|findAndModify)(find|get|select|count|query|fetch|load|read|exists)([A-Z_$0-9].*)?$/;

/** Writes whose lone object argument is the filter. For other writes it is the data written (`coupon.update({ used: true })`). */
const FILTER_FIRST_METHOD = /^(delete|deleteMany|deleteOne|findOneAndDelete)$/;

/**
 * Keys that scope a write to an owner or tenant. Compared with a field of a value
 * (`userId: session.userId`), they restrict who may write rather than re-check a state.
 */
const SCOPE_KEYS = /^(user|owner|account|team|org|organization|tenant|workspace|website|project|member|author|creator)_?id$/i;

/** Added text that names a write method or a filter, as the cheap filter before any blob is fetched. */
export const WRITE_TEXT =
  /\b(where|update|updateMany|updateOne|findOneAndUpdate|findOneAndReplace|findOneAndDelete|findAndModify|replaceOne|delete|deleteMany|deleteOne|destroy)\b/;

/** Keys of a filter operator object, in Prisma, Sequelize-style and MongoDB spellings. */
const OPERATOR_KEYS = new Set(["gt", "gte", "lt", "lte", "not", "equals", "in", "notIn", "is", "isNot", "$gt", "$gte", "$lt", "$lte", "$ne", "$eq", "$in", "$nin", "$exists"]);

export type RaceConfirmReason = "function_missing_before" | "call_added" | "guard_not_added" | "guard_not_state" | "no_read_before_write";

export const RACE_CONFIRM_REASONS: readonly RaceConfirmReason[] = ["function_missing_before", "call_added", "guard_not_added", "guard_not_state", "no_read_before_write"];

export type RaceMatchOutcome =
  | { readonly status: "confirmed"; readonly before_call: string; readonly before_line: number; readonly guard: string }
  | { readonly status: "rejected"; readonly reason: RaceConfirmReason; readonly detail: string };

export interface RaceFileMatch {
  readonly line: number;
  readonly call: string;
  readonly callee: string;
  readonly function: string;
  readonly outcome: RaceMatchOutcome;
}

function unquote(text: string): string {
  return /^(["'`])(.*)\1$/s.exec(text)?.[2] ?? text;
}

/** A filter property's key: a pair's key without quotes, or a shorthand name. Undefined for a spread or a computed key. */
function propertyKey(property: SgNode): string | undefined {
  const kind = kindOf(property);
  if (kind === "shorthand_property_identifier") {
    return property.text();
  }
  if (kind === "pair") {
    const key = fieldOf(property, "key");
    return key === null || kindOf(key) === "computed_property_name" ? undefined : unquote(key.text());
  }
  return undefined;
}

/**
 * The write's filter: the object value of a `where` key in an object argument, or else the first
 * argument when it is an object and either a second argument follows (`updateOne(filter, update)`)
 * or the method is a delete.
 */
export function filterOf(call: SgNode): SgNode | undefined {
  const args = argumentsOf(call);
  for (const argument of args.filter((node) => kindOf(node) === "object")) {
    for (const property of argument.namedChildren()) {
      const value = fieldOf(property, "value");
      if (kindOf(property) === "pair" && propertyKey(property) === "where" && kindOf(value) === "object" && value !== null) {
        return value;
      }
    }
  }
  const [first] = args;
  return kindOf(first) === "object" && (args.length > 1 || FILTER_FIRST_METHOD.test(methodOf(call))) ? first : undefined;
}

function filterKeys(filter: SgNode | undefined): Map<string, SgNode> {
  const keys = new Map<string, SgNode>();
  for (const property of filter?.namedChildren() ?? []) {
    const key = propertyKey(property);
    if (key !== undefined && !keys.has(key)) {
      keys.set(key, property);
    }
  }
  return keys;
}

function methodOf(call: SgNode): string {
  const callee = fieldOf(call, "function");
  return kindOf(callee) === "member_expression" ? (fieldOf(callee, "property")?.text() ?? "") : "";
}

function receiverOf(call: SgNode): string {
  return squash(fieldOf(fieldOf(call, "function"), "object")?.text() ?? "");
}

function writeCalls(root: SgNode, receiver: string, path: string): SgNode[] {
  return root
    .findAll({ rule: { kind: "call_expression" } })
    .filter((call) => WRITE_METHOD.test(methodOf(call)) && receiverOf(call) === receiver && functionPath(call) === path);
}

/** Whether the commit added a line of the write's filter (or, with no filter, of the call). */
function addsFilter(call: SgNode, added: ReadonlySet<number>): boolean {
  const { start, end } = (filterOf(call) ?? call).range();
  for (let line = start.line + 1; line <= end.line + 1; line += 1) {
    if (added.has(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a condition compares a state: a literal, an operator object, or the same field of a
 * record the function read earlier (`version: row.version`), unless the key scopes the write to an
 * owner or tenant (`userId: row.userId`).
 */
function comparesState(key: string, property: SgNode, records: ReadonlySet<string>): boolean {
  const value = kindOf(property) === "pair" ? fieldOf(property, "value") : null;
  if (value === null) {
    return false;
  }
  if (isLiteral(value)) {
    return true;
  }
  const kind = kindOf(value);
  if (kind === "object") {
    // Every key an operator, and no operand a nested filter (`owner: { is: { id } }` scopes by a relation).
    const properties = value.namedChildren();
    return (
      properties.length > 0 &&
      properties.every((child) => {
        const name = propertyKey(child);
        return name !== undefined && OPERATOR_KEYS.has(name) && kindOf(fieldOf(child, "value")) !== "object";
      })
    );
  }
  if (kind !== "member_expression" || SCOPE_KEYS.test(key)) {
    return false;
  }
  const object = fieldOf(value, "object");
  return kindOf(object) === "identifier" && records.has(object?.text() ?? "") && unquote(fieldOf(value, "property")?.text() ?? "") === key;
}

function calleeName(call: SgNode): string {
  const callee = fieldOf(call, "function");
  return kindOf(callee) === "member_expression" ? (fieldOf(callee, "property")?.text() ?? "") : (callee?.text() ?? "");
}

interface AwaitedRead {
  /** The receiver of the read call (`db.coupon` in `db.coupon.findFirst(...)`), or "" for a plain call. */
  readonly receiver: string;
  /** The name the awaited result is bound to (`coupon` in `const coupon = await ...`), if any. */
  readonly bound: string | undefined;
}

/** The reads the write's own function (or the module, at top level) awaits, ending before the write starts. */
function awaitedReadsBefore(root: SgNode, call: SgNode): AwaitedRead[] {
  const [owner] = enclosingFunctions(call);
  const scope = owner ?? root;
  const start = call.range().start.index;
  return scope
    .findAll({ rule: { kind: "await_expression" } })
    .filter((node) => node.range().end.index <= start && enclosingFunctions(node)[0]?.id() === owner?.id())
    .flatMap((node) => {
      const parent = node.parent();
      const name = kindOf(parent) === "variable_declarator" ? fieldOf(parent, "name") : null;
      const bound = kindOf(name) === "identifier" ? name?.text() : undefined;
      return node
        .findAll({ rule: { kind: "call_expression" } })
        .filter((inner) => READ_METHOD.test(calleeName(inner)))
        .map((inner) => ({ receiver: kindOf(fieldOf(inner, "function")) === "member_expression" ? receiverOf(inner) : "", bound }));
    });
}

/** The leading name of a receiver (`coupon` in `coupon.items`). */
function rootName(receiver: string): string {
  return /^[A-Za-z_$][\w$]*/.exec(receiver)?.[0] ?? "";
}

/**
 * Whether an awaited read is the check the write acts on: it reads through the write's receiver
 * (`db.coupon.findFirst` before `db.coupon.update`), or its result is the record the write goes
 * through (`coupon.destroy(...)`) or the guard compares with (`version: row.version`). A session
 * lookup or another unrelated read does not count.
 */
function readsChecked(reads: readonly AwaitedRead[], receiver: string, guard: SgNode): boolean {
  const guardValue = fieldOf(guard, "value");
  const compared = kindOf(guardValue) === "member_expression" ? (fieldOf(guardValue, "object")?.text() ?? "") : "";
  return reads.some(
    (read) => (receiver !== "" && read.receiver === receiver) || (read.bound !== undefined && (read.bound === rootName(receiver) || read.bound === compared)),
  );
}

function judge(beforeRoot: SgNode, afterRoot: SgNode, call: SgNode): RaceMatchOutcome {
  const path = functionPath(call);
  if (!hasFunctionPath(beforeRoot, path)) {
    return { status: "rejected", reason: "function_missing_before", detail: `the parent has no function ${path}` };
  }
  const receiver = receiverOf(call);
  const afterCalls = writeCalls(afterRoot, receiver, path);
  const beforeCalls = writeCalls(beforeRoot, receiver, path);
  if (afterCalls.length !== beforeCalls.length) {
    return {
      status: "rejected",
      reason: "call_added",
      detail: `${path} writes through ${receiver} ${String(beforeCalls.length)} times before and ${String(afterCalls.length)} after`,
    };
  }
  // A parent write that another write of the commit keeps unchanged is not a partner. The commit
  // has one write fewer than the parent besides this one, so at least one parent write stays free.
  const unchanged = afterCalls.filter((candidate) => candidate.id() !== call.id()).map((candidate) => squash(candidate.text()));
  const free = beforeCalls.filter((candidate) => {
    const kept = unchanged.indexOf(squash(candidate.text()));
    if (kept === -1) {
      return true;
    }
    unchanged.splice(kept, 1);
    return false;
  });
  const afterKeys = filterKeys(filterOf(call));
  const extends_ = (candidate: SgNode): boolean => {
    const keys = filterKeys(filterOf(candidate));
    return keys.size < afterKeys.size && [...keys.keys()].every((key) => afterKeys.has(key));
  };
  const partners = free.filter(extends_);
  const positional = beforeCalls[afterCalls.findIndex((candidate) => candidate.id() === call.id())];
  const paired = partners.find((candidate) => candidate.id() === positional?.id()) ?? partners[0];
  if (paired === undefined) {
    return { status: "rejected", reason: "guard_not_added", detail: `no write through ${receiver} in the parent's ${path} has a filter that ${squash(call.text())} extends` };
  }
  const before = filterKeys(filterOf(paired));
  const guards = [...afterKeys].filter(([key]) => !before.has(key));
  const reads = awaitedReadsBefore(afterRoot, call);
  const records = new Set(reads.flatMap((read) => (read.bound === undefined ? [] : [read.bound])));
  const guard = guards.find(([key, property]) => comparesState(key, property, records));
  if (guard === undefined) {
    return { status: "rejected", reason: "guard_not_state", detail: `the added condition ${guards.map(([, property]) => squash(property.text())).join(", ")} compares no state` };
  }
  if (!readsChecked(reads, receiver, guard[1])) {
    return { status: "rejected", reason: "no_read_before_write", detail: `${path} awaits no read before the write` };
  }
  return { status: "confirmed", before_call: paired.text(), before_line: paired.range().start.line + 1, guard: squash(guard[1].text()) };
}

/** Every candidate-rule match whose filter the commit added, each with its confirmation outcome. */
export function examineRaceFile(path: string, before: string, after: string, added: ReadonlySet<number>): RaceFileMatch[] {
  const rule = RACE_CANDIDATE_RULES.rule(path);
  const afterRoot = parse(Lang[rule.language], after).root();
  const matches = afterRoot.findAll(rule.config).filter((call) => addsFilter(call, added));
  if (matches.length === 0) {
    return [];
  }
  const beforeRoot = parse(Lang[rule.language], before).root();
  return matches.map((call) => ({
    line: call.range().start.line + 1,
    call: call.text(),
    callee: calleeOf(call),
    function: functionPath(call),
    outcome: judge(beforeRoot, afterRoot, call),
  }));
}
