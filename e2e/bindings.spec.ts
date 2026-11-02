// The framework example pages (ADR-013 batch 3: React, Vue, Svelte; basic, vod, surveillance):
// server-rendered markup (built in Node by e2e/framework-ssr.ts) hydrated without a mismatch, then
// the preset's player made in the box and playing, and the page's own framework state (the
// binding's state hook / composable / store) following the player's store.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { ExamplePlayer } from './site/example-presets.ts';

const storeState = (page: Page) =>
  page.evaluate(() => {
    const p = window.examplePlayer as ExamplePlayer | null | undefined;
    if (p == null) return null;
    const s = ('tiles' in p ? p.tiles[0]?.store : p.store)?.getState();
    return s === undefined ? null : { status: s.status, currentTime: s.currentTime, backend: s.backend, format: s.format };
  });

const BOX: Record<string, string> = { react: 'data-otter-react', vue: 'data-otter-vue', svelte: 'data-otter-svelte' };
const NAME: Record<string, string> = { react: 'React', vue: 'Vue', svelte: 'Svelte' };

for (const framework of ['react', 'vue', 'svelte'] as const) {
  for (const preset of ['basic', 'vod', 'surveillance'] as const) {
    test(`${framework} ${preset}: server markup hydrates without a mismatch, the player plays in the box, the state binding follows it`, async ({ page }) => {
      const box = BOX[framework] as string;
      // The HTML as served: the app's markup is already there (status "server"), before any script.
      const html = await (await page.request.get(`/${framework}-${preset}.html`)).text();
      expect(html).toMatch(new RegExp(`<h1>Otter \\+ ${NAME[framework]}: (<!-- -->|<!---->)?${preset}</h1>`));
      expect(html).toMatch(new RegExp(`<div[^>]*${box}[^>]*aspect-ratio: ?16 / 9`));
      expect(html).toMatch(/<span data-testid="status">server<\/span>/);
      // The box the parser made is marked before any script runs: hydration must keep that element
      // (a mismatch replaces it; Svelte's production build says nothing about one).
      await page.addInitScript((attr) => {
        new MutationObserver((records) => {
          for (const r of records) for (const n of r.addedNodes) if (n instanceof Element && n.hasAttribute(attr)) (n as Element & { fromServer?: boolean }).fromServer = true;
        }).observe(document, { childList: true, subtree: true });
      }, box);
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error' && /hydrat/i.test(m.text())) errors.push(m.text());
      });
      await page.goto(`/${framework}-${preset}.html`);
      if (preset === 'surveillance') test.skip(!(await page.evaluate(() => typeof VideoDecoder === 'function')), 'no WebCodecs here');
      await expect.poll(async () => (await storeState(page))?.currentTime ?? 0, { timeout: 20_000 }).toBeGreaterThan(1);
      const s = await storeState(page);
      expect(s?.status).toBe('ready');
      if (preset === 'surveillance') expect(s).toMatchObject({ backend: 'webcodecs', format: 'flv' });
      else expect(s?.format).toBe('hls');
      // One player, in the server-rendered box (a child container the binding made).
      await expect(page.locator(`[${box}] > div [data-otter-controls]`)).toHaveCount(1);
      expect(await page.locator(`[${box}]`).evaluate((el) => (el as Element & { fromServer?: boolean }).fromServer === true)).toBe(true);
      // The page's framework state: status and whole seconds from the binding.
      await expect(page.getByTestId('status')).toHaveText('ready');
      await expect.poll(async () => Number(await page.getByTestId('time').textContent()), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
      expect(await page.evaluate(() => window.hydrationErrors)).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}
