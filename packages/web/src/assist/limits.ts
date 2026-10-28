// The bug designer's caps: per-session and per-instance request limits over a sliding hour, kept in
// this server instance's memory, and the input and output sizes every call stays within. The limits
// bound what the designer can spend; they are not shared across instances.

export type AssistRoute = "bug-shapes" | "bug-spec" | "delivery-brief";

export const WINDOW_MS = 3_600_000;
/** Accepted calls per session per hour, by route. */
export const SESSION_LIMITS: Record<AssistRoute, number> = { "bug-shapes": 20, "bug-spec": 20, "delivery-brief": 10 };
/** Accepted calls per server instance per hour, every route and session together. */
export const INSTANCE_LIMIT = 300;

/** Each provider call is abandoned after this long, and nothing retries. */
export const PROVIDER_TIMEOUT_MS = 20_000;

export const QUERY_MIN_CHARS = 3;
export const QUERY_MAX_CHARS = 300;
export const SHAPE_TITLE_MAX_CHARS = 200;
export const SHAPE_SUMMARY_MAX_CHARS = 1200;
export const SHAPE_MAX_SOURCES = 8;
export const SOURCE_TITLE_MAX_CHARS = 300;
export const SOURCE_URL_MAX_CHARS = 2048;

/** Search results kept for the model, and the excerpt of each. */
export const SEARCH_MAX_RESULTS = 8;
export const EXCERPT_MAX_CHARS = 300;
/** The incident text sent to the model for a delivery brief. */
export const INCIDENT_MAX_CHARS = 6000;
/** The largest bug-case archive the brief unpacks. */
export const BUG_CASE_MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
export const NOVELTY_MAX_PHRASES = 3;
export const NOVELTY_MAX_RESULTS = 3;

/** Output token caps per model call. */
export const MAX_TOKENS: Record<AssistRoute, number> = { "bug-shapes": 2500, "bug-spec": 1800, "delivery-brief": 1500 };

export type LimitResult = { ok: true } | { ok: false; retry_after_s: number };

/** A sliding-window counter: a call counts once accepted, and drops out an hour later. */
export class RateLimiter {
  private readonly sessions = new Map<string, number[]>();
  private instance: number[] = [];

  /** Accepts and counts the call, or answers how long until one more would be accepted. */
  take(route: AssistRoute, session: string, now: number): LimitResult {
    const key = `${route}\u0000${session}`;
    const since = now - WINDOW_MS;
    const mine = (this.sessions.get(key) ?? []).filter((at) => at > since);
    this.instance = this.instance.filter((at) => at > since);
    const wait = (times: readonly number[]): number => Math.max(1, Math.ceil(((times[0] ?? now) + WINDOW_MS - now) / 1000));
    if (mine.length >= SESSION_LIMITS[route]) {
      this.sessions.set(key, mine);
      return { ok: false, retry_after_s: wait(mine) };
    }
    if (this.instance.length >= INSTANCE_LIMIT) {
      this.sessions.set(key, mine);
      return { ok: false, retry_after_s: wait(this.instance) };
    }
    mine.push(now);
    this.instance.push(now);
    this.sessions.set(key, mine);
    return { ok: true };
  }
}
