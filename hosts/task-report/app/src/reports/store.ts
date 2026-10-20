import type pg from 'pg';
import { query } from '../db/pool.ts';

export async function countCompletions(pool: pg.Pool, start: string, end: string): Promise<number> {
  const rows = await query<{ count: number }>(
    pool,
    'SELECT count(*)::int FROM completions WHERE completed_at >= $1::timestamptz AND completed_at < $2::timestamptz',
    [start, end],
  );
  return rows[0]!.count;
}
