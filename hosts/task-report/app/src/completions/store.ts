import type pg from 'pg';
import { query } from '../db/pool.ts';

type CompletionRow = { id: string; task_id: string; completed_at: Date };
type Completion = { id: string; task_id: string; completed_at: string };

export async function insertCompletion(
  pool: pg.Pool,
  taskId: string,
  completedAt: string | null,
): Promise<Completion | null> {
  const rows = await query<CompletionRow>(
    pool,
    'INSERT INTO completions (task_id, completed_at) SELECT t.id, COALESCE($2::timestamptz, now()) FROM tasks t WHERE t.id = $1 RETURNING id, task_id, completed_at',
    [taskId, completedAt],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { id: row.id, task_id: row.task_id, completed_at: row.completed_at.toISOString() };
}
