import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests run against the production build (`vite preview`).
 * Revit sample files are not part of the repository: point
 * RVT_SAMPLE (and optionally RVT_SAMPLE_LARGE) at local .rvt files.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173/rvt-viewer/',
    viewport: { width: 1440, height: 900 },
    locale: 'ja-JP',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'pnpm exec vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/rvt-viewer/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
