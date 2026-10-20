// The calendar window: on the 2nd to the 5th of a month (UTC) two of Umami's own revenue tests
// fail on an unmodified copy, because the suite seeds purchases 1, 3 and 5 days before the run and
// the app's session salt changes at the start of each month (packages/umami-driver README, Known
// limits). A run that touches any of those days could not qualify a case, so it is not offered.
import type { HostAvailability } from "@rbw/factory-contract";
import { UmamiRefusal } from "./errors.ts";

const DAY_MS = 86_400_000;
const FIRST_BLOCKED_DAY = 2;
const LAST_BLOCKED_DAY = 5;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export const CALENDAR_REASON =
  "Umami cases cannot run on the 2nd to the 5th of a month (UTC): on those days two of Umami's own revenue tests fail on an unmodified copy.";

function instant(value: string, name: string): number {
  const ms = UTC_TIME.test(value) ? Date.parse(value) : Number.NaN;
  // The round trip refuses calendar dates that do not exist, such as 2026-02-30.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new UmamiRefusal("time_invalid", `${name} is not a UTC time`);
  }
  return ms;
}

const blocked = (ms: number): boolean => {
  const day = new Date(ms).getUTCDate();
  return day >= FIRST_BLOCKED_DAY && day <= LAST_BLOCKED_DAY;
};

/**
 * Unavailable when any instant from `from` to `until` (inclusive) falls on UTC day 2 to 5 of a
 * month. Throws `time_invalid` for a malformed time or a window that ends before it starts.
 */
export function calendarAvailability(from: string, until: string): HostAvailability {
  const start = instant(from, "from");
  const end = instant(until, "until");
  if (end < start) throw new UmamiRefusal("time_invalid", "until is before from");
  // Every UTC day the window touches: its first day, then each following midnight up to the end.
  const firstMidnight = Math.floor(start / DAY_MS) * DAY_MS;
  for (let day = firstMidnight; day <= end; day += DAY_MS) {
    if (blocked(Math.max(day, start))) return { available: false, reason: CALENDAR_REASON };
  }
  return { available: true, reason: null };
}
