/** Micro-USD as dollars: two decimals, more only when the amount is not a whole cent ($0.70, $0.595). */
export function formatUsd(microusd: number): string {
  const sign = microusd < 0 ? "-" : "";
  const absolute = Math.abs(microusd);
  const whole = Math.floor(absolute / 1_000_000);
  const fraction = String(absolute % 1_000_000).padStart(6, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return `${sign}$${String(whole)}.${trimmed.length <= 2 ? fraction.slice(0, 2) : trimmed}`;
}
