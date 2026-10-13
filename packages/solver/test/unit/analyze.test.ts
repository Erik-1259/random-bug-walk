// Reference values: R 4.5.1 (r-base:4.5.1 image), binom.test(x, n)$conf.int,
// fisher.test(matrix(c(a, b, c, d), nrow = 2, byrow = TRUE))$p.value,
// wilcox.test(x, y, conf.int = TRUE, exact = TRUE) and p.adjust(p, "holm"), printed to 12 places.
// "Hand" values are worked out in the comments beside them.
import { parseCanonical } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import { analyze, analyzeBug, clopperPearson, fisherExact, futility, hodgesLehmann, holm, mannWhitneyExact, resultsRecordJson } from "../../src/analyze.ts";
import type { AttemptRow } from "../../src/analyze.ts";
import type { Arm } from "../../src/tools.ts";

const CLOSE = 9; // decimal places

describe("Clopper–Pearson", () => {
  it.each([
    [0, 20, 0, 0.168433470983],
    [20, 20, 0.831566529017, 1],
    [1, 2, 0.012579117093, 0.987420882907],
    [7, 20, 0.153909204785, 0.592188534533],
    [13, 20, 0.407811465467, 0.846090795215],
    [3, 10, 0.066739511178, 0.65245285006],
  ])("%i of %i matches R's binom.test", (x, n, lower, upper) => {
    const [lo, hi] = clopperPearson(x, n);
    expect(lo).toBeCloseTo(lower, CLOSE);
    expect(hi).toBeCloseTo(upper, CLOSE);
  });

  it("matches the closed forms by hand", () => {
    // x = 0: upper = 1 − 0.025^(1/n). x = 1, n = 2: 1 − (1 − p)² = 0.025 and 1 − p² = 0.025.
    expect(clopperPearson(0, 20)[1]).toBeCloseTo(1 - 0.025 ** (1 / 20), 12);
    expect(clopperPearson(1, 2)).toEqual([expect.closeTo(1 - Math.sqrt(0.975), 12), expect.closeTo(Math.sqrt(0.975), 12)]);
  });

  it("refuses impossible counts", () => {
    expect(() => clopperPearson(3, 2)).toThrow();
    expect(() => clopperPearson(0, 0)).toThrow();
  });
});

describe("Fisher's exact test", () => {
  it.each([
    [3, 0, 0, 3, 0.1],
    [1, 2, 2, 1, 1],
    [10, 10, 2, 18, 0.013814147852],
    [7, 13, 15, 5, 0.024841720378],
    [0, 20, 0, 20, 1],
    [4, 16, 9, 11, 0.175995636507],
  ])("[[%i, %i], [%i, %i]] matches R's fisher.test", (a, b, c, d, p) => {
    expect(fisherExact(a, b, c, d)).toBeCloseTo(p, CLOSE);
  });

  it("matches the hypergeometric sum by hand", () => {
    // Margins 3 and 3 of 6: P(k) = C(3,k)·C(3,3−k)/20 = 1/20, 9/20, 9/20, 1/20; the extremes sum to 0.1.
    expect(fisherExact(3, 0, 0, 3)).toBeCloseTo(0.1, 14);
  });
});

describe("Holm", () => {
  it("matches R's p.adjust", () => {
    expect(holm([0.01, 0.04, 0.03])).toEqual([expect.closeTo(0.03, 12), expect.closeTo(0.06, 12), expect.closeTo(0.06, 12)]);
    expect(holm([0.2, 0.001, 0.02])).toEqual([expect.closeTo(0.2, 12), expect.closeTo(0.003, 12), expect.closeTo(0.04, 12)]);
  });

  it("caps at 1", () => {
    expect(holm([0.5, 0.6, 0.7])).toEqual([1, 1, 1]);
  });
});

const OFF_TOKENS = [
  812345, 954210, 701233, 1203344, 655001, 880123, 990456, 1100234, 760321, 845678, 920111, 1010987, 690543, 870654, 1150321, 799876, 935012,
  1020456, 715098, 980765,
];
const ON_TOKENS = [
  612340, 734567, 801234, 590876, 688432, 905123, 640987, 777654, 699321, 820456, 560789, 745612, 860234, 630456, 710987, 795432, 655678,
  880999, 600123, 720345,
];

