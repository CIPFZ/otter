// The five classes the own CMAF-HLS engine leaves to hls.js (ADR-010 §2): each stream really plays
// on hls.js after the own engine declined it at load, and router.explain() says why. Fixtures:
// e2e/media/generate-hls-unsupported.sh (discontinuity, AES-128, LL-HLS parts), hls-ts/ (TS
// segments), hls-iframes/ (I-frame playlist).

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const CASES = [
  { name: 'EXT-X-DISCONTINUITY', src: '/hls-unsupported/discontinuity/master.m3u8', reason: 'EXT-X-DISCONTINUITY' },
  { name: 'AES-128', src: '/hls-unsupported/aes128/master.m3u8', reason: 'EXT-X-KEY' },
  { name: 'TS segments', src: '/hls-ts/master.m3u8', reason: 'TS segments' },
  { name: 'LL-HLS parts', src: '/hls-unsupported/ll-parts/master.m3u8', reason: 'EXT-X-PART' },
  { name: 'I-frame playlist', src: '/hls-iframes/master.m3u8', reason: 'EXT-X-I-FRAME-STREAM-INF' },
] as const;

const state = (page: Page) =>
  page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const s = o.state();
    return {
      t: s.currentTime,
      paused: s.paused,
      backend: s.backend,
      steps: s.route?.steps.map((r) => r.reason) ?? [],
      // Plain fields: Error objects lose their own properties on the way out of the page.
      errors: o.events
        .filter((e) => e.type === 'error')
        .map((e) => {
          const err = (e.payload as { error: { details: string; fatal: boolean } }).error;
          return { details: err.details, fatal: err.fatal };
        }),
    };
  });

for (const c of CASES) {
  test(`${c.name}: the own engine declines, hls.js plays it`, async ({ page }) => {
    test.setTimeout(60_000);
    // hls.js is loaded only after the own engine declined.
    const scripts: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'script') scripts.push(r.url());
    });
    await page.goto('/player.html?idle=0');
    await page.evaluate(async (src) => {
      const o = (await window.otter) as OtterFixture;
      o.dispatch('set-muted', { muted: true });
      o.load({ src }, { autoplay: true });
    }, c.src);
    await expect.poll(async () => (await state(page)).t, { timeout: 20_000 }).toBeGreaterThan(2.5);
    const s = await state(page);
    expect(s.paused).toBe(false);
    expect(s.backend).toBe('mse');
    expect(s.steps).toContain(`own engine does not support this stream: ${c.reason}; using the adapter`);
    // One non-fatal pipelineFallback, nothing fatal (hls.js may add non-fatal notes of its own).
    expect(s.errors.filter((e) => e.details === 'pipelineFallback')).toHaveLength(1);
    expect(s.errors.every((e) => !e.fatal)).toBe(true);
    expect(scripts.some((u) => /hls/i.test(u.split('/').pop() ?? '') && !/format-hls|hls-own/.test(u))).toBe(true);
  });
}
