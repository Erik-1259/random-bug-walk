import type { RouteContext } from '../server.ts';
import { readJsonObject } from '../http/body.ts';
import { HttpError } from '../http/errors.ts';
import { sendJson } from '../http/respond.ts';
import { parseInstant } from '../time/instant.ts';
import { insertCompletion } from './store.ts';

function validateCompletedAt(body: Record<string, unknown>): string | null {
  let completedAt: string | null = null;
  if (Object.hasOwn(body, 'completed_at')) {
    const value = body.completed_at;
    const instant = typeof value === 'string' ? parseInstant(value) : null;
    if (instant === null) throw new HttpError('validation_failed', { field: 'completed_at' });
    completedAt = new Date(instant).toISOString();
  }
  const unknown = Object.keys(body).find((key) => key !== 'completed_at');
  if (unknown !== undefined) throw new HttpError('validation_failed', { field: unknown });
  return completedAt;
}

export async function createCompletion({ req, res, pool, id }: RouteContext): Promise<void> {
  const completedAt = validateCompletedAt(await readJsonObject(req));
  const completion = await insertCompletion(pool, id, completedAt);
  if (completion === null) throw new HttpError('not_found');
  sendJson(res, 201, completion);
}
