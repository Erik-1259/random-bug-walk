import { expect, test } from '@playwright/test';
import { expectCommonHeaders, expectError, getReport, reportPath } from './helpers.ts';

// Dates read by this file: 1990-01-01 to 1999-12-31 (no test writes in those years).
const DAILY = '/api/reports/completions/daily';

test.describe('GET /api/reports/completions/daily: shape', () => {
  test('returns 200 with exactly date, time_zone, start, end and count', async ({ request }) => {
    const response = await request.get(reportPath('1990-06-15', 'UTC'));
    expect(response.status()).toBe(200);
    expectCommonHeaders(response.headers());
    expect(await response.json()).toEqual({
      date: '1990-06-15',
      time_zone: 'UTC',
      start: '1990-06-15T00:00:00.000Z',
      end: '1990-06-16T00:00:00.000Z',
      count: 0,
    });
  });

  test('time_zone is echoed exactly as given', async ({ request }) => {
    const nyStart = '1997-05-01T04:00:00.000Z';
    const nyEnd = '1997-05-02T04:00:00.000Z';
    for (const zone of ['America/New_York', 'america/new_york', 'AMERICA/NEW_YORK', 'US/Eastern']) {
      expect(await getReport(request, '1997-05-01', zone)).toEqual({
        date: '1997-05-01',
        time_zone: zone,
        start: nyStart,
        end: nyEnd,
        count: 0,
      });
    }
    for (const zone of ['Etc/UTC', 'Etc/GMT', 'Europe/London']) {
      const report = await getReport(request, '1997-01-10', zone);
      expect(report.time_zone).toBe(zone);
      expect(report.start).toBe('1997-01-10T00:00:00.000Z');
    }
  });

  test('values may be percent-encoded, and + must be encoded as %2B', async ({ request }) => {
    const encoded = await request.get(`${DAILY}?date=1998-03-03&time_zone=Etc%2FGMT%2B5`);
    expect(encoded.status()).toBe(200);
    expect(await encoded.json()).toMatchObject({ time_zone: 'Etc/GMT+5', start: '1998-03-03T05:00:00.000Z' });
    const rawSlash = await request.get(`${DAILY}?date=1998-03-03&time_zone=Etc/GMT%2B5`);
    expect(await rawSlash.json()).toMatchObject({ time_zone: 'Etc/GMT+5', start: '1998-03-03T05:00:00.000Z' });
    // A raw + decodes to a space, which no zone name contains.
    await expectError(await request.get(`${DAILY}?date=1998-03-03&time_zone=Etc/GMT+5`), 'validation_failed', 'time_zone');
    const encodedDate = await request.get(`${DAILY}?date=1998%2D03%2D04&time_zone=UTC`);
    expect(await encodedDate.json()).toMatchObject({ date: '1998-03-04', start: '1998-03-04T00:00:00.000Z' });
  });

  test('parameter order does not matter', async ({ request }) => {
    const response = await request.get(`${DAILY}?time_zone=UTC&date=1998-07-07`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ date: '1998-07-07', time_zone: 'UTC', count: 0 });
  });
});

test.describe('GET /api/reports/completions/daily: date', () => {
  test('accepts real Gregorian dates from 1970-01-01 to 2099-12-31', async ({ request }) => {
    for (const [date, end] of [
      ['1992-02-29', '1992-03-01T00:00:00.000Z'],
      ['1996-02-29', '1996-03-01T00:00:00.000Z'],
      ['1993-02-28', '1993-03-01T00:00:00.000Z'],
      ['1994-12-31', '1995-01-01T00:00:00.000Z'],
      ['1995-04-30', '1995-05-01T00:00:00.000Z'],
    ] as const) {
      const report = await getReport(request, date, 'UTC');
      expect(report.start).toBe(`${date}T00:00:00.000Z`);
      expect(report.end).toBe(end);
    }
  });

  test('rejects dates outside 1970-01-01 to 2099-12-31', async ({ request }) => {
    for (const date of ['1969-12-31', '2100-01-01', '0000-01-01', '1900-01-01', '9999-12-31']) {
      await expectError(await request.get(reportPath(date, 'UTC')), 'validation_failed', 'date');
    }
  });

  test('rejects impossible dates', async ({ request }) => {
    for (const date of ['1993-02-29', '1900-02-29', '1991-02-30', '1991-04-31', '1991-06-31', '1991-09-31', '1991-11-31', '1991-01-32', '1991-01-00', '1991-00-01', '1991-13-01']) {
      await expectError(await request.get(reportPath(date, 'UTC')), 'validation_failed', 'date');
    }
  });

  test('rejects other shapes', async ({ request }) => {
    for (const date of [
      '',
      '1991-1-01',
      '1991-01-1',
      '91-01-01',
      '01991-01-01',
      '1991/01/01',
      '19910101',
      '1991-01-01T00:00:00Z',
      '1991-01-01 ',
      ' 1991-01-01',
      '1991-01-01\n',
      '\u0661\u0669\u0669\u0661-01-01',
      '\uff11\uff19\uff19\uff11-01-01',
      'today',
    ]) {
      await expectError(await request.get(reportPath(date, 'UTC')), 'validation_failed', 'date');
    }
  });

  test('date is required exactly once', async ({ request }) => {
    await expectError(await request.get(`${DAILY}?time_zone=UTC`), 'validation_failed', 'date');
    await expectError(await request.get(DAILY), 'validation_failed', 'date');
    await expectError(await request.get(`${DAILY}?date&time_zone=UTC`), 'validation_failed', 'date');
    await expectError(await request.get(`${DAILY}?date=1991-05-05&date=1991-05-05&time_zone=UTC`), 'validation_failed', 'date');
    await expectError(await request.get(`${DAILY}?date=1991-05-05&time_zone=UTC&date=1991-05-06`), 'validation_failed', 'date');
    await expectError(await request.get(`${DAILY}?Date=1991-05-05&time_zone=UTC`), 'validation_failed', 'date');
  });
});

