import { defineConfig } from '@playwright/test';

// End-to-end tests drive the real interface against dev-server/server.mjs,
// which runs the real database migrations in an in-process Postgres.
// Set E2E_BASE_URL to run the full-game test against a deployed site instead
// (see README, "Verify production").
const live = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: live ?? 'http://127.0.0.1:5196',
    channel: process.env.PW_CHANNEL ?? 'msedge',
    trace: 'retain-on-failure',
  },
  webServer: live ? undefined : [
    {
      command: 'node dev-server/server.mjs',
      url: 'http://127.0.0.1:5197/events',
      reuseExistingServer: !process.env.CI,
      env: { PORT: '5197', WORDS: 'sample' },
    },
    {
      command: 'npx vite --mode e2e --host 127.0.0.1',
      url: 'http://127.0.0.1:5196',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
