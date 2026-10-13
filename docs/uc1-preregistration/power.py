"""Detectable-difference tables for the UC1 pre-registration (k = 20 attempts per arm).

Standard library only. Run from the repository root:

    python3 docs/uc1-preregistration/power.py            # print the generated block
    python3 docs/uc1-preregistration/power.py --check    # exit 1 if the doc's block differs

`--doc PATH` checks another copy of the doc (the repository's tests use it on a changed copy).

Solve outcome: exact power of the two-sided Fisher exact test, by full enumeration of the
21 x 21 outcome tables. The rejection region is computed with exact rational arithmetic; the
power sums binomial probabilities over that region, minus the probability that the registered
futility rule stops the solve test (both arms 0/FUTILITY_N or both FUTILITY_N/FUTILITY_N in
their first FUTILITY_N attempts), since a stopped test is fixed at p = 1. Nothing here is
simulated or measured.

Tokens and turns: power of the two-sided exact Mann-Whitney test (exact null distribution of U,
no ties) under a normal location shift in SD units, by seeded Monte Carlo. Mann-Whitney is
rank-based, so the same shift applies to log tokens under a lognormal model.
"""

from __future__ import annotations

import argparse
import math
import random
import sys
from bisect import bisect_left
from fractions import Fraction
from functools import cache
from pathlib import Path

K = 20  # attempts per arm
FUTILITY_N = 6  # the futility rule looks at each arm's first 6 counted attempts
POWER = 0.80
ALPHAS = (Fraction(5, 100), Fraction(5, 300))  # alpha 0.05, and Holm's first step at 0.05 / 3
BASE_RATES = tuple(range(0, 101, 5))  # off-arm solve rate, percentage points
MC_SEED = 20261013
MC_REPS = 20000
SHIFT_STEP = Fraction(5, 100)  # SD units

DOC = Path(__file__).resolve().parent.parent / "uc1-preregistration.md"
BEGIN = "<!-- BEGIN GENERATED: docs/uc1-preregistration/power.py -->"
END = "<!-- END GENERATED -->"


