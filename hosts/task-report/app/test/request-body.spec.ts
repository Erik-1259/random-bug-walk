import { expect, test, type APIRequestContext } from '@playwright/test';
import { createTask, expectError, expectRawError, postRaw, raw, UNKNOWN_ID, type Task } from './helpers.ts';

type BodyRoute = { name: string; method: string; path: (request: APIRequestContext) => Promise<string>; valid: string };

// The three body routes, each with a body that the route accepts.
const BODY_ROUTES: BodyRoute[] = [
  { name: 'POST /api/tasks', method: 'POST', path: async () => '/api/tasks', valid: '{"title":"body"}' },
  {
    name: 'PATCH /api/tasks/{id}',
    method: 'PATCH',
    path: async (request) => `/api/tasks/${(await createTask(request)).id}`,
    valid: '{"note":"body"}',
  },
  {
    name: 'POST /api/tasks/{id}/completions',
    method: 'POST',
    path: async (request) => `/api/tasks/${(await createTask(request)).id}/completions`,
    valid: '{"completed_at":"1986-04-01T12:00:00Z"}',
  },
];

const KIB = 1024;

for (const route of BODY_ROUTES) {
  test.describe(`${route.name} body handling`, () => {
    test('accepts application/json in any ASCII case, with parameters and surrounding spaces', async ({ request }) => {
      const path = await route.path(request);
      for (const contentType of [
        'application/json',
        'APPLICATION/JSON',
        'Application/Json',
        'application/json; charset=utf-8',
        'application/json;charset=UTF-8',
        'application/json ; foo=bar',
        'application/json;',
        '  application/json  ',
      ]) {
        const response = await postRaw(request, path, route.valid, contentType, route.method);
        expect(response.status(), contentType).toBe(route.method === 'PATCH' ? 200 : 201);
      }
    });

    test('a missing content-type is 415', async ({ request }) => {
      const path = await route.path(request);
      expectRawError(await raw({ method: route.method, path, body: route.valid }), 'unsupported_media_type');
    });

    test('any other media type, +json types included, is 415', async ({ request }) => {
      const path = await route.path(request);
      for (const contentType of [
        'text/plain',
        'text/json',
        'application/x-json',
        'application/jsonx',
        'application/json-patch+json',
        'application/merge-patch+json',
        'application/vnd.api+json',
        'application/x-www-form-urlencoded',
        'multipart/form-data; boundary=x',
        'application',
        'json',
        'application/ json',
        '',
      ]) {
        await expectError(await postRaw(request, path, route.valid, contentType, route.method), 'unsupported_media_type');
      }
    });

    test('415 comes before 413 and 400 (step 4 before steps 5 and 6)', async ({ request }) => {
      const path = await route.path(request);
      await expectError(await postRaw(request, path, Buffer.alloc(65 * KIB, 0x20), 'text/plain', route.method), 'unsupported_media_type');
      await expectError(await postRaw(request, path, '{', 'text/plain', route.method), 'unsupported_media_type');
      await expectError(await postRaw(request, path, '{"zzz":null}', 'text/plain', route.method), 'unsupported_media_type');
    });

    test('a body over 64 KiB is 413, before JSON parsing and validation', async ({ request }) => {
      const path = await route.path(request);
      const padded = route.valid + ' '.repeat(64 * KIB + 1 - route.valid.length);
      expect(Buffer.byteLength(padded)).toBe(64 * KIB + 1);
      await expectError(await postRaw(request, path, padded, 'application/json', route.method), 'payload_too_large');
      await expectError(await postRaw(request, path, '{' + 'x'.repeat(64 * KIB), 'application/json', route.method), 'payload_too_large');
      const invalidField = '{"title":' + JSON.stringify('t'.repeat(64 * KIB)) + '}';
      await expectError(await postRaw(request, path, invalidField, 'application/json', route.method), 'payload_too_large');
    });

    test('a body of exactly 64 KiB is accepted', async ({ request }) => {
      const path = await route.path(request);
      const padded = route.valid + ' '.repeat(64 * KIB - route.valid.length);
      expect(Buffer.byteLength(padded)).toBe(64 * KIB);
      const response = await postRaw(request, path, padded, 'application/json', route.method);
      expect(response.status()).toBe(route.method === 'PATCH' ? 200 : 201);
    });

    test('a chunked body over 64 KiB is 413', async ({ request }) => {
      const path = await route.path(request);
      const chunks = Array.from({ length: 9 }, () => Buffer.alloc(8 * KIB, 0x20));
      chunks[0]![0] = 0x7b; // '{'
      const response = await raw({ method: route.method, path, headers: { 'content-type': 'application/json' }, chunks });
      expectRawError(response, 'payload_too_large');
    });

    test('an empty body is 400 invalid_json', async ({ request }) => {
      const path = await route.path(request);
      expectRawError(
        await raw({ method: route.method, path, headers: { 'content-type': 'application/json', 'content-length': '0' } }),
        'invalid_json',
      );
      await expectError(await postRaw(request, path, '', 'application/json', route.method), 'invalid_json');
    });

    test('unparseable JSON and top-level non-objects are 400 invalid_json', async ({ request }) => {
      const path = await route.path(request);
      for (const body of ['{', '}', '{"title":"x",}', "{'title':'x'}", '{title:"x"}', 'nul', 'null', '[]', '[{"title":"x"}]', '1', '"x"', 'true', ' ', '{"a":1}{"b":2}', '{"title":"x"} x']) {
        await expectError(await postRaw(request, path, body, 'application/json', route.method), 'invalid_json');
      }
    });

    test('bad UTF-8 is 400 invalid_json', async ({ request }) => {
      const path = await route.path(request);
      const valid = Buffer.from(route.valid);
      const insertAt = valid.indexOf(':"') + 2;
      for (const bad of [[0xff], [0xc3], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82]]) {
        const body = Buffer.concat([valid.subarray(0, insertAt), Buffer.from(bad), valid.subarray(insertAt)]);
        await expectError(await postRaw(request, path, body, 'application/json', route.method), 'invalid_json');
      }
    });

    test('the body is decoded as UTF-8 whatever the charset parameter says', async ({ request }) => {
      const path = await route.path(request);
      const body = route.valid.replace('body', 'b\u00e9dy').replace('1986-04-01', '1986-04-02');
      const response = await postRaw(request, path, Buffer.from(body, 'utf8'), 'application/json; charset=iso-8859-1', route.method);
      expect(response.status()).toBe(route.method === 'PATCH' ? 200 : 201);
    });

    test('a leading BOM is ignored', async ({ request }) => {
      const path = await route.path(request);
      const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(route.valid.replace('1986-04-01', '1986-04-03'))]);
      const response = await postRaw(request, path, body, 'application/json', route.method);
      expect(response.status()).toBe(route.method === 'PATCH' ? 200 : 201);
    });

    test('unknown keys are 400 validation_failed naming the key', async ({ request }) => {
      const path = await route.path(request);
      const body = route.valid.slice(0, -1) + ',"extra":1}';
      await expectError(await postRaw(request, path, body, 'application/json', route.method), 'validation_failed', 'extra');
    });
  });
}

