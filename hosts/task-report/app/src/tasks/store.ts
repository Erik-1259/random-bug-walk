import type pg from 'pg';
import { query } from '../db/pool.ts';

type TaskRow = { id: string; title: string; note: string; created_at: Date; updated_at: Date };
type Task = { id: string; title: string; note: string; created_at: string; updated_at: string };

const COLUMNS = 'id,title,note,created_at,updated_at';

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function insertTask(pool: pg.Pool, title: string, note: string): Promise<Task> {
  const rows = await query<TaskRow>(pool, `INSERT INTO tasks (title, note) VALUES ($1, $2) RETURNING ${COLUMNS}`, [
    title,
    note,
  ]);
  return toTask(rows[0]!);
}

export async function findTask(pool: pg.Pool, id: string): Promise<Task | null> {
  const rows = await query<TaskRow>(pool, `SELECT ${COLUMNS} FROM tasks WHERE id = $1`, [id]);
  return rows.length === 0 ? null : toTask(rows[0]!);
}

// C-3, C-4: one autocommit statement, no prior read.
export async function updateTask(
  pool: pg.Pool,
  id: string,
  title: string | null,
  note: string | null,
): Promise<Task | null> {
  const rows = await query<TaskRow>(
    pool,
    'UPDATE tasks SET title = COALESCE($2,title), note = COALESCE($3,note), updated_at = now() WHERE id = $1 RETURNING id,title,note,created_at,updated_at',
    [id, title, note],
  );
  return rows.length === 0 ? null : toTask(rows[0]!);
}
