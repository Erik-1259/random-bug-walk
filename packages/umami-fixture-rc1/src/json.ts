const decoder = new TextDecoder("utf-8", { fatal: true });

export type JsonParse = { ok: true; value: unknown } | { ok: false; reason: string };

/** Decodes body bytes as strict UTF-8 JSON. Never throws; a failure says why without echoing the body. */
export function parseJsonBody(body: Uint8Array): JsonParse {
  let text: string;
  try {
    text = decoder.decode(body);
  } catch {
    return { ok: false, reason: "body is not UTF-8" };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "body is not JSON" };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The first line of an error message with each secret replaced. Playwright's request errors carry
 * a call log that can list request headers, so only the first line is ever kept.
 */
export function errorSummary(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  let summary = message.split("\n", 1)[0] ?? "";
  for (const secret of secrets) {
    if (secret !== "") {
      summary = summary.split(secret).join("[redacted]");
    }
  }
  return summary;
}
