import type { RouteContext } from '../server.ts';
import { HttpError } from '../http/errors.ts';
import { sendJson } from '../http/respond.ts';
import { parseCalendarDate } from '../time/calendar-date.ts';
import { localDayWindow } from '../time/local-day.ts';
import { isValidTimeZone } from '../time/time-zone.ts';
import { countCompletions } from './store.ts';

const KNOWN = new Set(['date', 'time_zone']);

function single(params: URLSearchParams, name: string): string {
  const values = params.getAll(name);
  if (values.length !== 1) throw new HttpError('validation_failed', { field: name });
  return values[0]!;
}

export async function dailyReport({ res, pool, query }: RouteContext): Promise<void> {
  const params = new URLSearchParams(query);
  const dateText = single(params, 'date');
  const date = parseCalendarDate(dateText);
  if (date === null) throw new HttpError('validation_failed', { field: 'date' });
  const timeZone = single(params, 'time_zone');
  if (!isValidTimeZone(timeZone)) throw new HttpError('validation_failed', { field: 'time_zone' });
  for (const name of params.keys()) {
    if (!KNOWN.has(name)) throw new HttpError('validation_failed', { field: name });
  }
  const window = localDayWindow(date, timeZone);
  const start = new Date(window.start).toISOString();
  const end = new Date(window.end).toISOString();
  const count = await countCompletions(pool, start, end);
  sendJson(res, 200, { date: dateText, time_zone: timeZone, start, end, count });
}
