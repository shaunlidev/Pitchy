import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '../apps/web/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/pitchroom-browser` : '/tmp/pitchroom-browser',
  use: {
    baseURL: 'http://127.0.0.1:3010',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  webServer: {
    command: 'pnpm exec next start --hostname 127.0.0.1 --port 3010',
    cwd: new URL('../apps/web', import.meta.url).pathname,
    url: 'http://127.0.0.1:3010',
    reuseExistingServer: false,
    timeout: 120000,
    env: { PITCHROOM_RUNTIME: 'fixture' },
  },
});
