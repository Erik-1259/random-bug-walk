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
    tokens: 0,
    turns: 0,
    cap: null,
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
    // Off tokens are the on reference sample and vice versa, so the shift is −172928.5.
    expect(bug.tokens).toMatchObject({ hodges_lehmann_off_minus_on: "-172928.5", interval: ["-269778", "-84691"], mann_whitney_p: "0.000258" });
    const p = [0.013814147852, 0.000257973808, Number(bug.turns?.mann_whitney_p)];
    const adjusted = holm(p);
    expect(bug.solve?.holm_p).toBe(adjusted[0]?.toFixed(6));
    expect(bug.tokens?.holm_p).toBe(adjusted[1]?.toFixed(6));
  });

  it("says the tool made the bug worse when the on arm did worse and Holm rejects", () => {
    const bug = analyzeBug("race-synthetic-1", worseRows());
    expect(bug.made_worse.solve).toBe("worse");
    expect(bug.made_worse.tokens).toBe("worse");
    expect(bug.made_worse.statement).toContain("the on arm solved fewer");
    expect(bug.made_worse.statement).toContain("the on arm used more tokens");
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
      row("on", 3, false),
    ];
    const bug = analyzeBug("race-synthetic-1", rows);
    expect(bug.arms.off).toMatchObject({ grade_disagreements: 1, contaminated: 1, capped: 1, solved: 1 });
  });

  it("refuses a counted in-scope attempt without the authoritative grade", () => {
    expect(() => analyzeBug("race-synthetic-1", [row("off", 1, true, { grade2: null })])).toThrow("has no grade 2");
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
    const rows = [1, 2, 3, 4, 5, 6].flatMap((i) => [row("off", i, false), row("on", 10 + i, false)]);
    rows.push(row("on", 9, true, { status: "infrastructure_error", grade1: null, grade2: null }));
    expect(futility(rows.filter((r) => r.arm === "off"), rows.filter((r) => r.arm === "on"))).toEqual({ triggered: true, extreme: "floor" });
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
