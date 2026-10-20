import { HttpError } from '../http/errors.ts';

type NewTask = { title: string; note: string };
type TaskChanges = { title: string | null; note: string | null };

function isText(value: unknown, maxCodePoints: number): value is string {
  return (
    typeof value === 'string' &&
    value.isWellFormed() &&
    !value.includes('\u0000') &&
    [...value].length <= maxCodePoints
  );
}

function checkTitle(value: unknown): string {
  if (!isText(value, 200) || value.trim() === '') throw new HttpError('validation_failed', { field: 'title' });
  return value;
}

function checkNote(value: unknown): string {
  if (!isText(value, 10_000)) throw new HttpError('validation_failed', { field: 'note' });
  return value;
}

function checkUnknownKeys(body: Record<string, unknown>): void {
  const unknown = Object.keys(body).find((key) => key !== 'title' && key !== 'note');
  if (unknown !== undefined) throw new HttpError('validation_failed', { field: unknown });
}

export function validateNewTask(body: Record<string, unknown>): NewTask {
  const title = checkTitle(body.title);
  const note = Object.hasOwn(body, 'note') ? checkNote(body.note) : '';
  checkUnknownKeys(body);
  return { title, note };
}

export function validateTaskChanges(body: Record<string, unknown>): TaskChanges {
  const title = Object.hasOwn(body, 'title') ? checkTitle(body.title) : null;
  const note = Object.hasOwn(body, 'note') ? checkNote(body.note) : null;
  checkUnknownKeys(body);
  if (title === null && note === null) throw new HttpError('validation_failed', { field: 'body' });
  return { title, note };
}