describe("Hodges–Lehmann and its interval", () => {
  it("matches R's wilcox.test on 20 against 20", () => {
    const hl = hodgesLehmann(OFF_TOKENS, ON_TOKENS);
    expect(hl.estimate).toBe(172928.5);
    expect([hl.lower, hl.upper]).toEqual([84691, 269778]);
    expect(hl.level).toBeGreaterThanOrEqual(0.95);
  });

  it("matches R on 6 against 7 with fractional values", () => {
    const hl = hodgesLehmann([3.5, 7.25, 1, 12, 9.5, 4.75], [2, 0.5, 6, 8.25, 5.5, 11, 1.5]);
    expect([hl.estimate, hl.lower, hl.upper]).toEqual([1.375, -4.5, 6.75]);
  });

  it("matches the hand computation on 3 against 3", () => {
    // Differences of [3, 5, 9] − [1, 2, 4], sorted: −1, 1, 1, 2, 3, 4, 5, 7, 8; the median is 3.
    // P(U = 0) = 1/20 > 0.025, so k = 1: the interval is [D(1), D(9)] at level 1 − 2/20 = 0.9.
    expect(hodgesLehmann([3, 5, 9], [1, 2, 4])).toEqual({ estimate: 3, lower: -1, upper: 8, level: 0.9 });
  });
});

/** The two-sided rank-sum permutation p by enumerating every split, for small samples. */
function bruteForcePermutationP(x: readonly number[], y: readonly number[]): number {
  const all = [...x, ...y];
  const n = all.length;
  const ranks = all.map((v) => {
    const below = all.filter((w) => w < v).length;
    const equal = all.filter((w) => w === v).length;
    return below + (equal + 1) / 2;
  });
  const observed = x.reduce((sum, _v, i) => sum + (ranks[i] ?? 0), 0);
  const mean = (x.length * (n + 1)) / 2;
  let extreme = 0;
  let total = 0;
  for (let mask = 0; mask < 1 << n; mask += 1) {
    let bits = 0;
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      if ((mask >> i) & 1) {
        bits += 1;
        sum += ranks[i] ?? 0;
      }
    }
    if (bits === x.length) {
      total += 1;
      if (Math.abs(sum - mean) >= Math.abs(observed - mean) - 1e-9) {
        extreme += 1;
      }
    }
  }
  return extreme / total;
}

describe("the exact Mann–Whitney p", () => {
  it("matches R's exact wilcox.test p without ties", () => {
    expect(mannWhitneyExact(OFF_TOKENS, ON_TOKENS)).toBeCloseTo(0.000257973808, CLOSE);
    expect(mannWhitneyExact([3.5, 7.25, 1, 12, 9.5, 4.75], [2, 0.5, 6, 8.25, 5.5, 11, 1.5])).toBeCloseTo(0.628205128205, CLOSE);
    expect(mannWhitneyExact([3, 5, 9], [1, 2, 4])).toBeCloseTo(0.2, 12);
  });

  it("matches the hand count with no overlap", () => {
    // [1, 2] against [3, 4]: 2 of the 6 splits are as extreme (rank sums 3 and 7).
    expect(mannWhitneyExact([1, 2], [3, 4])).toBeCloseTo(2 / 6, 12);
  });

  it("matches full enumeration with ties, using midranks", () => {
    const cases: [number[], number[]][] = [
      [[12, 15, 15, 20, 31, 31], [9, 12, 12, 15, 18, 22, 22]],
      [[5, 5, 5, 6], [5, 6, 6, 7, 7, 8]],
      [[50, 50, 50, 50], [50, 50, 49, 51, 50]],
    ];
    for (const [x, y] of cases) {
      expect(mannWhitneyExact(x, y)).toBeCloseTo(bruteForcePermutationP(x, y), 12);
    }
  });

  it("is 1 when every value is tied", () => {
    expect(mannWhitneyExact([4, 4, 4], [4, 4])).toBe(1);
  });
});

