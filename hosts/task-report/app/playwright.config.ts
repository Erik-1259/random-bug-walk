import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  },
  projects: [{ name: 'api' }],
});
