// The paired comparison's analysis and results record. Per bug and arm: solve counts with exact
// (Clopper–Pearson) intervals; the off-minus-on solve difference with Fisher's exact p; the
// registered estimates for tokens (the on/off ratio exp(HL shift of ln on − ln off) with its
// exponentiated interval) and turns (the HL shift on minus off in turns with its interval), each
// with the exact permutation Mann–Whitney p; Holm across the three co-primary outcomes; the futility rule; a
// per-bug "made worse" statement; and the per-attempt table. The record is canonical JSON v1, so
// every fraction is a decimal string.
import { encodeCanonical } from "@rbw/schema";
import { CAP_NAMES } from "./profile.ts";
import type { CapName } from "./profile.ts";
import type { Arm, ToolName } from "./tools.ts";
import { TOOL_NAMES } from "./tools.ts";

// ---------------------------------------------------------------------------------------------
// Statistics

/** The element at `index`; throws when there is none. */
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`index ${String(index)} is out of range`);
  }
  return value;
}

function logFactorial(n: number): number {
  let sum = 0;
  for (let k = 2; k <= n; k += 1) {
    sum += Math.log(k);
  }
  return sum;
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

function binomialPmf(k: number, n: number, p: number): number {
  if (p === 0) {
    return k === 0 ? 1 : 0;
  }
  if (p === 1) {
    return k === n ? 1 : 0;
  }
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
}

/** P(X ≤ x) for X ~ Binomial(n, p). */
function binomialCdf(x: number, n: number, p: number): number {
  let sum = 0;
  for (let k = 0; k <= x; k += 1) {
    sum += binomialPmf(k, n, p);
  }
  return Math.min(1, sum);
}

/** The root in [0, 1] of a monotone function, by bisection to below 1e-15. */
function bisect(f: (p: number) => number, increasing: boolean): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200 && hi - lo > 1e-15; i += 1) {
    const mid = (lo + hi) / 2;
    const value = f(mid);
    if (value < 0 === increasing) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

function checkCount(x: number, n: number): void {
  if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(x) || x < 0 || x > n) {
    throw new Error("a count needs 0 ≤ x ≤ n and n ≥ 1, both integers");
  }
}

/**
 * The exact (Clopper–Pearson) two-sided interval for x successes in n trials: the lower end solves
 * P(X ≥ x) = alpha/2 (0 when x = 0), the upper end P(X ≤ x) = alpha/2 (1 when x = n).
 */
export function clopperPearson(x: number, n: number, alpha = 0.05): [number, number] {
  checkCount(x, n);
  const lower = x === 0 ? 0 : bisect((p) => 1 - binomialCdf(x - 1, n, p) - alpha / 2, true);
  const upper = x === n ? 1 : bisect((p) => binomialCdf(x, n, p) - alpha / 2, false);
  return [lower, upper];
}

/** Relative tolerance for "as or less likely than observed", as R's fisher.test uses. */
const RELATIVE_TOLERANCE = 1 + 1e-7;

/**
 * Fisher's exact two-sided p for the 2×2 table [[a, b], [c, d]]: the sum of the hypergeometric
 * probabilities of every table with the same margins that is no more likely than the observed one.
 */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  for (const cell of [a, b, c, d]) {
    if (!Number.isSafeInteger(cell) || cell < 0) {
      throw new Error("table cells must be non-negative integers");
    }
  }
  const row1 = a + b;
  const col1 = a + c;
  const total = a + b + c + d;
  const min = Math.max(0, row1 + col1 - total);
  const max = Math.min(row1, col1);
  const logDenominator = logChoose(total, col1);
  const probability = (k: number) => Math.exp(logChoose(row1, k) + logChoose(total - row1, col1 - k) - logDenominator);
  const observed = probability(a);
  let p = 0;
  for (let k = min; k <= max; k += 1) {
    const pk = probability(k);
    if (pk <= observed * RELATIVE_TOLERANCE) {
      p += pk;
    }
  }
  return Math.min(1, p);
}

/** Holm's step-down adjusted p values, in the input order. */
export function holm(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p || x.i - y.i);
  const adjusted = new Array<number>(m).fill(1);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adjusted[i] = running;
  });
  return adjusted;
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) {
    throw new Error("the median of nothing");
  }
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? at(sorted, mid) : (at(sorted, mid - 1) + at(sorted, mid)) / 2;
}

/**
 * The null distribution of the Mann–Whitney count U (pairs with x > y) for samples of m and n
 * without ties: entry u is the number of the C(m+n, m) orderings with U = u.
 */