const NO_TOOLS = { bash: 0, read_file: 0, write_file: 0, rebuild_restart: 0, submit: 1, server_logs: 0 };

function row(arm: Arm, index: number, solved: boolean, extra: Partial<AttemptRow> = {}): AttemptRow {
  const grade = solved ? "pass" : "fail";
  return {
    bug_id: "race-synthetic-1",
    arm,
    index,
    status: "counted",
    reruns: 0,
    grade1: grade,
    grade2: grade,
    out_of_scope: false,
    prohibited_edits: 0,
    tokens: 1000,
    turns: 1,
    cap: null,
    history_elisions: 0,
    tool_calls: { ...NO_TOOLS, server_logs: arm === "on" ? 2 : 0 },
    contaminated: false,
    ...extra,
  };
}

/** 20 off attempts (10 solved) and 20 on attempts (2 solved), with the reference token samples. */
function worseRows(): AttemptRow[] {
  const rows: AttemptRow[] = [];
  for (let i = 0; i < 20; i += 1) {
    rows.push(row("off", 2 * i + 1, i % 2 === 0, { tokens: ON_TOKENS[i] ?? 0, turns: 10 + i }));
    rows.push(row("on", 2 * i + 2, i === 3 || i === 11, { tokens: OFF_TOKENS[i] ?? 0, turns: 30 - i }));
  }
  return rows;
}

