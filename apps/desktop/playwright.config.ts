import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1, // one shared stub daemon per run — broadcasts reach all pages
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node ./e2e/stub-daemon.mjs',
      port: 4197,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: 'npm run dev:web -- --port 1420 --strictPort',
      port: 1420,
      reuseExistingServer: false,
      env: { VOICE_RUNTIME_IPC_TOKEN: 'e2e-token' },
    },
  ],
});
