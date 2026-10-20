import pg from 'pg';
import { HttpError } from '../http/errors.ts';
import { log } from '../log.ts';

// Implementation rules: string parsers for date (1082) and timestamp (1114).
pg.types.setTypeParser(1082, (value: string) => value);
pg.types.setTypeParser(1114, (value: string) => value);

export function createPool(databaseUrl: string, max: number): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
    statement_timeout: 30000,
    application_name: 'taskapp',
  });
  pool.on('error', (err: Error & { code?: string }) => {
    log('error', 'db_pool_error', { error_name: err.name, sqlstate: err.code ?? null });
  });
  return pool;
}

export async function query<R extends pg.QueryResultRow>(
  pool: pg.Pool,
  text: string,
  values: unknown[],
): Promise<R[]> {
  // Like the pool.on('error') handler: a checked-out client's 'error' is logged and keeps the process up.
  // The listener is attached inside the connect callback so no gap exists before it; the client is released
  // once, and a statement that completed still returns its rows.
  let connectionError: Error | undefined;
  const onError = (err: Error & { code?: string }): void => {
    if (connectionError !== undefined) return;
    connectionError = err;
    log('error', 'db_pool_error', { error_name: err.name, sqlstate: err.code ?? null });
  };
  let client: pg.PoolClient;
  try {
    client = await new Promise<pg.PoolClient>((resolve, reject) => {
      pool.connect((err, connected) => {
        if (err || connected === undefined) {
          reject(err);
          return;
        }
        connected.on('error', onError);
        resolve(connected);
      });
    });
  } catch (cause) {
    // As pg-pool's promise form does: point the stack at this call rather than the socket callback.
    if (cause instanceof Error) Error.captureStackTrace(cause);
    throw new HttpError('database_unavailable', { cause });
  }
  let queryError: Error | true | undefined;
  try {
    const result = await client.query<R>(text, values);
    return result.rows;
  } catch (err) {
    queryError = err instanceof Error ? err : true;
    throw err;
  } finally {
    client.removeListener('error', onError);
    client.release(connectionError ?? queryError);
  }
}
