export type LogValue = string | number | null;

/**
 * The publisher's one logger. It writes key=value lines to stderr (or the sink a caller
 * passes). Callers pass IDs, counts, statuses, store keys and codes; never file contents,
 * redaction values, credentials, the pattern file or staged paths.
 */
export class Logger {
  private readonly sink: (line: string) => void;

  constructor(sink: (line: string) => void) {
    this.sink = sink;
  }

  event(name: string, fields: Record<string, LogValue> = {}): void {
    const parts = ["publisher", `event=${name}`];
    for (const [key, value] of Object.entries(fields)) {
      const text = value === null ? "-" : String(value);
      parts.push(`${key}=${/^[A-Za-z0-9._:/-]+$/.test(text) ? text : JSON.stringify(text)}`);
    }
    this.sink(`${parts.join(" ")}\n`);
  }
}