function mannWhitneyCounts(m: number, n: number): number[] {
  // f[i][j] is the distribution for samples of i and j; f(u; i, j) = f(u - j; i - 1, j) + f(u; i, j - 1).
  let previous: number[][] = [];
  for (let i = 0; i <= m; i += 1) {
    const row: number[][] = [];
    for (let j = 0; j <= n; j += 1) {
      const counts = new Array<number>(i * j + 1).fill(0);
      if (i === 0 || j === 0) {
        counts[0] = 1;
      } else {
        const left = at(previous, j);
        const down = at(row, j - 1);
        for (let u = 0; u <= i * j; u += 1) {
          counts[u] = (u - j >= 0 && u - j < left.length ? at(left, u - j) : 0) + (u < down.length ? at(down, u) : 0);
        }
      }
      row.push(counts);
    }
    previous = row;
  }
  return at(previous, n);
}

export interface HodgesLehmann {
  /** The median of the m·n differences x − y. */
  estimate: number;
  lower: number;
  upper: number;
  /** The interval's exact coverage under the no-ties null distribution, at least 1 − alpha when it can be. */
  level: number;
}

/**
 * The two-sample Hodges–Lehmann estimate of the shift x − y and its distribution-free (Moses)
 * interval [D(k), D(mn + 1 − k)] over the sorted differences, with k the smallest u where
 * P(U ≤ u) ≥ alpha/2 under the no-ties null (at least 1), as R's wilcox.test computes the exact
 * interval. With ties the same k is used, so the stated level is nominal.
 */
export function hodgesLehmann(x: readonly number[], y: readonly number[], alpha = 0.05): HodgesLehmann {
  const m = x.length;
  const n = y.length;
  if (m === 0 || n === 0) {
    throw new Error("both samples need at least one value");
  }
  const differences: number[] = [];
  for (const xi of x) {
    for (const yj of y) {
      differences.push(xi - yj);
    }
  }
  differences.sort((p, q) => p - q);
  const counts = mannWhitneyCounts(m, n);
  const total = counts.reduce((sum, c) => sum + c, 0);
  let cumulative = 0;
  let k = 0;
  for (let u = 0; u < counts.length; u += 1) {
    cumulative += at(counts, u);
    if (cumulative / total >= alpha / 2) {
      k = u;
      break;
    }
  }
  if (k === 0) {
    k = 1;
  }
  let below = 0;
  for (let u = 0; u <= k - 1; u += 1) {
    below += at(counts, u);
  }
  return {
    estimate: median(differences),
    lower: at(differences, k - 1),
    upper: at(differences, m * n - k),
    level: 1 - (2 * below) / total,
  };
}

/**
 * The exact two-sided permutation p of the Wilcoxon–Mann–Whitney rank-sum test, with midranks for
 * ties: the share of the C(m+n, m) splits whose rank sum of the first sample is at least as far
 * from its mean as the observed one.
 */
export function mannWhitneyExact(x: readonly number[], y: readonly number[]): number {
  const m = x.length;
  const all = [...x.map((value) => ({ value, first: true })), ...y.map((value) => ({ value, first: false }))];
  const total = all.length;
  if (m === 0 || y.length === 0) {
    throw new Error("both samples need at least one value");
  }
  all.sort((p, q) => p.value - q.value);
  // Doubled midranks are integers: a tie block over ranks i+1..j gets (i+1+j) each.
  const doubled = new Array<number>(total).fill(0);
  for (let i = 0; i < total; ) {
    let j = i;
    while (j + 1 < total && at(all, j + 1).value === at(all, i).value) {
      j += 1;
    }
    for (let t = i; t <= j; t += 1) {
      doubled[t] = i + 1 + (j + 1);
    }
    i = j + 1;
  }
  const observed = all.reduce((sum, item, index) => (item.first ? sum + at(doubled, index) : sum), 0);
  const maxSum = doubled.reduce((sum, r) => sum + r, 0);
  // ways[k][s]: the number of k-subsets of the items seen so far with doubled rank sum s.
  const ways: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(maxSum + 1).fill(0));
  at(ways, 0)[0] = 1;
  for (const rank of doubled) {
    for (let k = Math.min(m, total) - 1; k >= 0; k -= 1) {
      const from = at(ways, k);
      const to = at(ways, k + 1);
      for (let s = maxSum - rank; s >= 0; s -= 1) {
        const count = at(from, s);
        if (count !== 0) {
          to[s + rank] = at(to, s + rank) + count;
        }
      }
    }
  }
  const mean = m * (total + 1); // the mean of the doubled rank sum
  const distance = Math.abs(observed - mean);
  const subsets = at(ways, m);
  let extreme = 0;
  let splits = 0;
  subsets.forEach((count, s) => {
    splits += count;
    if (Math.abs(s - mean) >= distance) {
      extreme += count;
    }
  });
  return Math.min(1, extreme / splits);
}

