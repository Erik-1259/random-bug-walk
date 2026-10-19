import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type pg from 'pg';
import { createCompletion } from './completions/routes.ts';
import { query } from './db/pool.ts';
import { HttpError } from './http/errors.ts';
import { sendJson } from './http/respond.ts';
import { log } from './log.ts';
import { dailyReport } from './reports/routes.ts';
import { createTask, getTask, patchTask } from './tasks/routes.ts';

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pool: pg.Pool;
  id: string;
  query: string;
};

type Handler = (context: RouteContext) => Promise<void>;
type Route = { template: string; segments: string[]; methods: Map<string, Handler>; allow: string };

const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

async function heartbeat({ res, pool }: RouteContext): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError('database_unavailable')), 1000);
  });
  try {
    await Promise.race([query(pool, 'SELECT 1', []), timeout]);
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError('database_unavailable', { cause: err });
  } finally {
    clearTimeout(timer);
  }
  sendJson(res, 200, { status: 'ok' });
}

function route(template: string, handlers: Record<string, Handler>): Route {
  return {
    template,
    segments: template.split('/'),
    methods: new Map(Object.entries(handlers)),
    allow: Object.keys(handlers).join(', '),
  };
}

const ROUTES: Route[] = [
  route('/api/heartbeat', { GET: heartbeat }),
  route('/api/tasks', { POST: createTask }),
  route('/api/tasks/{id}', { GET: getTask, PATCH: patchTask }),
  route('/api/tasks/{id}/completions', { POST: createCompletion }),
  route('/api/reports/completions/daily', { GET: dailyReport }),
];

function match(path: string): { route: Route; id: string } | null {
  const segments = path.split('/');
  for (const candidate of ROUTES) {
    if (candidate.segments.length !== segments.length) continue;
    let id = '';
    const matched = candidate.segments.every((segment, index) => {
      if (segment !== '{id}') return segment === segments[index];
      id = segments[index]!;
      return id !== '';
    });
    if (matched) return { route: candidate, id };
  }
  return null;
}

function logRequestError(requestId: string, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  const pgError = error as Partial<pg.DatabaseError>;
  log('error', 'request_error', {
    request_id: requestId,
    error_name: error.name,
    sqlstate: pgError.code ?? null,
    severity: pgError.severity,
    position: pgError.position,
    internal_position: pgError.internalPosition,
    schema: pgError.schema,
    table: pgError.table,
    column: pgError.column,
    data_type: pgError.dataType,
    constraint: pgError.constraint,
    file: pgError.file,
    line: pgError.line,
    routine: pgError.routine,
    stack: error.stack,
  });
}

async function handle(pool: pg.Pool, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = performance.now();
  const requestId = randomUUID();
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-request-id', requestId);
  const url = req.url ?? '';
  const mark = url.indexOf('?');
  const path = mark === -1 ? url : url.slice(0, mark);
  let template: string | null = null;
  let errorCode: string | null = null;
  try {
    const found = match(path);
    if (found === null) throw new HttpError('not_found');
    template = found.route.template;
    const handler = found.route.methods.get(req.method ?? '');
    if (handler === undefined) throw new HttpError('method_not_allowed', { allow: found.route.allow });
    if (template.includes('{id}') && !UUID.test(found.id)) throw new HttpError('not_found');
    await handler({ req, res, pool, id: found.id, query: mark === -1 ? '' : url.slice(mark + 1) });
  } catch (err) {
    const error = err instanceof HttpError ? err : new HttpError('internal_error', { cause: err });
    errorCode = error.code;
    if (error.status >= 500 && error.cause !== undefined) logRequestError(requestId, error.cause);
    if (!res.headersSent) {
      sendJson(res, error.status, error.body(), error.allow === undefined ? {} : { allow: error.allow });
    } else {
      res.destroy();
    }
  }
  if (template === '/api/heartbeat' && res.statusCode === 200) return;
  log(res.statusCode >= 500 ? 'error' : 'info', 'request', {
    request_id: requestId,
    method: req.method,
    path: url.slice(0, 512),
    route: template,
    status: res.statusCode,
    duration_ms: Math.round(performance.now() - started),
    error_code: errorCode,
  });
}

export function createAppServer(pool: pg.Pool): Server {
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    void handle(pool, req, res);
  });
  return server;
}
