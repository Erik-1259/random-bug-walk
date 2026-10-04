import { appendFileSync } from "node:fs";

export type LogValue = string | number | null | undefined;

/**
 * The helper's host log: one line of key=value fields per event, written to stdout and
 * appended to a host-only file. Callers pass identifiers and categories, never request
 * text, matched text, terms, the pattern file's path or raw tool output.
 */
export class HostLog {
  private readonly file: string | null;

  constructor(file: string | null) {
    this.file = file;
  }

  write(fields: Record<string, LogValue>): void {
    const parts = [`time=${new Date().toISOString()}`];
    for (const [key, value] of Object.entries(fields)) {
      const text = value === null || value === undefined ? "-" : String(value);
      parts.push(`${key}=${/^[A-Za-z0-9._:/-]+$/.test(text) ? text : JSON.stringify(text)}`);
    }
    const line = `${parts.join(" ")}\n`;
    process.stdout.write(line);
    if (this.file !== null) appendFileSync(this.file, line, { mode: 0o600 });
  }

  event(message: string, fields: Record<string, LogValue> = {}): void {
    this.write({ event: message, ...fields });
  }
}