class CheckFailed(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CheckFailed(message)


# ---------- Fisher exact test ----------


@cache
def fisher_p(x0: int, x1: int, n: int = K) -> Fraction:
    """Two-sided Fisher exact p for x0/n versus x1/n: the sum of the probabilities of all
    tables with the same margins whose probability is at most the observed one (the
    convention of R's fisher.test, evaluated exactly rather than with a tolerance)."""
    total = x0 + x1
    denom = math.comb(2 * n, total)
    lo, hi = max(0, total - n), min(n, total)
    probs = {
        a: Fraction(math.comb(n, a) * math.comb(n, total - a), denom) for a in range(lo, hi + 1)
    }
    observed = probs[x0]
    return sum((p for p in probs.values() if p <= observed), Fraction(0))


@cache
def rejection_region(alpha: Fraction) -> frozenset[tuple[int, int]]:
    return frozenset(
        (x0, x1) for x0 in range(K + 1) for x1 in range(K + 1) if fisher_p(x0, x1) <= alpha
    )


def binom_pmf(n: int, p: float) -> list[float]:
    return [math.comb(n, x) * p**x * (1 - p) ** (n - x) for x in range(n + 1)]


def futility_joint(p: float) -> tuple[list[float], list[float]]:
    """P(first FUTILITY_N attempts all fail, total = x) and P(all succeed, total = x), x in 0..K."""
    rest = binom_pmf(K - FUTILITY_N, p)
    padding = [0.0] * FUTILITY_N
    none = [(1 - p) ** FUTILITY_N * r for r in rest + padding]
    every = [p**FUTILITY_N * r for r in padding + rest]
    return none, every


def fisher_power(p0: float, p1: float, alpha: Fraction) -> float:
    """Probability that Fisher's test runs and rejects: a run the futility rule stops (both arms
    0/FUTILITY_N or both FUTILITY_N/FUTILITY_N) is fixed at p = 1, so it never rejects."""
    f0, f1 = binom_pmf(K, p0), binom_pmf(K, p1)
    none0, every0 = futility_joint(p0)
    none1, every1 = futility_joint(p1)
    return sum(
        f0[x0] * f1[x1] - none0[x0] * none1[x1] - every0[x0] * every1[x1]
        for x0, x1 in rejection_region(alpha)
    )


def fisher_power_by_stage(p0: float, p1: float, alpha: Fraction) -> float:
    """The same probability by a separate route, for the self-check: enumerate each arm's
    successes in its first FUTILITY_N attempts and in the rest, and apply the rule directly."""
    head0, head1 = binom_pmf(FUTILITY_N, p0), binom_pmf(FUTILITY_N, p1)
    tail0, tail1 = binom_pmf(K - FUTILITY_N, p0), binom_pmf(K - FUTILITY_N, p1)
    total = 0.0
    heads = [(a0, a1) for a0 in range(FUTILITY_N + 1) for a1 in range(FUTILITY_N + 1)]
    tails = [(r0, r1) for r0 in range(K - FUTILITY_N + 1) for r1 in range(K - FUTILITY_N + 1)]
    for a0, a1 in heads:
        if a0 == a1 and a0 in (0, FUTILITY_N):
            continue
        for r0, r1 in tails:
            if fisher_p(a0 + r0, a1 + r1) <= alpha:
                total += head0[a0] * tail0[r0] * head1[a1] * tail1[r1]
    return total


def detectable(base: int, alpha: Fraction, direction: int) -> tuple[int, float] | None:
    """Smallest difference d (whole points) such that the power is at least POWER at d and at
    every larger feasible difference in that direction. None if no feasible difference has it."""
    found: tuple[int, float] | None = None
    for d in range(100, 0, -1):
        other = base + direction * d
        if not 0 <= other <= 100:
            continue
        power = fisher_power(base / 100, other / 100, alpha)
        if power >= POWER:
            found = (d, power)
        else:
            break
    return found


# ---------- Mann-Whitney ----------


@cache
def u_counts(m: int, n: int) -> tuple[int, ...]:
    """Number of orderings of m + n untied values giving each U from 0 to m * n."""
    if m == 0 or n == 0:
        return (1,)
    with_last_from_first = u_counts(m - 1, n)  # largest value from sample 1 adds n to U
    with_last_from_second = u_counts(m, n - 1)
    out = [0] * (m * n + 1)
    for u, c in enumerate(with_last_from_first):
        out[u + n] += c
    for u, c in enumerate(with_last_from_second):
        out[u] += c
    return tuple(out)


def mw_critical(m: int, n: int, alpha: Fraction) -> int:
    """Largest c such that P(min(U, mn - U) <= c) <= alpha under the null (two-sided)."""
    counts = u_counts(m, n)
    total = sum(counts)
    cumulative = 0
    critical = -1
    for c in range(m * n // 2 + 1):
        cumulative += counts[c]
        if Fraction(2 * cumulative, total) <= alpha:
            critical = c
        else:
            break
    return critical


def mw_detectable_shifts() -> dict[Fraction, tuple[Fraction, float]]:
    """For each alpha, the smallest shift on the SHIFT_STEP grid whose simulated power reaches
    POWER. The same seeded draws serve every shift and alpha (common random numbers)."""
    criticals = {alpha: mw_critical(K, K, alpha) for alpha in ALPHAS}
    rng = random.Random(MC_SEED)  # noqa: S311 - reproducible simulation, not security
    draws = [
        (sorted(rng.gauss(0.0, 1.0) for _ in range(K)), [rng.gauss(0.0, 1.0) for _ in range(K)])
        for _ in range(MC_REPS)
    ]
    found: dict[Fraction, tuple[Fraction, float]] = {}
    shift = Fraction(0)
    while len(found) < len(ALPHAS):
        require(shift <= 3, "no shift up to 3 SD reaches the target power")
        s = float(shift)
        rejected = dict.fromkeys(ALPHAS, 0)
        for a, b in draws:
            # U counts pairs with an off-arm value below a shifted on-arm value.
            u = sum(bisect_left(a, y + s) for y in b)
            for alpha, critical in criticals.items():
                if min(u, K * K - u) <= critical:
                    rejected[alpha] += 1
        for alpha in ALPHAS:
            power = rejected[alpha] / MC_REPS
            if alpha not in found and power >= POWER:
                found[alpha] = (shift, power)
        shift += SHIFT_STEP
    return found


# ---------- reference checks ----------


def self_check() -> None:
    # Fisher's tea-tasting table: two-sided p = 34/70 (R: 0.4857).
    tea = sum(
        (Fraction(math.comb(4, a) * math.comb(4, 4 - a), math.comb(8, 4)) for a in (0, 1, 3, 4)),
        Fraction(0),
    )
    require(tea == Fraction(34, 70), "tea-tasting reference")
    require(fisher_p(3, 1, 4) == Fraction(34, 70), "fisher_p tea-tasting")
    # 0/20 versus 6/20: both extreme tables, 2 * C(20,6) / C(40,6).
    require(fisher_p(0, 6) == Fraction(2 * 38760, 3838380), "fisher_p 0/20 vs 6/20")
    require(fisher_p(10, 10) == 1, "fisher_p equal arms")
    # Published Mann-Whitney critical values for n1 = n2 = 20, two-sided: 127 at 0.05, 105 at 0.01.
    require(mw_critical(20, 20, Fraction(5, 100)) == 127, "Mann-Whitney critical 0.05")
    require(mw_critical(20, 20, Fraction(1, 100)) == 105, "Mann-Whitney critical 0.01")
    require(sum(u_counts(20, 20)) == math.comb(40, 20), "Mann-Whitney null total")
    # The futility-aware solve power agrees with a stage-by-stage enumeration of the rule.
    for p0, p1 in ((0.0, 0.32), (0.25, 0.75), (0.5, 0.5), (1.0, 0.68)):
        for alpha in ALPHAS:
            joint = fisher_power(p0, p1, alpha)
            staged = fisher_power_by_stage(p0, p1, alpha)
            require(abs(joint - staged) < 1e-12, f"futility-aware power at {p0}, {p1}")


# ---------- output ----------


def pct(fraction: Fraction) -> str:
    return f"{float(fraction):.4f}".rstrip("0").rstrip(".")


def cell(result: tuple[int, float] | None) -> str:
    if result is None:
        return "none"
    d, power = result
    return f"{d} ({power:.3f})"


def size(base: int, alpha: Fraction) -> float:
    return fisher_power(base / 100, base / 100, alpha)


def generate() -> str:
    a05, a_holm = ALPHAS
    lines = [
        BEGIN,
        "",
        f"Solve outcome: smallest detectable difference in percentage points at {POWER:.0%} power,"
        f" k = {K} per arm, two-sided Fisher exact test, by exact enumeration. Each cell is"
        ' `difference (power at that difference)`. "Increase" means the on arm solves more'
        ' often than the off arm; "decrease" means it solves less often. `none` means no'
        ' difference within 0-100% reaches the power. "Size" is the actual false-positive'
        " rate when both arms share the base rate (Fisher is conservative at this size)."
        f" A run the futility rule stops counts as no rejection: both arms 0/{FUTILITY_N} or"
        f" both {FUTILITY_N}/{FUTILITY_N} in their first {FUTILITY_N} attempts fixes the solve"
        " test at p = 1.",
        "",
        f"| Off-arm base rate | Increase, alpha {pct(a05)} | Increase, alpha {pct(a_holm)}"
        f" | Decrease, alpha {pct(a05)} | Decrease, alpha {pct(a_holm)}"
        f" | Size, alpha {pct(a05)} | Size, alpha {pct(a_holm)} |",
        "|---|---|---|---|---|---|---|",
    ]
    for base in BASE_RATES:
        lines.append(
            f"| {base}% | {cell(detectable(base, a05, 1))} | {cell(detectable(base, a_holm, 1))}"
            f" | {cell(detectable(base, a05, -1))} | {cell(detectable(base, a_holm, -1))}"
            f" | {size(base, a05):.4f} | {size(base, a_holm):.4f} |"
        )
    lines += [
        "",
        f"Tokens and turns: smallest normal location shift (SD units, step {pct(SHIFT_STEP)})"
        f" detected with at least {POWER:.0%} power by the two-sided exact Mann-Whitney test,"
        f" k = {K} per arm, no ties. Monte Carlo, {MC_REPS} replicates, seed {MC_SEED}"
        " (standard error about 0.003 near 0.80).",
        "",
        "| Alpha | Mann-Whitney critical U | Detectable shift (SD) | Simulated power |",
        "|---|---|---|---|",
    ]
    shifts = mw_detectable_shifts()
    for alpha in ALPHAS:
        shift, power = shifts[alpha]
        lines.append(f"| {pct(alpha)} | {mw_critical(K, K, alpha)} | {pct(shift)} | {power:.3f} |")
    lines += ["", END]
    return "\n".join(lines) + "\n"


def doc_block(text: str) -> str | None:
    start, end = text.find(BEGIN), text.find(END)
    if start < 0 or end < start:
        return None
    return text[start : end + len(END)] + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="compare with the doc's block")
    parser.add_argument(
        "--doc", type=Path, default=DOC, help="the doc to check (default: %(default)s)"
    )
    args = parser.parse_args()
    try:
        self_check()
    except CheckFailed as error:
        sys.stderr.write(f"power: reference check failed: {error}\n")
        return 2
    block = generate()
    if not args.check:
        sys.stdout.write(block)
        return 0
    doc: Path = args.doc
    found = doc_block(doc.read_text(encoding="utf-8"))
    if found != block:
        sys.stderr.write(f"power: the generated block in {doc.name} is missing or differs\n")
        return 1
    sys.stdout.write(f"power: {doc.name} matches the generated block\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
