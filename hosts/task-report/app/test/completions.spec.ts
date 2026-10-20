import { expect, test } from '@playwright/test';
import {
  addCompletion,
  createTask,
  expectCommonHeaders,
  expectError,
  getReport,
  ISO_Z,
  UNKNOWN_ID,
  UUID_LOWER,
  type Completion,
} from './helpers.ts';

// Dates written by this file (no other test writes or reads them): 1970-01-01, 1971 to 1975,
// 2000-02-29, 2096-02-29 and 2099-12-31.

test.describe('POST /api/tasks/{id}/completions', () => {
  test('stores the given instant and returns 201 with the Completion shape (C-7)', async ({ request }) => {
    const task = await createTask(request, { title: 'complete me' });
    const response = await request.post(`/api/tasks/${task.id}/completions`, { data: { completed_at: '1974-06-15T08:30:00Z' } });
    expect(response.status()).toBe(201);
    expectCommonHeaders(response.headers());
    const completion = (await response.json()) as Completion;
    expect(Object.keys(completion).sort()).toEqual(['completed_at', 'id', 'task_id']);
    expect(completion.id).toMatch(UUID_LOWER);
    expect(completion.task_id).toBe(task.id);
    expect(completion.completed_at).toBe('1974-06-15T08:30:00.000Z');
  });

  test('instants are normalized to UTC with milliseconds, and the stored instant is what is counted (C-7)', async ({ request }) => {
    const task = await createTask(request, { title: 'normalize' });
    const cases: [string, string][] = [
      ['1971-03-04T05:06:07Z', '1971-03-04T05:06:07.000Z'],
      ['1971-03-04T05:06:07.000Z', '1971-03-04T05:06:07.000Z'],
      ['1971-03-04T05:06:07+00:00', '1971-03-04T05:06:07.000Z'],
      ['1971-03-04T05:06:07-00:00', '1971-03-04T05:06:07.000Z'],
      ['1971-03-04T10:36:07+05:30', '1971-03-04T05:06:07.000Z'],
      ['1971-03-03T23:06:07-06:00', '1971-03-04T05:06:07.000Z'],
      ['1971-03-05T05:05:07+23:59', '1971-03-04T05:06:07.000Z'],
      ['1971-03-03T05:07:07-23:59', '1971-03-04T05:06:07.000Z'],
      ['1971-03-04T05:06:07.8Z', '1971-03-04T05:06:07.800Z'],
      ['1971-03-04T05:06:07.05Z', '1971-03-04T05:06:07.050Z'],
      ['1971-03-04T05:06:07.891+01:00', '1971-03-04T04:06:07.891Z'],
      ['1971-03-04T00:00:00.001+00:00', '1971-03-04T00:00:00.001Z'],
      ['1971-03-04T23:59:59.999Z', '1971-03-04T23:59:59.999Z'],
      ['1971-03-05T00:30:00+01:00', '1971-03-04T23:30:00.000Z'],
    ];
    for (const [input, output] of cases) {
      const completion = await addCompletion(request, task.id, input);
      expect(completion.completed_at, input).toBe(output);
      expect(completion.task_id).toBe(task.id);
    }
    const report = await getReport(request, '1971-03-04', 'UTC');
    expect(report).toEqual({
      date: '1971-03-04',
      time_zone: 'UTC',
      start: '1971-03-04T00:00:00.000Z',
      end: '1971-03-05T00:00:00.000Z',
      count: cases.length,
    });
  });

  test('day, month and year roll over through the offset', async ({ request }) => {
    const task = await createTask(request, { title: 'rollover' });
    const cases: [string, string][] = [
      ['1972-01-01T00:30:00+01:00', '1971-12-31T23:30:00.000Z'],
      ['1972-12-31T20:00:00-05:00', '1973-01-01T01:00:00.000Z'],
      ['1972-03-01T01:00:00+02:00', '1972-02-29T23:00:00.000Z'],
      ['1973-03-01T01:00:00+02:00', '1973-02-28T23:00:00.000Z'],
      ['1973-04-30T23:59:59.999Z', '1973-04-30T23:59:59.999Z'],
    ];
    for (const [input, output] of cases) {
      expect((await addCompletion(request, task.id, input)).completed_at, input).toBe(output);
    }
  });

  test('leap days follow the Gregorian rule', async ({ request }) => {
    const task = await createTask(request, { title: 'leap' });
    for (const input of ['1972-02-29T12:00:00Z', '2000-02-29T12:00:00Z', '2096-02-29T12:00:00Z']) {
      expect((await addCompletion(request, task.id, input)).completed_at).toBe(input.replace('Z', '.000Z'));
    }
    for (const input of ['1973-02-29T12:00:00Z', '1975-02-29T00:00:00Z', '2100-02-29T00:00:00Z', '1900-02-29T00:00:00Z']) {
      await expectError(
        await request.post(`/api/tasks/${task.id}/completions`, { data: { completed_at: input } }),
        'validation_failed',
        'completed_at',
      );
    }
  });

  test('calendar and clock fields are range-checked, never rolled over', async ({ request }) => {
    const task = await createTask(request, { title: 'ranges' });
    const invalid = [
      '1974-02-30T00:00:00Z',
      '1974-02-31T00:00:00Z',
      '1974-04-31T00:00:00Z',
      '1974-06-31T00:00:00Z',
      '1974-09-31T00:00:00Z',
      '1974-11-31T00:00:00Z',
      '1974-01-32T00:00:00Z',
      '1974-01-00T00:00:00Z',
      '1974-00-10T00:00:00Z',
      '1974-13-01T00:00:00Z',
      '1974-99-99T00:00:00Z',
      '1974-01-01T24:00:00Z',
      '1974-01-01T24:00:00.000Z',
      '1974-01-01T25:00:00Z',
      '1974-01-01T23:60:00Z',
      '1974-01-01T23:59:60Z',
      '1974-06-30T23:59:60Z',
      '1974-01-01T00:00:99Z',
      '1974-01-01T12:00:00+24:00',
      '1974-01-01T12:00:00-24:00',
      '1974-01-01T12:00:00+00:60',
      '1974-01-01T12:00:00-05:99',
      '1974-01-01T12:00:00+99:00',
    ];
    for (const completed_at of invalid) {
      await expectError(
        await request.post(`/api/tasks/${task.id}/completions`, { data: { completed_at } }),
        'validation_failed',
        'completed_at',
      );
    }
    for (const [input, output] of [
      ['1974-01-31T23:59:59Z', '1974-01-31T23:59:59.000Z'],
      ['1974-12-31T00:00:00Z', '1974-12-31T00:00:00.000Z'],
      ['1974-01-01T12:00:00+23:00', '1973-12-31T13:00:00.000Z'],
      ['1974-01-01T12:00:00-23:00', '1974-01-02T11:00:00.000Z'],
    ] as const) {
      expect((await addCompletion(request, task.id, input)).completed_at, input).toBe(output);
    }
  });

  test('completed_at must match the RFC 3339 shape with an offset', async ({ request }) => {
    const task = await createTask(request, { title: 'shapes' });
    const invalid = [
      '1974-01-01T12:00:00',
      '1974-01-01T12:00:00.000',
      '1974-01-01 12:00:00Z',
      '1974-01-01t12:00:00Z',
      '1974-01-01T12:00:00z',
      '1974-01-01T12:00Z',
      '1974-01-01T12Z',
      '1974-01-01',
      '12:00:00Z',
      '1974-1-01T12:00:00Z',
      '1974-01-1T12:00:00Z',
      '74-01-01T12:00:00Z',
      '01974-01-01T12:00:00Z',
      '+001974-01-01T12:00:00Z',
      '1974-01-01T2:00:00Z',
      '1974-01-01T12:0:00Z',
      '1974-01-01T12:00:0Z',
      '1974-01-01T12:00:00.Z',
      '1974-01-01T12:00:00.1234Z',
      '1974-01-01T12:00:00,5Z',
      '1974-01-01T12:00:00+0530',
      '1974-01-01T12:00:00+05',
      '1974-01-01T12:00:00+5:30',
      '1974-01-01T12:00:00 +05:30',
      '1974-01-01T12:00:00UTC',
      '1974-01-01T12:00:00GMT',
      '1974-01-01T12:00:00Z[UTC]',
      ' 1974-01-01T12:00:00Z',
      '1974-01-01T12:00:00Z ',
      '1974-01-01T12:00:00Z\n',
      '\u0661\u0669\u0667\u0664-01-01T12:00:00Z',
      'Tue, 01 Jan 1974 12:00:00 GMT',
      '',
      'now',
    ];
    for (const completed_at of invalid) {
      await expectError(
        await request.post(`/api/tasks/${task.id}/completions`, { data: { completed_at } }),
        'validation_failed',
        'completed_at',
      );
    }
    for (const completed_at of [null, 0, 126230400000, true, {}, [], ['1974-01-01T12:00:00Z']]) {
      await expectError(
        await request.post(`/api/tasks/${task.id}/completions`, { data: { completed_at } }),
        'validation_failed',
        'completed_at',
      );
    }
  });

  test('the instant must lie in [1970-01-01T00:00:00.000Z, 2100-01-01T00:00:00.000Z)', async ({ request }) => {
    const task = await createTask(request, { title: 'bounds' });
    for (const completed_at of [
      '1969-12-31T23:59:59.999Z',
      '1969-12-31T23:59:59Z',
      '1969-12-31T18:59:59.999-05:00',
      '1970-01-01T00:00:00+00:01',
      '1970-01-01T00:59:59.999+01:00',
      '2100-01-01T00:00:00Z',
      '2100-01-01T00:00:00.000+00:00',
      '2099-12-31T23:00:00-01:00',
      '2100-01-01T01:00:00+00:59',
      '0000-01-01T00:00:00Z',
      '1000-01-01T00:00:00Z',
      '9999-12-31T23:59:59.999Z',
    ]) {
      await expectError(
        await request.post(`/api/tasks/${task.id}/completions`, { data: { completed_at } }),
        'validation_failed',
        'completed_at',
      );
    }
    const accepted: [string, string][] = [
      ['1970-01-01T00:00:00Z', '1970-01-01T00:00:00.000Z'],
      ['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'],
      ['1969-12-31T19:00:00-05:00', '1970-01-01T00:00:00.000Z'],
      ['1970-01-01T01:00:00+01:00', '1970-01-01T00:00:00.000Z'],
      ['2099-12-31T23:59:59.999Z', '2099-12-31T23:59:59.999Z'],
      ['2100-01-01T00:59:59.999+01:00', '2099-12-31T23:59:59.999Z'],
      ['2099-12-31T22:59:59.999-01:00', '2099-12-31T23:59:59.999Z'],
    ];
    for (const [input, output] of accepted) {
      expect((await addCompletion(request, task.id, input)).completed_at, input).toBe(output);
    }
    expect(await getReport(request, '1970-01-01', 'UTC')).toEqual({
      date: '1970-01-01',
      time_zone: 'UTC',
      start: '1970-01-01T00:00:00.000Z',
      end: '1970-01-02T00:00:00.000Z',
      count: 4,
    });
    expect(await getReport(request, '2099-12-31', 'UTC')).toEqual({
      date: '2099-12-31',
      time_zone: 'UTC',
      start: '2099-12-31T00:00:00.000Z',
      end: '2100-01-01T00:00:00.000Z',
      count: 3,
    });
  });

  test('{} stores the database now(): a fresh UTC instant no earlier than the task', async ({ request }) => {
    const task = await createTask(request, { title: 'now' });
    const first = await addCompletion(request, task.id);
    const second = await addCompletion(request, task.id);
    for (const completion of [first, second]) {
      expect(completion.task_id).toBe(task.id);
      expect(completion.completed_at).toMatch(ISO_Z);
      expect(completion.completed_at >= task.created_at).toBe(true);
    }
    expect(second.completed_at >= first.completed_at).toBe(true);
    expect(second.id).not.toBe(first.id);
  });

  test('each completion gets a new unique id, also for the same task and instant (C-7)', async ({ request }) => {
    const task = await createTask(request, { title: 'ids' });
    const other = await createTask(request, { title: 'ids 2' });
    const completions = await Promise.all([
      ...Array.from({ length: 5 }, () => addCompletion(request, task.id, '1975-05-05T05:05:05.555Z')),
      addCompletion(request, other.id, '1975-05-05T05:05:05.555Z'),
    ]);
    expect(new Set(completions.map((c) => c.id)).size).toBe(completions.length);
    for (const completion of completions) {
      expect(completion.id).toMatch(UUID_LOWER);
      expect(completion.completed_at).toBe('1975-05-05T05:05:05.555Z');
    }
    expect(completions.filter((c) => c.task_id === task.id)).toHaveLength(5);
  });

  test('an uppercase task id is accepted; task_id is returned lowercase', async ({ request }) => {
    const task = await createTask(request, { title: 'upper' });
    const response = await request.post(`/api/tasks/${task.id.toUpperCase()}/completions`, {
      data: { completed_at: '1974-07-01T00:00:00Z' },
    });
    expect(response.status()).toBe(201);
    const completion = (await response.json()) as Completion;
    expect(completion.task_id).toBe(task.id);
    expect(completion.id).toMatch(UUID_LOWER);
  });

  test('adding a completion does not change the task', async ({ request }) => {
    const task = await createTask(request, { title: 'unchanged', note: 'n' });
    await addCompletion(request, task.id, '1974-08-01T00:00:00Z');
    expect(await (await request.get(`/api/tasks/${task.id}`)).json()).toEqual(task);
  });

  test('field validation order: completed_at, then the first unknown key', async ({ request }) => {
    const task = await createTask(request, { title: 'order' });
    const path = `/api/tasks/${task.id}/completions`;
    const cases: [Record<string, unknown>, string][] = [
      [{ zzz: 1, completed_at: 'bad' }, 'completed_at'],
      [{ completed_at: null, zzz: 1 }, 'completed_at'],
      [{ completed_at: '1974-09-01T00:00:00Z', zzz: 1, aaa: 2 }, 'zzz'],
      [{ zzz: 1 }, 'zzz'],
      [{ task_id: task.id }, 'task_id'],
      [{ id: UNKNOWN_ID }, 'id'],
      [{ completedAt: '1974-09-01T00:00:00Z' }, 'completedAt'],
      [{ title: 'x' }, 'title'],
    ];
    for (const [data, field] of cases) {
      await expectError(await request.post(path, { data }), 'validation_failed', field);
    }
    await expectError(
      await request.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, data: '{"z":1,"7":2}' }),
      'validation_failed',
      '7',
    );
  });

  test('an unknown task is 404, but only after validation (C-7, step 7 before step 8)', async ({ request }) => {
    const path = `/api/tasks/${UNKNOWN_ID}/completions`;
    await expectError(await request.post(path, { data: {} }), 'not_found');
    await expectError(await request.post(path, { data: { completed_at: '1974-10-01T00:00:00Z' } }), 'not_found');
    await expectError(await request.post(path, { data: { completed_at: '1974-02-30T00:00:00Z' } }), 'validation_failed', 'completed_at');
    await expectError(await request.post(path, { data: { completed_at: null } }), 'validation_failed', 'completed_at');
    await expectError(await request.post(path, { data: { other: 1 } }), 'validation_failed', 'other');
    await expectError(await request.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, data: 'null' }), 'invalid_json');
    await expectError(await request.fetch(path, { method: 'POST', headers: { 'content-type': 'text/plain' }, data: '{}' }), 'unsupported_media_type');
  });
});
