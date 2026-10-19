import { expect, test } from '@playwright/test';
import { createTask, expectCommonHeaders, expectError, expectRawError, raw, reportPath, UNKNOWN_ID } from './helpers.ts';

test.describe('heartbeat', () => {
  test('GET /api/heartbeat answers 200 {"status":"ok"}', async ({ request }) => {
    const response = await request.get('/api/heartbeat');
    expect(response.status()).toBe(200);
    expectCommonHeaders(response.headers());
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('the query string is ignored', async ({ request }) => {
    const response = await request.get('/api/heartbeat?verbose=1&x');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});

test.describe('common response headers', () => {
  test('every response has cache-control: no-store and a fresh x-request-id', async ({ request }) => {
    const task = await createTask(request);
    const responses = [
      await request.get('/api/heartbeat'),
      await request.get('/api/heartbeat'),
      await request.post('/api/tasks', { data: { title: 'headers' } }),
      await request.get(`/api/tasks/${task.id}`),
      await request.patch(`/api/tasks/${task.id}`, { data: { note: 'n' } }),
      await request.get(reportPath('1991-01-01', 'UTC')),
      await request.get('/nope'),
      await request.delete('/api/tasks'),
      await request.post('/api/tasks', { data: { title: '' } }),
      await request.post('/api/tasks', { headers: { 'content-type': 'text/plain' }, data: '{}' }),
    ];
    const ids = new Set<string>();
    for (const response of responses) {
      expectCommonHeaders(response.headers());
      ids.add(response.headers()['x-request-id']!);
    }
    expect(ids.size).toBe(responses.length);
  });
});

test.describe('routing: unknown paths get 404 not_found', () => {
  const paths = [
    '/',
    '/api',
    '/api/',
    '/api/heartbeat/',
    '/api/Heartbeat',
    '/API/heartbeat',
    '/api/heart%62eat',
    '/api/tasks/',
    '/api/tasks/x/y',
    `/api/tasks/${UNKNOWN_ID}/`,
    `/api/tasks/${UNKNOWN_ID}/completions/`,
    `/api/tasks/${UNKNOWN_ID}/Completions`,
    `/api/tasks/${UNKNOWN_ID}/notes`,
    '/api/tasks//completions',
    '/api/reports/completions/daily/',
    '/api/reports/completions',
    '/api/reports/completions/Daily',
  ];
  for (const path of paths) {
    test(`GET ${path}`, async ({ request }) => {
      await expectError(await request.get(path), 'not_found');
    });
  }

  test('no slash normalization: double slashes and dot segments are not collapsed', async () => {
    for (const path of ['//api/heartbeat', '/api//heartbeat', '/api/./heartbeat', '/api/x/../heartbeat', '/api/tasks/.']) {
      expectRawError(await raw({ method: 'GET', path }), 'not_found');
    }
  });

  test('an unknown path is 404 whatever the method (step 1 before step 2)', async ({ request }) => {
    await expectError(await request.delete('/api/nothing'), 'not_found');
    await expectError(await request.post('/api/heartbeat/', { data: {} }), 'not_found');
    expectRawError(await raw({ method: 'PUT', path: '/api/tasks/', body: '{}' }), 'not_found');
  });
});

test.describe('routing: wrong method gets 405 with an allow header', () => {
  const cases: { path: string; methods: string[]; allow: string }[] = [
    { path: '/api/heartbeat', methods: ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'], allow: 'GET' },
    { path: '/api/tasks', methods: ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'], allow: 'POST' },
    { path: `/api/tasks/${UNKNOWN_ID}`, methods: ['POST', 'PUT', 'DELETE', 'OPTIONS'], allow: 'GET, PATCH' },
    { path: `/api/tasks/${UNKNOWN_ID}/completions`, methods: ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'], allow: 'POST' },
    { path: '/api/reports/completions/daily', methods: ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'], allow: 'GET' },
  ];
  for (const { path, methods, allow } of cases) {
    for (const method of methods) {
      test(`${method} ${path}`, async ({ request }) => {
        const response = await request.fetch(path, { method });
        expect(response.headers()['allow']).toBe(allow);
        await expectError(response, 'method_not_allowed');
      });
    }
    test(`HEAD ${path}`, async () => {
      const response = await raw({ method: 'HEAD', path });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe(allow);
      expectCommonHeaders(response.headers);
    });
  }

  test('405 is decided before the id is checked (step 2 before step 3)', async ({ request }) => {
    for (const path of ['/api/tasks/not-a-uuid', '/api/tasks/not-a-uuid/completions']) {
      const response = await request.fetch(path, { method: 'PUT' });
      await expectError(response, 'method_not_allowed');
    }
    const response = await request.delete('/api/tasks/not-a-uuid');
    expect(response.headers()['allow']).toBe('GET, PATCH');
  });
});

test.describe('routing: ids', () => {
  const invalidIds = [
    'not-a-uuid',
    '6f1c2b3a00004000800000000000000aa',
    '6f1c2b3a0000400080000000000000aa',
    '{6f1c2b3a-0000-4000-8000-0000000000aa}',
    '6f1c2b3a-0000-4000-8000-0000000000a',
    '6f1c2b3a-0000-4000-8000-0000000000aaa',
    '6f1c2b3g-0000-4000-8000-0000000000aa',
    '6f1c2b3a-0000-4000-8000-0000000000aa%20',
    '%206f1c2b3a-0000-4000-8000-0000000000aa',
    '6f1c2b3a%2D0000-4000-8000-0000000000aa',
    '6f1c2b3a-0000-4000-80000-000000000aa',
    '123',
  ];
  for (const id of invalidIds) {
    test(`a non-UUID id ${JSON.stringify(id)} is 404 on every id route`, async ({ request }) => {
      await expectError(await request.get(`/api/tasks/${id}`), 'not_found');
      await expectError(await request.patch(`/api/tasks/${id}`, { data: { title: 'x' } }), 'not_found');
      await expectError(await request.post(`/api/tasks/${id}/completions`, { data: {} }), 'not_found');
    });
  }

  test('a non-UUID id is 404 without reading the body (step 3 before steps 4 to 7)', async ({ request }) => {
    const id = 'nope';
    const big = Buffer.alloc(70 * 1024, 0x20);
    for (const path of [`/api/tasks/${id}`, `/api/tasks/${id}/completions`]) {
      const method = path.endsWith('completions') ? 'POST' : 'PATCH';
      await expectError(await request.fetch(path, { method, headers: { 'content-type': 'text/plain' }, data: 'x' }), 'not_found');
      expectRawError(await raw({ method, path }), 'not_found');
      await expectError(await request.fetch(path, { method, headers: { 'content-type': 'application/json' }, data: big }), 'not_found');
      await expectError(await request.fetch(path, { method, headers: { 'content-type': 'application/json' }, data: '{' }), 'not_found');
      await expectError(await request.fetch(path, { method, data: { unknown: true } }), 'not_found');
    }
  });

  test('well-formed UUIDs that match no row are 404 not_found', async ({ request }) => {
    for (const id of [
      UNKNOWN_ID,
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
      '01234567-89ab-cdef-0123-456789abcdef',
      'ABCDEF01-2345-6789-ABCD-EF0123456789',
    ]) {
      await expectError(await request.get(`/api/tasks/${id}`), 'not_found');
      await expectError(await request.patch(`/api/tasks/${id}`, { data: { title: 'x' } }), 'not_found');
      await expectError(await request.post(`/api/tasks/${id}/completions`, { data: {} }), 'not_found');
    }
  });

  test('an id in uppercase or mixed case addresses the same task; output ids stay lowercase', async ({ request }) => {
    const task = await createTask(request, { title: 'case' });
    for (const id of [task.id.toUpperCase(), task.id.replace(/[a-f]/, (c) => c.toUpperCase())]) {
      const response = await request.get(`/api/tasks/${id}`);
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual(task);
    }
    const patched = await request.patch(`/api/tasks/${task.id.toUpperCase()}`, { data: { note: 'upper' } });
    expect(patched.status()).toBe(200);
    expect(((await patched.json()) as { id: string }).id).toBe(task.id);
  });

  test('the query string is ignored on task routes', async ({ request }) => {
    const created = await request.post('/api/tasks?title=ignored&x=1', { data: { title: 'query' } });
    expect(created.status()).toBe(201);
    const task = (await created.json()) as { id: string; title: string };
    expect(task.title).toBe('query');
    const fetched = await request.get(`/api/tasks/${task.id}?id=${UNKNOWN_ID}`);
    expect(fetched.status()).toBe(200);
    const patched = await request.patch(`/api/tasks/${task.id}?note=ignored`, { data: { title: 'query 2' } });
    expect(patched.status()).toBe(200);
    expect(await patched.json()).toMatchObject({ title: 'query 2', note: '' });
    await expectError(await request.get(`/api/tasks/not-a-uuid?id=${task.id}`), 'not_found');
  });
});
