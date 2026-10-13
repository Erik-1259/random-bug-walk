// The log scrub of rebuild_restart, the same in both arms. rbw-start prints the last 50 lines of
// the Umami and Postgres logs to stderr when it fails, and copies the output of check-db.js and
// update-tracker.js when they run; that is runtime output, which reaches the agent only through
// server_logs (the on arm). The scrub keeps rbw-start's own lines, each on the stream rbw-start
// writes it to, and drops every other line, so nothing the app or the database wrote passes
// through rebuild_restart.

/** On stdout: the readiness timings and the listening sockets. */
const KEPT_STDOUT = /^(?:postgres_ready_ms=\d+|ready_ms=\d+ budget_ms=\d+ within_budget=(?:yes|no)|listening tcp6? \S+)$/;
/** On stderr: rbw-start's failure message (the log tails it prints after it are dropped). */
const KEPT_STDERR = /^rbw-start: /;

export interface Scrubbed {
  text: string;
  /** Lines removed; the agent sees only their count. */
  withheld: number;
}

/** rbw-start's output with every line that is not its own removed, stdout's lines before stderr's. */
export function scrubStartOutput(stdout: string, stderr: string): Scrubbed {
  const kept: string[] = [];
  let withheld = 0;
  const take = (text: string, pattern: RegExp): void => {
    for (const line of text.split("\n")) {
      if (line === "") continue;
      if (pattern.test(line)) kept.push(line);
      else withheld += 1;
    }
  };
  take(stdout, KEPT_STDOUT);
  take(stderr, KEPT_STDERR);
  if (withheld > 0) kept.push(`[${String(withheld)} lines of runtime output withheld]`);
  return { text: kept.length === 0 ? "" : `${kept.join("\n")}\n`, withheld };
}

/** The last `limit` bytes of a text, marked when cut, for build output returned to the agent. */
export function tailText(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  return `[first ${String(bytes.length - limit)} bytes omitted]\n${bytes.subarray(bytes.length - limit).toString("utf8")}`;
}
