export interface Fraction { numerator: bigint; denominator: bigint; decimal_usd?: string }
function gcd(a: bigint, b: bigint): bigint { while (b !== 0n) { const next = a % b; a = b; b = next; } return a; }
export function fraction(numerator: bigint, denominator: bigint): Fraction {
  const divisor = gcd(numerator, denominator);
  const n = numerator / divisor; const d = denominator / divisor;
  let remainderDenominator = d * 1000000n;
  for (const factor of [2n, 5n]) while (remainderDenominator % factor === 0n) remainderDenominator /= factor;
  if (remainderDenominator !== 1n) return { numerator: n, denominator: d };
  const usdDenominator = d * 1000000n;
  let decimal = (n / usdDenominator).toString(); let remainder = n % usdDenominator;
  if (remainder !== 0n) decimal += ".";
  while (remainder !== 0n) { remainder *= 10n; decimal += (remainder / usdDenominator).toString(); remainder %= usdDenominator; }
  return { numerator: n, denominator: d, decimal_usd: decimal };
}
export function add(a: Fraction, b: Fraction): Fraction {
  return fraction(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}
export function ceil(value: Fraction): bigint {
  return (value.numerator + value.denominator - 1n) / value.denominator;
}
