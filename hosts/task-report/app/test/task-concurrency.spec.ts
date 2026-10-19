import { expect, test, type APIRequestContext } from '@playwright/test';
import { createTask, type Task } from './helpers.ts';

async function patch(request: APIRequestContext, id: string, data: Record<string, string>): Promise<Task> {
  const response = await request.patch(`/api/tasks/${id}`, { data });
  expect(response.status()).toBe(200);
  return (await response.json()) as Task;
}

async function fetchTask(request: APIRequestContext, id: string): Promise<Task> {
  const response = await request.get(`/api/tasks/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as Task;
}

test.describe('independent updates to one task (C-3, C-4)', () => {
  test('A = {title:T1} then B = {note:N1}: both succeed and the task ends T1/N1', async ({ request }) => {
    const task = await createTask(request, { title: 'T0', note: 'N0' });
    const a = await patch(request, task.id, { title: 'T1' });
    expect(a).toMatchObject({ title: 'T1', note: 'N0' });
    const b = await patch(request, task.id, { note: 'N1' });
    expect(b).toMatchObject({ title: 'T1', note: 'N1' });
    expect(await fetchTask(request, task.id)).toMatchObject({ title: 'T1', note: 'N1' });
  });

  test('B = {note:N1} then A = {title:T1}: both succeed and the task ends T1/N1', async ({ request }) => {
    const task = await createTask(request, { title: 'T0', note: 'N0' });
    const b = await patch(request, task.id, { note: 'N1' });
    expect(b).toMatchObject({ title: 'T0', note: 'N1' });
    const a = await patch(request, task.id, { title: 'T1' });
    expect(a).toMatchObject({ title: 'T1', note: 'N1' });
    expect(await fetchTask(request, task.id)).toMatchObject({ title: 'T1', note: 'N1' });
  });

  for (const order of ['A first', 'B first'] as const) {
    test(`A and B overlapping (${order}): both get 2xx and a fresh GET returns T1/N1`, async ({ request }) => {
      for (let round = 0; round < 25; round++) {
        const task = await createTask(request, { title: 'T0', note: 'N0' });
        const sendA = () => request.patch(`/api/tasks/${task.id}`, { data: { title: 'T1' } });
        const sendB = () => request.patch(`/api/tasks/${task.id}`, { data: { note: 'N1' } });
        const [first, second] = order === 'A first' ? [sendA(), sendB()] : [sendB(), sendA()];
        const responses = await Promise.all([first, second]);
        for (const response of responses) expect(response.status()).toBe(200);
        const [ra, rb] = (await Promise.all(responses.map((r) => r.json()))) as Task[];
        const [aBody, bBody] = order === 'A first' ? [ra!, rb!] : [rb!, ra!];
        // Each response is the row as its own update left it.
        expect(aBody.title).toBe('T1');
        expect(['N0', 'N1']).toContain(aBody.note);
        expect(bBody.note).toBe('N1');
        expect(['T0', 'T1']).toContain(bBody.title);
        // At least one of them saw the other's commit.
        expect(aBody.note === 'N1' || bBody.title === 'T1').toBe(true);
        expect(await fetchTask(request, task.id)).toMatchObject({ title: 'T1', note: 'N1' });
      }
    });
  }

  test('many concurrent single-field updates to one task all land', async ({ request }) => {
    const task = await createTask(request, { title: 'T0', note: 'N0' });
    const responses = await Promise.all([
      ...Array.from({ length: 8 }, () => request.patch(`/api/tasks/${task.id}`, { data: { title: 'T1' } })),
      ...Array.from({ length: 8 }, () => request.patch(`/api/tasks/${task.id}`, { data: { note: 'N1' } })),
    ]);
    for (const response of responses) expect(response.status()).toBe(200);
    expect(await fetchTask(request, task.id)).toMatchObject({ title: 'T1', note: 'N1' });
  });
});

test.describe('concurrent updates elsewhere', () => {
  test('concurrent updates to different tasks never change each other (C-5)', async ({ request }) => {
    const tasks = await Promise.all(Array.from({ length: 10 }, (_, i) => createTask(request, { title: `T${i}`, note: `N${i}` })));
    const responses = await Promise.all(
      tasks.flatMap((task, i) => [
        request.patch(`/api/tasks/${task.id}`, { data: { title: `T${i}'` } }),
        request.patch(`/api/tasks/${task.id}`, { data: { note: `N${i}'` } }),
      ]),
    );
    for (const response of responses) expect(response.status()).toBe(200);
    for (const [i, task] of tasks.entries()) {
      expect(await fetchTask(request, task.id)).toMatchObject({ id: task.id, title: `T${i}'`, note: `N${i}'`, created_at: task.created_at });
    }
  });

  test('concurrent changes to the same field: both succeed and one of the values wins (C-6)', async ({ request }) => {
    for (let round = 0; round < 10; round++) {
      const task = await createTask(request, { title: 'T0', note: 'N0' });
      const responses = await Promise.all([
        request.patch(`/api/tasks/${task.id}`, { data: { title: 'X' } }),
        request.patch(`/api/tasks/${task.id}`, { data: { title: 'Y' } }),
        request.patch(`/api/tasks/${task.id}`, { data: { note: 'P', title: 'Z' } }),
      ]);
      for (const response of responses) expect(response.status()).toBe(200);
      const final = await fetchTask(request, task.id);
      expect(['X', 'Y', 'Z']).toContain(final.title);
      expect(final.note).toBe('P');
      // Last committed wins, so the final row is exactly the row the last update returned.
      const bodies = (await Promise.all(responses.map((r) => r.json()))) as Task[];
      expect(bodies).toContainEqual(final);
    }
  });
});
