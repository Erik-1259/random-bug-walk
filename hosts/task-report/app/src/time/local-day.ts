import { daysInMonth, type CalendarDate } from './calendar-date.ts';

const HOUR = 3_600_000;

function nextDate({ year, month, day }: CalendarDate): CalendarDate {
  if (day < daysInMonth(year, month)) return { year, month, day: day + 1 };
  if (month < 12) return { year, month: month + 1, day: 1 };
  return { year: year + 1, month: 1, day: 1 };
}

function dateKey({ year, month, day }: CalendarDate): number {
  return year * 10_000 + month * 100 + day;
}

function localDateKey(format: Intl.DateTimeFormat, instant: number): number {
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(instant)) parts[part.type] = Number(part.value);
  return dateKey({ year: parts.year!, month: parts.month!, day: parts.day! });
}

// C-8, C-9: the earliest instant whose local date in the zone is on or after `date`.
function startOf(date: CalendarDate, format: Intl.DateTimeFormat): number {
  const target = dateKey(date);
  const midnight = Date.UTC(date.year, date.month - 1, date.day);
  let low = midnight - 26 * HOUR;
  let high = midnight + 26 * HOUR;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDateKey(format, middle) >= target) high = middle;
    else low = middle;
  }
  return high;
}

export function localDayWindow(date: CalendarDate, zone: string): { start: number; end: number } {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
  });
  return { start: startOf(date, format), end: startOf(nextDate(date), format) };
}
