// Playwright device matrix (AGENT §2.6, SPEC §21): iPhone Safari, Android Chrome, desktop
// Chrome / Firefox / Safari, at least one Tizen or webOS TV.
//
// - desktop-*: run locally and in CI.
// - emulated-*: device emulation catches viewport / touch regressions in CI. It is NOT the
//   real-device matrix and never counts as a pass for it.
// - real-*: enabled only when the endpoint variable is set (see e2e/README.md).

import {
  defineConfig,
  devices,
  type PlaywrightTestOptions,
  type PlaywrightWorkerOptions,
  type Project,
} from '@playwright/test';
import type { OtterWorkerOptions } from './e2e/fixtures';

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

const baseURL = env('OTTER_E2E_BASE_URL') ?? 'http://localhost:4173';
const iosEndpoint = env('OTTER_REAL_IOS_WS_ENDPOINT');
const androidEndpoint = env('OTTER_REAL_ANDROID_WS_ENDPOINT');
const tvCdpUrl = env('OTTER_REAL_TV_CDP_URL');
const tvPlatform = env('OTTER_REAL_TV_PLATFORM') ?? 'tizen';

const projects: Project<PlaywrightTestOptions, PlaywrightWorkerOptions & OtterWorkerOptions>[] = [
  { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] }, metadata: { matrix: 'desktop' } },
  { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'] }, metadata: { matrix: 'desktop' } },
  { name: 'desktop-safari', use: { ...devices['Desktop Safari'] }, metadata: { matrix: 'desktop' } },
  { name: 'emulated-iphone', use: { ...devices['iPhone 15'] }, metadata: { matrix: 'emulated' } },
  { name: 'emulated-android', use: { ...devices['Pixel 7'] }, metadata: { matrix: 'emulated' } },
];

if (iosEndpoint !== undefined) {
  projects.push({
    name: 'real-iphone-safari',
    use: { ...devices['iPhone 15'], connectOptions: { wsEndpoint: iosEndpoint } },
    metadata: { matrix: 'real' },
  });
}
if (androidEndpoint !== undefined) {
  projects.push({
    name: 'real-android-chrome',
    use: { ...devices['Pixel 7'], connectOptions: { wsEndpoint: androidEndpoint } },
    metadata: { matrix: 'real' },
  });
}
if (tvCdpUrl !== undefined) {
  projects.push({
    name: `real-tv-${tvPlatform}`,
    use: { browserName: 'chromium', viewport: { width: 1920, height: 1080 }, cdpUrl: tvCdpUrl },
    metadata: { matrix: 'real' },
  });
}

export default defineConfig<object, OtterWorkerOptions>({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  forbidOnly: process.env['CI'] !== undefined,
  retries: process.env['CI'] !== undefined ? 1 : 0,
  reporter: process.env['CI'] !== undefined ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects,
  // A remote base URL (tunnel to a real device) means the fixture is served elsewhere.
  ...(env('OTTER_E2E_BASE_URL') === undefined
    ? {
        webServer: {
          command: 'pnpm exec vite --config e2e/vite.config.ts',
          url: baseURL,
          reuseExistingServer: process.env['CI'] === undefined,
        },
      }
    : {}),
});