// ---------------------------------------------------------------------------------------------
// The results record

export type Grade = "pass" | "fail";

/** One pre-registered attempt index as it finally ran. */
export interface AttemptRow {
  bug_id: string;
  arm: Arm;
  index: number;
  /**
   * `counted`: the attempt ran to submit or a cap. `infrastructure_error`: it still failed on
   * infrastructure after the allowed reruns; excluded from every outcome and reported apart.
   */
  status: "counted" | "infrastructure_error";
  /** Infrastructure reruns at this index before the run that is reported. */
  reruns: number;
  /** Local Docker judge_verify; null when not graded (out of scope or infrastructure error). */
  grade1: Grade | null;
  /** Protected Sandbox regrade, the authoritative grade; null when not graded. */
  grade2: Grade | null;
  /** The diff touched a file other than the target: unsolved and not graded (R5). */
  out_of_scope: boolean;
  prohibited_edits: number;
  /** Input plus output tokens of the attempt. */
  tokens: number;
  turns: number;
  cap: CapName | null;
  /** Tool results the history policy elided (AttemptResult.elided_tool_results). */
  history_elisions: number;
  tool_calls: Record<ToolName, number>;
  contaminated: boolean;
}

export const ALPHA = 0.05;
export const FUTILITY_FIRST = 6;
export const OUTCOMES = ["solve", "tokens", "turns"] as const;
export type OutcomeName = (typeof OUTCOMES)[number];

/** A fraction as a decimal string with six places. */
export function decimal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("a decimal must be finite");
  }
  const fixed = value.toFixed(6);
  return fixed === "-0.000000" ? "0.000000" : fixed;
}

/** An exact value that is an integer or a half-integer, such as a median of integers. */
function exact(value: number): string {
  if (!Number.isInteger(value * 2)) {
    throw new Error("expected an integer or half-integer");
  }
  return String(value);
}

function isSolved(row: AttemptRow): boolean {
  return row.status === "counted" && !row.out_of_scope && row.grade2 === "pass";
}

function validate(row: AttemptRow): void {
  if (row.status === "counted" && !row.out_of_scope && row.grade2 === null) {
    throw new Error(`attempt ${row.bug_id} ${row.arm} ${String(row.index)} is counted and in scope but has no grade 2`);
  }
  if (row.out_of_scope && (row.grade1 !== null || row.grade2 !== null)) {
    throw new Error(`attempt ${row.bug_id} ${row.arm} ${String(row.index)} is out of scope but carries a grade`);
  }
}

interface ArmSummary {
  attempts: number;
  counted: number;
  solved: number;
  solve_rate: string | null;
  clopper_pearson_95: [string, string] | null;
  infrastructure_errors: number;
  reruns: number;
  out_of_scope: number;
  prohibited_edits: number;
  contaminated: number;
  capped: number;
  /** Counted attempts stopped by each cap, `context_window` included. */
  caps: Record<CapName, number>;
  /** Counted attempts in which the history policy elided at least one tool result, and the total elided. */
  attempts_with_elisions: number;
  history_elisions: number;
  /** Attempts that called server_logs at least once (the on arm's tool-use check). */
  used_server_logs: number;
  tool_calls: Record<ToolName, number>;
  grade_disagreements: number;
  median_tokens: string | null;
  median_turns: string | null;
}