describe("the per-bug analysis", () => {
  it("reports counts, exact intervals, Fisher p, Hodges–Lehmann shifts and Holm", () => {
    const bug = analyzeBug("race-synthetic-1", worseRows());
    expect(bug.arms.off).toMatchObject({ counted: 20, solved: 10, solve_rate: "0.500000", used_server_logs: 0 });
    expect(bug.arms.on).toMatchObject({ counted: 20, solved: 2, solve_rate: "0.100000", used_server_logs: 20 });
    expect(bug.arms.on.clopper_pearson_95).toEqual(["0.012349", "0.316983"]);
    expect(bug.solve).toMatchObject({ off_minus_on_rate: "0.400000", fisher_p: "0.013814" });
    // Off tokens are the on reference sample and vice versa; the token estimate is the on/off ratio
    // (worked out under "the registered token ratio" below).
    expect(bug.tokens).toMatchObject({ ratio_on_over_off: "1.244383", ratio_interval_on_over_off: ["1.113242", "1.383191"], mann_whitney_p: "0.000258" });
    const p = [0.013814147852, 0.000257973808, Number(bug.turns?.mann_whitney_p)];
    const adjusted = holm(p);
    expect(bug.solve?.holm_p).toBe(adjusted[0]?.toFixed(6));
    expect(bug.tokens?.holm_p).toBe(adjusted[1]?.toFixed(6));
    expect(bug.turns?.holm_p).toBe(adjusted[2]?.toFixed(6));
  });

  it("reports the turns shift on minus off, as registered, worked out by hand", () => {
    // Pre-registration, Outcomes 3: "the Hodges–Lehmann shift on raw turns, on minus off, in turns,
    // with its 95% interval". On turns are 30 − j and off turns 10 + i (i, j = 0..19), so each
    // on-minus-off difference is 20 − s with s = i + j. The count of pairs with s ≤ k is
    // (k + 1)(k + 2) / 2 for k ≤ 19, and the counts are symmetric about s = 19, so the median is
    // 20 − 19 = +1: the on arm took one more turn. The registered interval runs from the 128th to
    // the 273rd of the 400 ordered differences. 20 − s falls as s rises, so the 128th smallest
    // difference has the 273rd smallest s, which is 23 (264 pairs have s ≤ 22, 280 have s ≤ 23),
    // and the 273rd smallest difference has the 128th smallest s, which is 15 (120 have s ≤ 14,
    // 136 have s ≤ 15). The interval is 20 − 23 = −3 to 20 − 15 = 5.
    const bug = analyzeBug("race-synthetic-1", worseRows());
    expect(bug.turns).toMatchObject({ hodges_lehmann_on_minus_off: "1", interval_on_minus_off: ["-3", "5"] });
    expect(bug.turns).not.toHaveProperty("hodges_lehmann_off_minus_on");
    // Off turns are 10..29 and on turns 11..30, so the arms share values and the interval's
    // coverage is approximate, which the record says next to it.
    expect(bug.turns?.interval_coverage_approximate).toBe(true);
  });

  it("reports the turns shift by hand on 3 against 3", () => {
    // On turns [3, 5, 9], off turns [1, 2, 4]: the on-minus-off differences sorted are
    // −1, 1, 1, 2, 3, 4, 5, 7, 8, so the median is 3; at 3 against 3, k = 1, so the interval is
    // [D(1), D(9)] = [−1, 8] at level 0.9. No value is shared, so the coverage is exact.
    const rows = [
      row("on", 1, false, { turns: 3 }),
      row("on", 2, false, { turns: 5 }),
      row("on", 3, false, { turns: 9 }),
      row("off", 4, false, { turns: 1 }),
      row("off", 5, false, { turns: 2 }),
      row("off", 6, false, { turns: 4 }),
    ];
    expect(analyzeBug("race-synthetic-1", rows).turns).toMatchObject({
      hodges_lehmann_on_minus_off: "3",
      interval_on_minus_off: ["-1", "8"],
      interval_level: "0.900000",
      interval_coverage_approximate: false,
    });
  });

  it("marks the coverage approximate when a value repeats within one arm only", () => {
    // Off turns [1, 1] repeat inside the off arm, and no value is shared with on [2, 3]: the
    // no-ties distribution still does not hold, so the coverage is approximate.
    const rows = [row("on", 1, false, { turns: 2 }), row("on", 2, false, { turns: 3 }), row("off", 3, false, { turns: 1 }), row("off", 4, false, { turns: 1 })];
    expect(analyzeBug("race-synthetic-1", rows).turns?.interval_coverage_approximate).toBe(true);
  });

  it("enters a solve test the futility rule stopped into Holm as p = 1", () => {
    // Both arms 0/6, with the reference token samples and distinct turn counts.
    const rows: AttemptRow[] = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push(row("off", 2 * i + 1, false, { tokens: ON_TOKENS[i] ?? 0, turns: 10 + i }));
      rows.push(row("on", 2 * i + 2, false, { tokens: OFF_TOKENS[i] ?? 0, turns: 30 - i }));
    }
    const bug = analyzeBug("race-synthetic-1", rows);
    expect(bug.futility).toEqual({ triggered: true, extreme: "floor" });
    const sample = (arm: Arm, field: "tokens" | "turns") => rows.filter((r) => r.arm === arm).map((r) => r[field]);
    const pTokens = mannWhitneyExact(sample("off", "tokens"), sample("on", "tokens"));
    // The turns are fully separated: 2 of the C(12, 6) = 924 splits are as extreme.
    const pTurns = mannWhitneyExact(sample("off", "turns"), sample("on", "turns"));
    expect(pTurns).toBeCloseTo(2 / 924, 12);
    const adjusted = holm([1, pTokens, pTurns]);
    expect(bug.tokens?.holm_p).toBe(adjusted[1]?.toFixed(6));
    expect(bug.turns?.holm_p).toBe(adjusted[2]?.toFixed(6));
  });

  it("says the tool made the bug worse when the on arm did worse and Holm rejects", () => {
    const bug = analyzeBug("race-synthetic-1", worseRows());
    expect(bug.made_worse.solve).toBe("worse");
    expect(bug.made_worse.tokens).toBe("worse");
    expect(bug.made_worse.statement).toContain("the on arm solved fewer");
    expect(bug.made_worse.statement).toContain("the on arm used more tokens");
  });

  it("says not worse when the on arm did better and Holm rejects", () => {
    const swapped = worseRows().map((r) => ({ ...r, arm: r.arm === "off" ? ("on" as const) : ("off" as const) }));
    const bug = analyzeBug("race-synthetic-1", swapped);
    expect(bug.arms.on).toMatchObject({ counted: 20, solved: 10 });
    expect(bug.made_worse.solve).toBe("not_worse");
    expect(bug.made_worse.tokens).toBe("not_worse");
    expect(bug.made_worse.statement).toContain("the on arm solved more");
    expect(bug.made_worse.statement).toContain("the on arm used fewer tokens");
  });

  it("calls a difference that Holm does not reject inconclusive, never a null", () => {
    const rows: AttemptRow[] = [];
    for (let i = 1; i <= 10; i += 1) {
      rows.push(row("off", i, i <= 4, { tokens: 1000 + i, turns: 5 }), row("on", 10 + i, i <= 3, { tokens: 1000 + i, turns: 5 }));
    }
    const bug = analyzeBug("race-synthetic-1", rows);
    expect(bug.made_worse.solve).toBe("inconclusive");
    expect(bug.made_worse.tokens).toBe("inconclusive");
    expect(bug.made_worse.statement).toContain("inconclusive at this sample size");
  });

  it("excludes infrastructure errors from every outcome and reports them apart", () => {
    const rows = [...worseRows(), row("on", 99, true, { status: "infrastructure_error", reruns: 2, grade1: null, grade2: null, tokens: 1 })];
    const bug = analyzeBug("race-synthetic-1", rows);
    expect(bug.arms.on).toMatchObject({ attempts: 21, counted: 20, solved: 2, infrastructure_errors: 1, reruns: 2 });
    const without = analyzeBug("race-synthetic-1", worseRows());
    expect(bug.solve).toEqual(without.solve);
    expect(bug.tokens).toEqual(without.tokens);
    expect(bug.turns).toEqual(without.turns);
  });

  it("counts an out-of-scope attempt as unsolved and reports it", () => {
    const rows = [row("off", 1, false, { out_of_scope: true, grade1: null, grade2: null }), row("on", 2, true)];
    const bug = analyzeBug("race-synthetic-1", rows);
    expect(bug.arms.off).toMatchObject({ counted: 1, solved: 0, out_of_scope: 1 });
  });

  it("counts grade disagreements, contamination and caps per arm", () => {
    const rows = [
      row("off", 1, true, { grade1: "fail" }),
      row("off", 2, false, { contaminated: true, cap: "turns" }),
      row("on", 3, false, { cap: "context_window", history_elisions: 7 }),
      row("on", 4, false, { history_elisions: 2 }),
    ];
    const bug = analyzeBug("race-synthetic-1", rows);
    expect(bug.arms.off).toMatchObject({ grade_disagreements: 1, contaminated: 1, capped: 1, solved: 1 });
    expect(bug.arms.off.caps).toEqual({ turns: 1, input_tokens: 0, wall: 0, context_window: 0 });
    expect(bug.arms.on.caps).toEqual({ turns: 0, input_tokens: 0, wall: 0, context_window: 1 });
    expect(bug.arms.on).toMatchObject({ attempts_with_elisions: 2, history_elisions: 9 });
    expect(bug.arms.off).toMatchObject({ attempts_with_elisions: 0, history_elisions: 0 });
  });

  it("refuses a counted in-scope attempt without the authoritative grade", () => {
    expect(() => analyzeBug("race-synthetic-1", [row("off", 1, true, { grade2: null })])).toThrow("has no grade 2");
  });
});

