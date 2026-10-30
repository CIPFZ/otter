// The React example pages (ADR-013 batch 3, first stop): server-rendered markup (built in Node by
// e2e/react-ssr.ts) hydrated without a mismatch, then the preset's player made in the box and
// playing, and the page's own React state (useOtterState) following the player's store.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { ExamplePlayer } from './site/react-app.tsx';

const storeState = (page: Page) =>
  page.evaluate(() => {
    const p = window.reactPlayer as ExamplePlayer | null | undefined;
    if (p == null) return null;
    const s = ('tiles' in p ? p.tiles[0]?.store : p.store)?.getState();
    return s === undefined ? null : { status: s.status, currentTime: s.currentTime, backend: s.backend, format: s.format };
  });

for (const preset of ['basic', 'vod', 'surveillance'] as const) {
  test(`react ${preset}: server markup hydrates without a mismatch, the player plays in the box, useOtterState follows it`, async ({ page }) => {
    // The HTML as served: the app's markup is already there (status "server"), before any script.
    const html = await (await page.request.get(`/react-${preset}.html`)).text();
    expect(html).toContain(`<h1>Otter + React: <!-- -->${preset}</h1>`);
    expect(html).toMatch(/<div data-otter-react="" style="position:relative;aspect-ratio:16 \/ 9" class="player"><\/div>/);
    expect(html).toContain('<span data-testid="status">server</span>');
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /hydrat/i.test(m.text())) errors.push(m.text());
    });
    await page.goto(`/react-${preset}.html`);
    if (preset === 'surveillance') test.skip(!(await page.evaluate(() => typeof VideoDecoder === 'function')), 'no WebCodecs here');
    await expect.poll(async () => (await storeState(page))?.currentTime ?? 0, { timeout: 20_000 }).toBeGreaterThan(1);
    const s = await storeState(page);
    expect(s?.status).toBe('ready');
    if (preset === 'surveillance') expect(s).toMatchObject({ backend: 'webcodecs', format: 'flv' });
    else expect(s?.format).toBe('hls');
    // One player, in the server-rendered box (a child container the binding made).
    await expect(page.locator('[data-otter-react] > div [data-otter-controls]')).toHaveCount(1);
    // The page's React state: status and whole seconds from useOtterState.
    await expect(page.getByTestId('status')).toHaveText('ready');
    await expect.poll(async () => Number(await page.getByTestId('time').textContent()), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(await page.evaluate(() => window.hydrationErrors)).toEqual([]);
    expect(errors).toEqual([]);
  });
}
