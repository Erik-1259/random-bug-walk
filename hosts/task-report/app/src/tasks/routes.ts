import type { RouteContext } from '../server.ts';
import { readJsonObject } from '../http/body.ts';
import { HttpError } from '../http/errors.ts';
import { sendJson } from '../http/respond.ts';
import { findTask, insertTask, updateTask } from './store.ts';
import { validateNewTask, validateTaskChanges } from './validate.ts';

export async function createTask({ req, res, pool }: RouteContext): Promise<void> {
  const { title, note } = validateNewTask(await readJsonObject(req));
  const task = await insertTask(pool, title, note);
  sendJson(res, 201, task, { location: `/api/tasks/${task.id}` });
}

export async function getTask({ res, pool, id }: RouteContext): Promise<void> {
  const task = await findTask(pool, id);
  if (task === null) throw new HttpError('not_found');
  sendJson(res, 200, task);
}

export async function patchTask({ req, res, pool, id }: RouteContext): Promise<void> {
  const { title, note } = validateTaskChanges(await readJsonObject(req));
  const task = await updateTask(pool, id, title, note);
  if (task === null) throw new HttpError('not_found');
  sendJson(res, 200, task);
}
