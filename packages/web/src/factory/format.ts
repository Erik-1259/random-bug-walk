// Display-only helpers for the /factory page: how amounts, times and service messages read.
// Nothing here changes what the browser sends or decides; every gate keeps using the exact
// micro-dollar amounts and the service's own codes. Erasable syntax only (type imports, no enums):
// test/factory-test-mode-browser.mjs imports this file through Node's type stripping.
import type { Capabilities, RequestStatus } from "./client.ts";

const MICRO_PER_CENT = 10_000;

/** "down" never shows more than there is (remaining, available); "up" never shows less (worst cases, limits). */
export type Rounding = "down" | "up" | "nearest";

/** A micro-dollar amount as dollars and cents: "$0.59", "-$0.05", "<$0.01" for a fraction of a cent. */
export function formatUsd(microusd: number, rounding: Rounding = "nearest"): string {
  const round = rounding === "down" ? Math.floor : rounding === "up" ? Math.ceil : Math.round;
  const cents = round(microusd / MICRO_PER_CENT);
  if (cents === 0 && microusd !== 0) return microusd > 0 ? "<$0.01" : "-<$0.01";
  const sign = cents < 0 ? "-" : "";
  const magnitude = Math.abs(cents);
  return `${sign}$${(magnitude / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The exact amount the service reported, with up to six decimals ("$0.346482"), for the Details views. */
export function formatExactUsd(microusd: number): string {
  return `$${(microusd / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

/** A budget for the input field: "2.00", or every significant decimal when the amount is not whole cents. */
export function formatBudgetInput(microusd: number): string {
  const whole = Math.floor(microusd / 1_000_000);
  const fraction = String(microusd % 1_000_000).padStart(6, "0");
  return `${String(whole)}.${microusd % MICRO_PER_CENT === 0 ? fraction.slice(0, 2) : fraction.replace(/0+$/, "")}`;
}

/** A duration: "45 s", "4 min 20 s", "1 h 5 min". Negative durations read as 0 s. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return minutes > 0 ? `${String(hours)} h ${String(minutes)} min` : `${String(hours)} h`;
  if (minutes > 0) return rest > 0 ? `${String(minutes)} min ${String(rest)} s` : `${String(minutes)} min`;
  return `${String(rest)} s`;
}

/** Time elapsed from `start` to `at`, as "+2 min 41 s"; independent of the viewer's time zone. */
export function formatOffset(start: string, at: string): string {
  return `+${formatDuration(Date.parse(at) - Date.parse(start))}`;
}

/** A clock time in the viewer's time zone (or the one given): "2:02:41 PM". */
export function formatClock(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", ...(timeZone === undefined ? {} : { timeZone }) }).format(new Date(iso));
}

/** A date and time with its zone named: "Oct 12, 2026, 5:52 PM UTC". */
export function formatDateTime(iso: string, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }).format(new Date(iso));
}

/** A long identifier cut to its first characters for display: "6e5f4274…". The full value stays elsewhere on the page. */
export function shortId(id: string, length = 8): string {
  return id.length > length ? `${id.slice(0, length)}…` : id;
}

export interface FriendlyMessage {
  title: string;
  body: string | null;
  /** The service's own text, `code: message` as the client reports it. */
  raw: string;
}

const NEEDS_OPERATOR = /operator/i;

/**
 * A plain heading and sentence for a message the client reports as `code: message`
 * (src/factory/client.ts). Unknown codes keep only the service's text.
 */
export function describeFactoryMessage(raw: string): FriendlyMessage {
  const code = /^([a-z_]+): /.exec(raw)?.[1] ?? null;
  switch (code) {
    case "busy":
      return NEEDS_OPERATOR.test(raw)
        ? { title: "Paused for an operator check", body: "Earlier work is waiting for an operator to confirm what it spent. New requests can start after that.", raw }
        : { title: "Another request is running", body: "The service runs one live request or validation at a time, for everyone. A request can take several minutes. Try again after it finishes.", raw };
    case "budget_unavailable":
      return { title: "Not enough shared budget left", body: "The shared judging budget cannot cover this request's budget right now. Try a smaller budget. When the shared budget is used up, new requests cannot start.", raw };
    case "passcode_incorrect":
      return { title: "That passcode didn't work", body: "Check the judge passcode and try again.", raw };
    case "unauthorized":
      return { title: "Please sign in again", body: "Your session has ended. Sign in with the judge passcode to continue.", raw };
    case "unavailable":
      return { title: "The request service isn't reachable right now", body: "Try again in a moment.", raw };
    case "interpretation_stale":
      return { title: "The requirements changed", body: "Review them again before starting.", raw };
    default:
      return { title: "The request service refused this", body: null, raw };
  }
}

/** A plain line for an unavailable service, keyed on its code; the service's own message is shown with it. */
export function describeServiceState(service: Capabilities["service"] | null): string {
  if (service === null) return "The request service did not answer, so no request can start right now.";
  if (service.state === "available") return "Reviewing your requirements is free. Starting a request spends from the shared judging budget, and one request runs at a time.";
  switch (service.code) {
    case "halted": return "Paused for an operator check. No new requests can start right now.";
    case "maintenance": return "Live requests are closed for maintenance right now.";
    case "not_configured": return "Live requests are not set up on this deployment.";
    default: return "Live requests are closed right now.";
  }
}

/** Why a request stopped, in plain words; the service's own sentence is shown with it. */
export function describeStopReason(status: Pick<RequestStatus, "stop_reason" | "limits">): string | null {
  const code = status.stop_reason?.code;
  switch (code) {
    case undefined: return null;
    case "fulfilled": return "Every requested case was delivered.";
    case "budget_exhausted": return "Stopped because the rest of this request's budget could not cover another attempt. Cases delivered before that stay available below.";
    case "time_limit": return `Stopped at the ${String(Math.round(status.limits.max_wall_clock_s / 60))}-minute time limit. Cases delivered before that stay available below.`;
    case "candidate_limit": return `Stopped after trying ${String(status.limits.max_candidates)} candidate bugs, the most one request may try.`;
    case "sources_exhausted": return "Every candidate bug available for this request was tried.";
    case "cancelled_by_user": return "Stopped at your request. Cases delivered before that stay available below.";
    case "worker_lost": return "The run stopped responding, so the service ended it. No replacement work was started.";
    case "needs_reconciliation": return "The run ended with spending that an operator still has to confirm.";
    case "operational_error": return "The run ended because of a service error.";
    default: return null;
  }
}

/** Plain words for a host and bug type combination's support status. */
export function describeSupport(status: string, reason: string | null): string {
  if (status === "supported") return "available";
  return isCalendarReason(reason) ? "not available today" : "not offered yet";
}

/**
 * A copy of CALENDAR_REASON in packages/host-umami/src/availability.ts, the reason the service gives
 * when Umami cases are refused on UTC days 2 to 5 of a month. A UI hint only: the service decides.
 */
export const UMAMI_CALENDAR_REASON =
  "Umami cases cannot run on the 2nd to the 5th of a month (UTC): on those days two of Umami's own revenue tests fail on an unmodified copy.";

export function isCalendarReason(reason: string | null): boolean {
  return reason === UMAMI_CALENDAR_REASON;
}

/** True when the service refuses a host's combinations because of the calendar window. */
export function closedByCalendar(capabilities: Capabilities, hostId: string): boolean {
  return capabilities.combinations.some((combination) => combination.host_id === hostId && isCalendarReason(combination.reason));
}

export const CALENDAR_HINT = "Not available today: Umami cases cannot run on the 2nd to the 5th of each month (UTC), because two of Umami's own tests fail on those days. They can run again from the 6th.";