function summarize(rows: readonly AttemptRow[]): ArmSummary {
  const counted = rows.filter((row) => row.status === "counted");
  const solved = counted.filter(isSolved).length;
  const toolCalls = Object.fromEntries(TOOL_NAMES.map((name) => [name, 0])) as Record<ToolName, number>;
  for (const row of counted) {
    for (const name of TOOL_NAMES) {
      toolCalls[name] += row.tool_calls[name];
    }
  }
  const interval = counted.length === 0 ? null : clopperPearson(solved, counted.length, ALPHA);
  const sortedTokens = counted.map((row) => row.tokens).sort((a, b) => a - b);
  const sortedTurns = counted.map((row) => row.turns).sort((a, b) => a - b);
  return {
    attempts: rows.length,
    counted: counted.length,
    solved,
    solve_rate: counted.length === 0 ? null : decimal(solved / counted.length),
    clopper_pearson_95: interval === null ? null : [decimal(interval[0]), decimal(interval[1])],
    infrastructure_errors: rows.filter((row) => row.status === "infrastructure_error").length,
    reruns: rows.reduce((sum, row) => sum + row.reruns, 0),
    out_of_scope: counted.filter((row) => row.out_of_scope).length,
    prohibited_edits: counted.reduce((sum, row) => sum + row.prohibited_edits, 0),
    contaminated: counted.filter((row) => row.contaminated).length,
    capped: counted.filter((row) => row.cap !== null).length,
    caps: Object.fromEntries(CAP_NAMES.map((name) => [name, counted.filter((row) => row.cap === name).length])) as Record<CapName, number>,
    attempts_with_elisions: counted.filter((row) => row.history_elisions > 0).length,
    history_elisions: counted.reduce((sum, row) => sum + row.history_elisions, 0),
    used_server_logs: counted.filter((row) => row.tool_calls.server_logs > 0).length,
    tool_calls: toolCalls,
    grade_disagreements: counted.filter((row) => row.grade1 !== null && row.grade2 !== null && row.grade1 !== row.grade2).length,
    median_tokens: sortedTokens.length === 0 ? null : exact(median(sortedTokens)),
    median_turns: sortedTurns.length === 0 ? null : exact(median(sortedTurns)),
  };
}

export type Futility = { triggered: false } | { triggered: true; extreme: "floor" | "ceiling" };

/**
 * The futility rule: after the first 6 counted attempts of each arm in index order, both arms at
 * 0/6 or both at 6/6 stops the solve analysis. Not triggered while either arm has fewer than 6.
 */
export function futility(off: readonly AttemptRow[], on: readonly AttemptRow[]): Futility {
  const first = (rows: readonly AttemptRow[]) =>
    rows
      .filter((row) => row.status === "counted")
      .sort((a, b) => a.index - b.index)
      .slice(0, FUTILITY_FIRST);
  const a = first(off);
  const b = first(on);
  if (a.length < FUTILITY_FIRST || b.length < FUTILITY_FIRST) {
    return { triggered: false };
  }
  const solvedA = a.filter(isSolved).length;
  const solvedB = b.filter(isSolved).length;
  if (solvedA === 0 && solvedB === 0) {
    return { triggered: true, extreme: "floor" };
  }
  if (solvedA === FUTILITY_FIRST && solvedB === FUTILITY_FIRST) {
    return { triggered: true, extreme: "ceiling" };
  }
  return { triggered: false };
}

/** What the token and turn results share: the interval's level, the test and Holm. */
interface RankTest {
  /** The interval's coverage under the no-ties null distribution. */
  interval_level: string;
  /** True when any value repeats in the pooled samples: the coverage is then approximate. */
  interval_coverage_approximate: boolean;
  mann_whitney_p: string;
  holm_p: string;
  holm_reject: boolean;
}

/**
 * Tokens per attempt, as registered: the Hodges–Lehmann shift of ln(on) − ln(off), reported as
 * the ratio exp(shift) with its interval ends exponentiated. Below 1: the on arm used fewer
 * tokens; 0.75 is the registered 25% reduction.
 */
interface TokenRatioResult extends RankTest {
  ratio_on_over_off: string;
  ratio_interval_on_over_off: [string, string];
}

/** Turns per attempt, as registered: the Hodges–Lehmann shift on raw turns, on minus off. Positive: the on arm took more turns. */
interface TurnShiftResult extends RankTest {
  hodges_lehmann_on_minus_off: string;
  interval_on_minus_off: [string, string];
}

interface SolveResult {
  off_minus_on_rate: string;
  fisher_p: string;
  holm_p: string;
  holm_reject: boolean;
}

export type Verdict = "worse" | "not_worse" | "inconclusive" | "not_tested";

export interface BugAnalysis {
  bug_id: string;
  arms: { off: ArmSummary; on: ArmSummary };
  futility: Futility;
  /** Null when the futility rule stopped the solve analysis or an arm has no counted attempt. */
  solve: SolveResult | null;
  tokens: TokenRatioResult | null;
  turns: TurnShiftResult | null;
  made_worse: { solve: Verdict; tokens: Verdict; statement: string };
}

/** The shift on minus off with the rank test, before Holm. */
interface Shift {
  hl: HodgesLehmann;
  p: number;
  ties: boolean;
}