/** Rows for one bug with the given token counts per arm (all unsolved, one turn each). */
function tokenRows(off: readonly number[], on: readonly number[]): AttemptRow[] {
  return [
    ...off.map((tokens, i) => row("off", i + 1, false, { tokens })),
    ...on.map((tokens, i) => row("on", 100 + i, false, { tokens })),
  ];
}

describe("the registered token ratio", () => {
  // Pre-registration, Outcomes 2: "Estimate: the Hodges–Lehmann shift on natural-log tokens, on
  // minus off, reported as the ratio exp(shift) with its 95% interval (the exponentiated interval
  // endpoints)." Each log difference ln(on) − ln(off) is ln(on / off), so the ratio is the median
  // of the pairwise ratios on / off (the geometric mean of the two middle ones for an even count),
  // and the interval ends are pairwise ratios.

  it("is the median pairwise ratio on over off, by hand on 3 against 3", () => {
    // Off [100, 200, 400], on [50, 100, 200]. The nine ratios on / off, sorted:
    // 0.125, 0.25, 0.25, 0.5, 0.5, 0.5, 1, 1, 2. The median (5th) is 0.5. At 3 against 3, k = 1,
    // so the interval is [R(1), R(9)] = [0.125, 2] at level 0.9. A raw-token shift would give
    // −100 here (the median of the raw differences), never a ratio. 100 and 200 appear in both
    // arms, so the coverage is approximate.
    const tokens = analyzeBug("race-synthetic-1", tokenRows([100, 200, 400], [50, 100, 200])).tokens;
    expect(tokens).toMatchObject({
      ratio_on_over_off: "0.500000",
      ratio_interval_on_over_off: ["0.125000", "2.000000"],
      interval_level: "0.900000",
      interval_coverage_approximate: true,
    });
    expect(tokens).not.toHaveProperty("hodges_lehmann_off_minus_on");
  });

  it("takes the geometric mean of the two middle ratios for an even count, by hand", () => {
    // Off [100, 400], on [100]: ratios 0.25 and 1. The log median is (ln 0.25 + ln 1) / 2, so the
    // ratio is √0.25 = 0.5 (a raw-token median would be −150). At 1 against 2, P(U = 0) = 1/3, so
    // k = 1 and the interval is [0.25, 1] at level 1 − 2/3.
    expect(analyzeBug("race-synthetic-1", tokenRows([100, 400], [100])).tokens).toMatchObject({
      ratio_on_over_off: "0.500000",
      ratio_interval_on_over_off: ["0.250000", "1.000000"],
      interval_level: "0.333333",
    });
  });

  it("reads 0.75 for an on arm that uses exactly 25% fewer tokens", () => {
    // On = 0.75 × off, value by value. The ratios are 0.75 × off(i) / off(j); the log terms
    // ln(off(i) / off(j)) are symmetric about 0 (i = j gives 0), so the median ratio is exactly
    // 0.75, the registered 25% reduction, and the interval ends multiply to 0.75².
    const off = [400, 800, 1200, 2000, 2400, 3200, 4000, 6000];
    const on = off.map((value) => (value * 3) / 4);
    const tokens = analyzeBug("race-synthetic-1", tokenRows(off, on)).tokens;
    expect(tokens?.ratio_on_over_off).toBe("0.750000");
    const [lower, upper] = (tokens?.ratio_interval_on_over_off ?? ["0", "0"]).map(Number);
    expect((lower ?? 0) * (upper ?? 0)).toBeCloseTo(0.5625, 5);
    expect(lower).toBeLessThan(0.75);
    expect(upper).toBeGreaterThan(0.75);
  });

  it("takes the registered 128th and 273rd of the 400 ordered ratios on 20 against 20", () => {
    // In worseRows the on arm's tokens are OFF_TOKENS and the off arm's ON_TOKENS. Sorting the 400
    // ratios on / off: the 128th is 980765 / 880999 = 1.113242, the 273rd is 1100234 / 795432 =
    // 1.383191, and the middle two (200th and 201st) are 1020456 / 820456 and 870654 / 699321,
    // whose geometric mean is 1.244383. The same values by brute force first.
    const ratios = OFF_TOKENS.flatMap((on) => ON_TOKENS.map((off) => on / off)).sort((a, b) => a - b);
    const bug = analyzeBug("race-synthetic-1", worseRows());
    expect(bug.tokens).toMatchObject({
      ratio_on_over_off: Math.sqrt((ratios[199] ?? 0) * (ratios[200] ?? 0)).toFixed(6),
      ratio_interval_on_over_off: [(ratios[127] ?? 0).toFixed(6), (ratios[272] ?? 0).toFixed(6)],
    });
    expect(bug.tokens).toMatchObject({ ratio_on_over_off: "1.244383", ratio_interval_on_over_off: ["1.113242", "1.383191"] });
    expect(bug.tokens?.interval_coverage_approximate).toBe(false);
    expect(Number(bug.tokens?.interval_level)).toBeGreaterThanOrEqual(0.95);
  });

  it("states the token figure as a ratio on over off", () => {
    const bug = analyzeBug("race-synthetic-1", worseRows());
    expect(bug.made_worse.statement).toContain("token ratio on over off 1.244383, interval 1.113242 to 1.383191");
  });

  it("refuses a counted attempt with no tokens, which has no logarithm", () => {
    expect(() => analyzeBug("race-synthetic-1", tokenRows([0, 100], [100]))).toThrow("positive token count");
  });
});

