import { expect, test, type APIRequestContext } from '@playwright/test';
import { addCompletion, createTask, getReport } from './helpers.ts';

// Each test below owns the dates it writes and reads; no other test touches them.
// Expected windows come from the IANA rules for each zone, written out by hand.

async function writeCompletions(request: APIRequestContext, instants: string[]): Promise<void> {
  const task = await createTask(request, { title: 'report fixture' });
  for (const instant of instants) await addCompletion(request, task.id, instant);
}

async function expectWindow(
  request: APIRequestContext,
  date: string,
  zone: string,
  start: string,
  end: string,
  count: number,
): Promise<void> {
  expect(await getReport(request, date, zone), `${date} in ${zone}`).toEqual({ date, time_zone: zone, start, end, count });
}

test.describe('daily report windows and counts (C-8)', () => {
  test('counts start <= completed_at < end on a UTC day', async ({ request }) => {
    await writeCompletions(request, [
      '2010-06-09T23:59:59.999Z',
      '2010-06-10T00:00:00.000Z',
      '2010-06-10T12:34:56.789Z',
      '2010-06-10T23:59:59.999Z',
      '2010-06-11T00:00:00.000Z',
    ]);
    await expectWindow(request, '2010-06-10', 'UTC', '2010-06-10T00:00:00.000Z', '2010-06-11T00:00:00.000Z', 3);
    await expectWindow(request, '2010-06-09', 'UTC', '2010-06-09T00:00:00.000Z', '2010-06-10T00:00:00.000Z', 1);
    await expectWindow(request, '2010-06-11', 'UTC', '2010-06-11T00:00:00.000Z', '2010-06-12T00:00:00.000Z', 1);
  });

  test('rows sharing an instant each count, across tasks', async ({ request }) => {
    const a = await createTask(request, { title: 'shared a' });
    const b = await createTask(request, { title: 'shared b' });
    await addCompletion(request, a.id, '2012-08-08T20:00:00.000Z');
    await addCompletion(request, a.id, '2012-08-08T20:00:00Z');
    await addCompletion(request, b.id, '2012-08-08T13:00:00-07:00');
    await expectWindow(request, '2012-08-08', 'UTC', '2012-08-08T00:00:00.000Z', '2012-08-09T00:00:00.000Z', 3);
  });

  test('the same rows fall on different local dates in different zones', async ({ request }) => {
    await writeCompletions(request, ['2013-09-09T20:00:00.000Z', '2013-09-09T20:00:00.000Z', '2013-09-10T01:00:00.000Z']);
    await expectWindow(request, '2013-09-09', 'UTC', '2013-09-09T00:00:00.000Z', '2013-09-10T00:00:00.000Z', 2);
    await expectWindow(request, '2013-09-10', 'UTC', '2013-09-10T00:00:00.000Z', '2013-09-11T00:00:00.000Z', 1);
    await expectWindow(request, '2013-09-09', 'Asia/Tokyo', '2013-09-08T15:00:00.000Z', '2013-09-09T15:00:00.000Z', 0);
    await expectWindow(request, '2013-09-10', 'Asia/Tokyo', '2013-09-09T15:00:00.000Z', '2013-09-10T15:00:00.000Z', 3);
    await expectWindow(request, '2013-09-09', 'America/Los_Angeles', '2013-09-09T07:00:00.000Z', '2013-09-10T07:00:00.000Z', 3);
    await expectWindow(request, '2013-09-10', 'America/Los_Angeles', '2013-09-10T07:00:00.000Z', '2013-09-11T07:00:00.000Z', 0);
  });

  test('fixed-offset and half-hour zones', async ({ request }) => {
    await expectWindow(request, '2021-06-15', 'Asia/Kolkata', '2021-06-14T18:30:00.000Z', '2021-06-15T18:30:00.000Z', 0);
    await expectWindow(request, '2021-06-20', 'Asia/Kathmandu', '2021-06-19T18:15:00.000Z', '2021-06-20T18:15:00.000Z', 0);
    await expectWindow(request, '2022-05-05', 'Etc/GMT+5', '2022-05-05T05:00:00.000Z', '2022-05-06T05:00:00.000Z', 0);
    await expectWindow(request, '2022-05-10', 'Etc/GMT-14', '2022-05-09T10:00:00.000Z', '2022-05-10T10:00:00.000Z', 0);
    await expectWindow(request, '2022-05-15', 'Pacific/Kiritimati', '2022-05-14T10:00:00.000Z', '2022-05-15T10:00:00.000Z', 0);
    await expectWindow(request, '2022-05-20', 'Etc/GMT+12', '2022-05-20T12:00:00.000Z', '2022-05-21T12:00:00.000Z', 0);
  });

  test('a 24-hour day in a DST zone, and a year boundary', async ({ request }) => {
    await writeCompletions(request, ['2023-07-14T03:59:59.999Z', '2023-07-14T04:00:00.000Z', '2023-07-15T03:59:59.999Z', '2023-07-15T04:00:00.000Z']);
    await expectWindow(request, '2023-07-14', 'America/New_York', '2023-07-14T04:00:00.000Z', '2023-07-15T04:00:00.000Z', 2);
    await expectWindow(request, '2023-12-31', 'America/New_York', '2023-12-31T05:00:00.000Z', '2024-01-01T05:00:00.000Z', 0);
  });
});

