import { request as httpRequest } from 'node:http';
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';

export const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3000';

export const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// A syntactically valid UUID that no test ever creates.
export const UNKNOWN_ID = '6f1c2b3a-0000-4000-8000-0000000000aa';

export type Task = { id: string; title: string; note: string; created_at: string; updated_at: string };
export type Completion = { id: string; task_id: string; completed_at: string };
export type Report = { date: string; time_zone: string; start: string; end: string; count: number };

export const ERROR_STATUS: Record<string, number> = {
  invalid_json: 400,
  validation_failed: 400,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal_error: 500,
  database_unavailable: 503,
};

/** Every response carries `cache-control: no-store` and a UUID `x-request-id`. */
export function expectCommonHeaders(headers: Record<string, string | string[] | undefined>): void {
  expect(headers['cache-control']).toBe('no-store');
  const requestId = headers['x-request-id'];
  expect(typeof requestId).toBe('string');
  expect(requestId as string).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
}

/** Asserts the error envelope, the status for its code, and the presence (or absence) of `field`. */
export function expectErrorBody(status: number, body: unknown, code: string, field?: string): void {
  expect(status).toBe(ERROR_STATUS[code]);
  const expected: Record<string, unknown> = { code, message: expect.any(String) };
  if (field !== undefined) expected.field = field;
  expect(body).toEqual({ error: expected });
  expect(((body as { error: { message: string } }).error.message).length).toBeGreaterThan(0);
}

export async function expectError(response: APIResponse, code: string, field?: string): Promise<void> {
  expectCommonHeaders(response.headers());
  expectErrorBody(response.status(), await response.json(), code, field);
}

export async function createTask(
  request: APIRequestContext,
  body: Record<string, unknown> = { title: 'A task' },
): Promise<Task> {
  const response = await request.post('/api/tasks', { data: body });
  expect(response.status()).toBe(201);
  return (await response.json()) as Task;
}

export async function addCompletion(request: APIRequestContext, taskId: string, completedAt?: string): Promise<Completion> {
  const response = await request.post(`/api/tasks/${taskId}/completions`, {
    data: completedAt === undefined ? {} : { completed_at: completedAt },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as Completion;
}

/** Builds the report URL, percent-encoding both values. */
export function reportPath(date: string, timeZone: string): string {
  return `/api/reports/completions/daily?date=${encodeURIComponent(date)}&time_zone=${encodeURIComponent(timeZone)}`;
}

export async function getReport(request: APIRequestContext, date: string, timeZone: string): Promise<Report> {
  const response = await request.get(reportPath(date, timeZone));
  expect(response.status()).toBe(200);
  expectCommonHeaders(response.headers());
  return (await response.json()) as Report;
}

/** Sends a JSON body with an explicit content type (Playwright would otherwise choose one). */
export function postRaw(
  request: APIRequestContext,
  path: string,
  body: string | Buffer,
  contentType = 'application/json',
  method = 'POST',
): Promise<APIResponse> {
  return request.fetch(path, { method, headers: { 'content-type': contentType }, data: body });
}

export type RawResponse = { status: number; headers: Record<string, string | string[] | undefined>; text: string };

/**
 * Sends a request with node:http so that the path, headers and body framing go out exactly as given:
 * no dot-segment normalization and no default content type. `chunks` are sent with chunked encoding.
 */
export function raw(options: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  chunks?: Buffer[];
}): Promise<RawResponse> {
  const url = new URL(BASE_URL);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port === '' ? 80 : Number(url.port),
        method: options.method,
        path: options.path,
        headers: options.headers ?? {},
        agent: false,
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(parts).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.chunks !== undefined) {
      for (const chunk of options.chunks) req.write(chunk);
      req.end();
    } else {
      req.end(options.body);
    }
  });
}

export function expectRawError(response: RawResponse, code: string, field?: string): void {
  expectCommonHeaders(response.headers);
  expectErrorBody(response.status, JSON.parse(response.text), code, field);
}