function shiftOnMinusOff(off: readonly number[], on: readonly number[]): Shift {
  // Any repeated value in the pooled samples breaks the no-ties distribution, within an arm or across arms.
  const pooled = [...off, ...on];
  return {
    hl: hodgesLehmann(on, off, ALPHA),
    // The registered statistic is the on arm's rank sum; the two-sided p is the same either way.
    p: mannWhitneyExact(on, off),
    ties: new Set(pooled).size < pooled.length,
  };
}

function logTokens(rows: readonly AttemptRow[]): number[] {
  return rows.map((row) => {
    if (!(row.tokens > 0)) {
      throw new Error(`attempt ${row.bug_id} ${row.arm} ${String(row.index)} needs a positive token count for the log-token estimate`);
    }
    return Math.log(row.tokens);
  });
}

function rankTest(s: Shift, adjustedP: number): RankTest {
  return {
    interval_level: decimal(s.hl.level),
    interval_coverage_approximate: s.ties,
    mann_whitney_p: decimal(s.p),
    holm_p: decimal(adjustedP),
    holm_reject: adjustedP <= ALPHA,
  };
}

/** The tool made the bug worse when the on arm did worse and the Holm-adjusted test rejects. */
function verdict(onWorse: boolean, onBetter: boolean, reject: boolean): Verdict {
  if (!reject) {
    return "inconclusive";
  }
  if (onWorse) {
    return "worse";
  }
  return onBetter ? "not_worse" : "inconclusive";
}

function solveSentence(off: ArmSummary, on: ArmSummary, solve: SolveResult | null, fut: Futility): string {
  if (fut.triggered) {
    return `Solve analysis stopped by the futility rule: both arms were at the ${fut.extreme} after ${String(FUTILITY_FIRST)} attempts each.`;
  }
  if (solve === null) {
    return "Solve was not tested: an arm has no counted attempt.";
  }
  const counts = `off ${String(off.solved)}/${String(off.counted)}, on ${String(on.solved)}/${String(on.counted)}`;
  if (!solve.holm_reject) {
    return `Solves: ${counts}; inconclusive at this sample size (Fisher p ${solve.fisher_p}, Holm-adjusted ${solve.holm_p}).`;
  }
  const direction = off.solved / off.counted > on.solved / on.counted ? "fewer" : "more";
  return `Solves: ${counts}; the on arm solved ${direction} (Fisher p ${solve.fisher_p}, Holm-adjusted ${solve.holm_p}).`;
}

function tokenSentence(tokens: TokenRatioResult | null, logShift: number): string {
  if (tokens === null) {
    return "Tokens were not tested: an arm has no counted attempt.";
  }
  const approximate = tokens.interval_coverage_approximate ? " (approximate with ties)" : "";
  const detail = `token ratio on over off ${tokens.ratio_on_over_off}, interval ${tokens.ratio_interval_on_over_off[0]} to ${tokens.ratio_interval_on_over_off[1]} at level ${tokens.interval_level}${approximate}, Holm-adjusted p ${tokens.holm_p}`;
  if (!tokens.holm_reject) {
    return `Tokens: ${detail}; inconclusive at this sample size.`;
  }
  const direction = logShift > 0 ? "more" : "fewer";
  return `Tokens: ${detail}; the on arm used ${direction} tokens.`;
}

