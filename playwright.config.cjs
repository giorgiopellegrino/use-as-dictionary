const { defineConfig } = require('@playwright/test');
const os = require('node:os');
const path = require('node:path');

const channel = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
if (!['chrome', 'chromium', 'msedge'].includes(channel)) {
  throw new Error('PLAYWRIGHT_CHANNEL deve essere chrome, chromium oppure msedge.');
}

module.exports = defineConfig({
  testDir: './test',
  testMatch: 'browser.spec.cjs',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  outputDir: path.join(os.tmpdir(), `use-as-dictionary-playwright-${process.pid}`),
  use: {
    browserName: 'chromium',
    ...(channel === 'chromium' ? {} : { channel }),
    baseURL: 'http://localhost:4174',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node server/index.cjs',
    cwd: __dirname,
    env: { PORT: '4174', HOST: 'localhost' },
    url: 'http://localhost:4174/',
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
