// Measurement probes (not part of `pnpm e2e` or CI): `*.probe.ts` record what a browser does and
// write it to test-results/probes/, without pass / fail judgements. They reuse the main config's
// projects (real-windows-edge included when OTTER_REAL_WINDOWS_EDGE=1) and its fixture server.
//
//   pnpm exec playwright test --config e2e/probes/playwright.config.ts --project=desktop-chrome
//   OTTER_PROBE_HEADED=1 pnpm exec playwright test --config e2e/probes/playwright.config.ts --project=desktop-chrome-headed
//
// desktop-chrome-headed: the same Chromium build with a window. The headless shell gives a Document
// PiP window the size of an ordinary page (RESEARCH §1), so window geometry needs a headed browser.

import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from '../../playwright.config';

const root = fileURLToPath(new URL('../..', import.meta.url));
const projects = [...(base.projects ?? [])];
if (process.env['OTTER_PROBE_HEADED'] === '1') {
  projects.push({ name: 'desktop-chrome-headed', use: { ...devices['Desktop Chrome'], headless: false }, metadata: { matrix: 'desktop' } });
}

export default defineConfig({
  ...base,
  globalTeardown: `${root}e2e/global-teardown.ts`,
  outputDir: `${root}test-results/probes-output`,
  testDir: '.',
  testMatch: '*.probe.ts',
  retries: 0,
  workers: 1,
  reporter: [['list']],
  projects,
  ...(base.webServer === undefined || Array.isArray(base.webServer) ? {} : { webServer: { ...base.webServer, cwd: root } }),
});
