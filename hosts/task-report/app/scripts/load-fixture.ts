import { readFileSync } from 'node:fs';

type Fixture = {
  version: number;
  tasks: { title: string; note: string; completions: string[] }[];
};

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/demo.v1.json', import.meta.url), 'utf8')) as Fixture;
if (fixture.version !== 1) throw new Error(`unsupported fixture version ${fixture.version}`);

async function post(path: string, body: unknown): Promise<{ id: string }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status !== 201) throw new Error(`POST ${path} returned ${response.status}`);
  return (await response.json()) as { id: string };
}

for (const { title, note, completions } of fixture.tasks) {
  const task = await post('/api/tasks', { title, note });
  console.log(`task ${task.id}`);
  for (const completedAt of completions) {
    const completion = await post(`/api/tasks/${task.id}/completions`, { completed_at: completedAt });
    console.log(`  completion ${completion.id}`);
  }
}
