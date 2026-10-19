import { daysInMonth } from './calendar-date.ts';

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const MIN = Date.UTC(1970, 0, 1);
const MAX = Date.UTC(2100, 0, 1);

// Returns epoch milliseconds, or null when the text is not a valid completed_at.
export function parseInstant(text: string): number | null {
  const match = INSTANT.exec(text);
  if (match === null) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const hour = Number(text.slice(11, 13));
  const minute = Number(text.slice(14, 16));
  const second = Number(text.slice(17, 19));
  const millisecond = match[1] === undefined ? 0 : Number(match[1].slice(1).padEnd(3, '0'));
  const zone = match[2]!;
  // Instants in range have a local year of 1969 to 2100.
  if (year < 1969 || year > 2100) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }
  const instant = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetMinutes * 60_000;
  return instant >= MIN && instant < MAX ? instant : null;
}
