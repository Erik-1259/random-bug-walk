// Canonical JSON for records: keys sorted at every depth, no insignificant whitespace.
// Identical values give identical bytes.

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON cannot represent a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  throw new TypeError(`canonical JSON cannot represent a value of type ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}