/** The analysis of one bug's attempts, both arms. */
export function analyzeBug(bugId: string, rows: readonly AttemptRow[]): BugAnalysis {
  const own = rows.filter((row) => row.bug_id === bugId);
  own.forEach(validate);
  const off = own.filter((row) => row.arm === "off");
  const on = own.filter((row) => row.arm === "on");
  const offSummary = summarize(off);
  const onSummary = summarize(on);
  const fut = futility(off, on);
  const offCounted = off.filter((row) => row.status === "counted");
  const onCounted = on.filter((row) => row.status === "counted");
  const testable = offCounted.length > 0 && onCounted.length > 0;

  const fisherP = testable && !fut.triggered
    ? fisherExact(offSummary.solved, offSummary.counted - offSummary.solved, onSummary.solved, onSummary.counted - onSummary.solved)
    : null;
  // Tokens: the shift of natural-log tokens (ln is one-to-one, so the ranks, ties and p are those
  // of the raw counts). Turns: the shift of raw turns. Both on minus off.
  const tokens = testable ? shiftOnMinusOff(logTokens(offCounted), logTokens(onCounted)) : null;
  const turns = testable ? shiftOnMinusOff(offCounted.map((r) => r.turns), onCounted.map((r) => r.turns)) : null;
  // Holm runs across all three outcomes. A solve test the futility rule stopped enters as p = 1,
  // which never makes the other two easier to reject than with three tests.
  const adjusted = holm([fisherP ?? 1, tokens?.p ?? 1, turns?.p ?? 1]);
  const solve: SolveResult | null =
    fisherP === null
      ? null
      : {
          off_minus_on_rate: decimal(offSummary.solved / offSummary.counted - onSummary.solved / onSummary.counted),
          fisher_p: decimal(fisherP),
          holm_p: decimal(at(adjusted, 0)),
          holm_reject: at(adjusted, 0) <= ALPHA,
        };
  const tokenResult: TokenRatioResult | null =
    tokens === null
      ? null
      : {
          ratio_on_over_off: decimal(Math.exp(tokens.hl.estimate)),
          ratio_interval_on_over_off: [decimal(Math.exp(tokens.hl.lower)), decimal(Math.exp(tokens.hl.upper))],
          ...rankTest(tokens, at(adjusted, 1)),
        };
  const turnResult: TurnShiftResult | null =
    turns === null
      ? null
      : {
          hodges_lehmann_on_minus_off: exact(turns.hl.estimate),
          interval_on_minus_off: [exact(turns.hl.lower), exact(turns.hl.upper)],
          ...rankTest(turns, at(adjusted, 2)),
        };

  const solveVerdict: Verdict =
    solve === null
      ? "not_tested"
      : verdict(
          offSummary.solved / offSummary.counted > onSummary.solved / onSummary.counted,
          offSummary.solved / offSummary.counted < onSummary.solved / onSummary.counted,
          solve.holm_reject,
        );
  // The log shift on minus off: positive (a ratio above 1) means the on arm used more tokens.
  const logShift = tokens === null ? 0 : tokens.hl.estimate;
  const tokenVerdict: Verdict =
    tokenResult === null ? "not_tested" : verdict(logShift > 0, logShift < 0, tokenResult.holm_reject);
  return {
    bug_id: bugId,
    arms: { off: offSummary, on: onSummary },
    futility: fut,
    solve,
    tokens: tokenResult,
    turns: turnResult,
    made_worse: {
      solve: solveVerdict,
      tokens: tokenVerdict,
      statement: `${solveSentence(offSummary, onSummary, solve, fut)} ${tokenSentence(tokenResult, logShift)}`,
    },
  };
}

export interface AttemptTableRow extends AttemptRow {
  solved: boolean;
  grades_disagree: boolean;
}

export interface ResultsRecord {
  schema_version: 1;
  kind: "paired_comparison_analysis";
  alpha: string;
  holm_family: readonly OutcomeName[];
  /** The scope of every claim this record supports. */
  claim_scope: string;
  bugs: BugAnalysis[];
  attempts: AttemptTableRow[];
}

export const CLAIM_SCOPE =
  "An illustration on the bugs listed, not an estimate of the tool's effect. Pairing is at the bug level only. A non-detection is inconclusive at this sample size.";

/** The results record over every attempt row, bugs in order of first appearance. */
export function analyze(rows: readonly AttemptRow[]): ResultsRecord {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.bug_id}\u0000${row.arm}\u0000${String(row.index)}`;
    if (seen.has(key)) {
      throw new Error(`attempt ${row.bug_id} ${row.arm} ${String(row.index)} appears twice; report one row per index`);
    }
    seen.add(key);
  }
  const bugIds = [...new Set(rows.map((row) => row.bug_id))];
  const attempts = [...rows]
    .sort((a, b) => (a.bug_id < b.bug_id ? -1 : a.bug_id > b.bug_id ? 1 : a.arm < b.arm ? -1 : a.arm > b.arm ? 1 : a.index - b.index))
    .map((row) => ({
      ...row,
      solved: isSolved(row),
      grades_disagree: row.grade1 !== null && row.grade2 !== null && row.grade1 !== row.grade2,
    }));
  return {
    schema_version: 1,
    kind: "paired_comparison_analysis",
    alpha: decimal(ALPHA),
    holm_family: OUTCOMES,
    claim_scope: CLAIM_SCOPE,
    bugs: bugIds.map((id) => analyzeBug(id, rows)),
    attempts,
  };
}

/** The record as canonical JSON v1 text, for the publisher. */
export function resultsRecordJson(record: ResultsRecord): string {
  return new TextDecoder().decode(encodeCanonical(record));
}