test.describe('no 24-hour-day assumption (C-9)', () => {
  test('a 23-hour day: America/New_York 2023-03-12', async ({ request }) => {
    await writeCompletions(request, [
      '2023-03-12T04:59:59.999Z', // 2023-03-11 23:59:59.999 EST
      '2023-03-12T00:00:00-05:00', // start
      '2023-03-12T01:59:59.999-05:00', // just before the gap
      '2023-03-12T03:00:00-04:00', // just after the gap
      '2023-03-13T03:59:59.999Z', // 23:59:59.999 EDT
      '2023-03-13T04:00:00.000Z', // 2023-03-13 00:00 EDT
    ]);
    await expectWindow(request, '2023-03-12', 'America/New_York', '2023-03-12T05:00:00.000Z', '2023-03-13T04:00:00.000Z', 4);
    await expectWindow(request, '2023-03-11', 'America/New_York', '2023-03-11T05:00:00.000Z', '2023-03-12T05:00:00.000Z', 1);
    await expectWindow(request, '2023-03-13', 'America/New_York', '2023-03-13T04:00:00.000Z', '2023-03-14T04:00:00.000Z', 1);
  });

  test('a 25-hour day: America/New_York 2023-11-05', async ({ request }) => {
    await writeCompletions(request, [
      '2023-11-05T03:59:59.999Z', // 2023-11-04 23:59:59.999 EDT
      '2023-11-05T04:00:00.000Z', // 00:00 EDT
      '2023-11-05T01:30:00-04:00', // first 01:30
      '2023-11-05T01:30:00-05:00', // second 01:30
      '2023-11-06T04:00:00.000Z', // 23:00 EST, past the 24-hour mark
      '2023-11-06T04:59:59.999Z', // 23:59:59.999 EST
      '2023-11-06T05:00:00.000Z', // 2023-11-06 00:00 EST
    ]);
    await expectWindow(request, '2023-11-05', 'America/New_York', '2023-11-05T04:00:00.000Z', '2023-11-06T05:00:00.000Z', 5);
    await expectWindow(request, '2023-11-04', 'America/New_York', '2023-11-04T04:00:00.000Z', '2023-11-05T04:00:00.000Z', 1);
    await expectWindow(request, '2023-11-06', 'America/New_York', '2023-11-06T05:00:00.000Z', '2023-11-07T05:00:00.000Z', 1);
  });

  test('a 23-hour day without a 24-hour-day UTC equivalent: Europe/London 2022-03-27', async ({ request }) => {
    await expectWindow(request, '2022-03-27', 'Europe/London', '2022-03-27T00:00:00.000Z', '2022-03-27T23:00:00.000Z', 0);
    await expectWindow(request, '2022-10-30', 'Europe/London', '2022-10-29T23:00:00.000Z', '2022-10-31T00:00:00.000Z', 0);
  });

  test('a half-hour DST change gives a 24.5-hour day: Australia/Lord_Howe 2022-04-03', async ({ request }) => {
    await writeCompletions(request, [
      '2022-04-02T12:59:59.999Z',
      '2022-04-02T13:00:00.000Z',
      '2022-04-03T13:29:59.999Z',
      '2022-04-03T13:30:00.000Z',
    ]);
    await expectWindow(request, '2022-04-03', 'Australia/Lord_Howe', '2022-04-02T13:00:00.000Z', '2022-04-03T13:30:00.000Z', 2);
  });

  test('a missing midnight: the day starts when the gap ends (America/Sao_Paulo 2018-11-04)', async ({ request }) => {
    await writeCompletions(request, [
      '2018-11-04T02:59:59.999Z', // 2018-11-03 23:59:59.999 -03
      '2018-11-04T03:00:00.000Z', // 01:00 -02, the first instant of 2018-11-04
      '2018-11-05T01:59:59.999Z',
      '2018-11-05T02:00:00.000Z',
    ]);
    await expectWindow(request, '2018-11-04', 'America/Sao_Paulo', '2018-11-04T03:00:00.000Z', '2018-11-05T02:00:00.000Z', 2);
    await expectWindow(request, '2018-11-03', 'America/Sao_Paulo', '2018-11-03T03:00:00.000Z', '2018-11-04T03:00:00.000Z', 1);
  });

  test('a missing midnight: America/Havana 2024-03-10', async ({ request }) => {
    await writeCompletions(request, [
      '2024-03-10T04:59:59.999Z', // 2024-03-09 23:59:59.999 CST
      '2024-03-10T01:00:00-04:00', // 01:00 CDT, the first instant of 2024-03-10
      '2024-03-11T03:59:59.999Z',
      '2024-03-11T04:00:00.000Z',
    ]);
    await expectWindow(request, '2024-03-10', 'America/Havana', '2024-03-10T05:00:00.000Z', '2024-03-11T04:00:00.000Z', 2);
    await expectWindow(request, '2024-03-09', 'America/Havana', '2024-03-09T05:00:00.000Z', '2024-03-10T05:00:00.000Z', 1);
  });

  test('a repeated midnight means its first occurrence: America/Havana 2024-11-03', async ({ request }) => {
    await writeCompletions(request, [
      '2024-11-03T03:59:59.999Z', // 2024-11-02 23:59:59.999 CDT
      '2024-11-03T00:00:00-04:00', // first midnight
      '2024-11-03T00:30:00-04:00',
      '2024-11-03T00:00:00-05:00', // second midnight
      '2024-11-03T00:30:00-05:00',
      '2024-11-04T04:59:59.999Z', // 2024-11-03 23:59:59.999 CST
      '2024-11-04T05:00:00.000Z', // 2024-11-04 00:00 CST
    ]);
    await expectWindow(request, '2024-11-03', 'America/Havana', '2024-11-03T04:00:00.000Z', '2024-11-04T05:00:00.000Z', 5);
    await expectWindow(request, '2024-11-02', 'America/Havana', '2024-11-02T04:00:00.000Z', '2024-11-03T04:00:00.000Z', 1);
    await expectWindow(request, '2024-11-04', 'America/Havana', '2024-11-04T05:00:00.000Z', '2024-11-05T05:00:00.000Z', 1);
  });

  test('a 25-hour day with a repeated 23:00 hour: America/Sao_Paulo 2019-02-16', async ({ request }) => {
    await writeCompletions(request, [
      '2019-02-16T01:59:59.999Z',
      '2019-02-16T02:00:00.000Z', // 00:00 -02
      '2019-02-16T23:30:00-02:00', // first 23:30
      '2019-02-16T23:30:00-03:00', // second 23:30
      '2019-02-17T02:59:59.999Z', // last instant of 2019-02-16
      '2019-02-17T03:00:00.000Z', // 2019-02-17 00:00 -03
    ]);
    await expectWindow(request, '2019-02-16', 'America/Sao_Paulo', '2019-02-16T02:00:00.000Z', '2019-02-17T03:00:00.000Z', 4);
    await expectWindow(request, '2019-02-17', 'America/Sao_Paulo', '2019-02-17T03:00:00.000Z', '2019-02-18T03:00:00.000Z', 1);
  });

  test('a skipped date gives start = end and count 0: Pacific/Apia 2011-12-30', async ({ request }) => {
    await writeCompletions(request, [
      '2011-12-30T09:59:59.999Z', // 2011-12-29 23:59:59.999 -10
      '2011-12-30T10:00:00.000Z', // 2011-12-31 00:00 +14
    ]);
    await expectWindow(request, '2011-12-30', 'Pacific/Apia', '2011-12-30T10:00:00.000Z', '2011-12-30T10:00:00.000Z', 0);
    await expectWindow(request, '2011-12-29', 'Pacific/Apia', '2011-12-29T10:00:00.000Z', '2011-12-30T10:00:00.000Z', 1);
    await expectWindow(request, '2011-12-31', 'Pacific/Apia', '2011-12-30T10:00:00.000Z', '2011-12-31T10:00:00.000Z', 1);
  });

  test('where the local date steps backward, the windows are deterministic', async ({ request }) => {
    for (const [zone, dates] of [
      ['America/St_Johns', ['2006-10-28', '2006-10-29', '2006-10-30']],
      ['America/Moncton', ['2005-10-29', '2005-10-30', '2005-10-31']],
      ['Antarctica/Casey', ['2010-03-04', '2010-03-05', '2010-03-06']],
    ] as const) {
      for (const date of dates) {
        const first = await getReport(request, date, zone);
        const second = await getReport(request, date, zone);
        expect(second).toEqual(first);
        expect(first).toMatchObject({ date, time_zone: zone, count: 0 });
      }
    }
  });
});