test.describe('GET /api/reports/completions/daily: time_zone', () => {
  test('accepts UTC and Area/Location names', async ({ request }) => {
    for (const zone of [
      'UTC',
      'Etc/UTC',
      'Etc/GMT-14',
      'Etc/GMT+12',
      'Europe/Paris',
      'America/Argentina/Buenos_Aires',
      'America/Port-au-Prince',
      'America/Indiana/Indianapolis',
      'Asia/Kolkata',
      'Asia/Calcutta',
      'Antarctica/Troll',
      'Pacific/Chatham',
    ]) {
      const report = await getReport(request, '1999-09-09', zone);
      expect(report.time_zone).toBe(zone);
      expect(report.count).toBe(0);
    }
  });

  test('rejects abbreviations, POSIX-style names, numeric offsets and other shapes', async ({ request }) => {
    for (const zone of [
      '',
      'utc',
      'Utc',
      'GMT',
      'Z',
      'EST',
      'CET',
      'EST5EDT',
      'CST6CDT',
      'PST8PDT',
      'MST7MDT',
      '+05:00',
      '-0500',
      'UTC+5',
      'UTC+05:00',
      'GMT+5',
      'Etc/GMT 5',
      'Etc/GMT+5 ',
      ' UTC',
      'UTC ',
      'America/New York',
      'America/',
      '/America/New_York',
      'America//New_York',
      'America/New_York/',
      '1America/New_York',
      '_America/New_York',
      'America\\New_York',
      'America/New_York\n',
      'Am\u00e9rica/New_York',
    ]) {
      await expectError(await request.get(reportPath('1991-07-07', zone)), 'validation_failed', 'time_zone');
    }
  });

  test('rejects well-shaped names that are not time zones', async ({ request }) => {
    for (const zone of ['Mars/Olympus_Mons', 'America/Atlantis', 'Europe/Londonn', 'Etc/GMT+15', 'Etc/GMT-15', 'Foo/Bar']) {
      await expectError(await request.get(reportPath('1991-07-08', zone)), 'validation_failed', 'time_zone');
    }
  });

  test('rejects names over 64 characters', async ({ request }) => {
    const long = `America/${'A'.repeat(57)}`;
    expect(long).toHaveLength(65);
    await expectError(await request.get(reportPath('1991-07-09', long)), 'validation_failed', 'time_zone');
    await expectError(await request.get(reportPath('1991-07-09', `Etc/${'x/'.repeat(40)}UTC`)), 'validation_failed', 'time_zone');
  });

  test('time_zone is required exactly once', async ({ request }) => {
    await expectError(await request.get(`${DAILY}?date=1991-08-08`), 'validation_failed', 'time_zone');
    await expectError(await request.get(`${DAILY}?date=1991-08-08&time_zone=`), 'validation_failed', 'time_zone');
    await expectError(await request.get(`${DAILY}?date=1991-08-08&time_zone=UTC&time_zone=UTC`), 'validation_failed', 'time_zone');
    await expectError(await request.get(`${DAILY}?date=1991-08-08&time_zone=UTC&time_zone=Europe%2FParis`), 'validation_failed', 'time_zone');
    await expectError(await request.get(`${DAILY}?date=1991-08-08&timezone=UTC`), 'validation_failed', 'time_zone');
  });
});

test.describe('GET /api/reports/completions/daily: unknown parameters and order', () => {
  test('an unknown query parameter is 400 naming it', async ({ request }) => {
    const valid = 'date=1991-09-09&time_zone=UTC';
    for (const [query, field] of [
      [`${valid}&extra=1`, 'extra'],
      [`extra=1&${valid}`, 'extra'],
      [`${valid}&Date=1991-09-09`, 'Date'],
      [`${valid}&TIME_ZONE=UTC`, 'TIME_ZONE'],
      [`${valid}&count=5`, 'count'],
      [`${valid}&flag`, 'flag'],
      [`${valid}&b=1&a=2`, 'b'],
    ] as const) {
      await expectError(await request.get(`${DAILY}?${query}`), 'validation_failed', field);
    }
  });

  test('validation order: date, then time_zone, then unknown parameters', async ({ request }) => {
    await expectError(await request.get(`${DAILY}?extra=1&time_zone=EST&date=bad`), 'validation_failed', 'date');
    await expectError(await request.get(`${DAILY}?extra=1&time_zone=EST`), 'validation_failed', 'date');
    await expectError(await request.get(`${DAILY}?extra=1&date=1991-10-10&time_zone=EST`), 'validation_failed', 'time_zone');
    await expectError(await request.get(`${DAILY}?extra=1&date=1991-10-10`), 'validation_failed', 'time_zone');
    await expectError(await request.get(`${DAILY}?date=1991-10-10&date=1991-10-11&time_zone=EST`), 'validation_failed', 'date');
    await expectError(await request.get(`${DAILY}?date=1991-10-10&time_zone=UTC&time_zone=EST&extra=1`), 'validation_failed', 'time_zone');
  });

  test('the report route ignores request bodies and content types', async ({ request }) => {
    const response = await request.fetch(reportPath('1991-11-11', 'UTC'), {
      method: 'GET',
      headers: { 'content-type': 'text/plain' },
      data: 'not json',
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ date: '1991-11-11', count: 0 });
  });
});
