// Shared test fixture. Adds a `cdpUrl` option so TV web runtimes (Tizen / webOS developer mode,
// which expose the Chrome DevTools Protocol) can be driven like any other project.

import { test as base, expect } from '@playwright/test';

export interface OtterWorkerOptions {
  /** Chrome DevTools Protocol endpoint of a remote Chromium-based runtime. */
  cdpUrl: string | undefined;
}

export const test = base.extend<object, OtterWorkerOptions>({
  cdpUrl: [undefined, { option: true, scope: 'worker' }],
  browser: [
    async ({ playwright, browserName, headless, channel, launchOptions, connectOptions, cdpUrl }, use) => {
      if (cdpUrl !== undefined) {
        const browser = await playwright.chromium.connectOverCDP(cdpUrl);
        await use(browser);
        await browser.close();
        return;
      }
      const type = playwright[browserName];
      const browser =
        connectOptions !== undefined
          ? await type.connect(connectOptions.wsEndpoint, connectOptions)
          : await type.launch({ ...launchOptions, headless, ...(channel === undefined ? {} : { channel }) });
      await use(browser);
      await browser.close();
    },
    { scope: 'worker' },
  ],
});

export { expect };
