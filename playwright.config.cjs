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
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: ['webpack', 'vite'].map((bundler, index) => ({
    name: bundler,
    use: { baseURL: `http://localhost:${4174 + index}` },
    metadata: { buildDir: path.join(__dirname, 'examples', `vue-${bundler}`, 'build') },
  })),
  webServer: ['webpack', 'vite'].map((bundler, index) => ({
    command: `npm run serve:${bundler}`,
    cwd: __dirname,
    env: { PORT: String(4174 + index), HOST: 'localhost' },
    url: `http://localhost:${4174 + index}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  })),
});
