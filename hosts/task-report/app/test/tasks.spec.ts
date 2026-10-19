import { expect, test } from '@playwright/test';
import { createTask, expectCommonHeaders, expectError, ISO_Z, UNKNOWN_ID, UUID_LOWER, type Task } from './helpers.ts';

const astral = '\u{1f600}'; // one code point, two UTF-16 code units, four UTF-8 bytes

test.describe('POST /api/tasks', () => {
  test('creates a task and returns 201 with the Task shape and a location header (C-1)', async ({ request }) => {
    const response = await request.post('/api/tasks', { data: { title: 'Water the plants', note: 'Ferns first.' } });
    expect(response.status()).toBe(201);
    expectCommonHeaders(response.headers());
    expect(response.headers()['content-type']).toMatch(/^application\/json/);
    const task = (await response.json()) as Task;
    expect(Object.keys(task).sort()).toEqual(['created_at', 'id', 'note', 'title', 'updated_at']);
    expect(task.id).toMatch(UUID_LOWER);
    expect(task.title).toBe('Water the plants');
    expect(task.note).toBe('Ferns first.');
    expect(task.created_at).toMatch(ISO_Z);
    expect(task.updated_at).toMatch(ISO_Z);
    expect(task.updated_at).toBe(task.created_at);
    expect(response.headers()['location']).toBe(`/api/tasks/${task.id}`);
  });

  test('note defaults to "" when omitted (C-1)', async ({ request }) => {
    const task = await createTask(request, { title: 'No note' });
    expect(task.note).toBe('');
    const fetched = await request.get(`/api/tasks/${task.id}`);
    expect(((await fetched.json()) as Task).note).toBe('');
  });

  test('each task gets a new id', async ({ request }) => {
    const a = await createTask(request, { title: 'same' });
    const b = await createTask(request, { title: 'same' });
    expect(a.id).not.toBe(b.id);
  });

  test('title and note are stored exactly as given (C-1)', async ({ request }) => {
    const cases: { title: string; note: string }[] = [
      { title: '  padded title  ', note: '  padded note  ' },
      { title: 'tab\tand\nnewline', note: '\r\n' },
      { title: `emoji ${astral} e\u0301 \u00e9`, note: '\u4e2d\u6587 \u0639\u0631\u0628\u064a' },
      { title: "'; DROP TABLE tasks; --", note: '$1 %s \\x00 \\\\' },
      { title: '\u200b', note: '\ufffd' },
      { title: 'x', note: '   ' },
      { title: '<b>html</b>', note: '{"json":true}' },
    ];
    for (const data of cases) {
      const created = await request.post('/api/tasks', { data });
      expect(created.status(), JSON.stringify(data)).toBe(201);
      const task = (await created.json()) as Task;
      expect(task).toMatchObject(data);
      const fetched = await request.get(`/api/tasks/${task.id}`);
      expect(await fetched.json()).toEqual(task);
    }
  });

  test('title length is 1 to 200 code points', async ({ request }) => {
    for (const title of ['x', 'x'.repeat(200), astral.repeat(200), 'e\u0301'.repeat(100)]) {
      const task = await createTask(request, { title });
      expect(task.title).toBe(title);
    }
    for (const title of ['', 'x'.repeat(201), astral.repeat(201), 'e\u0301'.repeat(100) + 'x']) {
      await expectError(await request.post('/api/tasks', { data: { title } }), 'validation_failed', 'title');
    }
  });

  test('a title that is empty after ECMAScript trim() is rejected', async ({ request }) => {
    for (const title of [' ', '   ', '\t', '\n', '\r\n', '\u00a0', '\u2028', '\u2029', '\u3000', '\ufeff', '\u1680', '\u2003', '\v\f', ' \t\n\u00a0\u3000 ']) {
      await expectError(await request.post('/api/tasks', { data: { title } }), 'validation_failed', 'title');
    }
  });

  test('a title with non-whitespace format characters is not blank', async ({ request }) => {
    for (const title of ['\u200b', '\u200d', '\u180e', ' . ']) {
      const task = await createTask(request, { title });
      expect(task.title).toBe(title);
    }
  });

  test('title must be a well-formed string without U+0000', async ({ request }) => {
    const raws = ['"\\u0000"', '"a\\u0000b"', '"\\ud800"', '"\\udc00"', '"a\\ude00b"', '"\\ude00\\ud83d"'];
    for (const value of raws) {
      const response = await request.fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        data: `{"title":${value}}`,
      });
      await expectError(response, 'validation_failed', 'title');
    }
    for (const title of [null, 1, 0, true, false, [], ['x'], {}, { a: 'b' }]) {
      await expectError(await request.post('/api/tasks', { data: { title } }), 'validation_failed', 'title');
    }
  });

  test('title is required', async ({ request }) => {
    await expectError(await request.post('/api/tasks', { data: {} }), 'validation_failed', 'title');
    await expectError(await request.post('/api/tasks', { data: { note: 'only a note' } }), 'validation_failed', 'title');
  });

  test('note length is 0 to 10,000 code points', async ({ request }) => {
    for (const note of ['', 'n'.repeat(10_000), astral.repeat(10_000)]) {
      const task = await createTask(request, { title: 'note length', note });
      expect(task.note).toBe(note);
    }
    for (const note of ['n'.repeat(10_001), astral.repeat(10_001)]) {
      await expectError(await request.post('/api/tasks', { data: { title: 'x', note } }), 'validation_failed', 'note');
    }
  });

  test('a whitespace-only note is allowed and stored as given', async ({ request }) => {
    for (const note of [' ', '\n\n', '\t \u00a0 \u3000']) {
      const task = await createTask(request, { title: 'blank note', note });
      expect(task.note).toBe(note);
    }
  });

  test('note must be a well-formed string without U+0000', async ({ request }) => {
    for (const value of ['"\\u0000"', '"text\\u0000"', '"\\ud800"', '"x\\udfff"']) {
      const response = await request.fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        data: `{"title":"t","note":${value}}`,
      });
      await expectError(response, 'validation_failed', 'note');
    }
    for (const note of [null, 0, false, [], {}, ['a']]) {
      await expectError(await request.post('/api/tasks', { data: { title: 't', note } }), 'validation_failed', 'note');
    }
  });

  test('fields are validated in order: title, note, then the first unknown key', async ({ request }) => {
    const cases: [Record<string, unknown> | string, string][] = [
      [{ title: null, note: null }, 'title'],
      [{ note: 1, title: '' }, 'title'],
      [{ zzz: 1, title: 2 }, 'title'],
      [{ zzz: 1, note: 2 }, 'title'],
      [{ title: 'ok', note: null, zzz: 1 }, 'note'],
      [{ zzz: 1, note: 2, title: 'ok' }, 'note'],
      [{ title: 'ok', zzz: 1, aaa: 2 }, 'zzz'],
      [{ aaa: 2, title: 'ok', zzz: 1 }, 'aaa'],
      [{ title: 'ok', id: UNKNOWN_ID }, 'id'],
      [{ title: 'ok', created_at: '2020-01-01T00:00:00Z' }, 'created_at'],
      [{ title: 'ok', Title: 'x' }, 'Title'],
      [{ title: 'ok', '': 1 }, ''],
      // Object.keys lists integer-like keys first, in ascending order.
      ['{"title":"ok","b":1,"10":2,"2":3}', '2'],
      ['{"title":"ok","__proto__":{"x":1}}', '__proto__'],
    ];
    for (const [body, field] of cases) {
      const response = await request.fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        data: typeof body === 'string' ? body : JSON.stringify(body),
      });
      await expectError(response, 'validation_failed', field);
    }
  });

  test('the error message is a fixed string per code', async ({ request }) => {
    const a = await request.post('/api/tasks', { data: { title: '' } });
    const b = await request.post('/api/tasks', { data: { title: 'x', note: null } });
    const c = await request.post('/api/tasks', { data: { title: 'x', extra: true } });
    const d = await request.get('/api/reports/completions/daily?date=nope&time_zone=UTC');
    const messages = await Promise.all([a, b, c, d].map(async (r) => ((await r.json()) as { error: { message: string } }).error.message));
    expect(new Set(messages).size).toBe(1);
    const e = await request.get(`/api/tasks/${UNKNOWN_ID}`);
    const f = await request.get('/api/nowhere');
    const notFound = await Promise.all([e, f].map(async (r) => ((await r.json()) as { error: { message: string } }).error.message));
    expect(notFound[0]).toBe(notFound[1]);
  });
});

