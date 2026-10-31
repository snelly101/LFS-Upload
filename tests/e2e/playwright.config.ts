import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against the dev API (:3000) + Vite dev server (:5173) started by scripts/e2e-env.sh.
 * They use the file mail sink (var/mail) to read invitation links and verification codes – never real email.
 */
export default defineConfig({
  testDir: './specs',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PW_CHROME ?? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' }, testMatch: /recipient|mobile/ },
  ],
});