test.describe('JSON parsing semantics', () => {
  test('a repeated key: the last one wins', async ({ request }) => {
    const created = await postRaw(request, '/api/tasks', '{"title":"first","note":"a","title":"second","note":"b"}');
    expect(created.status()).toBe(201);
    const task = (await created.json()) as Task;
    expect(task).toMatchObject({ title: 'second', note: 'b' });

    const patched = await postRaw(request, `/api/tasks/${task.id}`, '{"note":"x","note":"y"}', 'application/json', 'PATCH');
    expect(patched.status()).toBe(200);
    expect(await patched.json()).toMatchObject({ title: 'second', note: 'y' });

    await expectError(await postRaw(request, '/api/tasks', '{"title":"ok","title":null}'), 'validation_failed', 'title');
    const recovered = await postRaw(request, '/api/tasks', '{"title":null,"title":"ok"}');
    expect(recovered.status()).toBe(201);
  });

  test('a charset parameter does not change the UTF-8 decoding of stored text', async ({ request }) => {
    const body = Buffer.from('{"title":"caf\u00e9 \u{1f600}"}', 'utf8');
    const created = await postRaw(request, '/api/tasks', body, 'application/json; charset=iso-8859-1');
    expect(created.status()).toBe(201);
    expect(((await created.json()) as Task).title).toBe('caf\u00e9 \u{1f600}');
  });

  test('JSON escapes are decoded before validation and storage', async ({ request }) => {
    const created = await postRaw(request, '/api/tasks', '{"title":"\\u0041\\ud83d\\ude00\\n","note":"\\"q\\"\\t\\/"}');
    expect(created.status()).toBe(201);
    expect(await created.json()).toMatchObject({ title: 'A\u{1f600}\n', note: '"q"\t/' });
  });

  test('a BOM-prefixed body on an unknown task still reaches the 404 step', async ({ request }) => {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"title":"x"}')]);
    await expectError(await postRaw(request, `/api/tasks/${UNKNOWN_ID}`, body, 'application/json', 'PATCH'), 'not_found');
  });
});