describe("the futility rule", () => {
  it("triggers at the floor when both arms are 0/6 after 6 each", () => {
    const rows = [1, 2, 3, 4, 5, 6].flatMap((i) => [row("off", i, false), row("on", 10 + i, false)]);
    expect(futility(rows.filter((r) => r.arm === "off"), rows.filter((r) => r.arm === "on"))).toEqual({ triggered: true, extreme: "floor" });
    const bug = analyzeBug("race-synthetic-1", rows);
    expect(bug.solve).toBeNull();
    expect(bug.made_worse.solve).toBe("not_tested");
    expect(bug.made_worse.statement).toContain("futility rule");
  });

  it("triggers at the ceiling when both are 6/6, judged on the first 6 by index", () => {
    const rows = [1, 2, 3, 4, 5, 6].flatMap((i) => [row("off", i, true), row("on", 10 + i, true)]);
    rows.push(row("off", 50, false), row("on", 51, false));
    const off = rows.filter((r) => r.arm === "off");
    const on = rows.filter((r) => r.arm === "on");
    expect(futility(off, on)).toEqual({ triggered: true, extreme: "ceiling" });
  });

  it("does not trigger when only one arm is at an extreme, or before 6 each", () => {
    const mixed = [1, 2, 3, 4, 5, 6].flatMap((i) => [row("off", i, false), row("on", 10 + i, i === 1)]);
    expect(futility(mixed.filter((r) => r.arm === "off"), mixed.filter((r) => r.arm === "on"))).toEqual({ triggered: false });
    const short = [1, 2, 3, 4, 5].flatMap((i) => [row("off", i, false), row("on", 10 + i, false)]);
    expect(futility(short.filter((r) => r.arm === "off"), short.filter((r) => r.arm === "on"))).toEqual({ triggered: false });
  });

  it("skips infrastructure errors when taking the first 6", () => {
    // Both arms 6/6. Taken among the on arm's first 6 (indexes 11 to 16), the never-solved
    // infrastructure row at index 9 would leave that arm at 5/6 and the rule untriggered.
    const rows = [1, 2, 3, 4, 5, 6].flatMap((i) => [row("off", i, true), row("on", 10 + i, true)]);
    rows.push(row("on", 9, false, { status: "infrastructure_error", grade1: null, grade2: null }));
    expect(futility(rows.filter((r) => r.arm === "off"), rows.filter((r) => r.arm === "on"))).toEqual({ triggered: true, extreme: "ceiling" });
  });
});

describe("the results record", () => {
  it("is canonical JSON with the claim scope, every bug and the per-attempt table", () => {
    const rows = [...worseRows(), ...worseRows().map((r) => ({ ...r, bug_id: "race-synthetic-2" }))];
    const record = analyze(rows);
    const json = resultsRecordJson(record);
    expect(parseCanonical(new TextEncoder().encode(json))).toEqual(JSON.parse(json));
    expect(record.bugs.map((bug) => bug.bug_id)).toEqual(["race-synthetic-1", "race-synthetic-2"]);
    expect(record.attempts).toHaveLength(80);
    expect(record.claim_scope).toContain("not an estimate of the tool's effect");
    expect(record.attempts[0]).toMatchObject({ bug_id: "race-synthetic-1", arm: "off", index: 1, solved: true, grades_disagree: false });
  });

  it("refuses two rows for one index", () => {
    expect(() => analyze([row("off", 1, true), row("off", 1, false)])).toThrow("appears twice");
  });
});
