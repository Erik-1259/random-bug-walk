// Display-only helpers for the /factory page: how amounts, times and service messages read.
// Nothing here changes what the browser sends or decides; every gate keeps using the exact
// micro-dollar amounts and the service's own codes. Erasable syntax only (type imports, no enums):
// test/factory-test-mode-browser.mjs imports this file through Node's type stripping.
import type { Capabilities, FactoryEvent, RequestStatus } from "./client.ts";

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
 * (src/factory/client.ts). Unknown codes keep only the service's text, and a message the client
 * writes itself, without a code, is not called a refusal.
 */
export function describeFactoryMessage(raw: string): FriendlyMessage {
  const code = /^([a-z_]+): /.exec(raw)?.[1] ?? null;
  switch (code) {
    case "busy":
      return NEEDS_OPERATOR.test(raw)
        ? { title: "Paused for an operator check", body: "Earlier work is waiting for an operator to confirm what it spent. New requests can start after that.", raw }
        : { title: "Another request is running", body: "The service runs one live request or validation at a time, for everyone. A request can take several minutes. Try again after it finishes.", raw };
    case "budget_unavailable":
      return { title: "Not enough budget left", body: "The shared judging budget, or what is left of this request's own budget, cannot cover this right now. For a new request, try a smaller budget. When the shared budget is used up, new requests cannot start.", raw };
    case "passcode_incorrect":
      return { title: "That passcode didn't work", body: "Check the judge passcode and try again.", raw };
    case "unauthorized":
      return { title: "Please sign in again", body: "Your session has ended. Sign in with the judge passcode to continue.", raw };
    case "unavailable":
      return { title: "The request service isn't reachable right now", body: "Try again in a moment.", raw };
    case "interpretation_stale":
      return { title: "The requirements changed", body: "Review them again before starting.", raw };
    case "not_found":
      return { title: "Nothing was found with this ID", body: null, raw };
    case null:
      return { title: "Your saved request", body: null, raw };
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
    case "budget_exhausted": return "Stopped because the rest of this request's budget, or of the shared judging budget, could not cover another attempt. Cases delivered before that stay available below.";
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

export const CALENDAR_HINT = "Umami is unavailable on UTC days 2–5.";

const DAY_MS = 86_400_000;

/**
 * A copy of the rule in packages/host-umami/src/availability.ts: true when any instant from `fromMs`
 * to `untilMs` (inclusive) falls on UTC day 2 to 5 of a month. A UI hint only: the service decides.
 */
export function calendarBlocks(fromMs: number, untilMs: number): boolean {
  for (let day = Math.floor(fromMs / DAY_MS) * DAY_MS; day <= untilMs; day += DAY_MS) {
    const date = new Date(Math.max(day, fromMs)).getUTCDate();
    if (date >= 2 && date <= 5) return true;
  }
  return false;
}

/**
 * True when the calendar closes a host now: the capabilities say so, or (with a clock, for a page
 * whose capabilities were read earlier) a request started at `nowMs` would touch a blocked day.
 */
export function hostClosedByCalendar(capabilities: Capabilities, hostId: string, nowMs: number | null = null): boolean {
  if (closedByCalendar(capabilities, hostId)) return true;
  return hostId === "umami" && nowMs !== null && calendarBlocks(nowMs, nowMs + capabilities.limits.max_wall_clock_s * 1000);
}

/** The hosts the calendar closes now, in capabilities order. */
export function calendarClosedHosts(capabilities: Capabilities | null, nowMs: number | null = null): string[] {
  return capabilities === null ? [] : capabilities.hosts.map((host) => host.host_id).filter((hostId) => hostClosedByCalendar(capabilities, hostId, nowMs));
}

/** True when the host would offer this bug type but the calendar closes it now. */
export function calendarClosesPair(capabilities: Capabilities, hostId: string, bugTypeId: string, nowMs: number | null = null): boolean {
  const combination = capabilities.combinations.find((item) => item.host_id === hostId && item.bug_type_id === bugTypeId);
  if (combination === undefined) return false;
  return isCalendarReason(combination.reason) || (combination.status === "supported" && hostClosedByCalendar(capabilities, hostId, nowMs));
}

/**
 * The next instant after `nowMs` when the clock rule opens or closes Umami for a request window of
 * `windowMs`, or null. The rule changes only at a UTC midnight or one window before one.
 */
export function nextCalendarChange(nowMs: number, windowMs: number): number | null {
  const blocked = calendarBlocks(nowMs, nowMs + windowMs);
  const firstDay = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const candidates: number[] = [];
  for (let day = firstDay; day <= firstDay + 40 * DAY_MS; day += DAY_MS) candidates.push(day - windowMs, day);
  candidates.sort((a, b) => a - b);
  return candidates.find((instant) => instant > nowMs && calendarBlocks(instant, instant + windowMs) !== blocked) ?? null;
}

/** The longest delay setTimeout accepts. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** How long a page waits before it rereads its clock for the calendar, or null when it need not. */
export function calendarClockDelay(capabilities: Capabilities | null, nowMs: number): number | null {
  if (capabilities === null) return null;
  const next = nextCalendarChange(nowMs, capabilities.limits.max_wall_clock_s * 1000);
  return next === null ? null : Math.min(next - nowMs, MAX_TIMEOUT_MS);
}

/** The line that offers the task-and-report service while Umami is closed, or null when it offers nothing either. */
export function calendarFallback(capabilities: Capabilities | null): string | null {
  if (capabilities === null) return null;
  const host = capabilities.hosts.find((item) => item.host_id === "task-report");
  const offered = capabilities.combinations.some((item) => item.host_id === "task-report" && item.status === "supported");
  return host === undefined || !offered ? null : `The ${host.label} is still available.`;
}

/**
 * A plain line for an event, for the latest-update line; the activity log keeps the service's own
 * text. Budget bookkeeping events have no line of their own (null), and unknown types keep their text.
 */
export function describeEvent(event: Pick<FactoryEvent, "type" | "host_id" | "message">, hostLabels: Readonly<Record<string, string>> = {}): string | null {
  const host = event.host_id === null ? "the application" : hostLabels[event.host_id] ?? event.host_id;
  switch (event.type) {
    case "budget_updated": return null;
    case "request_accepted": return "Request accepted.";
    case "worker_started": return "The run started.";
    case "host_preparing": return `Preparing a fresh copy of ${host}.`;
    case "host_ready": return `The copy of ${host} is ready.`;
    case "candidate_selected": return `Trying a candidate bug on ${host}.`;
    case "check_finished": return `A check finished on ${host}.`;
    case "behavior_checks_passed": return "A candidate bug passed its behavior checks.";
    case "requested_criteria_passed": return "A candidate bug matches what you asked for.";
    case "candidate_rejected": case "candidate_invalid": case "candidate_incomplete": case "candidate_skipped": return "A candidate bug was set aside.";
    case "package_ready": return "A case's downloads are packaged; delivery comes next.";
    case "case_delivered": return "A case was delivered.";
    case "stop_requested": return "Stop requested.";
    case "validation_started": return "Validation started.";
    case "validation_finished": return "Validation finished.";
    default: return event.message;
  }
}