test.describe('GET /api/tasks/{id}', () => {
  test('returns the stored task (C-2)', async ({ request }) => {
    const task = await createTask(request, { title: 'Fetch me', note: 'please' });
    const response = await request.get(`/api/tasks/${task.id}`);
    expect(response.status()).toBe(200);
    expectCommonHeaders(response.headers());
    expect(await response.json()).toEqual(task);
  });

  test('an unknown id is 404 not_found (C-2)', async ({ request }) => {
    await expectError(await request.get(`/api/tasks/${UNKNOWN_ID}`), 'not_found');
  });

  test('GET ignores any request body', async ({ request }) => {
    const task = await createTask(request, { title: 'body on get' });
    const response = await request.fetch(`/api/tasks/${task.id}`, {
      method: 'GET',
      headers: { 'content-type': 'text/plain' },
      data: 'not json',
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual(task);
  });
});

test.describe('PATCH /api/tasks/{id}', () => {
  test('changes only the title when only the title is sent (C-3)', async ({ request }) => {
    const task = await createTask(request, { title: 'T0', note: 'N0' });
    const response = await request.patch(`/api/tasks/${task.id}`, { data: { title: 'T1' } });
    expect(response.status()).toBe(200);
    expectCommonHeaders(response.headers());
    const patched = (await response.json()) as Task;
    expect(patched).toMatchObject({ id: task.id, title: 'T1', note: 'N0', created_at: task.created_at });
    expect(patched.updated_at).toMatch(ISO_Z);
    expect(patched.updated_at >= task.updated_at).toBe(true);
    expect(await (await request.get(`/api/tasks/${task.id}`)).json()).toEqual(patched);
  });

  test('changes only the note when only the note is sent (C-3)', async ({ request }) => {
    const task = await createTask(request, { title: 'T0', note: 'N0' });
    const response = await request.patch(`/api/tasks/${task.id}`, { data: { note: 'N1' } });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ title: 'T0', note: 'N1', created_at: task.created_at });
  });

  test('changes both fields when both are sent', async ({ request }) => {
    const task = await createTask(request, { title: 'T0', note: 'N0' });
    const response = await request.patch(`/api/tasks/${task.id}`, { data: { title: 'T1', note: 'N1' } });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ id: task.id, title: 'T1', note: 'N1' });
  });

  test('an empty note is "" and clears the note', async ({ request }) => {
    const task = await createTask(request, { title: 'T0', note: 'N0' });
    const response = await request.patch(`/api/tasks/${task.id}`, { data: { note: '' } });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ title: 'T0', note: '' });
    expect(await (await request.get(`/api/tasks/${task.id}`)).json()).toMatchObject({ title: 'T0', note: '' });
  });

  test('a PATCH with the current values still succeeds', async ({ request }) => {
    const task = await createTask(request, { title: 'same', note: 'same' });
    const response = await request.patch(`/api/tasks/${task.id}`, { data: { title: 'same', note: 'same' } });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ id: task.id, title: 'same', note: 'same', created_at: task.created_at });
  });

  test('updated_at never moves backward and created_at never changes', async ({ request }) => {
    const task = await createTask(request, { title: 'clock' });
    let previous = task.updated_at;
    for (let i = 0; i < 5; i++) {
      const response = await request.patch(`/api/tasks/${task.id}`, { data: { note: `n${i}` } });
      const patched = (await response.json()) as Task;
      expect(patched.created_at).toBe(task.created_at);
      expect(patched.updated_at >= previous).toBe(true);
      previous = patched.updated_at;
    }
  });

  test('values are stored exactly as given', async ({ request }) => {
    const task = await createTask(request, { title: 'orig' });
    const data = { title: `  ${astral}  `, note: ' \n ' };
    const response = await request.patch(`/api/tasks/${task.id}`, { data });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject(data);
  });

  test('at least one field is required: {} is 400 with field "body"', async ({ request }) => {
    const task = await createTask(request);
    await expectError(await request.patch(`/api/tasks/${task.id}`, { data: {} }), 'validation_failed', 'body');
  });

  test('null is rejected for every field', async ({ request }) => {
    const task = await createTask(request, { title: 'T0', note: 'N0' });
    await expectError(await request.patch(`/api/tasks/${task.id}`, { data: { title: null } }), 'validation_failed', 'title');
    await expectError(await request.patch(`/api/tasks/${task.id}`, { data: { note: null } }), 'validation_failed', 'note');
    await expectError(await request.patch(`/api/tasks/${task.id}`, { data: { title: 'ok', note: null } }), 'validation_failed', 'note');
    expect(await (await request.get(`/api/tasks/${task.id}`)).json()).toEqual(task);
  });

  test('the same title and note rules apply as on create', async ({ request }) => {
    const task = await createTask(request, { title: 'T0', note: 'N0' });
    const path = `/api/tasks/${task.id}`;
    for (const title of ['', ' ', '\u3000\n', 'x'.repeat(201), astral.repeat(201), 5, false, []]) {
      await expectError(await request.patch(path, { data: { title } }), 'validation_failed', 'title');
    }
    for (const value of ['"\\u0000"', '"\\ud800"']) {
      const response = await request.fetch(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, data: `{"title":${value}}` });
      await expectError(response, 'validation_failed', 'title');
      const noteResponse = await request.fetch(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, data: `{"note":${value}}` });
      await expectError(noteResponse, 'validation_failed', 'note');
    }
    await expectError(await request.patch(path, { data: { note: 'n'.repeat(10_001) } }), 'validation_failed', 'note');
    await expectError(await request.patch(path, { data: { note: 7 } }), 'validation_failed', 'note');
    expect(await (await request.get(path)).json()).toEqual(task);

    const ok = await request.patch(path, { data: { title: astral.repeat(200), note: astral.repeat(10_000) } });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toMatchObject({ title: astral.repeat(200), note: astral.repeat(10_000) });
  });

  test('validation order: title, note, unknown keys, then the at-least-one rule', async ({ request }) => {
    const task = await createTask(request, { title: 'T0', note: 'N0' });
    const path = `/api/tasks/${task.id}`;
    const cases: [Record<string, unknown>, string][] = [
      [{ zzz: 1, note: null, title: null }, 'title'],
      [{ zzz: 1, note: null }, 'note'],
      [{ zzz: 1, note: 'ok' }, 'zzz'],
      [{ zzz: 1 }, 'zzz'],
      [{ zzz: 1, aaa: 1 }, 'zzz'],
      [{ id: task.id }, 'id'],
      [{ title: 'ok', updated_at: '2020-01-01T00:00:00Z' }, 'updated_at'],
    ];
    for (const [data, field] of cases) {
      await expectError(await request.patch(path, { data }), 'validation_failed', field);
    }
    expect(await (await request.get(path)).json()).toEqual(task);
  });

  test('an unknown task is 404, but only after validation (step 7 before step 8)', async ({ request }) => {
    const path = `/api/tasks/${UNKNOWN_ID}`;
    await expectError(await request.patch(path, { data: { title: 'x' } }), 'not_found');
    await expectError(await request.patch(path, { data: { note: '' } }), 'not_found');
    await expectError(await request.patch(path, { data: {} }), 'validation_failed', 'body');
    await expectError(await request.patch(path, { data: { title: '' } }), 'validation_failed', 'title');
    await expectError(await request.patch(path, { data: { other: 1 } }), 'validation_failed', 'other');
    await expectError(await request.fetch(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, data: '[]' }), 'invalid_json');
    await expectError(await request.fetch(path, { method: 'PATCH', headers: { 'content-type': 'text/plain' }, data: '{}' }), 'unsupported_media_type');
  });

  test('updates to different tasks never change each other (C-5)', async ({ request }) => {
    const a = await createTask(request, { title: 'A0', note: 'a0' });
    const b = await createTask(request, { title: 'B0', note: 'b0' });
    await request.patch(`/api/tasks/${a.id}`, { data: { title: 'A1', note: 'a1' } });
    expect(await (await request.get(`/api/tasks/${b.id}`)).json()).toEqual(b);
    await request.patch(`/api/tasks/${b.id}`, { data: { note: 'b1' } });
    expect(await (await request.get(`/api/tasks/${a.id}`)).json()).toMatchObject({ title: 'A1', note: 'a1' });
    expect(await (await request.get(`/api/tasks/${b.id}`)).json()).toMatchObject({ title: 'B0', note: 'b1' });
  });
});
