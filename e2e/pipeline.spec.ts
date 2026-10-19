// Own pipeline end to end (ADR-007 §2): FLV live / TS VOD / video-only TS through the full player
// (session -> backend-mse -> engine-pipeline -> transmuxer -> MSE), selected with ?pipeline=otter.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const state = (page: Page) => page.evaluate(async () => ((await window.otter) as OtterFixture).state());

for (const [id, source] of [
  ['cn-live-flv', { src: '/live/stream.flv', live: true }],
  ['cn-vod-ts', { src: '/ts/clip.ts' }],
  ['camera-ts-video-only', { src: '/ts/clip-video-only.ts' }],
] as const) {
  test(`own pipeline plays ${id}`, async ({ page }) => {
    await page.goto('/player.html?pipeline=otter');
    await page.evaluate(async (src) => {
      const o = (await window.otter) as OtterFixture;
      o.dispatch('set-muted', { muted: true });
      o.load(src, { autoplay: true });
    }, source);
    await expect.poll(async () => (await state(page)).qoe.ttff, { timeout: 20_000 }).not.toBeNull();
    const s0 = await state(page);
    expect(s0.error, JSON.stringify(s0.error)).toBeNull();
    expect(s0.backend).toBe('mse');
    // No fallback to the adapter happened.
    const events = await page.evaluate(async () => ((await window.otter) as OtterFixture).events.filter((e) => e.type === 'error').map((e) => (e.payload as { error: { details: string } }).error.details));
    expect(events).not.toContain('pipelineFallback');
    const start = s0.currentTime;
    await expect.poll(async () => (await state(page)).currentTime - start, { timeout: 15_000 }).toBeGreaterThan(2);
    const s = await state(page);
    expect(s.videoWidth).toBe(640);
    if (id === 'cn-live-flv') {
      expect(s.live).toBe(true);
      // Held near the 1 s target by the LiveController (acceptance: <= 2 s, ADR-007 §3).
      await expect.poll(async () => (await state(page)).latency ?? 99, { timeout: 15_000 }).toBeLessThanOrEqual(2);
    }
  });
}

test('the mpegts.js adapter (fallback target) still plays live FLV', async ({ page }) => {
  await page.goto('/player.html?pipeline=mpegts');
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/live/stream.flv', live: true }, { autoplay: true });
  });
  await expect.poll(async () => (await state(page)).qoe.ttff, { timeout: 20_000 }).not.toBeNull();
  const start = (await state(page)).currentTime;
  await expect.poll(async () => (await state(page)).currentTime - start, { timeout: 15_000 }).toBeGreaterThan(2);
});

test('back to live: pause until behind, the capsule appears, one click returns to the edge and plays', async ({ page }) => {
  await page.goto('/player.html?idle=0');
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/live/stream.flv', live: true }, { autoplay: true });
  });
  await expect.poll(async () => (await state(page)).qoe.ttff, { timeout: 20_000 }).not.toBeNull();
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('pause', undefined));
  const back = page.locator('otter-live-indicator').getByRole('button', { name: 'Back to live' });
  await expect(back).toBeVisible({ timeout: 15_000 });
  await back.click();
  await expect.poll(async () => (await state(page)).paused).toBe(false);
  await expect.poll(async () => (await state(page)).latency ?? 99, { timeout: 10_000 }).toBeLessThanOrEqual(2);
  await expect(back).toBeHidden();
});

